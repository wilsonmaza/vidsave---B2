import { resolveUrl } from '../services/resolve.service.js';

/**
 * Extrai só o hostname de um URL para logging seguro. Nunca regista o
 * path nem a query string, que podem conter tokens ou outros dados
 * sensíveis — e nunca regista o body inteiro.
 */
function safeHostnameForLog(rawUrl) {
  if (typeof rawUrl !== 'string') return '(sem url)';
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return '(url inválido)';
  }
}

/**
 * Fábrica do controller — recebe registry e downloadStore por injeção
 * (nunca importa um provider ou um store concreto diretamente), para que
 * os testes possam usar instâncias de teste sem tocar em configuração
 * real.
 */
export function createResolveController({ registry, downloadStore, isHostAllowed }) {
  return async function resolveController(req, res, next) {
    const host = safeHostnameForLog(req.body?.url);

    try {
      const media = await resolveUrl(req.body, { registry, downloadStore, isHostAllowed });
      console.log('[resolve]', { ip: req.clientIp, host, outcome: 'success' });
      res.status(200).json({ success: true, data: media });
    } catch (err) {
      console.log('[resolve]', { ip: req.clientIp, host, outcome: 'error', status: err.status || 500 });
      next(err); // o error-handler partilhado (Etapa 1) decide a resposta
    }
  };
}
