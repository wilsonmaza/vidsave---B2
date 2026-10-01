import crypto from 'node:crypto';
import { createSizeGuardTransform, isSizeGuardExceededError } from '../storage/size-guard.js';

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutos, como pedido

// Mesmo valor por defeito de env.downloadMaxSizeBytes (config/env.js) —
// duplicado aqui só como rede de segurança para quem chamar
// resolveDownloadTarget()/ensureStored() diretamente (nomeadamente
// testes) sem passar maxDownloadSizeBytes explicitamente. Em produção,
// o valor vem sempre de app.js -> env.js, nunca desta constante.
const DEFAULT_MAX_DOWNLOAD_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB

/**
 * Gera um downloadId imprevisível: 32 bytes de entropia criptográfica
 * (`crypto.randomBytes`, não `Math.random`), codificados em base64url —
 * seguro para URLs, sem caracteres que precisem de escaping.
 */
export function generateDownloadId() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Os três estados possíveis de um downloadId (Etapa 6.3.1: máquina de
 * estados explícita, para garantir consumo único mesmo sob concorrência
 * real — ver DownloadStore.claim()/release() mais abaixo). Exportado
 * para quem precisar de comparar contra eles explicitamente (sobretudo
 * testes) em vez de strings soltas espalhadas pelo código.
 */
export const DOWNLOAD_STATE = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  CONSUMING: 'CONSUMING',
  CONSUMED: 'CONSUMED',
});

/**
 * Nunca devolve a referência interna do Map — só cópias — para que
 * mutar o resultado nunca corrompa o estado do store (a mesma garantia
 * que já existia antes desta etapa). `consumed` fica como campo
 * derivado, só por compatibilidade com código e testes que já existiam
 * antes da máquina de estados explícita: a fonte de verdade passa a ser
 * sempre `state`.
 */
function toPublicRecord(record) {
  return { ...record, consumed: record.state === DOWNLOAD_STATE.CONSUMED };
}

/**
 * O modelo de estado de um download: associa um downloadId opaco (tudo
 * o que o cliente alguma vez vê ou envia) ao providerId e formatId
 * reais, que ficam escondidos do cliente. Nada disto vive dentro de
 * nenhum provider — os providers continuam sem estado (Etapa 4).
 *
 * Deliberadamente parecido com o `MemoryRateLimiter` da Etapa 3: em
 * memória, por processo, com expiração automática via TTL e um timer de
 * limpeza `unref()`ado. Se um dia correrem várias instâncias do backend,
 * vai precisar do mesmo tipo de substituto partilhado (Redis ou
 * equivalente) que já está documentado como limitação do rate limiter.
 */
