import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  DownloadStore,
  DOWNLOAD_STATE,
  DownloadCoordinator,
  resolveDownloadTarget,
  DownloadTooLargeError,
} from '../../src/services/download.service.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { createLocalStorage } from '../../src/storage/local-storage.js';
import { StorageError } from '../../src/storage/storage.interface.js';

function fakeProvider(id) {
  return {
    id,
    canHandle: () => true,
    resolve: async () => ({ title: id, thumbnail: null, duration: null, formats: [] }),
    getDownloadStream: async () => ({ stream: null }),
  };
}

/** Provider que falha o teste se alguma vez for chamado -- usado para provar rejeição ANTES de tocar no provider. */
function providerThatMustNeverBeCalled(id) {
  return {
    id,
    canHandle: () => true,
    resolve: async () => ({ title: id, thumbnail: null, duration: null, formats: [] }),
    getDownloadStream: async () => {
      throw new Error(`provider "${id}" NUNCA devia ter sido chamado -- a rejeição por tamanho tinha de acontecer antes`);
    },
  };
}

async function withTempStorage(run) {
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vidsave-download-service-size-guard-'));
  try {
    await run(createLocalStorage({ baseDir }), baseDir);
  } finally {
    await fsp.rm(baseDir, { recursive: true, force: true });
  }
}

// =====================================================================
// PONTO B: rejeição antecipada por tamanho (resolveDownloadTarget)
// =====================================================================

test('B: record.sizeBytes > maxDownloadSizeBytes lança DownloadTooLargeError (413) sem tocar no provider', () => {
  const registry = new ProviderRegistry();
  registry.register(providerThatMustNeverBeCalled('demo')); // o registo existe, mas getDownloadStream nunca pode ser chamado
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1', sizeBytes: 1000 });

    assert.throws(
      () => resolveDownloadTarget(created.downloadId, { downloadStore: store, registry, maxDownloadSizeBytes: 500 }),
      (err) => err instanceof DownloadTooLargeError && err.status === 413
    );
  } finally {
    store.stop();
  }
});

test('B: a rejeição por tamanho acontece ANTES de qualquer streaming -- resolveDownloadTarget nunca chega a invocar storage', () => {
  // resolveDownloadTarget nem sequer recebe `storage` como dependência --
  // é estruturalmente impossível streaming ter começado neste ponto. Este
  // teste documenta essa garantia arquitetural.
  const registry = new ProviderRegistry();
  registry.register(providerThatMustNeverBeCalled('demo'));
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1', sizeBytes: 1000 });
    assert.throws(
      () => resolveDownloadTarget(created.downloadId, { downloadStore: store, registry, maxDownloadSizeBytes: 500 }),
      DownloadTooLargeError
    );
  } finally {
    store.stop();
  }
});

test('B: depois da rejeição por tamanho, o claim é libertado -- o estado volta a AVAILABLE, não fica preso em CONSUMING', () => {
  const registry = new ProviderRegistry();
  registry.register(providerThatMustNeverBeCalled('demo'));
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1', sizeBytes: 1000 });

    assert.throws(
      () => resolveDownloadTarget(created.downloadId, { downloadStore: store, registry, maxDownloadSizeBytes: 500 }),
      DownloadTooLargeError
    );

    assert.equal(store.get(created.downloadId).state, DOWNLOAD_STATE.AVAILABLE, 'o claim tinha de ter sido libertado, não deixado preso em CONSUMING');

    // Confirma que uma segunda tentativa consegue mesmo reclamar de novo
    // (release() real, não só um estado que parece certo por acidente).
    const secondClaim = store.claim(created.downloadId);
    assert.equal(secondClaim.claimed, true);
    store.release(created.downloadId);
  } finally {
    store.stop();
  }
});

test('B: sizeBytes desconhecido (null, registo criado sem esse campo) NÃO é rejeitado antecipadamente -- passa para o provider normalmente', () => {
  const registry = new ProviderRegistry();
  const provider = fakeProvider('demo');
  registry.register(provider);
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1' }); // sem sizeBytes -> null
    const target = resolveDownloadTarget(created.downloadId, { downloadStore: store, registry, maxDownloadSizeBytes: 500 });
    assert.equal(target.provider, provider);
  } finally {
    store.stop();
  }
});

// =====================================================================
// PONTO C: limite exato (a nível de resolveDownloadTarget)
// =====================================================================

test('C: sizeBytes === maxDownloadSizeBytes é aceite (não excede, é igual)', () => {
  const registry = new ProviderRegistry();
  const provider = fakeProvider('demo');
  registry.register(provider);
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1', sizeBytes: 500 });
    const target = resolveDownloadTarget(created.downloadId, { downloadStore: store, registry, maxDownloadSizeBytes: 500 });
    assert.equal(target.provider, provider);
  } finally {
    store.stop();
  }
});

test('C: sizeBytes === maxDownloadSizeBytes + 1 já é rejeitado (a fronteira é estritamente "maior que", não "maior ou igual")', () => {
  const registry = new ProviderRegistry();
  registry.register(providerThatMustNeverBeCalled('demo'));
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1', sizeBytes: 501 });
    assert.throws(
      () => resolveDownloadTarget(created.downloadId, { downloadStore: store, registry, maxDownloadSizeBytes: 500 }),
      DownloadTooLargeError
    );
  } finally {
    store.stop();
  }
});

// =====================================================================
// PONTO D: Size Guard durante provider -> storage (ensureStored, storage real)
// =====================================================================

