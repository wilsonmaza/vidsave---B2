import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createApp } from '../../src/app.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { DownloadStore, DownloadCoordinator } from '../../src/services/download.service.js';
import { createLocalStorage } from '../../src/storage/local-storage.js';

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
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vidsave-download-route-size-guard-'));
  try {
    await run(createLocalStorage({ baseDir }), baseDir);
  } finally {
    await fsp.rm(baseDir, { recursive: true, force: true });
  }
}

// Igual ao buildTestApp() de download.route.test.js, mas também aceita
// maxDownloadSizeBytes -- o helper original não precisava disto antes da
// Etapa 6.4. Definido localmente, sem tocar no ficheiro existente.
async function buildTestApp({ registry, storage, downloadStore, maxDownloadSizeBytes } = {}) {
  return startTestServer({
    registry,
    storage,
    downloadStore,
    downloadCoordinator: new DownloadCoordinator(),
    maxDownloadSizeBytes,
  });
}

function textProvider(id, text) {
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
      async getDownloadStream() {
        calls += 1;
        return { stream: Readable.from([Buffer.from(text)]), contentType: 'text/plain' };
      },
    },
  };
}

// =====================================================================
// PONTO B (E2E): rejeição antecipada por tamanho via HTTP
// =====================================================================

test('B (E2E): GET /api/download com record.sizeBytes acima do limite devolve 413 JSON, sem chamar o provider', async () => {
  await withTempStorage(async (storage) => {
    const registry = new ProviderRegistry();
    const { provider, calls } = textProvider('demo', 'conteúdo qualquer');
    registry.register(provider);

    const downloadStore = new DownloadStore({ ttlMs: 60000 });
    const created = downloadStore.create({ providerId: 'demo', formatId: 'f1', sizeBytes: 1000 });

    const { baseUrl, close } = await buildTestApp({ registry, storage, downloadStore, maxDownloadSizeBytes: 500 });
    try {
      const res = await fetch(`${baseUrl}/api/download/${created.downloadId}`);
      const body = await res.json();

      assert.equal(res.status, 413);
      assert.equal(body.error, 'O ficheiro excede o tamanho máximo permitido.');
      assert.equal(calls(), 0, 'o provider NUNCA devia ter sido chamado -- a rejeição tinha de acontecer antes de qualquer streaming');
    } finally {
      await close();
      downloadStore.stop();
    }
  });
});

test('B (E2E): depois do 413 por tamanho, o claim foi libertado (não fica preso, confirmado por uma vaga de concorrência=1)', async () => {
  await withTempStorage(async (storage) => {
    const registry = new ProviderRegistry();
    const { provider } = textProvider('demo', 'conteúdo qualquer');
    registry.register(provider);

    const downloadStore = new DownloadStore({ ttlMs: 60000 });
    const created = downloadStore.create({ providerId: 'demo', formatId: 'f1', sizeBytes: 1000 });

    const { baseUrl, close } = await buildTestApp({ registry, storage, downloadStore, maxDownloadSizeBytes: 500 });
    try {
      const first = await fetch(`${baseUrl}/api/download/${created.downloadId}`);
      assert.equal(first.status, 413);

      // Se o claim tivesse ficado preso em CONSUMING, esta segunda
      // tentativa devolveria 404 (downloadId indisponível), não 413 de novo.
      const second = await fetch(`${baseUrl}/api/download/${created.downloadId}`);
      assert.equal(second.status, 413, 'uma segunda tentativa tinha de conseguir reclamar de novo e ser recusada pelo MESMO motivo, não um 404 de claim preso');
    } finally {
      await close();
      downloadStore.stop();
    }
  });
});

// =====================================================================
// PONTO C (E2E): limite exato
// =====================================================================