export class DownloadStore {
  constructor({ ttlMs = DEFAULT_TTL_MS, nowFn = Date.now, cleanupIntervalMs, onExpire } = {}) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error('DownloadStore requer um ttlMs positivo.');
    }
    this.ttlMs = ttlMs;
    this.nowFn = nowFn;
    this.records = new Map(); // downloadId -> record
    // Callback opcional, chamado quando um registo expira (por leitura
    // preguiçosa em get() ou pelo timer periódico). Serve para a Etapa
    // 6.3 ligar a limpeza do ficheiro físico sem precisar de um job novo
    // — reutiliza o timer que já existia na 6.1. Por omissão não faz
    // nada, para não alterar o comportamento de quem já usava isto sem
    // este parâmetro.
    this.onExpire = typeof onExpire === 'function' ? onExpire : () => {};

    const interval = cleanupIntervalMs ?? ttlMs;
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), interval);
    this.cleanupTimer.unref?.();
  }

  /**
   * Cria um registo novo com um downloadId novo. Não aceita nem precisa
   * de nada vindo do cliente — quem chama isto é sempre código interno
   * (o resolve.service.js, a partir da Etapa 6.2), nunca um pedido HTTP.
   *
   * @param {{ providerId: string, formatId: string, sizeBytes?: number|null }} params
   *   `sizeBytes` (Etapa 6.4 — Size Guard) é o tamanho declarado pelo
   *   provider no /resolve (ResolvedFormat.sizeBytes), guardado aqui
   *   para permitir rejeição antecipada em resolveDownloadTarget() —
   *   antes de qualquer streaming HTTP — sem ter de chamar o provider
   *   outra vez. É opcional (`null` por omissão) de propósito: quem
   *   chamar create() sem o passar continua a funcionar exatamente
   *   como antes desta etapa, só que sem rejeição antecipada possível
   *   para esse registo — o SizeGuardTransform em ensureStored()
   *   continua a proteger de qualquer forma, é a defesa que não
   *   depende de nada ter sido declarado.
   */
  create({ providerId, formatId, sizeBytes = null }) {
    if (typeof providerId !== 'string' || providerId.trim() === '') {
      throw new Error('DownloadStore.create requer um providerId (string não vazia).');
    }
    if (typeof formatId !== 'string' || formatId.trim() === '') {
      throw new Error('DownloadStore.create requer um formatId (string não vazia).');
    }
    if (sizeBytes !== null && !(typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) && sizeBytes >= 0)) {
      throw new Error('DownloadStore.create requer sizeBytes null ou um número finito >= 0.');
    }

    const downloadId = generateDownloadId();
    const now = this.nowFn();
    const record = {
      downloadId,
      providerId,
      formatId,
      sizeBytes,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      // A política de QUANDO cada transição de estado é permitida
      // continua fora daqui (em resolveDownloadTarget() e no
      // controller) — DownloadStore só garante que as transições em si
      // são atómicas (claim/release/markConsumed), tal como a allowlist
      // foi mantida fora do ssrf-guard.
      state: DOWNLOAD_STATE.AVAILABLE,
    };

    this.records.set(downloadId, { ...record });
    return toPublicRecord(record);
  }

  /**
   * Devolve uma CÓPIA do registo se existir e ainda não tiver expirado;
   * `null` caso contrário (inexistente, formato inválido, ou expirado —
   * o chamador não precisa de distinguir estes casos, a resposta pública
   * vai ser sempre a mesma: 404). Nunca devolve a referência interna,
   * para que mutar o resultado nunca corrompa o estado do store.
   */
  get(downloadId) {
    if (typeof downloadId !== 'string' || downloadId.trim() === '') return null;

    const record = this.records.get(downloadId);
    if (!record) return null;

    if (this.nowFn() >= record.expiresAt) {
      this.records.delete(downloadId);
      this.onExpire(record);
      return null;
    }

    return toPublicRecord(record);
  }

  /**
   * Força a transição para CONSUMED, seja qual for o estado atual — não
   * impõe nenhuma política sozinho, quem decide QUANDO isto pode
   * acontecer é o controller, depois (e só depois) de um streaming
   * completo com sucesso. Não lança para um downloadId inexistente.
   */
  markConsumed(downloadId) {
    const record = this.records.get(downloadId);
    if (record) record.state = DOWNLOAD_STATE.CONSUMED;
  }

  /**
   * Reivindica atomicamente um downloadId para consumo exclusivo:
   * transita AVAILABLE -> CONSUMING numa única operação síncrona, sem
   * `await` pelo meio — a leitura do estado atual e a escrita do novo
   * estado acontecem na mesma volta do event loop, por isso não existe
   * nenhuma janela de corrida entre dois pedidos concorrentes que
   * cheguem aqui (mesmo princípio já usado na fixação de DNS da Etapa 2
   * e em DownloadCoordinator.ensureStored()).
   *
   * Falha (`claimed: false`) para exatamente os mesmos casos que antes
   * levavam resolveDownloadTarget() a responder 404: inexistente,
   * expirado, já CONSUMING (outro pedido está a usá-lo agora mesmo) ou
   * já CONSUMED. O chamador não precisa de — nem deve — distinguir estes
   * casos (ver DownloadNotFoundError).
   *
   * @returns {{ claimed: true, record: object } | { claimed: false }}
   */
  claim(downloadId) {
    if (typeof downloadId !== 'string' || downloadId.trim() === '') return { claimed: false };

    const record = this.records.get(downloadId);
    if (!record) return { claimed: false };

    if (this.nowFn() >= record.expiresAt) {
      this.records.delete(downloadId);
      this.onExpire(record);
      return { claimed: false };
    }

    if (record.state !== DOWNLOAD_STATE.AVAILABLE) return { claimed: false };

    record.state = DOWNLOAD_STATE.CONSUMING;
    return { claimed: true, record: toPublicRecord(record) };
  }

  /**
   * Liberta um claim que não chegou a consumir com sucesso (falha a
   * meio, abort do cliente, ou o pedido nem chegou a gastar uma vaga de
   * concorrência) — devolve CONSUMING -> AVAILABLE para que uma nova
   * tentativa seja possível. Não faz nada se o registo já não existir
   * (expirou entretanto) ou já não estiver em CONSUMING: se já está
   * CONSUMED, foi essa mesma tentativa (ou outra coisa) que terminou com
   * sucesso entretanto, e "libertar" reabriria um recurso que já devia
   * ficar fechado.
   */
  release(downloadId) {
    const record = this.records.get(downloadId);
    if (record && record.state === DOWNLOAD_STATE.CONSUMING) {
      record.state = DOWNLOAD_STATE.AVAILABLE;
    }
  }

  delete(downloadId) {
    this.records.delete(downloadId);
  }

  /** Remove entradas cuja janela já expirou. Chamado pelo timer periódico, mas exposto para testes/uso manual. */
  cleanupExpired() {
    const now = this.nowFn();
    for (const [id, record] of this.records) {
      if (now >= record.expiresAt) {
        this.records.delete(id);
        this.onExpire(record);
      }
    }
  }

  get size() {
    return this.records.size;
  }

  /**
   * Retorna um array com os downloadIds válidos (não expirados) actualmente
   * armazenados no DownloadStore. Limpa registos expirados durante a iteração,
   * chamando `onExpire` para cada um, e devolve apenas os que permanecem
   * válidos após essa limpeza.
   *
   * Isto é a API pública para obter lista de IDs — nunca aceder directamente
   * a `this.records.keys()` (detalhe de implementação interna).
   *
   * @returns {string[]} Array de downloadIds válidos
   */
  getValidIds() {
    const now = this.nowFn();
    const expiredIds = [];

    // Identifica e marca para expiração qualquer registo vencido
    for (const [id, record] of this.records) {
      if (now >= record.expiresAt) {
        expiredIds.push(id);
      }
    }

    // Remove os expirados e chama onExpire para cada um
    for (const id of expiredIds) {
      const record = this.records.get(id);
      this.records.delete(id);
      this.onExpire(record);
    }

    // Retorna os IDs que ainda existem (não expirados)
    return Array.from(this.records.keys());
  }

  /** Para uso explícito em testes/shutdown controlado; o `unref()` já torna isto opcional em produção. */
  stop() {
    clearInterval(this.cleanupTimer);
  }
}

