import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUrl } from '../../src/services/resolve.service.js';
import { SecurityValidationError } from '../../src/security/url-validator.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { DownloadStore } from '../../src/services/download.service.js';
import { isAllowedHost } from '../../src/config/allowlist.js';

function fakeLookup(map) {
  return async (hostname) => {
    const entry = map[hostname];
    if (!entry) throw new Error(`fakeLookup: sem entrada para "${hostname}"`);
    return Array.isArray(entry) ? entry : [entry];
  };
}

function providerThatMustNeverBeCalled(id) {
  return {
    id,
    canHandle: () => true,
    resolve: async () => {
      throw new Error(`provider "${id}" NUNCA devia ter sido chamado -- a allowlist tinha de bloquear antes`);
    },
    getDownloadStream: async () => ({ stream: null }),
  };
}

// --- host fora da allowlist é bloqueado antes do provider ---

test('host fora da allowlist é bloqueado por SecurityValidationError, sem chamar nenhum provider', async () => {
  const registry = new ProviderRegistry();
  registry.register(providerThatMustNeverBeCalled('qualquer'));
  const downloadStore = new DownloadStore({ ttlMs: 60000 });
  const lookup = fakeLookup({ 'nao-permitido.exemplo.com': { address: '93.184.216.34', family: 4 } });

  try {
    await assert.rejects(
      () =>
        resolveUrl(
          { url: 'https://nao-permitido.exemplo.com/x' },
          { registry, downloadStore, lookup, isHostAllowed: isAllowedHost }
        ),
      SecurityValidationError
    );
  } finally {
    downloadStore.stop();
  }
});

test('o bloqueio por allowlist acontece ANTES do SSRF Guard tentar sequer resolver DNS', async () => {
  const registry = new ProviderRegistry();
  registry.register(providerThatMustNeverBeCalled('qualquer'));
  const downloadStore = new DownloadStore({ ttlMs: 60000 });
  // lookup que falha o teste se for chamado -- prova que a allowlist
  // corre primeiro, antes até do assertSafeHostname.
  const lookup = async () => {
    throw new Error('lookup NUNCA devia ter sido chamado -- a allowlist tinha de bloquear antes do DNS');
  };

  try {
    await assert.rejects(
      () =>
        resolveUrl(
          { url: 'https://nao-permitido.exemplo.com/x' },
          { registry, downloadStore, lookup, isHostAllowed: isAllowedHost }
        ),
      SecurityValidationError
    );
  } finally {
    downloadStore.stop();
  }
});

// --- archive.org passa pela allowlist ---

test('archive.org passa pela allowlist real (isAllowedHost) e chega ao provider', async () => {
  const registry = new ProviderRegistry();
  let providerCalled = false;
  registry.register({
    id: 'archive-org',
    canHandle: () => true,
    resolve: async () => {
      providerCalled = true;
      return { title: 't', thumbnail: null, duration: null, formats: [{ formatId: 'f', quality: 'q', format: 'mp4', sizeBytes: 1 }] };
    },
    getDownloadStream: async () => ({ stream: null }),
  });
  const downloadStore = new DownloadStore({ ttlMs: 60000 });
  const lookup = fakeLookup({ 'archive.org': { address: '207.241.224.2', family: 4 } });

  try {
    await resolveUrl(
      { url: 'https://archive.org/details/qualquer-item' },
      { registry, downloadStore, lookup, isHostAllowed: isAllowedHost }
    );
    assert.equal(providerCalled, true);
  } finally {
    downloadStore.stop();
  }
});

test('sample.test (domínio do demo provider) também passa pela allowlist real', async () => {
  const registry = new ProviderRegistry();
  let providerCalled = false;
  registry.register({
    id: 'demo',
    canHandle: () => true,
    resolve: async () => {
      providerCalled = true;
      return { title: 't', thumbnail: null, duration: null, formats: [{ formatId: 'f', quality: 'q', format: 'txt', sizeBytes: 1 }] };
    },
    getDownloadStream: async () => ({ stream: null }),
  });
  const downloadStore = new DownloadStore({ ttlMs: 60000 });

  try {
    // sample.test usa o override de DNS embutido em resolve.service.js
    // (KNOWN_TEST_HOSTS) -- não precisa de lookup próprio aqui.
    await resolveUrl(
      { url: 'https://sample.test/demo/video-1' },
      { registry, downloadStore, isHostAllowed: isAllowedHost }
    );
    assert.equal(providerCalled, true);
  } finally {
    downloadStore.stop();
  }
});

test('sem isHostAllowed passado, a allowlist não é aplicada (comportamento por omissão, preserva testes existentes)', async () => {
  const registry = new ProviderRegistry();
  let providerCalled = false;
  registry.register({
    id: 'qualquer',
    canHandle: () => true,
    resolve: async () => {
      providerCalled = true;
      return { title: 't', thumbnail: null, duration: null, formats: [{ formatId: 'f', quality: 'q', format: 'mp4', sizeBytes: 1 }] };
    },
    getDownloadStream: async () => ({ stream: null }),
  });
  const downloadStore = new DownloadStore({ ttlMs: 60000 });
  const lookup = fakeLookup({ 'host-nao-listado.exemplo.com': { address: '93.184.216.34', family: 4 } });

  try {
    // Sem isHostAllowed -- mesmo um host fora da allowlist real passa,
    // exatamente como já acontecia antes desta etapa.
    await resolveUrl({ url: 'https://host-nao-listado.exemplo.com/x' }, { registry, downloadStore, lookup });
    assert.equal(providerCalled, true);
  } finally {
    downloadStore.stop();
  }
});