test('D: stream real do provider acima do limite dispara DownloadTooLargeError (413) e não deixa .tmp nem ficheiro final órfão', async () => {
  await withTempStorage(async (storage, baseDir) => {
    const coordinator = new DownloadCoordinator();
    const provider = {
      id: 'mentiroso',
      getDownloadStream: async () => ({ stream: Readable.from([Buffer.alloc(600, 'x')]), contentType: 'text/plain' }), // 600 bytes reais
    };

    await assert.rejects(
      () => coordinator.ensureStored({ downloadId: 'a'.repeat(32), provider, formatId: 'f1', storage, maxDownloadSizeBytes: 500 }),
      (err) => err instanceof DownloadTooLargeError && err.status === 413
    );

    const entries = await fsp.readdir(baseDir);
    assert.equal(entries.length, 0, `esperava 0 ficheiros em baseDir, encontrei: ${JSON.stringify(entries)}`);
  });
});

test('D: stream dividido em VÁRIOS chunks, cada um dentro do limite, só dispara quando a soma acumulada o ultrapassa -- e mesmo assim limpa tudo', async () => {
  await withTempStorage(async (storage, baseDir) => {
    const coordinator = new DownloadCoordinator();
    // 3 chunks de 200 bytes cada (nenhum, isolado, excede 500) -- só a soma
    // (200, 400, 600) ultrapassa o limite, e só no 3º chunk.
    const chunk = () => Buffer.alloc(200, 'y');
    const provider = {
      id: 'aos-poucos',
      getDownloadStream: async () => ({ stream: Readable.from([chunk(), chunk(), chunk()]), contentType: 'text/plain' }),
    };

    await assert.rejects(
      () => coordinator.ensureStored({ downloadId: 'b'.repeat(32), provider, formatId: 'f1', storage, maxDownloadSizeBytes: 500 }),
      (err) => err instanceof DownloadTooLargeError
    );

    const entries = await fsp.readdir(baseDir);
    assert.equal(entries.length, 0, 'nenhum .tmp nem ficheiro final órfão, mesmo com o disparo a acontecer só no 3º chunk');
  });
});

test('D: um stream dentro do limite continua a gravar normalmente (sem falsos positivos)', async () => {
  await withTempStorage(async (storage, baseDir) => {
    const coordinator = new DownloadCoordinator();
    const provider = {
      id: 'ok',
      getDownloadStream: async () => ({ stream: Readable.from([Buffer.from('conteudo pequeno, bem dentro do limite')]), contentType: 'text/plain' }),
    };

    const result = await coordinator.ensureStored({ downloadId: 'c'.repeat(32), provider, formatId: 'f1', storage, maxDownloadSizeBytes: 500 });
    assert.equal(result.contentType, 'text/plain');

    const entries = await fsp.readdir(baseDir);
    assert.deepEqual(entries, ['c'.repeat(32)], 'só o ficheiro final devia sobrar, sem .tmp');
  });
});

// =====================================================================
// PONTO E: erro real de storage não pode virar 413
// =====================================================================

test('E: uma falha genuína de storage (não relacionada com tamanho) continua StorageError/500, NUNCA DownloadTooLargeError', async () => {
  await withTempStorage(async (storage) => {
    const coordinator = new DownloadCoordinator();
    // Stream que falha a meio por um motivo qualquer, nada a ver com o
    // Size Guard -- mesma técnica de local-storage.test.js.
    const failingStream = new Readable({
      read() {
        this.push(Buffer.from('bytes parciais antes da falha'));
        process.nextTick(() => this.destroy(new Error('disco cheio (simulado)')));
      },
    });
    const provider = { id: 'instavel', getDownloadStream: async () => ({ stream: failingStream, contentType: 'text/plain' }) };

    try {
      // Limite generoso -- o Size Guard não tem sequer hipótese de disparar aqui.
      await coordinator.ensureStored({ downloadId: 'd'.repeat(32), provider, formatId: 'f1', storage, maxDownloadSizeBytes: 1_000_000 });
      assert.fail('devia ter lançado');
    } catch (err) {
      assert.ok(err instanceof StorageError, `esperava StorageError, recebi ${err.constructor.name}`);
      assert.ok(!(err instanceof DownloadTooLargeError), 'um erro de storage genuíno NUNCA pode virar DownloadTooLargeError');
      assert.equal(err.status, 500);
      assert.equal(err.message, 'Não foi possível processar este pedido.'); // mensagem pública, sem detalhe interno
    }
  });
});

test('E: a cause do erro de storage genuíno é preservada (para diagnóstico em logs), sem aparecer na mensagem pública', async () => {
  await withTempStorage(async (storage) => {
    const coordinator = new DownloadCoordinator();
    const failingStream = new Readable({
      read() {
        this.push(Buffer.from('x'));
        process.nextTick(() => this.destroy(new Error('ENOSPC simulado')));
      },
    });
    const provider = { id: 'instavel-2', getDownloadStream: async () => ({ stream: failingStream, contentType: 'text/plain' }) };

    try {
      await coordinator.ensureStored({ downloadId: 'e'.repeat(32), provider, formatId: 'f1', storage, maxDownloadSizeBytes: 1_000_000 });
      assert.fail('devia ter lançado');
    } catch (err) {
      assert.ok(err.cause instanceof Error, 'err.cause tinha de preservar o erro de fs original');
      assert.equal(err.cause.message, 'ENOSPC simulado');
      assert.equal(err.message.includes('ENOSPC'), false, 'a mensagem pública nunca pode conter o detalhe interno');
    }
  });
});