// ==================================================================
// Etapa 6.3 — download HTTP
// ==================================================================

/**
 * Mesmo princípio do ProviderError/StorageError: mensagem pública fixa,
 * motivo real só em `detail`. Cobre tanto inconsistências internas
 * (provider referenciado já não existe) como falhas de stream.
 */
export class DownloadError extends Error {
  constructor(detail, { publicMessage = 'Não foi possível processar este pedido.', status = 500 } = {}) {
    super(publicMessage);
    this.name = 'DownloadError';
    this.detail = detail;
    this.status = status;
  }
}

/**
 * Representa "este downloadId não pode ser usado agora" — inexistente,
 * expirado, ou já consumido. As três causas mapeiam para a MESMA
 * resposta pública (404, sem distinguir o motivo), de propósito: não
 * damos a quem estiver a sondar o endpoint uma forma de distinguir um
 * downloadId que nunca existiu de um que já foi usado.
 */
export class DownloadNotFoundError extends DownloadError {
  constructor(detail) {
    super(detail, { publicMessage: 'Download não encontrado ou expirado.', status: 404 });
    this.name = 'DownloadNotFoundError';
  }
}

/**
 * Etapa 6.4 — Size Guard. Lançado quando um download é rejeitado por
 * exceder downloadMaxSizeBytes (config/env.js) — de duas origens
 * possíveis, que produzem deliberadamente o MESMO tipo de erro e a
 * MESMA resposta pública (413), para o cliente nunca poder distinguir
 * qual mecanismo disparou:
 *   (1) rejeição antecipada em resolveDownloadTarget(), a partir de
 *       record.sizeBytes — antes de qualquer streaming HTTP;
 *   (2) o SizeGuardTransform (storage/size-guard.js) a meio da gravação
 *       provider -> storage, em DownloadCoordinator.ensureStored() —
 *       cobre um sizeBytes declarado pelo provider que seja incorreto
 *       ou ausente.
 * `status: 413` já cai dentro do intervalo 4xx válido que
 * error-handler.js aceita (400–499) — não foi preciso alterar o
 * mapeamento em error-handler.js para isto ser reconhecido; é
 * reconhecido pela mesma verificação `instanceof DownloadError` que já
 * cobre DownloadNotFoundError.
 */
