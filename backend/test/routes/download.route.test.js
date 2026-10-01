import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createApp } from '../../src/app.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { ProviderError } from '../../src/providers/provider.interface.js';
import { DownloadStore, DownloadCoordinator, generateDownloadId } from '../../src/services/download.service.js';
import { ConcurrencyLimiter } from '../../src/security/rate-limiter.js';
import { createLocalStorage } from '../../src/storage/local-storage.js';
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

async function withTempStorage(run) {
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vidsave-download-route-test-'));
  try {
    await run(createLocalStorage({ baseDir }), baseDir);
  } finally {
    await fsp.rm(baseDir, { recursive: true, force: true });
  }
}

function textProvider(id, text, { delayMs = 0 } = {}) {
  let calls = 0;
  return {
    calls: () => calls,
    provider: {
      id,
      canHandle: () => true,
      resolve: async () => ({
        title: id,
        thumbnail: null,
        duration: null,
        formats: [{ formatId: 'f1', quality: 'sd', format: 'txt', sizeBytes: text.length }],
      }),
      async getDownloadStream(formatId) {
        calls += 1;
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        return { stream: Readable.from([Buffer.from(`${text}|formatId=${formatId}`)]), contentType: 'text/plain' };
      },
    },
  };
}

function makeClock(start = 0) {
  let current = start;
  return { nowFn: () => current, advance: (ms) => { current += ms; } };
}

async function buildTestApp({ registry, storage, downloadStore, downloadConcurrencyLimiter } = {}) {
  const resolvedRegistry = registry ?? createProviderRegistry({ demoProviderEnabled: true });
  return startTestServer({
    registry: resolvedRegistry,
    storage,
    downloadStore,
    downloadCoordinator: new DownloadCoordinator(),
    downloadConcurrencyLimiter,
  });
}

// --- downloadId: inválido / inexistente / expirado ---

test('GET /api/download com downloadId inválido devolve 400', async () => {
  await withTempStorage(async (storage) => {
    const { baseUrl, close } = await buildTestApp({ storage });
    try {
      const res = await fetch(`${baseUrl}/api/download/curto`);
      assert.equal(res.status, 400);
    } finally {
      await close();
    }
  });
});

test('GET /api/download com downloadId inexistente devolve 404', async () => {
  await withTempStorage(async (storage) => {
    const { baseUrl, close } = await buildTestApp({ storage });
    try {
      const res = await fetch(`${baseUrl}/api/download/${generateDownloadId()}`);
      assert.equal(res.status, 404);
    } finally {
      await close();
    }
  });
});

test('GET /api/download com downloadId expirado devolve 404', async () => {
  await withTempStorage(async (storage) => {
    const clock = makeClock();
    const registry = new ProviderRegistry();
    const { provider } = textProvider('demo', 'conteúdo');
    registry.register(provider);

    const downloadStore = new DownloadStore({ ttlMs: 1000, nowFn: clock.nowFn });
    const created = downloadStore.create({ providerId: 'demo', formatId: 'f1' });
    clock.advance(1000);

    const { baseUrl, close } = await buildTestApp({ registry, storage, downloadStore });
    try {
      const res = await fetch(`${baseUrl}/api/download/${created.downloadId}`);
      assert.equal(res.status, 404);
    } finally {
      await close();
      downloadStore.stop();
    }
  });
});

// --- Segurança: identificadores do cliente são ignorados ---

test('formatId/providerId/url na query string são completamente ignorados', async () => {
  await withTempStorage(async (storage) => {
    const registry = new ProviderRegistry();
    const { provider } = textProvider('demo', 'conteúdo-real');
    registry.register(provider);

    const downloadStore = new DownloadStore({ ttlMs: 60000 });
    const created = downloadStore.create({ providerId: 'demo', formatId: 'f1' });

    const { baseUrl, close } = await buildTestApp({ registry, storage, downloadStore });
    try {
      const res = await fetch(
        `${baseUrl}/api/download/${created.downloadId}?formatId=forjado&providerId=forjado&url=https://evil.example.com`
      );
      const body = await res.text();

      assert.equal(res.status, 200);
      assert.ok(body.startsWith('conteúdo-real'));
      assert.equal(body.includes('forjado'), false);
    } finally {
      await close();
      downloadStore.stop();
    }
  });
});

