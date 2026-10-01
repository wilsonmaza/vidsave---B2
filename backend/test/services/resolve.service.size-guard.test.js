import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUrl } from '../../src/services/resolve.service.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { DownloadStore } from '../../src/services/download.service.js';

// Mesmo padrão de resolve.service.test.js: uma única instância partilhada,
// já que cada create() gera sempre um downloadId novo e independente.
const downloadStore = new DownloadStore({ ttlMs: 60000 });
after(() => downloadStore.stop());

function spyProvider(id, { resolveImpl } = {}) {
  return {
    provider: {
      id,
      canHandle: () => true,
      async resolve(url) {
        if (resolveImpl) return resolveImpl(url);
        return { title: id, thumbnail: null, duration: null, formats: [{ formatId: 'default', quality: 'sd', format: 'mp4', sizeBytes: 1 }] };
      },
      async getDownloadStream() {
        return { stream: null };
      },
    },
  };
}

function fakeLookup(map) {
  return async (hostname) => {
    const entry = map[hostname];
    if (!entry) throw new Error(`fakeLookup: sem entrada para "${hostname}"`);
    return Array.isArray(entry) ? entry : [entry];
  };
}

// --- Ponto A: format.sizeBytes é persistido no DownloadStore.create() ---

test('o sizeBytes declarado pelo provider fica gravado no registo do DownloadStore, igual ao devolvido na resposta pública', async () => {
  const registry = new ProviderRegistry();
  const { provider } = spyProvider('provider-tamanho', {
    resolveImpl: async () => ({
      title: 'x',
      thumbnail: null,
      duration: null,
      formats: [{ formatId: 'f1', quality: 'hd', format: 'mp4', sizeBytes: 123456 }],
    }),
  });
  registry.register(provider);

  const lookup = fakeLookup({ 'publico.exemplo.com': { address: '93.184.216.34', family: 4 } });
  const media = await resolveUrl({ url: 'http://publico.exemplo.com/x' }, { registry, downloadStore, lookup });

  // A resposta pública já continha sizeBytes antes desta etapa -- o que é
  // novo é o MESMO valor também ficar acessível via o registo interno.
  assert.equal(media.formats[0].sizeBytes, 123456);

  const record = downloadStore.get(media.formats[0].downloadId);
  assert.ok(record, 'o downloadId devolvido tem de corresponder a um registo real');
  assert.equal(typeof record.sizeBytes, 'number');
  assert.equal(record.sizeBytes, 123456);
});

test('sizeBytes=0 (formato legitimamente vazio) fica gravado como 0, nunca como null por confusão com "desconhecido"', async () => {
  const registry = new ProviderRegistry();
  const { provider } = spyProvider('provider-vazio', {
    resolveImpl: async () => ({
      title: 'x',
      thumbnail: null,
      duration: null,
      formats: [{ formatId: 'f1', quality: 'sd', format: 'mp4', sizeBytes: 0 }],
    }),
  });
  registry.register(provider);

  const lookup = fakeLookup({ 'outro.exemplo.com': { address: '93.184.216.34', family: 4 } });
  const media = await resolveUrl({ url: 'http://outro.exemplo.com/x' }, { registry, downloadStore, lookup });

  const record = downloadStore.get(media.formats[0].downloadId);
  assert.equal(record.sizeBytes, 0);
  assert.notEqual(record.sizeBytes, null);
});

test('múltiplos formatos do mesmo resolve ficam cada um com o SEU PRÓPRIO sizeBytes, sem misturar entre registos', async () => {
  const registry = new ProviderRegistry();
  const { provider } = spyProvider('provider-multi', {
    resolveImpl: async () => ({
      title: 'x',
      thumbnail: null,
      duration: null,
      formats: [
        { formatId: 'sd', quality: 'sd', format: 'mp4', sizeBytes: 1000 },
        { formatId: 'hd', quality: 'hd', format: 'mp4', sizeBytes: 9000 },
      ],
    }),
  });
  registry.register(provider);

  const lookup = fakeLookup({ 'multi.exemplo.com': { address: '93.184.216.34', family: 4 } });
  const media = await resolveUrl({ url: 'http://multi.exemplo.com/x' }, { registry, downloadStore, lookup });

  const [sd, hd] = media.formats;
  assert.equal(downloadStore.get(sd.downloadId).sizeBytes, 1000);
  assert.equal(downloadStore.get(hd.downloadId).sizeBytes, 9000);
});