export class DownloadTooLargeError extends DownloadError {
  constructor(detail) {
    super(detail, { publicMessage: 'O ficheiro excede o tamanho máximo permitido.', status: 413 });
    this.name = 'DownloadTooLargeError';
  }
}

// Mesmo alfabeto/gama de tamanho que generateDownloadId() produz.
// Definido de forma independente do SAFE_KEY_PATTERN do local-storage.js
// — são a mesma forma por coincidência de propósito (um downloadId É a
// key de storage), mas validam coisas conceptualmente diferentes: isto
// valida "é um downloadId bem formado", aquilo valida "é seguro para um
// caminho de ficheiro". Fica como defesa em profundidade duplicada de
// propósito, não como duplicação acidental.
const DOWNLOAD_ID_FORMAT = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * @param {unknown} downloadId
 * @returns {boolean}
 */
export function isValidDownloadIdFormat(downloadId) {
  return typeof downloadId === 'string' && DOWNLOAD_ID_FORMAT.test(downloadId);
}

/**
 * Resolve um downloadId para {provider, formatId}, exclusivamente a
 * partir do registo interno — nunca de nada vindo do pedido HTTP além
 * do próprio downloadId. Não faz I/O (sem chamadas ao provider nem ao
 * storage); só decide se este downloadId pode continuar.
 *
 * @param {string} downloadId
 * @param {{
 *   downloadStore: DownloadStore,
 *   registry: import('../providers/registry.js').ProviderRegistry,
 *   maxDownloadSizeBytes?: number,
 * }} deps
 */