test('nenhum identificador interno (providerId/formatId) aparece numa resposta de erro', async () => {
  await withTempStorage(async (storage) => {
    const registry = new ProviderRegistry(); // vazio -> qualquer downloadId válido dá 404
    const { baseUrl, close } = await buildTestApp({ registry, storage });
    try {
      const res = await fetch(`${baseUrl}/api/download/${generateDownloadId()}`);
      const rawBody = await res.text();

      assert.equal(res.status, 404);
      for (const snippet of ['providerId', 'formatId', 'demo-provider', '/tmp/', 'backend/src', 'at Object.']) {
        assert.equal(rawBody.includes(snippet), false, `vazou "${snippet}": ${rawBody}`);
      }
    } finally {
      await close();
    }
  });
});

// --- Provider ---

test('o provider certo recebe o formatId interno correto (nunca nada vindo do pedido)', async () => {
  await withTempStorage(async (storage) => {
    const registry = new ProviderRegistry();
    const { provider } = textProvider('demo', 'x');
    registry.register(provider);

    const downloadStore = new DownloadStore({ ttlMs: 60000 });
    const created = downloadStore.create({ providerId: 'demo', formatId: 'formato-interno-xyz' });

    const { baseUrl, close } = await buildTestApp({ registry, storage, downloadStore });
    try {
      const res = await fetch(`${baseUrl}/api/download/${created.downloadId}?formatId=outro-completamente-diferente`);
      const body = await res.text();
      assert.ok(body.includes('formatId=formato-interno-xyz'));
    } finally {
      await close();
      downloadStore.stop();
    }
  });
});

test('provider interno referenciado pelo registo mas ausente do registry devolve 500 seguro', async () => {
  await withTempStorage(async (storage) => {
    const registry = new ProviderRegistry(); // "demo" nunca é registado
    const downloadStore = new DownloadStore({ ttlMs: 60000 });
    const created = downloadStore.create({ providerId: 'demo', formatId: 'f1' });

    const { baseUrl, close } = await buildTestApp({ registry, storage, downloadStore });
    try {
      const res = await fetch(`${baseUrl}/api/download/${created.downloadId}`);
      const body = await res.json();

      assert.equal(res.status, 500);
      assert.equal(body.error, 'Algo correu mal. Tenta novamente.');
    } finally {
      await close();
      downloadStore.stop();
    }
  });
});

test('erro do provider não deixa a vaga de concorrência presa', async () => {
  await withTempStorage(async (storage) => {
    const registry = new ProviderRegistry();
    registry.register({
      id: 'quebrado',
      canHandle: () => true,
      resolve: async () => ({}),
      getDownloadStream: async () => {
        throw new ProviderError('falha simulada', { publicMessage: 'Falha no provider.' });
      },
    });

    const downloadStore = new DownloadStore({ ttlMs: 60000 });
    const downloadConcurrencyLimiter = new ConcurrencyLimiter({ maxConcurrent: 1 });

    const { baseUrl, close } = await buildTestApp({ registry, storage, downloadStore, downloadConcurrencyLimiter });
    try {
      const first = downloadStore.create({ providerId: 'quebrado', formatId: 'f1' });
      const res1 = await fetch(`${baseUrl}/api/download/${first.downloadId}`);
      assert.equal(res1.status, 500);

      // Se a vaga tivesse ficado presa depois do erro, este segundo
      // pedido (limite=1) seria bloqueado com 429 em vez de chegar a
      // tentar (e falhar da mesma forma seguramente, não por excesso).
      const second = downloadStore.create({ providerId: 'quebrado', formatId: 'f1' });
      const res2 = await fetch(`${baseUrl}/api/download/${second.downloadId}`);
      assert.equal(res2.status, 500, 'a vaga tinha de ter sido libertada depois do erro anterior');
    } finally {
      await close();
      downloadStore.stop();
    }
  });
});

