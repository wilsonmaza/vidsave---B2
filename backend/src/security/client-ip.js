import net from 'node:net';

function normalizeIp(rawIp) {
  if (typeof rawIp !== 'string') return null;
  const trimmed = rawIp.trim();
  // Sockets IPv4 por vezes chegam mapeados em IPv6 (::ffff:1.2.3.4).
  const unwrapped = trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
  return net.isIP(unwrapped) === 0 ? null : unwrapped;
}

/**
 * Devolve o IP do cliente de forma segura.
 *
 * Por defeito (`trustProxy: false`), usa sempre `req.socket.remoteAddress`
 * — a única fonte que um cliente não consegue falsificar — e ignora
 * completamente o `X-Forwarded-For`, mesmo que esteja presente.
 *
 * Com `trustProxy: true`, assume exatamente UM proxy confiável
 * imediatamente à frente da app (o caso comum de um único load balancer,
 * como o que a Render/Railway/Fly.io colocam à frente da aplicação) e usa
 * o ÚLTIMO valor do `X-Forwarded-For` — o único que esse proxy pode ter
 * adicionado ele próprio. Não resolve cadeias com mais do que um proxy;
 * isso precisaria de contar hops com uma topologia real para testar, que
 * ainda não existe.
 *
 * @param {{ socket?: { remoteAddress?: string }, headers?: Record<string, string | string[]> }} req
 * @param {{ trustProxy?: boolean }} [options]
 * @returns {string | null}
 */
export function getClientIp(req, { trustProxy = false } = {}) {
  const socketIp = normalizeIp(req?.socket?.remoteAddress);

  if (!trustProxy) {
    return socketIp;
  }

  const header = req?.headers?.['x-forwarded-for'];
  if (!header) {
    return socketIp;
  }

  const rawValue = Array.isArray(header) ? header.join(',') : header;
  const parts = rawValue.split(',').map((v) => v.trim()).filter(Boolean);
  if (parts.length === 0) {
    return socketIp;
  }

  const candidate = normalizeIp(parts[parts.length - 1]);
  return candidate ?? socketIp;
}

/**
 * Middleware Express que resolve o IP uma vez (com a configuração de
 * `trustProxy` correta) e disponibiliza-o em `req.clientIp`, para que os
 * middlewares de rate limiting não precisem de conhecer essa configuração
 * cada um por si. Previsto para correr antes de qualquer rate limiter,
 * quando as rotas reais existirem (Etapa 5).
 */
export function attachClientIp({ trustProxy = false } = {}) {
  return function attachClientIpMiddleware(req, res, next) {
    req.clientIp = getClientIp(req, { trustProxy });
    next();
  };
}