export function resolveDownloadTarget(
  downloadId,
  { downloadStore, registry, maxDownloadSizeBytes = DEFAULT_MAX_DOWNLOAD_SIZE_BYTES }
) {
  if (!isValidDownloadIdFormat(downloadId)) {
    throw new DownloadError(`downloadId com formato inválido: "${downloadId}".`, {
      publicMessage: 'downloadId inválido.',
      status: 400,
    });
  }

  // O claim acontece AQUI, não uma simples leitura: é isto que impede
  // dois pedidos concorrentes ao MESMO downloadId de ambos passarem por
  // este ponto (Etapa 6.3.1 — ver DownloadStore.claim). Antes desta
  // etapa isto era um `get()` + verificação de `consumed`, com uma
  // janela de corrida entre os dois: dois pedidos podiam ambos ler
  // "ainda não consumido" antes de qualquer um dos dois marcar o outro,
  // e ambos acabavam por completar o download do mesmo recurso.
  const claimResult = downloadStore.claim(downloadId);
  if (!claimResult.claimed) {
    // Mesma resposta pública quer o registo nunca tenha existido, tenha
    // expirado, já esteja a ser consumido por outro pedido concorrente
    // neste preciso momento, ou já tenha sido consumido — ver o
    // comentário em DownloadNotFoundError. Não distinguimos "já em uso"
    // de "já usado" de propósito, pela mesma razão de não dar pistas a
    // quem estiver a sondar o endpoint.
    throw new DownloadNotFoundError(
      `downloadId indisponível (inexistente/expirado/em consumo/consumido): "${downloadId}".`
    );
  }

  const { record } = claimResult;

  // Etapa 6.4 — Size Guard, rejeição antecipada: se o sizeBytes
  // declarado pelo provider no /resolve já é conhecido (não-null — ver
  // DownloadStore.create) e excede o limite, nem vale a pena resolver o
  // provider nem gastar uma vaga de concorrência para um pedido que já
  // sabemos que vai ser recusado. `record.sizeBytes === null` (registo
  // criado sem esse valor) não é tratado como "excede o limite" — é
  // "desconhecido"; nesse caso a única defesa possível é o
  // SizeGuardTransform durante a gravação real (ver
  // DownloadCoordinator.ensureStored, mais abaixo neste ficheiro).
  if (record.sizeBytes !== null && record.sizeBytes > maxDownloadSizeBytes) {
    // Já reivindicámos o downloadId acima (claim) — sem libertar aqui,
    // ficava preso em CONSUMING para sempre, exatamente pela mesma razão
    // já documentada abaixo para o caso "provider já não existe".
    downloadStore.release(downloadId);
    throw new DownloadTooLargeError(
      `Download "${downloadId}" tem sizeBytes=${record.sizeBytes}, acima do limite de ${maxDownloadSizeBytes} bytes.`
    );
  }

  const provider = registry.getById(record.providerId);
  if (!provider) {
    // Nunca devia acontecer em operação normal: um registo válido a
    // apontar para um provider que já não existe é uma inconsistência
    // interna, não algo que o cliente possa ter causado. Mas já
    // reivindicámos o downloadId acima — se não o libertarmos aqui,
    // fica preso em CONSUMING para sempre, e nenhuma tentativa futura
    // (nem depois de o provider ser corrigido) o conseguia voltar a
    // reivindicar.
    downloadStore.release(downloadId);
    throw new DownloadError(`Provider "${record.providerId}" referenciado pelo registo já não existe.`);
  }

  return { downloadId, provider, formatId: record.formatId };
}

function isReadableStreamLike(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.pipe === 'function' &&
    typeof value.on === 'function'
  );
}

/**
 * Nunca confia cegamente no que um provider devolve de
 * getDownloadStream() — um provider mal implementado (ou um futuro
 * provider externo com um bug) não pode produzir um valor que quebre o
 * controller mais abaixo.
 */
function assertValidProviderStreamResult(result, { providerId } = {}) {
  if (!result || typeof result !== 'object' || !isReadableStreamLike(result.stream)) {
    throw new DownloadError(
      `Provider "${providerId ?? 'desconhecido'}" devolveu um stream inválido de getDownloadStream().`
    );
  }
  if (result.contentType !== undefined && result.contentType !== null && typeof result.contentType !== 'string') {
    throw new DownloadError(
      `Provider "${providerId ?? 'desconhecido'}" devolveu um contentType inválido de getDownloadStream().`
    );
  }
}

/**
 * Coordena, por downloadId, a operação "obter do provider + gravar no
 * storage" — pedidos concorrentes para o MESMO downloadId partilham a
 * mesma promise em vez de duplicar o trabalho (e, no caso de um
 * provider real, o pedido de rede). A verificação-e-registo na map é
 * síncrona (sem `await` pelo meio), para não haver janela de corrida
 * entre dois pedidos a chegar ao mesmo tempo — o mesmo princípio já
 * usado na fixação de DNS da Etapa 2.
 */