// --- Concorrência ---

test('duas leituras concorrentes ao MESMO downloadId: exatamente uma consome (200), a outra é rejeitada de imediato (404), e o provider só é chamado uma vez', async () => {
  await withTempStorage(async (storage) => {
    const registry = new ProviderRegistry();
    const { provider, calls } = textProvider('demo', 'conteúdo-único', { delayMs: 30 });
    registry.register(provider);

    const downloadStore = new DownloadStore({ ttlMs: 60000 });
    const created = downloadStore.create({ providerId: 'demo', formatId: 'f1' });

    const { baseUrl, close } = await buildTestApp({ registry, storage, downloadStore });
    try {
      const [res1, res2] = await Promise.all([
        fetch(`${baseUrl}/api/download/${created.downloadId}`),
        fetch(`${baseUrl}/api/download/${created.downloadId}`),
      ]);

      // Antes da Etapa 6.3.1, o single-flight só evitava chamar o
      // provider duas vezes — mas nada impedia os DOIS pedidos de
      // completarem o streaming e ambos receberem 200 para o mesmo
      // downloadId "de uso único". Com o claim atómico, exatamente um
      // dos dois pode consumir; o outro é recusado antes sequer de
      // chegar ao provider/storage.
      const statuses = [res1.status, res2.status].sort();
      assert.deepEqual(statuses, [200, 404], 'exatamente um dos dois pedidos concorrentes pode consumir o downloadId');
      assert.equal(calls(), 1, 'o provider só é chamado pela tentativa que conseguiu reclamar o downloadId');

      const winner = res1.status === 200 ? res1 : res2;
      const body = await winner.text();
      assert.ok(body.startsWith('conteúdo-único'));
    } finally {
      await close();
      downloadStore.stop();
    }
  });
});

test('dois downloadIds diferentes, pedidos em simultâneo, continuam totalmente independentes um do outro', async () => {
  await withTempStorage(async (storage) => {
    const registry = new ProviderRegistry();
    const { provider, calls } = textProvider('demo', 'conteúdo-independente');
    registry.register(provider);

    const downloadStore = new DownloadStore({ ttlMs: 60000 });
    const a = downloadStore.create({ providerId: 'demo', formatId: 'formato-a' });
    const b = downloadStore.create({ providerId: 'demo', formatId: 'formato-b' });

    const { baseUrl, close } = await buildTestApp({ registry, storage, downloadStore });
    try {
      const [resA, resB] = await Promise.all([
        fetch(`${baseUrl}/api/download/${a.downloadId}`),
        fetch(`${baseUrl}/api/download/${b.downloadId}`),
      ]);

      assert.equal(resA.status, 200, 'downloadId "a" tem de conseguir ser consumido independentemente de "b"');
      assert.equal(resB.status, 200, 'downloadId "b" tem de conseguir ser consumido independentemente de "a"');
      assert.equal(calls(), 2, 'cada downloadId aciona a sua própria chamada ao provider');
    } finally {
      await close();
      downloadStore.stop();
    }
  });
});

