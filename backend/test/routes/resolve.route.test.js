import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/app.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { ProviderError } from '../../src/providers/provider.interface.js';
import { MemoryRateLimiter } from '../../src/security/rate-limiter.js';
import { createProviderRegistry } from '../../src/providers/bootstrap.js';

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

function brokenProviderRegistry({ error } = {}) {
  const registry = new ProviderRegistry();
  registry.register({
    id: 'broken',
    canHandle: () => true,
    resolve: async () => {
      throw error ?? new ProviderError('falha simulada no provider', { publicMessage: 'Falha no provider.' });
    },
    getDownloadStream: async () => ({ stream: null }),
  });
  return registry;
}

// --- Sucesso ---

test('POST /api/resolve com o URL de demonstração devolve 200 e metadata correta', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://sample.test/demo/video-1' }),
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.title, 'VidSave — vídeo de demonstração 1');
    assert.equal(Array.isArray(body.data.formats), true);
    assert.equal(body.data.formats.length, 2);
    for (const format of body.data.formats) {
      assert.equal(typeof format.downloadId, 'string');
      assert.equal(typeof format.sizeBytes, 'number');
      assert.equal(format.formatId, undefined, 'formatId nunca deve aparecer na resposta pública');
    }
    assert.notEqual(
      body.data.formats[0].downloadId,
      body.data.formats[1].downloadId,
      'cada formato tem de ter o seu próprio downloadId'
    );
  } finally {
    await close();
  }
});

test('campos providerId/formatId enviados pelo cliente são ignorados', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://sample.test/demo/video-1',
        providerId: 'provider-forjado',
        formatId: 'formato-forjado',
      }),
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.data.title, 'VidSave — vídeo de demonstração 1');
  } finally {
    await close();
  }
});

// --- Input ---

test('rejeita body vazio com 400', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test('rejeita JSON malformado com 400 e mensagem segura', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ isto não é json',
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.error, 'Corpo do pedido não é JSON válido.');
  } finally {
    await close();
  }
});

test('rejeita "url" ausente com 400', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: 'sem url aqui' }),
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test('rejeita protocolo proibido com 400', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'ftp://example.com/x' }),
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test('rejeita URL demasiado longo com 400', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://example.com/' + 'a'.repeat(3000) }),
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

// --- Segurança ---

test('URL bloqueada pelo SSRF Guard devolve 400, sem detalhes internos no corpo', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://localhost:1234/x' }),
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(JSON.stringify(body).includes('localhost'), false);
  } finally {
    await close();
  }
});

test('provider não compatível devolve 404', async () => {
  // IP literal público: não passa por DNS real, não é bloqueado pelo
  // SSRF Guard, mas não corresponde a nenhum provider registado.
  const { baseUrl, close } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://93.184.216.34/nao-suportado' }),
    });
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test('provider desativado é tratado como inexistente (404)', async () => {
  const registry = createProviderRegistry({ demoProviderEnabled: false });
  const { baseUrl, close } = await startTestServer({ registry });
  try {
    const res = await fetch(`${baseUrl}/api/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://sample.test/demo/video-1' }),
    });
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

// --- Rate limiting ---

test('respeita o limite de pedidos e devolve 429 com Retry-After', async () => {
  const resolveRateLimiter = new MemoryRateLimiter({ windowMs: 60000, maxRequests: 2 });
  const { baseUrl, close } = await startTestServer({ resolveRateLimiter });
  try {
    const request = () => fetch(`${baseUrl}/api/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://sample.test/demo/video-1' }),
    });

    const first = await request();
    const second = await request();
    const third = await request();

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 429);

    const body = await third.json();
    assert.equal(body.error, 'Too many requests.');
    assert.ok(third.headers.get('retry-after'));
  } finally {
    resolveRateLimiter.stop();
    await close();
  }
});

// --- Erros ---

test('erro do provider devolve 500 com mensagem genérica, sem stack trace', async () => {
  const registry = brokenProviderRegistry();
  const { baseUrl, close } = await startTestServer({ registry });
  try {
    const res = await fetch(`${baseUrl}/api/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://qualquer.exemplo.com/x' }),
    });
    const body = await res.json();

    assert.equal(res.status, 500);
    assert.equal(body.error, 'Algo correu mal. Tenta novamente.');
    assert.equal(JSON.stringify(body).toLowerCase().includes('at '), false); // sem cheiro a stack trace
  } finally {
    await close();
  }
});

test('erro inesperado (não é um ProviderError) também devolve 500 seguro', async () => {
  const registry = brokenProviderRegistry({ error: new Error('algo rebentou de forma inesperada') });
  const { baseUrl, close } = await startTestServer({ registry });
  try {
    const res = await fetch(`${baseUrl}/api/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://qualquer.exemplo.com/x' }),
    });
    const body = await res.json();

    assert.equal(res.status, 500);
    assert.equal(body.error, 'Algo correu mal. Tenta novamente.');
    assert.equal(JSON.stringify(body).includes('algo rebentou'), false);
  } finally {
    await close();
  }
});