export class DownloadCoordinator {
  constructor() {
    this.inFlight = new Map(); // downloadId -> Promise<{ contentType: string|null }>
    // Guarda o contentType devolvido pelo provider da PRIMEIRA vez que um
    // downloadId é preparado. Sem isto, uma chamada a ensureStored()
    // depois de a primeira já ter terminado (quando o `storage.exists()`
    // mais abaixo evita chamar o provider outra vez) perdia sempre o
    // contentType original e caía no `null` genérico — bug identificado
    // na auditoria da Etapa 6.3. Fica válido enquanto o ficheiro existir
    // em storage; é removido junto com ele por quem o apaga — ver
    // forgetContentType(), chamado pelo controller depois de um consumo
    // com sucesso, e pelo onExpire do DownloadStore (app.js) quando
    // expira sem nunca ter sido consumido.
    this.contentTypes = new Map(); // downloadId -> string|null
  }

  /**
   * @param {{
   *   downloadId: string,
   *   provider: import('../providers/provider.interface.js').VideoProvider,
   *   formatId: string,
   *   storage: import('../storage/storage.interface.js').TempStorage,
   *   maxDownloadSizeBytes?: number,
   * }} params
   * @returns {Promise<{ contentType: string|null }>}
   */
  ensureStored({ downloadId, provider, formatId, storage, maxDownloadSizeBytes = DEFAULT_MAX_DOWNLOAD_SIZE_BYTES }) {
    let savePromise = this.inFlight.get(downloadId);

    if (!savePromise) {
      savePromise = (async () => {
        if (await storage.exists(downloadId)) {
          // Já gravado por um pedido anterior, já terminado (não um
          // concorrente) — devolve o contentType guardado nessa altura,
          // em vez do `null` genérico de antes desta etapa.
          return { contentType: this.contentTypes.get(downloadId) ?? null };
        }

        const result = await provider.getDownloadStream(formatId);
        assertValidProviderStreamResult(result, { providerId: provider.id });

        // Etapa 6.4 — Size Guard, defesa durante a gravação real:
        // fluxo provider -> SizeGuardTransform -> storage.save() -> .tmp
        // -> rename(). Corre SEMPRE aqui, independentemente de
        // record.sizeBytes já ter passado (ou não ter sequer existido)
        // na rejeição antecipada de resolveDownloadTarget() — é a única
        // das duas defesas que não pode ser enganada por um valor
        // declarado incorreto ou ausente, porque conta os bytes REAIS
        // que o provider está a enviar. local-storage.js já apaga o
        // .tmp para qualquer erro do pipeline, incluindo este.
        const sizeGuard = createSizeGuardTransform(maxDownloadSizeBytes);
        try {
          await storage.save(downloadId, result.stream, { transforms: [sizeGuard] });
        } catch (err) {
          if (isSizeGuardExceededError(err)) {
            throw new DownloadTooLargeError(
              `Download para key "${downloadId}" (provider "${provider.id}") excedeu ${maxDownloadSizeBytes} bytes durante a gravação.`
            );
          }
          throw err;
        }

        const contentType = result.contentType ?? null;
        this.contentTypes.set(downloadId, contentType);
        return { contentType };
      })();

      this.inFlight.set(downloadId, savePromise);
      // Limpa a entrada quer a promise resolva quer rejeite — nunca fica
      // uma promise órfã na map depois de terminar. O `.catch(() => {})`
      // aqui é só para não gerar um unhandledRejection nesta cadeia de
      // bookkeeping interna — o erro real continua a propagar-se
      // normalmente para quem chamar `await coordinator.ensureStored(...)`,
      // através da `savePromise` devolvida abaixo.
      savePromise.finally(() => this.inFlight.delete(downloadId)).catch(() => {});
    }

    return savePromise;
  }

  /**
   * Remove o contentType em cache para um downloadId. Tem de ser chamado
   * sempre que o ficheiro correspondente for apagado — depois de um
   * consumo com sucesso, ou quando expira sem nunca ter sido consumido
   * — para a cache não crescer indefinidamente ao longo da vida do
   * processo. Não faz nada (nem lança) se não houver nada em cache para
   * este downloadId.
   */
  forgetContentType(downloadId) {
    this.contentTypes.delete(downloadId);
  }

  get inFlightCount() {
    return this.inFlight.size;
  }
}