test('quando a primeira tentativa falha, um pedido concorrente ao mesmo downloadId recebe 404 (claim já indisponível); depois de ambos terminarem, uma nova tentativa consegue reclamar e ter sucesso', async () => {
  await withTempStorage(async (storage) => {
    const registry = new ProviderRegistry();
    let attempt = 0;
    registry.register({
      id: 'falha-na-primeira',
      canHandle: () => true,
      resolve: async () => ({}),
      async getDownloadStream() {
        attempt += 1;
        const isFirstAttempt = attempt === 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (isFirstAttempt) {
          throw new ProviderError('falha simulada na primeira tentativa', { publicMessage: 'Falha no provider.' });
        }
        return { stream: Readable.from([Buffer.from('conteúdo-depois-da-falha')]), contentType: 'text/plain' };
      },
    });

    const downloadStore = new DownloadStore({ ttlMs: 60000 });
    const created = downloadStore.create({ providerId: 'falha-na-primeira', formatId: 'f1' });

    const { baseUrl, close } = await buildTestApp({ registry, storage, downloadStore });
    try {
      const [res1, res2] = await Promise.all([
        fetch(`${baseUrl}/api/download/${created.downloadId}`),
        fetch(`${baseUrl}/api/download/${created.downloadId}`),
      ]);

      const statuses = [res1.status, res2.status].sort();
      assert.deepEqual(
        statuses,
        [404, 500],
        'um dos dois consegue reclamar e falha (500); o outro nunca chega a reclamar, porque o claim já estava tomado (404)'
      );

      // Depois de ambos terminarem, o claim foi libertado pelo `finally`
      // do controller — uma nova tentativa sequencial consegue
      // reclamar, e desta vez o provider tem sucesso.
      const retryRes = await fetch(`${baseUrl}/api/download/${created.downloadId}`);
      assert.equal(retryRes.status, 200, 'depois da falha, uma nova tentativa tem de conseguir reclamar o downloadId outra vez');
      const body = await retryRes.text();
      assert.ok(body.includes('conteúdo-depois-da-falha'));
    } finally {
      await close();
      downloadStore.stop();
    }
  });
});

test('excesso de downloads simultâneos por IP devolve 429', async () => {
  await withTempStorage(async (storage) => {
    const registry = new ProviderRegistry();
    const { provider } = textProvider('demo', 'conteúdo', { delayMs: 100 });
    registry.register(provider);

    const downloadStore = new DownloadStore({ ttlMs: 60000 });
    const downloadConcurrencyLimiter = new ConcurrencyLimiter({ maxConcurrent: 1 });

    const { baseUrl, close } = await buildTestApp({ registry, storage, downloadStore, downloadConcurrencyLimiter });
    try {
      const a = downloadStore.create({ providerId: 'demo', formatId: 'f1' });
      const b = downloadStore.create({ providerId: 'demo', formatId: 'f1' });

      const firstRequest = fetch(`${baseUrl}/api/download/${a.downloadId}`);
      await new Promise((resolve) => setTimeout(resolve, 10)); // garante que "a" já reservou a vaga

      const secondResponse = await fetch(`${baseUrl}/api/download/${b.downloadId}`);
      assert.equal(secondResponse.status, 429);

      const firstResponse = await firstRequest;
      assert.equal(firstResponse.status, 200);
    } finally {
      await close();
      downloadStore.stop();
    }
  });
});

