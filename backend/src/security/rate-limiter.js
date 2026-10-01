/**
 * Contrato que qualquer implementação de rate limiter deve cumprir, para
 * que uma futura `RedisRateLimiter` possa substituir a `MemoryRateLimiter`
 * sem tocar em controllers, rotas, ou no middleware abaixo:
 *
 *   consume(key: string) => { allowed: boolean, remaining: number, retryAfterMs: number }
 */

/**
 * Rate limiter de janela fixa, em memória. Simples de propósito — não é
 * "sliding window" nem nada mais sofisticado, porque não há ainda tráfego
 * real para justificar essa complexidade.
 */
export class MemoryRateLimiter {
  constructor({ windowMs, maxRequests, nowFn = Date.now, cleanupIntervalMs } = {}) {
    if (!windowMs || !maxRequests) {
      throw new Error('MemoryRateLimiter requer windowMs e maxRequests.');
    }
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.nowFn = nowFn;
    this.buckets = new Map(); // key -> { count, windowStart }

    // A limpeza periódica evita que `buckets` cresça sem limite com IPs que
    // já não voltam a aparecer. `unref()` garante que este timer, sozinho,
    // nunca impede o processo de terminar — mais simples e mais robusto do
    // que depender de todos os chamadores lembrarem-se de chamar `stop()`.
    const interval = cleanupIntervalMs ?? windowMs;
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), interval);
    this.cleanupTimer.unref?.();
  }

  consume(key) {
    const now = this.nowFn();
    const bucket = this.buckets.get(key);

    if (!bucket || now - bucket.windowStart >= this.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return { allowed: true, remaining: this.maxRequests - 1, retryAfterMs: 0 };
    }

    if (bucket.count < this.maxRequests) {
      bucket.count += 1;
      return { allowed: true, remaining: this.maxRequests - bucket.count, retryAfterMs: 0 };
    }

    return { allowed: false, remaining: 0, retryAfterMs: this.windowMs - (now - bucket.windowStart) };
  }

  /** Remove entradas cuja janela já expirou. Chamado pelo timer periódico, mas exposto para testes/uso manual. */
  cleanupExpired() {
    const now = this.nowFn();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= this.windowMs) {
        this.buckets.delete(key);
      }
    }
  }

  reset(key) {
    this.buckets.delete(key);
  }

  get size() {
    return this.buckets.size;
  }

  /** Para uso explícito em testes/shutdown controlado; o `unref()` já torna isto opcional em produção. */
  stop() {
    clearInterval(this.cleanupTimer);
  }
}

/**
 * Semáforo simples por chave (tipicamente o IP), para limitar operações
 * concorrentes — como downloads simultâneos — em vez de pedidos por
 * janela de tempo. `tryAcquire` devolve uma função `release` que o
 * chamador deve invocar num `finally`, para libertar a vaga mesmo que a
 * operação falhe.
 */
export class ConcurrencyLimiter {
  constructor({ maxConcurrent }) {
    if (!maxConcurrent) {
      throw new Error('ConcurrencyLimiter requer maxConcurrent.');
    }
    this.maxConcurrent = maxConcurrent;
    this.counts = new Map(); // key -> contagem atual
  }

  tryAcquire(key) {
    const current = this.counts.get(key) ?? 0;
    if (current >= this.maxConcurrent) {
      return { acquired: false, release: () => {} };
    }

    this.counts.set(key, current + 1);
    let released = false;

    return {
      acquired: true,
      release: () => {
        if (released) return; // evita libertar duas vezes por engano
        released = true;
        const updated = (this.counts.get(key) ?? 1) - 1;
        if (updated <= 0) {
          this.counts.delete(key);
        } else {
          this.counts.set(key, updated);
        }
      },
    };
  }

  currentCount(key) {
    return this.counts.get(key) ?? 0;
  }
}

/**
 * Transforma um rate limiter (com o contrato `consume`) num middleware
 * Express. Ainda não é usado em nenhuma rota — /api/resolve e
 * /api/download ainda não existem — mas fica pronto para a Etapa 5.
 *
 * Uso previsto, quando o endpoint existir:
 *   app.post('/api/resolve', createRateLimitMiddleware(resolveLimiter), resolveController);
 */
export function createRateLimitMiddleware(limiter, {
  getKey = (req) => req.clientIp ?? 'unknown',
  message = 'Too many requests.',
} = {}) {
  return function rateLimitMiddleware(req, res, next) {
    const key = getKey(req);
    const { allowed, retryAfterMs } = limiter.consume(key);

    if (!allowed) {
      res.set('Retry-After', Math.ceil(retryAfterMs / 1000).toString());
      res.status(429).json({ error: message });
      return;
    }

    next();
  };
}
