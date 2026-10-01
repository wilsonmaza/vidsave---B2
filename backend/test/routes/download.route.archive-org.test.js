import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createApp } from '../../src/app.js';
import { createArchiveOrgProvider } from '../../src/providers/archive-org-provider.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { createLocalStorage } from '../../src/storage/local-storage.js';
import { isAllowedHost } from '../../src/config/allowlist.js';

async function startTestServer(appOptions) {
  const app = createApp(appOptions);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function withTempStorage(run) {
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-org-e2e-'));
  try {
    await run(createLocalStorage({ baseDir }), baseDir);
  } finally {
    await fsp.rm(baseDir, { recursive: true, force: true });
  }
}

/** Fetch fake que despacha por URL -- sem tocar na internet real. */
function fakeFetchDispatcher(routes) {
  return async (url) => {
    for (const [matcher, handler] of routes) {
      if ((typeof matcher === 'string' && matcher === url) || (matcher instanceof RegExp && matcher.test(url))) {
        return handler(url);
      }
    }
    throw new Error(`fakeFetchDispatcher: sem rota para "${url}"`);
  };
}

function jsonBody(obj) {
  return { status: 200, headers: {}, stream: Readable.from([Buffer.from(JSON.stringify(obj))]) };
}

function fileBody(bytes, contentType = 'video/mp4') {
  return { status: 200, headers: { 'content-type': contentType }, stream: Readable.from([Buffer.from(bytes)]) };
}

const SMALL_ITEM = {
  metadata: { title: 'Public Domain Short' },
  files: [{ name: 'clip.mp4', format: 'h.264', size: '20' }], // declara 20 bytes
};

// =====================================================================
// /api/resolve -> /api/download completo, com fetch fake
// =====================================================================

test('fluxo completo /api/resolve -> /api/download com o Internet Archive (fetch fake, sem internet real)', async () => {
  await withTempStorage(async (storage) => {
    const fetchFn = fakeFetchDispatcher([
      [/\/metadata\//, () => jsonBody(SMALL_ITEM)],
      [/\/download\//, () => fileBody('conteudo real do clip')], // 22 bytes reais, dentro do declarado (20 é só aproximado aqui)
    ]);
    const registry = new ProviderRegistry();
    registry.register(createArchiveOrgProvider({ fetchFn, isHostAllowed: isAllowedHost }));

    const { baseUrl, close } = await startTestServer({ registry, storage, isHostAllowed: isAllowedHost });
    try {
      const resolveRes = await fetch(`${baseUrl}/api/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://archive.org/details/public-domain-short' }),
      });
      const resolveBody = await resolveRes.json();
      assert.equal(resolveRes.status, 200, JSON.stringify(resolveBody));
      assert.equal(resolveBody.data.title, 'Public Domain Short');
      assert.equal(resolveBody.data.formats.length, 1);
      const { downloadId, sizeBytes } = resolveBody.data.formats[0];
      assert.equal(sizeBytes, 20); // valor DECLARADO pela fonte, devolvido ao cliente

      const downloadRes = await fetch(`${baseUrl}/api/download/${downloadId}`);
      assert.equal(downloadRes.status, 200);
      const downloadBody = await downloadRes.text();
      assert.equal(downloadBody, 'conteudo real do clip');
    } finally {
      await close();
    }
  });
});

// --- Size Guard continua a proteger um provider real ---

test('Size Guard: sizeBytes declarado pela fonte correto, mas dentro do limite -> download normal', async () => {
  await withTempStorage(async (storage) => {
    const fetchFn = fakeFetchDispatcher([
      [/\/metadata\//, () => jsonBody(SMALL_ITEM)],
      [/\/download\//, () => fileBody('x'.repeat(20))], // exatamente o declarado
    ]);
    const registry = new ProviderRegistry();
    registry.register(createArchiveOrgProvider({ fetchFn, isHostAllowed: isAllowedHost }));

    const { baseUrl, close } = await startTestServer({ registry, storage, isHostAllowed: isAllowedHost, maxDownloadSizeBytes: 500 });
    try {
      const resolveRes = await fetch(`${baseUrl}/api/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://archive.org/details/public-domain-short' }),
      });
      const { data } = await resolveRes.json();
      const downloadRes = await fetch(`${baseUrl}/api/download/${data.formats[0].downloadId}`);
      assert.equal(downloadRes.status, 200);
    } finally {
      await close();
    }
  });
});

test('Size Guard: record.sizeBytes declarado pela fonte acima do limite -> 413 antecipado, provider de download nunca chamado', async () => {
  await withTempStorage(async (storage, baseDir) => {
    let downloadCalled = false;
    const bigItem = { metadata: { title: 'Filme Grande' }, files: [{ name: 'big.mp4', format: 'h.264', size: '999999999' }] };
    const fetchFn = fakeFetchDispatcher([
      [/\/metadata\//, () => jsonBody(bigItem)],
      [
        /\/download\//,
        () => {
          downloadCalled = true;
          return fileBody('nunca devia chegar aqui');
        },
      ],
    ]);
    const registry = new ProviderRegistry();
    registry.register(createArchiveOrgProvider({ fetchFn, isHostAllowed: isAllowedHost }));

    const { baseUrl, close } = await startTestServer({ registry, storage, isHostAllowed: isAllowedHost, maxDownloadSizeBytes: 500 });
    try {
      const resolveRes = await fetch(`${baseUrl}/api/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://archive.org/details/filme-grande' }),
      });
      const { data } = await resolveRes.json();

      const downloadRes = await fetch(`${baseUrl}/api/download/${data.formats[0].downloadId}`);
      const downloadBody = await downloadRes.json();
      assert.equal(downloadRes.status, 413);
      assert.equal(downloadBody.error, 'O ficheiro excede o tamanho máximo permitido.');
      assert.equal(downloadCalled, false, 'a rejeição antecipada tinha de acontecer antes de sequer chamar getDownloadStream()');

      const entries = await fsp.readdir(baseDir);
      assert.equal(entries.length, 0);
    } finally {
      await close();
    }
  });
});

test('Size Guard: tamanho declarado pela fonte INCORRETO (menor que o real) -> guard durante a escrita apanha, 413, sem ficheiros órfãos', async () => {
  await withTempStorage(async (storage, baseDir) => {
    // A fonte "mente": declara 10 bytes no metadata, mas o ficheiro real
    // enviado no download é muito maior -- só o SizeGuardTransform,
    // durante a escrita real, apanha isto (não o valor declarado).
    const lyingItem = { metadata: { title: 'Declaração Incorreta' }, files: [{ name: 'lie.mp4', format: 'h.264', size: '10' }] };
    const fetchFn = fakeFetchDispatcher([
      [/\/metadata\//, () => jsonBody(lyingItem)],
      [/\/download\//, () => fileBody('x'.repeat(500))], // 500 bytes reais, declarado só 10
    ]);
    const registry = new ProviderRegistry();
    registry.register(createArchiveOrgProvider({ fetchFn, isHostAllowed: isAllowedHost }));

    const { baseUrl, close } = await startTestServer({ registry, storage, isHostAllowed: isAllowedHost, maxDownloadSizeBytes: 100 });
    try {
      const resolveRes = await fetch(`${baseUrl}/api/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://archive.org/details/declaracao-incorreta' }),
      });
      const { data } = await resolveRes.json();
      assert.equal(data.formats[0].sizeBytes, 10); // valor declarado (incorreto) devolvido ao cliente tal e qual

      const downloadRes = await fetch(`${baseUrl}/api/download/${data.formats[0].downloadId}`);
      const downloadBody = await downloadRes.json();
      assert.equal(downloadRes.status, 413);
      assert.equal(downloadBody.error, 'O ficheiro excede o tamanho máximo permitido.');

      const entries = await fsp.readdir(baseDir);
      assert.equal(entries.length, 0, `esperava 0 ficheiros órfãos, encontrei: ${JSON.stringify(entries)}`);
    } finally {
      await close();
    }
  });
});

test('item restrito nunca chega a produzir um downloadId (Etapa 3 integrada end-to-end)', async () => {
  await withTempStorage(async (storage) => {
    const restrictedItem = {
      metadata: { title: 'Restrito', 'access-restricted-item': 'true' },
      files: [{ name: 'a.mp4', format: 'h.264', size: '100' }],
    };
    const fetchFn = fakeFetchDispatcher([[/\/metadata\//, () => jsonBody(restrictedItem)]]);
    const registry = new ProviderRegistry();
    registry.register(createArchiveOrgProvider({ fetchFn, isHostAllowed: isAllowedHost }));

    const { baseUrl, close } = await startTestServer({ registry, storage, isHostAllowed: isAllowedHost });
    try {
      const resolveRes = await fetch(`${baseUrl}/api/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://archive.org/details/item-restrito' }),
      });
      const body = await resolveRes.json();
      assert.equal(resolveRes.status, 404);
      assert.equal(body.error, 'Item não encontrado.');
      assert.equal(body.success, undefined);
    } finally {
      await close();
    }
  });
});
