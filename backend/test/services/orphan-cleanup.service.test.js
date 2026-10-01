import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { OrphanCleanupService } from '../../src/services/orphan-cleanup.service.js';
import { DownloadStore } from '../../src/services/download.service.js';
import { createLocalStorage } from '../../src/storage/local-storage.js';

async function withTempStorage(run) {
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'orphan-cleanup-test-'));
  const storage = createLocalStorage({ baseDir });
  try {
    await run(storage, baseDir);
  } finally {
    await fsp.rm(baseDir, { recursive: true, force: true });
  }
}

function toReadable(content) {
  return Readable.from(Buffer.from(content));
}

test('OrphanCleanupService encontra e deleta ficheiros órfãos', async () => {
  await withTempStorage(async (storage) => {
    const store = new DownloadStore({ ttlMs: 60000 });

    // Cria um ficheiro "válido" (registo existe no DownloadStore)
    const valid = store.create({ providerId: 'demo', formatId: 'f1' });
    await storage.save(valid.downloadId, toReadable('conteúdo válido'));

    // Cria ficheiros órfãos (sem registo)
    const orphan1 = 'orphan-file-1-12345678901234567890123456789012';
    const orphan2 = 'orphan-file-2-12345678901234567890123456789012';
    await storage.save(orphan1, toReadable('órfão 1'));
    await storage.save(orphan2, toReadable('órfão 2'));

    // Verifica que os ficheiros existem
    assert.equal(await storage.exists(valid.downloadId), true);
    assert.equal(await storage.exists(orphan1), true);
    assert.equal(await storage.exists(orphan2), true);

    // Executa cleanup
    const cleanup = new OrphanCleanupService({
      storage,
      downloadStore: store,
      enabled: true,
      intervalMs: 60000,
      maxRetries: 1,
    });

    await cleanup.cleanupOnce();

    // Verifica que órfãos foram deletados
    assert.equal(await storage.exists(orphan1), false, 'órfão 1 devia ter sido deletado');
    assert.equal(await storage.exists(orphan2), false, 'órfão 2 devia ter sido deletado');

    // Verifica que ficheiro válido continua
    assert.equal(await storage.exists(valid.downloadId), true, 'ficheiro válido não devia ter sido deletado');

    // Verifica stats
    const stats = cleanup.getStats();
    assert.equal(stats.orphansFound, 2);
    assert.equal(stats.orphansDeleted, 2);
    assert.equal(stats.deleteFailed, 0);

    store.stop();
  });
});

test('OrphanCleanupService não deleta ficheiros válidos', async () => {
  await withTempStorage(async (storage) => {
    const store = new DownloadStore({ ttlMs: 60000 });

    // Cria múltiplos ficheiros válidos
    const ids = [
      store.create({ providerId: 'demo', formatId: 'f1' }).downloadId,
      store.create({ providerId: 'demo', formatId: 'f2' }).downloadId,
      store.create({ providerId: 'demo', formatId: 'f3' }).downloadId,
    ];

    for (const id of ids) {
      await storage.save(id, toReadable(`conteúdo de ${id}`));
    }

    const cleanup = new OrphanCleanupService({ storage, downloadStore: store });
    await cleanup.cleanupOnce();

    // Verifica que nenhum foi deletado
    for (const id of ids) {
      assert.equal(await storage.exists(id), true, `${id} não devia ter sido deletado`);
    }

    const stats = cleanup.getStats();
    assert.equal(stats.orphansFound, 0);
    assert.equal(stats.orphansDeleted, 0);

    store.stop();
  });
});