// --- Etapa 5.1: auditoria ---

test('ProviderError com status inválido/corrompido nunca é confiado — devolve 500 genérico', async () => {
  const registry = brokenProviderRegistry({
    error: new ProviderError('status corrompido de propósito', { publicMessage: 'não devia aparecer', status: 999 }),
  });
  const { baseUrl, close } = await startTestServer({ registry });
  try {
    const res = await fetch(`${baseUrl}/api/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://qualquer.exemplo.com/x' }),
    });
    const body = await res.json();

    assert.equal(res.status, 500);
    assert.equal(body.error, 'Algo correu mal. Tenta novamente.');
    assert.equal(JSON.stringify(body).includes('não devia aparecer'), false);
  } finally {
    await close();
  }
});

test('provider que devolve metadata inválida resulta em 500 seguro, não 200 com lixo', async () => {
  const registry = new ProviderRegistry();
  registry.register({
    id: 'mal-comportado',
    canHandle: () => true,
    resolve: async () => ({ formats: 'isto devia ser um array' }), // sem título, formats errado
    getDownloadStream: async () => ({ stream: null }),
  });
  const { baseUrl, close } = await startTestServer({ registry });
  try {
    const res = await fetch(`${baseUrl}/api/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://qualquer.exemplo.com/x' }),
    });
    const body = await res.json();

    assert.equal(res.status, 500);
    assert.equal(body.success, undefined); // nunca deve parecer um sucesso
    assert.equal(body.error, 'Algo correu mal. Tenta novamente.');
  } finally {
    await close();
  }
});

test('pedidos que falham na validação ainda consomem o limite de rate limit', async () => {
  const resolveRateLimiter = new MemoryRateLimiter({ windowMs: 60000, maxRequests: 2 });
  const { baseUrl, close } = await startTestServer({ resolveRateLimiter });
  try {
    const invalidRequest = () => fetch(`${baseUrl}/api/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}), // url ausente -> 400
    });

    const first = await invalidRequest(); // consome 1/2
    const second = await invalidRequest(); // consome 2/2
    const third = await invalidRequest(); // devia ser 429, não 400

    assert.equal(first.status, 400);
    assert.equal(second.status, 400);
    assert.equal(third.status, 429, 'pedidos inválidos têm de contar para o rate limit, senão dá para o contornar');
  } finally {
    resolveRateLimiter.stop();
    await close();
  }
});

test('nenhuma resposta de erro contém detalhes internos (varredura ampla)', async () => {
  const brokenRegistry = brokenProviderRegistry({ error: new Error('detalhe interno sensível XYZ') });
  const scenarios = [
    { name: 'body vazio', app: {}, body: {} },
    { name: 'protocolo proibido', app: {}, body: { url: 'ftp://exemplo.com/x' } },
    { name: 'SSRF bloqueado', app: {}, body: { url: 'http://127.0.0.1/x' } },
    { name: 'provider inexistente', app: {}, body: { url: 'http://93.184.216.34/x' } },
    { name: 'erro interno do provider', app: { registry: brokenRegistry }, body: { url: 'https://qualquer.exemplo.com/x' } },
  ];

  const forbiddenSnippets = [
    'at Object.', 'at async', '.js:', '/home/', '/backend/src/', 'node_modules',
    'detalhe interno sensível XYZ', 'SecurityValidationError', 'ProviderError', 'TypeError',
  ];

  for (const scenario of scenarios) {
    const { baseUrl, close } = await startTestServer(scenario.app);
    try {
      const res = await fetch(`${baseUrl}/api/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scenario.body),
      });
      const rawBody = await res.text();

      assert.notEqual(res.status, 200, `cenário "${scenario.name}" não devia ter tido sucesso`);
      for (const snippet of forbiddenSnippets) {
        assert.equal(
          rawBody.includes(snippet),
          false,
          `cenário "${scenario.name}" vazou um detalhe interno: "${snippet}" em ${rawBody}`
        );
      }
    } finally {
      await close();
    }
  }
});