async function waitUntil(predicate, { timeoutMs = 500, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// --- Client abort, storage error, stream error ---

test('cliente que aborta a ligação antes de a resposta começar: liberta a vaga e não marca consumed', async () => {
  await withTempStorage(async (storage) => {
    const registry = new ProviderRegistry();
    const { provider } = textProvider('demo', 'conteúdo', { delayMs: 100 });
    registry.register(provider);

    const downloadStore = new DownloadStore({ ttlMs: 60000 });
    const downloadConcurrencyLimiter = new ConcurrencyLimiter({ maxConcurrent: 1 });
    const created = downloadStore.create({ providerId: 'demo', formatId: 'f1' });

    const { baseUrl, close } = await buildTestApp({ registry, storage, downloadStore, downloadConcurrencyLimiter });
    try {
      const controller = new AbortController();
      const abortedFetch = fetch(`${baseUrl}/api/download/${created.downloadId}`, { signal: controller.signal });
      setTimeout(() => controller.abort(), 20); // aborta durante o delay artificial do provider

      await assert.rejects(() => abortedFetch);

      // Dá tempo ao servidor para reagir ao close do pedido.
      await new Promise((resolve) => setTimeout(resolve, 150));

      assert.equal(downloadStore.get(created.downloadId)?.consumed, false, 'não podia ter marcado consumed');

      // Se a vaga tivesse ficado presa (limite=1), isto seria 429.
      const retryRes = await fetch(`${baseUrl}/api/download/${created.downloadId}`);
      assert.equal(retryRes.status, 200, 'a vaga tinha de ter sido libertada depois do abort do cliente');
    } finally {
      await close();
      downloadStore.stop();
    }
  });
});

test('falha do storage ao gravar devolve 500 seguro e liberta a vaga', async () => {
  await withTempStorage(async (realStorage) => {
    const registry = new ProviderRegistry();
    const { provider } = textProvider('demo', 'conteúdo');
    registry.register(provider);

    const storage = {
      ...realStorage,
      save: async () => {
        throw new Error('disco cheio (simulado)');
      },
    };

    const downloadStore = new DownloadStore({ ttlMs: 60000 });
    const downloadConcurrencyLimiter = new ConcurrencyLimiter({ maxConcurrent: 1 });

    const { baseUrl, close } = await buildTestApp({ registry, storage, downloadStore, downloadConcurrencyLimiter });
    try {
      const created = downloadStore.create({ providerId: 'demo', formatId: 'f1' });
      const res = await fetch(`${baseUrl}/api/download/${created.downloadId}`);
      const body = await res.json();

      assert.equal(res.status, 500);
      assert.equal(body.error, 'Algo correu mal. Tenta novamente.');
      assert.equal(JSON.stringify(body).includes('disco cheio'), false);

      // Confirma que a vaga foi libertada.
      const secondCreated = downloadStore.create({ providerId: 'demo', formatId: 'f1' });
      const res2 = await fetch(`${baseUrl}/api/download/${secondCreated.downloadId}`);
      assert.equal(res2.status, 500, 'devia ter chegado a tentar (500), não 429');
    } finally {
      await close();
      downloadStore.stop();
    }
  });
});

test('erro do provider ao devolver o stream não marca consumed nem deixa a vaga presa', async () => {
  await withTempStorage(async (storage) => {
    const registry = new ProviderRegistry();
    registry.register({
      id: 'instavel',
      canHandle: () => true,
      resolve: async () => ({}),
      getDownloadStream: async () => {
        throw new ProviderError('falha simulada a obter o stream', { publicMessage: 'Falha no provider.' });
      },
    });

    const downloadStore = new DownloadStore({ ttlMs: 60000 });
    const created = downloadStore.create({ providerId: 'instavel', formatId: 'f1' });

    const { baseUrl, close } = await buildTestApp({ registry, storage, downloadStore });
    try {
      const res = await fetch(`${baseUrl}/api/download/${created.downloadId}`);
      assert.equal(res.status, 500);
      assert.equal(downloadStore.get(created.downloadId)?.consumed, false);
    } finally {
      await close();
      downloadStore.stop();
    }
  });
});

test('falha a MEIO do streaming da resposta (depois dos headers já enviados): não marca consumed, liberta o claim para uma nova tentativa', async () => {
  await withTempStorage(async (realStorage) => {
    const registry = new ProviderRegistry();
    const { provider } = textProvider('demo', 'conteúdo-guardado-em-disco');
    registry.register(provider);

    // A gravação inicial (provider -> storage.save) corre normalmente;
    // só a LEITURA de volta para o cliente (storage.createReadStream,
    // já depois de storage.exists()/headers enviados) é que falha — e só
    // na primeira vez, para depois provar que uma nova tentativa
    // recupera. Isto simula uma falha de leitura/disco a meio da
    // entrega, distinta de uma falha ao gravar (já coberta noutro
    // teste) ou de um abort do cliente.
    let readAttempts = 0;
    const storage = {
      ...realStorage,
      createReadStream: (key) => {
        readAttempts += 1;
        if (readAttempts === 1) {
          const failingStream = new Readable({ read() {} });
          setTimeout(() => {
            failingStream.push(Buffer.from('inicio-do-ficheiro-que-nunca-chega-ao-fim-'));
            setTimeout(() => failingStream.emit('error', new Error('falha simulada a meio da leitura')), 30);
          }, 10);
          return failingStream;
        }
        return realStorage.createReadStream(key);
      },
    };

    const downloadStore = new DownloadStore({ ttlMs: 60000 });
    const created = downloadStore.create({ providerId: 'demo', formatId: 'f1' });

    const { baseUrl, close } = await buildTestApp({ registry, storage, downloadStore });
    try {
      // Consoante o timing exato, a falha pode interromper a ligação
      // antes do fetch() sequer resolver, ou já depois, a meio da
      // leitura do corpo — em qualquer dos casos, o cliente nunca
      // recebe uma resposta completa e bem sucedida.
      let clientSawFailure = false;
      try {
        const res = await fetch(`${baseUrl}/api/download/${created.downloadId}`);
        await res.text();
      } catch {
        clientSawFailure = true;
      }
      assert.equal(clientSawFailure, true, 'o cliente não pode receber uma resposta completa e bem sucedida depois de uma falha a meio da leitura');

      assert.equal(
        downloadStore.get(created.downloadId)?.consumed,
        false,
        'uma falha a meio do streaming da resposta não pode marcar consumed'
      );

      // O claim tinha de ter sido libertado: uma nova tentativa consegue
      // reclamar outra vez e, desta vez, o ficheiro (que continua em
      // disco — só a leitura anterior é que falhou) é entregue por
      // completo.
      const retryRes = await fetch(`${baseUrl}/api/download/${created.downloadId}`);
      assert.equal(retryRes.status, 200, 'o claim tinha de ter sido libertado para permitir nova tentativa depois da falha');
      const retryBody = await retryRes.text();
      assert.ok(retryBody.startsWith('conteúdo-guardado-em-disco'));
    } finally {
      await close();
      downloadStore.stop();
    }
  });
});

// --- Integração completa (E2E): resolve -> download -> consumed -> segundo pedido -> ficheiro apagado ---

test('E2E: POST /api/resolve -> GET /api/download entrega o conteúdo certo, consome, e limpa o ficheiro', async () => {
  await withTempStorage(async (storage, baseDir) => {
    const { baseUrl, close } = await buildTestApp({ storage }); // usa o demo provider real

    try {
      const resolveRes = await fetch(`${baseUrl}/api/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://sample.test/demo/video-1' }),
      });
      const resolveBody = await resolveRes.json();
      assert.equal(resolveRes.status, 200);
      const downloadId = resolveBody.data.formats[0].downloadId;

      const downloadRes = await fetch(`${baseUrl}/api/download/${downloadId}`);
      const content = await downloadRes.text();
      assert.equal(downloadRes.status, 200);
      assert.match(content, /Item: video-1/);

      // O cliente já recebeu a resposta completa neste ponto, mas a
      // limpeza (markConsumed + apagar o ficheiro) acontece no servidor
      // DEPOIS de o pipeline terminar — pode ficar uma fração de
      // milissegundos depois do fetch() do lado do cliente já ter
      // resolvido. Por isso esperamos pela condição em vez de verificar
      // imediatamente.
      const fileGone = await waitUntil(async () => {
        const entries = await fsp.readdir(baseDir);
        return entries.filter((name) => !name.endsWith('.tmp')).length === 0;
      });
      assert.ok(fileGone, 'o ficheiro tinha de ter sido apagado depois do download com sucesso');

      const secondRes = await fetch(`${baseUrl}/api/download/${downloadId}`);
      assert.equal(secondRes.status, 404, 'um downloadId já consumido tem de responder como inexistente');
    } finally {
      await close();
    }
  });
});
