import 'dotenv/config';

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Como toInt(), mas rejeita <= 0. 0 e negativos não são "inválidos" para
// toInt() (Number.isFinite(0) é true), mas são inválidos como limite de
// bytes: um limite <= 0 faria o SizeGuardTransform recusar-se logo a
// nascer (ver storage/size-guard.js), partindo TODOS os downloads com
// um 500 genérico — nunca o comportamento pretendido de "sem valor
// configurado (ou valor sem sentido) -> usa o fallback de 500 MB".
// Scoped só a downloadMaxSizeBytes; as outras chaves de env continuam a
// usar toInt() tal como antes.
function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Interpreta CORS_ORIGIN:
 *  - vazio, só espaços/vírgulas, ou contém '*'  -> '*' (qualquer origem; dev)
 *  - uma origem                                  -> string
 *  - várias, separadas por vírgula               -> array
 * Remove a barra final, porque o browser envia a origem SEM barra e o
 * cors() compara texto exato — "https://x.vercel.app/" nunca coincidiria.
 *
 * @param {string|undefined} value
 * @returns {string|string[]}
 */
export function parseCorsOrigin(value) {
  if (typeof value !== 'string') return '*';

  const origins = value
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => origin !== '');

  if (origins.length === 0 || origins.includes('*')) return '*';
  return origins.length === 1 ? origins[0] : origins;
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: toInt(process.env.PORT, 3000),
  // '*' só serve para dev local (frontend aberto via file:// ou noutra
  // porta). Em produção, define CORS_ORIGIN com o domínio do frontend
  // (uma origem, ou várias separadas por vírgula) — server.js avisa nos
  // logs se ficar em '*'.
  corsOrigin: parseCorsOrigin(process.env.CORS_ORIGIN),

  // Etapa 3 — rate limiting e controlo de abuso.
  // Só true quando existir exatamente um proxy confiável à frente da app
  // (ver security/client-ip.js) — nunca ativar sem essa infraestrutura.
  trustProxy: process.env.TRUST_PROXY === 'true',
  rateLimit: {
    windowMs: toInt(process.env.RATE_LIMIT_WINDOW_MS, 60000),
    maxRequests: toInt(process.env.RATE_LIMIT_MAX_REQUESTS, 15),
  },
  resolveRateLimitMax: toInt(process.env.RESOLVE_RATE_LIMIT_MAX, 10),
  // I2 — limite próprio para /api/download/:downloadId, partilhando a
  // mesma janela geral (rateLimit.windowMs). Downloads fazem I/O real
  // (Size Guard incluído), por isso um pouco mais generoso que o resolve
  // (que só devolve metadata) para não penalizar um utilizador legítimo
  // que tente descarregar vários formatos numa sessão.
  downloadRateLimitMax: toInt(process.env.DOWNLOAD_RATE_LIMIT_MAX, 20),
  downloadMaxConcurrentPerIp: toInt(process.env.DOWNLOAD_MAX_CONCURRENT_PER_IP, 2),

  // Etapa 4 — quais providers estão ativos. Cada novo provider real ganha
  // a sua própria flag aqui, não espalhada pelos controllers.
  demoProviderEnabled: process.env.DEMO_PROVIDER_ENABLED !== 'false',
  // B2 — mesmo padrão de feature flag do demo provider.
  archiveOrgProviderEnabled: process.env.ARCHIVE_ORG_PROVIDER_ENABLED !== 'false',

  // Etapa 6 — quanto tempo um downloadId (e, a partir da 6.3, o
  // ficheiro temporário associado) fica válido. 15 minutos por defeito.
  downloadTtlMs: toInt(process.env.DOWNLOAD_TTL_MS, 15 * 60 * 1000),

  // Size Guard — tamanho máximo aceite para um download, em bytes.
  // Usado em dois pontos distintos (ver services/download.service.js):
  // (1) rejeição antecipada, via record.sizeBytes, logo depois do claim
  // e antes de qualquer streaming HTTP; (2) SizeGuardTransform, que
  // conta os bytes reais durante a gravação provider -> storage — a
  // segunda defesa existe porque o primeiro valor vem de fora (declarado
  // pelo provider no /resolve) e não é, por si só, uma fonte fiável.
  // 500 MB por defeito.
  downloadMaxSizeBytes: toPositiveInt(process.env.DOWNLOAD_MAX_SIZE_BYTES, 500 * 1024 * 1024),

  // Etapa 6.4 — limpeza periódica de ficheiros órfãos. Compara o que está
  // em disco com o que o DownloadStore conhece; deleta ficheiros sem registo.
  orphanCleanup: {
    enabled: process.env.ORPHAN_CLEANUP_ENABLED !== 'false',
    intervalMs: toInt(process.env.ORPHAN_CLEANUP_INTERVAL_MS, 5 * 60 * 1000), // 5 minutos
    maxRetries: toInt(process.env.ORPHAN_CLEANUP_MAX_RETRIES, 3),
    retryDelayMs: toInt(process.env.ORPHAN_CLEANUP_RETRY_DELAY_MS, 1000),
  },
};

export const isProduction = env.nodeEnv === 'production';