test('OrphanCleanupService retry em caso de falha de delete', async () => {
  await withTempStorage(async (storage) => {
    const store = new DownloadStore({ ttlMs: 60000 });

    const orphan = 'retry-test-orphan-file-1234567890123456';
    await storage.save(orphan, toReadable('órfão'));

    let deleteAttempts = 0;
    const faultyStorage = {
      ...storage,
      delete: async (key) => {
        if (key === orphan) {
          deleteAttempts += 1;
          if (deleteAttempts < 3) {
            throw new Error(`falha simulada na tentativa ${deleteAttempts}`);
          }
        }
        return storage.delete(key);
      },
      listKeys: storage.listKeys,
      exists: storage.exists,
      createReadStream: storage.createReadStream,
      save: storage.save,
    };

    const cleanup = new OrphanCleanupService({
      storage: faultyStorage,
      downloadStore: store,
      maxRetries: 3,
      retryDelayMs: 10,
    });

    await cleanup.cleanupOnce();

    // Verifica que foi tentado 3 vezes e eventualmente sucedeu
    assert.equal(deleteAttempts, 3, 'devia ter tentado 3 vezes');
    assert.equal(await storage.exists(orphan), false, 'ficheiro devia ter sido deletado na 3ª tentativa');

    const stats = cleanup.getStats();
    assert.equal(stats.orphansDeleted, 1);
    assert.equal(stats.deleteFailed, 0);

    store.stop();
  });
});

test('OrphanCleanupService respeita maxRetries e log falhas', async () => {
  await withTempStorage(async (storage) => {
    const store = new DownloadStore({ ttlMs: 60000 });

    const orphan = 'permanent-fail-orphan-file-123456789012345';
    await storage.save(orphan, toReadable('órfão'));

    // Storage que falha permanentemente
    const faultyStorage = {
      ...storage,
      delete: async () => {
        throw new Error('falha permanente de delete');
      },
      listKeys: storage.listKeys,
      exists: storage.exists,
      createReadStream: storage.createReadStream,
      save: storage.save,
    };

    const cleanup = new OrphanCleanupService({
      storage: faultyStorage,
      downloadStore: store,
      maxRetries: 2,
      retryDelayMs: 5,
    });

    await cleanup.cleanupOnce();

    // Verifica que ficheiro continua em disco (falha final)
    assert.equal(await storage.exists(orphan), true, 'ficheiro permanece após falhas');

    const stats = cleanup.getStats();
    assert.equal(stats.orphansFound, 1);
    assert.equal(stats.deleteFailed, 1, 'devia contar como falha');
    assert.equal(stats.orphansDeleted, 0);

    store.stop();
  });
});

test('OrphanCleanupService lida com múltiplos órfãos misto com válidos', async () => {
  await withTempStorage(async (storage) => {
    const store = new DownloadStore({ ttlMs: 60000 });

    // Cria mix de válidos e órfãos
    const validIds = [
      store.create({ providerId: 'p1', formatId: 'f1' }).downloadId,
      store.create({ providerId: 'p2', formatId: 'f2' }).downloadId,
    ];

    const orphanIds = [
      'orphan-mix-001-1234567890123456789012345',
      'orphan-mix-002-1234567890123456789012345',
      'orphan-mix-003-1234567890123456789012345',
    ];

    // Grava tudo
    for (const id of [...validIds, ...orphanIds]) {
      await storage.save(id, toReadable(`conteúdo de ${id}`));
    }

    const cleanup = new OrphanCleanupService({ storage, downloadStore: store });
    await cleanup.cleanupOnce();

    // Válidos continuam
    for (const id of validIds) {
      assert.equal(await storage.exists(id), true, `válido ${id} devia permanecer`);
    }

    // Órfãos desaparecem
    for (const id of orphanIds) {
      assert.equal(await storage.exists(id), false, `órfão ${id} devia ter sido deletado`);
    }

    const stats = cleanup.getStats();
    assert.equal(stats.orphansFound, 3);
    assert.equal(stats.orphansDeleted, 3);

    store.stop();
  });
});

test('OrphanCleanupService start/stop funciona', async () => {
  await withTempStorage(async (storage) => {
    const store = new DownloadStore({ ttlMs: 60000 });

    const orphan = 'timer-orphan-file-1234567890123456789012';
    await storage.save(orphan, toReadable('órfão'));

    const cleanup = new OrphanCleanupService({
      storage,
      downloadStore: store,
      intervalMs: 100,
      maxRetries: 1,
    });

    cleanup.start();
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Verifica que cleanup foi executado
    const stats = cleanup.getStats();
    assert.equal(stats.runsCount, 1, 'cleanup devia ter rodado pelo menos uma vez');
    assert.equal(stats.orphansDeleted, 1);

    cleanup.stop();
    const statsAfterStop = cleanup.getStats();

    // Aguarda mais tempo e verifica que não rodou novamente
    await new Promise((resolve) => setTimeout(resolve, 150));
    const statsLater = cleanup.getStats();
    assert.equal(statsLater.runsCount, statsAfterStop.runsCount, 'cleanup não devia rodar após stop');

    store.stop();
  });
});

