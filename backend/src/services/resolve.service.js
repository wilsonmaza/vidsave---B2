import { validateUrlSyntax, SecurityValidationError } from '../security/url-validator.js';
import { assertSafeHostname, createLookupWithOverrides } from '../security/ssrf-guard.js';
import { assertValidResolvedMedia } from '../providers/provider.interface.js';

/**
 * "sample.test" é reservado pela IANA (RFC 2606) especificamente para
 * documentação e testes — nunca tem DNS real, de propósito. O demo
 * provider usa este domínio exatamente por isso: não há forma de ser
 * confundido com uma plataforma real.
 *
 * Sem este override, o SSRF Guard tentaria uma resolução de DNS real
 * para "sample.test" e falharia (o domínio não existe em DNS real),
 * quebrando o demo provider por uma razão que nada tem a ver com
 * segurança. Com o override, o Guard continua a correr por completo —
 * o endereço "resolvido" ainda passa pelo mesmo bloqueio de IP — só que
 * sem precisar de tocar na rede real. Qualquer outro hostname continua a
 * ir para a resolução de DNS real (ver `createLookupWithOverrides`).
 */
const KNOWN_TEST_HOSTS = {
  'sample.test': [{ address: '93.184.216.34', family: 4 }],
};

/**
 * Extrai e valida o campo `url` do corpo do pedido. Não aceita nada além
 * de um objeto plano com uma propriedade `url` que seja uma string não
 * vazia — arrays, números, objetos aninhados no lugar de `url`, e corpos
 * que não sejam objetos são todos rejeitados aqui.
 */
function extractUrlFromBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new SecurityValidationError('Corpo do pedido tem de ser um objeto JSON.');
  }

  const { url } = body;
  if (typeof url !== 'string') {
    throw new SecurityValidationError('"url" é obrigatório e tem de ser uma string.');
  }

  if (url.trim() === '') {
    throw new SecurityValidationError('"url" não pode estar vazio.');
  }

  return url;
}

/**
 * O pipeline de resolução completo. Qualquer falha em qualquer etapa
 * lança antes de chegar à seguinte — em particular, nenhum provider é
 * chamado antes da sintaxe e do SSRF Guard passarem, e os downloadIds só
 * são criados depois de tudo o resto ter passado (ver Regra 3 da Etapa 6).
 *
 * @param {unknown} body - o corpo do pedido, ainda por validar
 * @param {{
 *   registry: import('../providers/registry.js').ProviderRegistry,
 *   downloadStore: import('./download.service.js').DownloadStore,
 *   lookup?: Function,
 *   isHostAllowed?: (hostname: string) => boolean,
 * }} deps
 * @returns {Promise<{ title: string, thumbnail: string|null, duration: number|null, formats: Array<{ downloadId: string, quality: string, format: string, sizeBytes: number }> }>}
 */
export async function resolveUrl(
  body,
  { registry, downloadStore, lookup = createLookupWithOverrides(KNOWN_TEST_HOSTS), isHostAllowed }
) {
  const rawUrl = extractUrlFromBody(body);

  // Sintaxe + protocolo (reaproveita a Etapa 2, não reimplementa nada).
  const parsed = validateUrlSyntax(rawUrl);

  // Allowlist (B2) — opcional, tal como safeFetch() já trata isHostAllowed
  // (ver ssrf-guard.js: "o ssrf-guard não conhece a allowlist do VidSave").
  // Decide quais hosts podem sequer tentar um provider, antes de qualquer
  // pedido de DNS/rede — mais barato que assertSafeHostname, por isso
  // corre primeiro. Quem constrói o pipeline real é que decide se (e com
  // que allowlist) isto é ativado (ver server.js).
  if (isHostAllowed && !isHostAllowed(parsed.hostname)) {
    throw new SecurityValidationError(`Domínio não permitido: "${parsed.hostname}".`);
  }

  // SSRF Guard (reaproveita a Etapa 2). Só a verificação de IP — não faz
  // um pedido HTTP real, porque ainda nem sabemos qual provider (se
  // algum) vai tratar este URL.
  await assertSafeHostname(parsed.hostname, { lookup });

  // Só depois de tudo acima passar é que o registry (Etapa 4) entra.
  const provider = registry.findForUrl(rawUrl);

  const media = await provider.resolve(rawUrl);

  // Nunca confiar que o provider respeitou o contrato só porque passou
  // em assertValidProvider (isso só verifica que os métodos existem, não
  // que o resultado de resolve() tem a forma certa). Um provider mal
  // implementado nunca deve conseguir devolver dados arbitrários ao
  // cliente nem partir o controller a meio.
  assertValidResolvedMedia(media, { providerId: provider.id });

  // Etapa 6.2: cada formato ganha um downloadId opaco, criado só agora —
  // depois de todas as validações de segurança, exatamente como pedido.
  // O formatId real nunca sai daqui: fica só no registo interno do
  // DownloadStore, associado ao providerId. O cliente nunca vê nem
  // envia nenhum dos dois — só o downloadId.
  const formats = media.formats.map((format) => {
    // Etapa 6.4 — Size Guard: o sizeBytes já validado por
    // assertValidResolvedMedia() (número finito >= 0, linha 81 acima)
    // fica guardado no registo, para permitir rejeição antecipada em
    // resolveDownloadTarget() no momento do download — antes desta
    // etapa, este valor só ia para a resposta pública e morria aí.
    const record = downloadStore.create({
      providerId: provider.id,
      formatId: format.formatId,
      sizeBytes: format.sizeBytes,
    });
    return {
      downloadId: record.downloadId,
      quality: format.quality,
      format: format.format,
      sizeBytes: format.sizeBytes,
    };
  });

  return { ...media, formats };
}
