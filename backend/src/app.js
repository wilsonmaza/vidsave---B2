import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import { healthRouter } from './routes/health.routes.js';
import { createResolveRouter } from './routes/resolve.routes.js';
import { createResolveController } from './controllers/resolve.controller.js';
import { createDownloadRouter } from './routes/download.routes.js';
import { createDownloadController } from './controllers/download.controller.js';
import { notFoundHandler, errorHandler } from './middleware/error-handler.js';
import { attachClientIp } from './security/client-ip.js';
import { MemoryRateLimiter, ConcurrencyLimiter, createRateLimitMiddleware } from './security/rate-limiter.js';
import { createProviderRegistry } from './providers/bootstrap.js';
import { DownloadStore, DownloadCoordinator } from './services/download.service.js';
import { createLocalStorage } from './storage/local-storage.js';
import { OrphanCleanupService } from './services/orphan-cleanup.service.js';

function jsonParseErrorHandler(err, req, res, next) {
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Corpo do pedido não é JSON válido.' });
    return;
  }
  next(err);
}

/**
 * As dependências têm valores por defeito prontos para produção, mas são
 * todas substituíveis — é o que permite aos testes usar um registry, um
 * rate limiter, um storage ou um download store de teste sem tocar em
 * configuração real, no filesystem real, ou em timers reais.
 */
export function createApp({
  registry = createProviderRegistry({ demoProviderEnabled: env.demoProviderEnabled }),
  // B2 — verificação antecipada em resolve.service.js, ANTES de saber
  // qual provider (se algum) trataria o pedido. Opcional, default
  // undefined (desligado), tal como safeFetch() já trata isHostAllowed
  // — preserva todos os testes que constroem a app sem o passar (ver
  // resolve.route.test.js, que usa hosts fictícios como
  // "qualquer.exemplo.com" para testar o pipeline genérico, sem
  // depender de nenhuma allowlist). Quem liga isto a sério para
  // produção é server.js, explicitamente. Note: o próprio
  // archive-org-provider (dentro do `registry` acima) já usa a
  // allowlist REAL por omissão, independentemente disto — este
  // parâmetro é só a camada de rejeição antecipada, não a única defesa.
  isHostAllowed,
  // Função de DNS usada pelo SSRF Guard em /api/resolve. Só os testes a
  // passam (para não dependerem de DNS real); em produção fica undefined
  // e é usado o DNS real.
  lookup,
  resolveRateLimiter = new MemoryRateLimiter({
    windowMs: env.rateLimit.windowMs,
    maxRequests: env.resolveRateLimitMax,
  }),
  // I2 — instância própria (mesma classe MemoryRateLimiter, mesmo
  // createRateLimitMiddleware já usados para /api/resolve): buckets
  // independentes por endpoint, não um segundo sistema de rate limiting.
  downloadRateLimiter = new MemoryRateLimiter({
    windowMs: env.rateLimit.windowMs,
    maxRequests: env.downloadRateLimitMax,
  }),
  storage = createLocalStorage(),
  // Definido antes de downloadStore para que o onExpire abaixo o possa
  // referenciar (defaults num destructuring podem referir bindings já
  // declarados mais acima no mesmo padrão — mesmo princípio já usado
  // para `storage` aqui em baixo).
  downloadCoordinator = new DownloadCoordinator(),
  downloadStore = new DownloadStore({
    ttlMs: env.downloadTtlMs,
    // Reutiliza o timer de expiração já existente para também limpar o
    // ficheiro físico — sem isto, um registo que expira sem nunca ter
    // sido consumido deixava o ficheiro para trás indefinidamente. A
    // partir da Etapa 6.3.1 também esquece o contentType em cache no
    // coordinator (ver DownloadCoordinator.forgetContentType) pela mesma
    // razão: sem isto a cache cresceria indefinidamente para downloadIds
    // nunca consumidos.
    onExpire: (record) => {
      storage.delete(record.downloadId).catch((err) => {
        console.error('[download] falha ao limpar ficheiro expirado', err);
      });
      downloadCoordinator.forgetContentType(record.downloadId);
    },
  }),
  downloadConcurrencyLimiter = new ConcurrencyLimiter({ maxConcurrent: env.downloadMaxConcurrentPerIp }),
  // Size Guard — limite máximo de bytes aceite por download, usado tanto
  // na rejeição antecipada (resolveDownloadTarget, via record.sizeBytes)
  // como no SizeGuardTransform aplicado durante a gravação real
  // (DownloadCoordinator.ensureStored). Os testes podem injetar um valor
  // baixo para exercitar os dois caminhos sem precisar de ficheiros
  // grandes a sério.
  maxDownloadSizeBytes = env.downloadMaxSizeBytes,
  // Etapa 6.4 — serviço de limpeza de órfãos. Se não for passado, cria um novo
  // com a configuração de env. Os testes podem injetar um disabled ou customizado.
  orphanCleanupService = null,
} = {}) {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.corsOrigin }));
  app.use(express.json({ limit: '10kb' }));
  app.use(jsonParseErrorHandler);
  app.use(attachClientIp({ trustProxy: env.trustProxy }));

  app.use('/api', healthRouter);

  const resolveController = createResolveController({ registry, downloadStore, isHostAllowed, lookup });
  const resolveRouter = createResolveRouter({
    controller: resolveController,
    rateLimitMiddleware: createRateLimitMiddleware(resolveRateLimiter),
  });
  app.use('/api', resolveRouter);

  const downloadController = createDownloadController({
    registry,
    downloadStore,
    storage,
    downloadCoordinator,
    concurrencyLimiter: downloadConcurrencyLimiter,
    maxDownloadSizeBytes,
  });
  const downloadRouter = createDownloadRouter({
    controller: downloadController,
    rateLimitMiddleware: createRateLimitMiddleware(downloadRateLimiter),
  });
  app.use('/api', downloadRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  // Etapa 6.4 — Reconciliação e cleanup de ficheiros órfãos.
  const cleanup = orphanCleanupService || new OrphanCleanupService({
    storage,
    downloadStore,
    enabled: env.orphanCleanup.enabled,
    intervalMs: env.orphanCleanup.intervalMs,
    maxRetries: env.orphanCleanup.maxRetries,
    retryDelayMs: env.orphanCleanup.retryDelayMs,
  });
  app.orphanCleanup = cleanup;

  return app;
}
