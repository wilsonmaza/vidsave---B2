import { pipeline } from 'node:stream/promises';
import { resolveDownloadTarget } from '../services/download.service.js';

// Grammar aproximada de um media type (RFC 6838) + parâmetros simples.
// Qualquer coisa fora disto (incluindo CR/LF, que este padrão já exclui
// por não os listar em nenhuma classe de caracteres) cai no fallback
// seguro — nunca copiamos o contentType do provider para o header sem
// esta validação.
const SAFE_CONTENT_TYPE = /^[\w.+-]+\/[\w.+-]+(;\s*[\w-]+=[\w".-]+)*$/;
const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

function sanitizeContentType(contentType) {
  if (typeof contentType === 'string' && SAFE_CONTENT_TYPE.test(contentType)) {
    return contentType;
  }
  return FALLBACK_CONTENT_TYPE;
}

/**
 * Fábrica do controller — todas as dependências são injetadas, incluindo
 * o storage e o coordenador de single-flight; nunca importa um provider
 * específico.
 */
export function createDownloadController({
  registry,
  downloadStore,
  storage,
  downloadCoordinator,
  concurrencyLimiter,
  // Etapa 6.4 — Size Guard. Usado em dois pontos: aqui, para rejeição
  // antecipada via record.sizeBytes (resolveDownloadTarget); e passado
  // adiante para downloadCoordinator.ensureStored(), para o
  // SizeGuardTransform durante a gravação real. Se omitido, cada função
  // usa o seu próprio valor por defeito (ver download.service.js) — o
  // mesmo de env.downloadMaxSizeBytes.
  maxDownloadSizeBytes,
}) {
  return async function downloadController(req, res, next) {
    const { downloadId } = req.params;
    const clientIp = req.clientIp ?? 'unknown';

    // Validação de formato + claim atómico (AVAILABLE -> CONSUMING) +
    // rejeição antecipada por tamanho (Etapa 6.4) + resolução do
    // provider acontecem ANTES de gastar uma vaga de concorrência — não
    // faz sentido reservar um recurso escasso para um pedido que já
    // sabemos que vai falhar. O claim, em particular, é o que garante
    // que só UM pedido consegue passar daqui para a frente para este
    // downloadId, mesmo com dois pedidos a chegar ao mesmo tempo (ver
    // resolveDownloadTarget / DownloadStore.claim — Etapa 6.3.1).
    let target;
    try {
      target = resolveDownloadTarget(downloadId, { downloadStore, registry, maxDownloadSizeBytes });
    } catch (err) {
      next(err);
      return;
    }

    // A partir daqui este downloadId está CONSUMING e é exclusivamente
    // nosso. QUALQUER saída a partir deste ponto que não termine em
    // sucesso tem de libertar o claim (downloadStore.release) para
    // permitir uma nova tentativa — centralizado no `finally` mais
    // abaixo através desta flag, para não haver nenhum caminho de saída
    // que se esqueça de libertar.
    let consumedSuccessfully = false;

    const { acquired, release: releaseConcurrencySlot } = concurrencyLimiter.tryAcquire(clientIp);
    if (!acquired) {
      downloadStore.release(target.downloadId);
      res.status(429).json({ error: 'Demasiados downloads simultâneos. Tenta novamente dentro de instantes.' });
      return;
    }

    // Deteta o cliente a desligar-se o mais cedo possível. Isto não
    // cancela tecnicamente uma operação já em curso — Node não dá uma
    // forma de interromper um `await` em progresso — mas permite: (a)
    // registar corretamente o motivo, e (b) evitar tentar escrever numa
    // resposta que já ninguém vai receber, se o abort acontecer antes de
    // começarmos a enviar dados.
    let clientClosedEarly = false;
    const onClientClose = () => {
      clientClosedEarly = true;
    };
    req.on('close', onClientClose);

    let outcome = 'error';

    try {
      const { contentType } = await downloadCoordinator.ensureStored({
        downloadId: target.downloadId,
        provider: target.provider,
        formatId: target.formatId,
        storage,
        maxDownloadSizeBytes,
      });

      if (clientClosedEarly) {
        // O cliente já desligou enquanto ainda estávamos a preparar o
        // ficheiro (ver limitação acima: não conseguimos cancelar essa
        // preparação em curso, só evitamos trabalho a mais depois dela).
        // Se outro pedido concorrente ao MESMO downloadId ainda estiver
        // à espera da mesma operação, essa gravação continua a ser útil
        // para ele — não a desfazemos por causa deste pedido específico.
        outcome = 'client-abort';
        return;
      }

      res.setHeader('Content-Type', sanitizeContentType(contentType));
      // Nome fixo e genérico, de propósito: nunca construído a partir de
      // nada fornecido pelo cliente nem de nada devolvido pelo provider,
      // por isso não há sequer superfície para injeção no header.
      res.setHeader('Content-Disposition', 'attachment; filename="vidsave-download"');

      await pipeline(storage.createReadStream(target.downloadId), res);

      // Só chega aqui se o streaming terminou com sucesso completo —
      // pipeline() só resolve nesse caso, e rejeita em qualquer falha ou
      // desconexão do cliente a meio.
      outcome = 'success';
      consumedSuccessfully = true;
      downloadStore.markConsumed(target.downloadId);
      await storage.delete(target.downloadId).catch((cleanupErr) => {
        console.error('[download] falha ao limpar ficheiro depois do consumo', cleanupErr);
      });
      downloadCoordinator.forgetContentType(target.downloadId);
    } catch (err) {
      const clientAborted =
        clientClosedEarly || req.destroyed || res.destroyed || err?.code === 'ERR_STREAM_PREMATURE_CLOSE';
      outcome = clientAborted ? 'client-abort' : 'error';

      if (res.headersSent) {
        // A resposta já começou a ser enviada — não há forma segura de
        // mudar o status HTTP a esta altura. Registamos o motivo e só
        // garantimos que a ligação não fica pendurada. `consumed` nunca
        // é marcado neste ramo.
        console.error('[download] falha depois de a resposta já ter começado', err);
        res.destroy();
      } else if (!clientAborted) {
        next(err);
      }
      // Se o cliente já se desligou e ainda não enviámos headers, não
      // vale a pena chamar next(err) — não há ninguém do outro lado para
      // receber uma resposta de erro.
    } finally {
      req.off('close', onClientClose);
      if (!consumedSuccessfully) {
        // Cobre TODOS os desfechos que não terminam em sucesso: erro do
        // provider/storage, abort do cliente (antes ou a meio do
        // streaming), falha a meio do pipeline. Sem isto, o downloadId
        // ficava preso em CONSUMING para sempre depois de qualquer falha
        // — nenhuma nova tentativa seria possível (Etapa 6.3.1).
        downloadStore.release(target.downloadId);
      }
      // Acontece sempre, em todos os desfechos possíveis (sucesso, erro,
      // abort do cliente) — nunca fica uma vaga presa.
      releaseConcurrencySlot();
      console.log('[download]', { ip: clientIp, downloadId: target.downloadId, outcome });
    }
  };
}
