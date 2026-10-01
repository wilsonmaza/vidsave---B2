import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createLocalStorage } from '../../src/storage/local-storage.js';
import { StorageError } from '../../src/storage/storage.interface.js';

async function withTempDir(run) {
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vidsave-storage-test-'));
  try {
    await run(createLocalStorage({ baseDir }), baseDir);
  } finally {
    await fsp.rm(baseDir, { recursive: true, force: true });
  }
}

function streamFromString(text) {
  return Readable.from([Buffer.from(text, 'utf-8')]);
}

/** Um stream que emite alguns bytes e depois falha a meio — simula uma origem instável. */
function failingStream() {
  return new Readable({
    read() {
      this.push(Buffer.from('bytes parciais antes da falha'));
      process.nextTick(() => this.destroy(new Error('falha simulada a meio da leitura')));
    },
  });
}

const VALID_KEY = 'a'.repeat(32); // cumpre SAFE_KEY_PATTERN

// --- Roundtrip básico ---

test('save() seguido de createReadStream() devolve o conteúdo gravado', async () => {
  await withTempDir(async (storage) => {
    const result = await storage.save(VALID_KEY, streamFromString('conteúdo de teste'));
    assert.ok(result.sizeBytes > 0);

    const chunks = [];
    for await (const chunk of storage.createReadStream(VALID_KEY)) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString('utf-8'), 'conteúdo de teste');
  });
});

test('exists() reflete corretamente presença e ausência', async () => {
  await withTempDir(async (storage) => {
    assert.equal(await storage.exists(VALID_KEY), false);
    await storage.save(VALID_KEY, streamFromString('x'));
    assert.equal(await storage.exists(VALID_KEY), true);
  });
});

test('delete() remove o ficheiro; é idempotente para keys já ausentes', async () => {
  await withTempDir(async (storage) => {
    await storage.save(VALID_KEY, streamFromString('x'));
    await storage.delete(VALID_KEY);
    assert.equal(await storage.exists(VALID_KEY), false);
    await assert.doesNotReject(() => storage.delete(VALID_KEY)); // apagar de novo não é erro
  });
});

// --- Path traversal ---

test('rejeita keys com tentativas óbvias de path traversal', async () => {
  await withTempDir(async (storage) => {
    for (const badKey of ['../etc/passwd', '../../secret', 'a/../../b', '/etc/passwd', 'a/b']) {
      await assert.rejects(() => storage.save(badKey, streamFromString('x')), StorageError);
      await assert.rejects(() => storage.exists(badKey), StorageError);
    }
  });
});

test('rejeita keys demasiado curtas, vazias, ou com caracteres fora do alfabeto seguro', async () => {
  await withTempDir(async (storage) => {
    for (const badKey of ['', 'curta', 'tem espaço aqui inválido', 'tem;ponto;e;virgula', null, undefined, 123]) {
      await assert.rejects(() => storage.save(badKey, streamFromString('x')), StorageError);
    }
  });
});

test('a mensagem pública do erro de path traversal nunca inclui o caminho real', async () => {
  await withTempDir(async (storage, baseDir) => {
    try {
      await storage.save('../../etc/passwd', streamFromString('x'));
      assert.fail('devia ter lançado');
    } catch (err) {
      assert.equal(err.message, 'Não foi possível processar este pedido.');
      assert.equal(err.message.includes(baseDir), false);
    }
  });
});

// --- Escrita atómica ---

test('durante uma escrita bem sucedida, não fica nenhum ficheiro .tmp para trás', async () => {
  await withTempDir(async (storage, baseDir) => {
    await storage.save(VALID_KEY, streamFromString('conteúdo'));
    const entries = await fsp.readdir(baseDir);
    assert.equal(entries.some((name) => name.endsWith('.tmp')), false);
    assert.deepEqual(entries, [VALID_KEY]);
  });
});

test('escrever para a mesma key duas vezes substitui o conteúdo por completo (rename atómico)', async () => {
  await withTempDir(async (storage) => {
    await storage.save(VALID_KEY, streamFromString('primeira versão'));
    await storage.save(VALID_KEY, streamFromString('segunda versão, mais curta'));

    const chunks = [];
    for await (const chunk of storage.createReadStream(VALID_KEY)) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString('utf-8'), 'segunda versão, mais curta');
  });
});

// --- Falha durante a escrita ---

test('uma origem que falha a meio não deixa ficheiro final nem .tmp órfão', async () => {
  await withTempDir(async (storage, baseDir) => {
    await assert.rejects(() => storage.save(VALID_KEY, failingStream()), StorageError);

    assert.equal(await storage.exists(VALID_KEY), false, 'não podia existir ficheiro final');

    const entries = await fsp.readdir(baseDir).catch(() => []);
    assert.equal(entries.length, 0, 'não devia sobrar nenhum ficheiro .tmp órfão');
  });
});

test('o erro de uma escrita falhada nunca expõe o motivo interno na mensagem pública', async () => {
  await withTempDir(async (storage) => {
    try {
      await storage.save(VALID_KEY, failingStream());
      assert.fail('devia ter lançado');
    } catch (err) {
      assert.equal(err.message, 'Não foi possível processar este pedido.');
      assert.equal(err.message.includes('falha simulada'), false);
    }
  });
});

// --- Concorrência ---

test('saves concorrentes para keys diferentes não interferem entre si', async () => {
  await withTempDir(async (storage) => {
    const keyA = 'a'.repeat(32);
    const keyB = 'b'.repeat(32);

    await Promise.all([
      storage.save(keyA, streamFromString('conteúdo A')),
      storage.save(keyB, streamFromString('conteúdo B')),
    ]);

    const readAll = async (key) => {
      const chunks = [];
      for await (const chunk of storage.createReadStream(key)) chunks.push(chunk);
      return Buffer.concat(chunks).toString('utf-8');
    };

    assert.equal(await readAll(keyA), 'conteúdo A');
    assert.equal(await readAll(keyB), 'conteúdo B');
  });
});

test('saves concorrentes para a MESMA key nunca produzem um ficheiro corrompido/misturado', async () => {
  await withTempDir(async (storage, baseDir) => {
    await Promise.all([
      storage.save(VALID_KEY, streamFromString('versão-um-completa')),
      storage.save(VALID_KEY, streamFromString('versão-dois-tambem-completa')),
    ]);

    const chunks = [];
    for await (const chunk of storage.createReadStream(VALID_KEY)) chunks.push(chunk);
    const content = Buffer.concat(chunks).toString('utf-8');

    // O resultado tem de ser EXATAMENTE uma das duas versões completas,
    // nunca uma mistura de bytes das duas.
    assert.ok(
      content === 'versão-um-completa' || content === 'versão-dois-tambem-completa',
      `conteúdo misturado/corrompido: "${content}"`
    );

    const entries = await fsp.readdir(baseDir);
    assert.equal(entries.some((name) => name.endsWith('.tmp')), false, 'sem .tmp órfãos depois da corrida');
  });
});

// --- listKeys (capacidade extra, para reconciliação de limpeza futura) ---

test('listKeys() reflete o que está guardado e ignora ficheiros .tmp', async () => {
  await withTempDir(async (storage, baseDir) => {
    await storage.save(VALID_KEY, streamFromString('x'));
    await fsp.writeFile(path.join(baseDir, `${VALID_KEY}.lixo.tmp`), 'resto de uma escrita falhada');

    const keys = await storage.listKeys();
    assert.deepEqual(keys, [VALID_KEY]);
  });
});