test('C (E2E): sizeBytes declarado === maxDownloadSizeBytes é aceite e o download completa com sucesso', async () => {
  await withTempStorage(async (storage) => {
    const conteudo = 'x'.repeat(500); // exatamente 500 bytes
    const registry = new ProviderRegistry();
    const { provider } = textProvider('demo', conteudo);
    registry.register(provider);

    const downloadStore = new DownloadStore({ ttlMs: 60000 });
    const created = downloadStore.create({ providerId: 'demo', formatId: 'f1', sizeBytes: 500 });

    const { baseUrl, close } = await buildTestApp({ registry, storage, downloadStore, maxDownloadSizeBytes: 500 });
    try {
      const res = await fetch(`${baseUrl}/api/download/${created.downloadId}`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.equal(body, conteudo);
    } finally {
      await close();
      downloadStore.stop();
    }
  });
});

// =====================================================================
// PONTO D (E2E): Size Guard durante a gravação real, via HTTP
// =====================================================================

test('D (E2E): sizeBytes declarado corretamente mas stream real maior -> o Size Guard apanha durante a escrita -> 413 JSON, sem ficheiros órfãos', async () => {
  await withTempStorage(async (storage, baseDir) => {
    const registry = new ProviderRegistry();
    // Declara 10 bytes no /resolve (dentro do limite), mas o provider
    // envia 500 bytes reais -- só o Size Guard, durante a escrita, apanha isto.
    registry.register({
      id: 'mentiroso-http',
      canHandle: () => true,
      resolve: async () => ({ title: 't', thumbnail: null, duration: null, formats: [{ formatId: 'f1', quality: 'sd', format: 'txt', sizeBytes: 10 }] }),
      getDownloadStream: async () => ({ stream: Readable.from([Buffer.alloc(500, 'z')]), contentType: 'text/plain' }),
    });

    const downloadStore = new DownloadStore({ ttlMs: 60000 });
    const created = downloadStore.create({ providerId: 'mentiroso-http', formatId: 'f1', sizeBytes: 10 });

    const { baseUrl, close } = await buildTestApp({ registry, storage, downloadStore, maxDownloadSizeBytes: 100 });
    try {
      const res = await fetch(`${baseUrl}/api/download/${created.downloadId}`);
      const body = await res.json();

      assert.equal(res.status, 413);
      assert.equal(body.error, 'O ficheiro excede o tamanho máximo permitido.');

      const entries = await fsp.readdir(baseDir);
      assert.equal(entries.length, 0, `esperava 0 ficheiros no storage, encontrei: ${JSON.stringify(entries)}`);
    } finally {
      await close();
      downloadStore.stop();
    }
  });
});

// =====================================================================
// PONTO G: streaming após headers -- comportamento inalterado pelo Size Guard
// =====================================================================

test('G: uma falha a MEIO do streaming storage->cliente (depois dos headers enviados) continua a abortar a ligação, NUNCA um 413 fabricado', async () => {
  await withTempStorage(async (realStorage) => {
    const registry = new ProviderRegistry();
    const { provider } = textProvider('demo', 'conteúdo-gravado-com-sucesso-pelo-size-guard');
    registry.register(provider);

    // A gravação inicial (provider -> SizeGuardTransform -> storage.save)
    // corre e termina com sucesso -- o Size Guard já não está envolvido
    // nesta fase nenhuma. Só a LEITURA de volta para o cliente falha, e só
    // na primeira vez -- mesma técnica do teste equivalente já existente
    // em download.route.test.js, aqui só para confirmar que nada mudou
    // com a introdução do Size Guard.
    let readAttempts = 0;
    const storage = {
      ...realStorage,
      createReadStream: (key) => {
        readAttempts += 1;
        if (readAttempts === 1) {
          const failingStream = new Readable({ read() {} });
          setTimeout(() => {
            failingStream.push(Buffer.from('inicio-que-nunca-chega-ao-fim-'));
            setTimeout(() => failingStream.emit('error', new Error('falha simulada a meio da leitura')), 30);
          }, 10);
          return failingStream;
        }
        return realStorage.createReadStream(key);
      },
    };

    const downloadStore = new DownloadStore({ ttlMs: 60000 });
    const created = downloadStore.create({ providerId: 'demo', formatId: 'f1', sizeBytes: 44 });

    const { baseUrl, close } = await buildTestApp({ registry, storage, downloadStore, maxDownloadSizeBytes: 500 });
    try {
      let sawJsonError413 = false;
      let clientSawFailure = false;
      try {
        const res = await fetch(`${baseUrl}/api/download/${created.downloadId}`);
        if (res.status === 413) sawJsonError413 = true; // NUNCA pode acontecer aqui
        await res.text();
      } catch {
        clientSawFailure = true;
      }

      assert.equal(sawJsonError413, false, 'uma falha DEPOIS dos headers enviados nunca pode virar um 413 JSON -- a resposta já começou');
      assert.equal(clientSawFailure, true, 'o cliente não pode receber uma resposta completa e bem sucedida depois de uma falha a meio da leitura');
      assert.equal(downloadStore.get(created.downloadId)?.consumed, false);

      // O claim foi libertado -- nova tentativa recupera o ficheiro
      // completo (que continua em disco, intacto: só a leitura anterior falhou).
      const retryRes = await fetch(`${baseUrl}/api/download/${created.downloadId}`);
      assert.equal(retryRes.status, 200);
      const retryBody = await retryRes.text();
      assert.equal(retryBody, 'conteúdo-gravado-com-sucesso-pelo-size-guard');
    } finally {
      await close();
      downloadStore.stop();
    }
  });
});
