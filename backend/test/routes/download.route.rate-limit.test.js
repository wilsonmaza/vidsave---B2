import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/app.js';
import { MemoryRateLimiter } from '../../src/security/rate-limiter.js';
import { ProviderRegistry } from '../../src/providers/registry.js';

async function startTestServer(appOptions) {
  const app = createApp(appOptions);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// --- I2: /api/download/:downloadId agora tem rate limit próprio ---

test('GET /api/download respeita o seu próprio limite de pedidos e devolve 429 com Retry-After', async () => {
  // Mesma classe/infraestrutura já usada para /api/resolve
  // (MemoryRateLimiter + createRateLimitMiddleware) -- só uma instância
  // própria, com buckets independentes, injetada aqui com um limite
  // baixo para o teste ser rápido e determinístico.
  const downloadRateLimiter = new MemoryRateLimiter({ windowMs: 60000, maxRequests: 2 });
  const registry = new ProviderRegistry(); // vazio -> qualquer downloadId dá 404, sem tocar em provider/storage
  const { baseUrl, close } = await startTestServer({ downloadRateLimiter, registry });
  try {
    const request = () => fetch(`${baseUrl}/api/download/${'a'.repeat(32)}`);

    const first = await request();
    const second = await request();
    const third = await request();

    // Os dois primeiros ainda contam para o limite mesmo sendo 404
    // (downloadId inexistente) -- o rate limit corre antes do controller,
    // exatamente como já acontece em /api/resolve.
    assert.equal(first.status, 404);
    assert.equal(second.status, 404);
    assert.equal(third.status, 429);

    const body = await third.json();
    assert.equal(body.error, 'Too many requests.');
    assert.ok(third.headers.get('retry-after'));
  } finally {
    downloadRateLimiter.stop();
    await close();
  }
});

test('o rate limit de /api/download é independente do de /api/resolve (buckets separados, mesma infraestrutura)', async () => {
  const downloadRateLimiter = new MemoryRateLimiter({ windowMs: 60000, maxRequests: 1 });
  const { baseUrl, close } = await startTestServer({ downloadRateLimiter });
  try {
    const firstDownload = await fetch(`${baseUrl}/api/download/${'b'.repeat(32)}`);
    assert.equal(firstDownload.status, 404); // consome a única vaga do download

    const resolveRes = await fetch(`${baseUrl}/api/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://sample.test/demo/video-1' }),
    });
    // /api/resolve não pode ter sido afetado por o download ter esgotado
    // o SEU limite -- seriam dois sistemas partilhados se isto falhasse.
    assert.equal(resolveRes.status, 200);
  } finally {
    downloadRateLimiter.stop();
    await close();
  }
});

test('um download legítimo, bem dentro do limite, continua a funcionar normalmente (200) com o novo middleware', async () => {
  const downloadRateLimiter = new MemoryRateLimiter({ windowMs: 60000, maxRequests: 20 });
  const { baseUrl, close } = await startTestServer({ downloadRateLimiter });
  try {
    const resolveRes = await fetch(`${baseUrl}/api/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://sample.test/demo/video-1' }),
    });
    const { data } = await resolveRes.json();
    const downloadId = data.formats[0].downloadId;

    const downloadRes = await fetch(`${baseUrl}/api/download/${downloadId}`);
    assert.equal(downloadRes.status, 200, 'o rate limit novo não pode impedir um download legítimo dentro do limite');
    const body = await downloadRes.text();
    assert.match(body, /Item: video-1/);
  } finally {
    downloadRateLimiter.stop();
    await close();
  }
});