test('OrphanCleanupService desativado não faz nada', async () => {
  await withTempStorage(async (storage) => {
    const store = new DownloadStore({ ttlMs: 60000 });

    const orphan = 'disabled-orphan-file-123456789012345678';
    await storage.save(orphan, toReadable('órfão'));

    const cleanup = new OrphanCleanupService({
      storage,
      downloadStore: store,
      enabled: false,
      intervalMs: 100,
    });

    cleanup.start();
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Verifica que não foi deletado
    assert.equal(await storage.exists(orphan), true, 'com disabled=true, ficheiros deviam permanecer');

    const stats = cleanup.getStats();
    assert.equal(stats.runsCount, 0, 'desativado não devia ter rodado');

    cleanup.stop();
    store.stop();
  });
});

test('OrphanCleanupService caso de restart: ficheiros órfãos sem registo', async () => {
  await withTempStorage(async (storage, baseDir) => {
    // Simula um restart:
    // 1. Cria ficheiros como se tivessem vindo de um processo anterior
    // 2. Novo DownloadStore (vazio, porque o anterior foi perdido)
    // 3. Cleanup encontra e deleta os órfãos

    const orphanIds = [
      'restart-orphan-1-12345678901234567890123456789012',
      'restart-orphan-2-12345678901234567890123456789012',
    ];

    for (const id of orphanIds) {
      await storage.save(id, toReadable(`ficheiro do processo anterior: ${id}`));
    }

    // Novo DownloadStore (vazio, simula restart)
    const newStore = new DownloadStore({ ttlMs: 60000 });

    const cleanup = new OrphanCleanupService({
      storage,
      downloadStore: newStore,
    });

    await cleanup.cleanupOnce();

    // Todos os ficheiros foram considerados órfãos e deletados
    for (const id of orphanIds) {
      assert.equal(await storage.exists(id), false, `${id} devia ter sido deletado (órfão após restart)`);
    }

    const stats = cleanup.getStats();
    assert.equal(stats.orphansFound, 2);
    assert.equal(stats.orphansDeleted, 2);

    newStore.stop();
  });
});

test('OrphanCleanupService handle de storage.listKeys() vazio', async () => {
  await withTempStorage(async (storage) => {
    const store = new DownloadStore({ ttlMs: 60000 });

    // Sem ficheiros em disco
    const cleanup = new OrphanCleanupService({ storage, downloadStore: store });

    await cleanup.cleanupOnce();

    // Não lança, tudo OK
    const stats = cleanup.getStats();
    assert.equal(stats.orphansFound, 0);
    assert.equal(stats.runsCount, 1);

    store.stop();
  });
});

test('OrphanCleanupService stats são acumuladas em múltiplas execuções', async () => {
  await withTempStorage(async (storage) => {
    const store = new DownloadStore({ ttlMs: 60000 });

    // Primeira limpeza: 2 órfãos
    await storage.save('first-orphan-1-1234567890123456789012', toReadable('o1'));
    await storage.save('first-orphan-2-1234567890123456789012', toReadable('o2'));

    const cleanup = new OrphanCleanupService({ storage, downloadStore: store });

    await cleanup.cleanupOnce();
    let stats = cleanup.getStats();
    assert.equal(stats.orphansDeleted, 2);
    assert.equal(stats.runsCount, 1);

    // Segunda limpeza: 3 órf ãos novos
    await storage.save('second-orphan-1-1234567890123456789012', toReadable('o3'));
    await storage.save('second-orphan-2-1234567890123456789012', toReadable('o4'));
    await storage.save('second-orphan-3-1234567890123456789012', toReadable('o5'));

    await cleanup.cleanupOnce();
    stats = cleanup.getStats();
    assert.equal(stats.orphansDeleted, 5, 'stats devem ser acumuladas');
    assert.equal(stats.runsCount, 2, 'runsCount deve contar ambas execuções');

    store.stop();
  });
});
