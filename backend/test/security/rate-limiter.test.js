import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRateLimiter, ConcurrencyLimiter, createRateLimitMiddleware } from '../../src/security/rate-limiter.js';

function makeClock(start = 0) {
  let current = start;
  return { nowFn: () => current, advance: (ms) => { current += ms; } };
}

// --- MemoryRateLimiter ---

test('permite pedidos dentro do limite', () => {
  const clock = makeClock();
  const limiter = new MemoryRateLimiter({ windowMs: 1000, maxRequests: 3, nowFn: clock.nowFn });

  assert.equal(limiter.consume('ip-a').allowed, true);
  assert.equal(limiter.consume('ip-a').allowed, true);
  assert.equal(limiter.consume('ip-a').allowed, true);
  limiter.stop();
});

test('bloqueia a partir do momento em que o limite é atingido', () => {
  const clock = makeClock();
  const limiter = new MemoryRateLimiter({ windowMs: 1000, maxRequests: 2, nowFn: clock.nowFn });

  assert.equal(limiter.consume('ip-a').allowed, true);
  assert.equal(limiter.consume('ip-a').allowed, true);
  const third = limiter.consume('ip-a');
  assert.equal(third.allowed, false);
  assert.ok(third.retryAfterMs > 0);
  limiter.stop();
});

test('uma nova janela liberta pedidos novamente', () => {
  const clock = makeClock();
  const limiter = new MemoryRateLimiter({ windowMs: 1000, maxRequests: 1, nowFn: clock.nowFn });

  assert.equal(limiter.consume('ip-a').allowed, true);
  assert.equal(limiter.consume('ip-a').allowed, false);

  clock.advance(1000); // janela seguinte

  assert.equal(limiter.consume('ip-a').allowed, true);
  limiter.stop();
});

test('IPs diferentes têm contadores independentes', () => {
  const clock = makeClock();
  const limiter = new MemoryRateLimiter({ windowMs: 1000, maxRequests: 1, nowFn: clock.nowFn });

  assert.equal(limiter.consume('ip-a').allowed, true);
  assert.equal(limiter.consume('ip-a').allowed, false);
  assert.equal(limiter.consume('ip-b').allowed, true); // não afetado pelo limite de ip-a
  limiter.stop();
});

test('cleanupExpired remove entradas cuja janela já passou', () => {
  const clock = makeClock();
  const limiter = new MemoryRateLimiter({ windowMs: 1000, maxRequests: 1, nowFn: clock.nowFn });

  limiter.consume('ip-a');
  limiter.consume('ip-b');
  assert.equal(limiter.size, 2);

  clock.advance(1000);
  limiter.cleanupExpired();

  assert.equal(limiter.size, 0);
  limiter.stop();
});

test('aceita configuração explícita de janela e limite (equivalente a vir do .env)', () => {
  const clock = makeClock();
  const limiter = new MemoryRateLimiter({ windowMs: 60000, maxRequests: 15, nowFn: clock.nowFn });

  for (let i = 0; i < 15; i += 1) {
    assert.equal(limiter.consume('ip-a').allowed, true, `pedido ${i + 1} devia ser permitido`);
  }
  assert.equal(limiter.consume('ip-a').allowed, false);
  limiter.stop();
});

// --- ConcurrencyLimiter ---

test('primeiro e segundo download são permitidos quando o limite é 2', () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 2 });

  assert.equal(limiter.tryAcquire('ip-a').acquired, true);
  assert.equal(limiter.tryAcquire('ip-a').acquired, true);
});

test('terceiro download é bloqueado quando o limite é 2', () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 2 });

  limiter.tryAcquire('ip-a');
  limiter.tryAcquire('ip-a');
  assert.equal(limiter.tryAcquire('ip-a').acquired, false);
});

test('o contador é libertado quando a operação termina com sucesso', () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1 });

  const first = limiter.tryAcquire('ip-a');
  assert.equal(first.acquired, true);
  assert.equal(limiter.tryAcquire('ip-a').acquired, false);

  first.release();

  assert.equal(limiter.tryAcquire('ip-a').acquired, true);
});

test('o contador é libertado mesmo quando a operação lança um erro (padrão try/finally)', async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1 });

  async function operacaoQueFalha() {
    const { acquired, release } = limiter.tryAcquire('ip-a');
    assert.equal(acquired, true);
    try {
      throw new Error('falha simulada');
    } finally {
      release();
    }
  }

  await assert.rejects(operacaoQueFalha, /falha simulada/);
  assert.equal(limiter.tryAcquire('ip-a').acquired, true, 'a vaga devia ter sido libertada apesar do erro');
});

// --- createRateLimitMiddleware ---

function makeRes() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    set(header, value) { this.headers[header] = value; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

test('middleware chama next() quando o pedido é permitido', () => {
  const clock = makeClock();
  const limiter = new MemoryRateLimiter({ windowMs: 1000, maxRequests: 5, nowFn: clock.nowFn });
  const middleware = createRateLimitMiddleware(limiter);

  let nextCalled = false;
  const req = { clientIp: '203.0.113.5' };
  middleware(req, makeRes(), () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  limiter.stop();
});

test('middleware devolve 429 em JSON, com Retry-After, sem detalhes internos', () => {
  const clock = makeClock();
  const limiter = new MemoryRateLimiter({ windowMs: 1000, maxRequests: 1, nowFn: clock.nowFn });
  const middleware = createRateLimitMiddleware(limiter);
  const req = { clientIp: '203.0.113.5' };

  middleware(req, makeRes(), () => {}); // consome a única vaga
  const res = makeRes();
  let nextCalled = false;

  middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 429);
  assert.deepEqual(res.body, { error: 'Too many requests.' });
  assert.ok(res.headers['Retry-After']);
  limiter.stop();
});
