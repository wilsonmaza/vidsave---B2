import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUrl } from '../../src/services/resolve.service.js';
import { ProviderRegistry, ProviderNotFoundError } from '../../src/providers/registry.js';
import { ProviderError } from '../../src/providers/provider.interface.js';
import { SecurityValidationError } from '../../src/security/url-validator.js';
import { DownloadStore } from '../../src/services/download.service.js';

// Uma única instância partilhada por todos os testes deste ficheiro —
// cada create() gera sempre um downloadId novo e independente, por isso
// não há interferência entre testes. O timer de limpeza é unref()ado,
// mas paramo-lo explicitamente no fim por higiene.
const downloadStore = new DownloadStore({ ttlMs: 60000 });
after(() => downloadStore.stop());

function spyProvider(id, { handles = () => true, resolveImpl } = {}) {
  const calls = { canHandle: 0, resolve: 0 };
  return {
    calls,
    provider: {
      id,
      canHandle(url) {
        calls.canHandle += 1;
        return handles(url);
      },
      async resolve(url) {
        calls.resolve += 1;
        if (resolveImpl) return resolveImpl(url);
        return {
          title: id,
          thumbnail: null,
          duration: null,
          formats: [{ formatId: 'default', quality: 'sd', format: 'mp4', sizeBytes: 1 }],
        };
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

// --- Validação do body/URL ---

test('rejeita corpo vazio', async () => {
  const registry = new ProviderRegistry();
  await assert.rejects(() => resolveUrl(undefined, { registry, downloadStore }), SecurityValidationError);
  await assert.rejects(() => resolveUrl(null, { registry, downloadStore }), SecurityValidationError);
});

test('rejeita corpo que é um array', async () => {
  const registry = new ProviderRegistry();
  await assert.rejects(() => resolveUrl([], { registry, downloadStore }), SecurityValidationError);
});

test('rejeita quando "url" está ausente', async () => {
  const registry = new ProviderRegistry();
  await assert.rejects(() => resolveUrl({}, { registry, downloadStore }), SecurityValidationError);
});

test('rejeita quando "url" está vazio ou só com espaços', async () => {
  const registry = new ProviderRegistry();
  await assert.rejects(() => resolveUrl({ url: '' }, { registry, downloadStore }), SecurityValidationError);
  await assert.rejects(() => resolveUrl({ url: '   ' }, { registry, downloadStore }), SecurityValidationError);
});

test('rejeita quando "url" não é uma string', async () => {
  const registry = new ProviderRegistry();
  for (const badUrl of [123, true, {}, [], null]) {
    await assert.rejects(() => resolveUrl({ url: badUrl }, { registry, downloadStore }), SecurityValidationError);
  }
});

test('rejeita URL sintaticamente inválido', async () => {
  const registry = new ProviderRegistry();
  await assert.rejects(
    () => resolveUrl({ url: 'isto não é um url' }, { registry, downloadStore }),
    SecurityValidationError
  );
});

test('rejeita protocolos proibidos', async () => {
  const registry = new ProviderRegistry();
  for (const url of ['file:///etc/passwd', 'ftp://example.com', 'javascript:alert(1)']) {
    await assert.rejects(() => resolveUrl({ url }, { registry, downloadStore }), SecurityValidationError);
  }
});

test('rejeita URL demasiado longo', async () => {
  const registry = new ProviderRegistry();
  const url = 'http://example.com/' + 'a'.repeat(3000);
  await assert.rejects(() => resolveUrl({ url }, { registry, downloadStore }), SecurityValidationError);
});

test('rejeita URL com credenciais embutidas', async () => {
  const registry = new ProviderRegistry();
  await assert.rejects(
    () => resolveUrl({ url: 'http://user:pass@example.com' }, { registry, downloadStore }),
    SecurityValidationError
  );
});

// --- SSRF Guard integrado no service ---

test('rejeita hostname que resolve para IP privado, e o provider nunca é chamado', async () => {
  const registry = new ProviderRegistry();
  const { provider, calls } = spyProvider('spy', { handles: () => true });
  registry.register(provider);

  const lookup = fakeLookup({ 'interno.exemplo.com': { address: '10.0.0.5', family: 4 } });

  await assert.rejects(
    () => resolveUrl({ url: 'http://interno.exemplo.com/x' }, { registry, downloadStore, lookup }),
    SecurityValidationError
  );
  assert.equal(calls.canHandle, 0, 'canHandle não devia ter sido chamado');
  assert.equal(calls.resolve, 0, 'resolve não devia ter sido chamado');
});

test('a resolução do domínio de demonstração (sample.test) funciona sem lookup real injetado', async () => {
  const registry = new ProviderRegistry();
  const { provider } = spyProvider('spy', {
    handles: (url) => url.startsWith('https://sample.test/'),
    resolveImpl: async () => ({
      title: 'ok',
      thumbnail: null,
      duration: null,
      formats: [{ formatId: 'a', quality: 'sd', format: 'mp4', sizeBytes: 1 }],
    }),
  });
  registry.register(provider);

  // Sem `lookup` injetado: usa o override de produção para sample.test,
  // que não faz nenhuma chamada de rede real.
  const media = await resolveUrl({ url: 'https://sample.test/demo/video-1' }, { registry, downloadStore });
  assert.equal(media.title, 'ok');
});

// --- Provider Registry integrado no service ---

test('propaga ProviderNotFoundError quando nenhum provider é compatível', async () => {
  const registry = new ProviderRegistry(); // vazio
  const lookup = fakeLookup({ 'publico.exemplo.com': { address: '93.184.216.34', family: 4 } });

  await assert.rejects(
    () => resolveUrl({ url: 'http://publico.exemplo.com/x' }, { registry, downloadStore, lookup }),
    ProviderNotFoundError
  );
});

test('devolve o resultado de resolve() quando um provider compatível existe', async () => {
  const registry = new ProviderRegistry();
  const { provider } = spyProvider('spy', {
    resolveImpl: async () => ({
      title: 'Vídeo',
      thumbnail: null,
      duration: 10,
      formats: [{ formatId: 'a', quality: 'sd', format: 'mp4', sizeBytes: 1 }],
    }),
  });
  registry.register(provider);

  const lookup = fakeLookup({ 'publico.exemplo.com': { address: '93.184.216.34', family: 4 } });
  const media = await resolveUrl({ url: 'http://publico.exemplo.com/x' }, { registry, downloadStore, lookup });

  assert.equal(media.title, 'Vídeo');
  assert.equal(media.duration, 10);
});

test('propaga um erro lançado pelo provider', async () => {
  const registry = new ProviderRegistry();
  const { provider } = spyProvider('spy', {
    resolveImpl: async () => {
      throw new ProviderError('falha simulada', { publicMessage: 'Falha no provider.' });
    },
  });
  registry.register(provider);

  const lookup = fakeLookup({ 'publico.exemplo.com': { address: '93.184.216.34', family: 4 } });

  await assert.rejects(
    () => resolveUrl({ url: 'http://publico.exemplo.com/x' }, { registry, downloadStore, lookup }),
    ProviderError
  );
});

// --- Etapa 5.1: um provider mal implementado não pode devolver dados arbitrários ---

test('rejeita quando o provider devolve metadata sem título', async () => {
  const registry = new ProviderRegistry();
  const { provider } = spyProvider('mal-comportado', {
    resolveImpl: async () => ({ thumbnail: null, duration: null, formats: [] }), // sem "title"
  });
  registry.register(provider);

  const lookup = fakeLookup({ 'publico.exemplo.com': { address: '93.184.216.34', family: 4 } });

  await assert.rejects(
    () => resolveUrl({ url: 'http://publico.exemplo.com/x' }, { registry, downloadStore, lookup }),
    ProviderError
  );
});

test('rejeita quando o provider devolve formats vazio ou mal formado', async () => {
  const registry = new ProviderRegistry();
  const { provider } = spyProvider('mal-comportado', {
    resolveImpl: async () => ({ title: 'x', thumbnail: null, duration: null, formats: [] }),
  });
  registry.register(provider);

  const lookup = fakeLookup({ 'publico.exemplo.com': { address: '93.184.216.34', family: 4 } });

  await assert.rejects(
    () => resolveUrl({ url: 'http://publico.exemplo.com/x' }, { registry, downloadStore, lookup }),
    ProviderError
  );
});

test('rejeita quando um formato não tem sizeBytes numérico', async () => {
  const registry = new ProviderRegistry();
  const { provider } = spyProvider('mal-comportado', {
    resolveImpl: async () => ({
      title: 'x',
      thumbnail: null,
      duration: null,
      formats: [{ formatId: 'a', quality: 'hd', format: 'mp4', sizeBytes: 'muito grande' }],
    }),
  });
  registry.register(provider);

  const lookup = fakeLookup({ 'publico.exemplo.com': { address: '93.184.216.34', family: 4 } });

  await assert.rejects(
    () => resolveUrl({ url: 'http://publico.exemplo.com/x' }, { registry, downloadStore, lookup }),
    ProviderError
  );
});

test('rejeita quando o provider devolve algo que nem sequer é um objeto', async () => {
  const registry = new ProviderRegistry();
  const { provider } = spyProvider('mal-comportado', { resolveImpl: async () => 'não sou um objeto' });
  registry.register(provider);

  const lookup = fakeLookup({ 'publico.exemplo.com': { address: '93.184.216.34', family: 4 } });

  await assert.rejects(
    () => resolveUrl({ url: 'http://publico.exemplo.com/x' }, { registry, downloadStore, lookup }),
    ProviderError
  );
});

test('aceita metadata válida com thumbnail e duration nulos (campos opcionais)', async () => {
  const registry = new ProviderRegistry();
  const { provider } = spyProvider('bem-comportado', {
    resolveImpl: async () => ({
      title: 'Vídeo válido',
      thumbnail: null,
      duration: null,
      formats: [{ formatId: 'a', quality: 'hd', format: 'mp4', sizeBytes: 100 }],
    }),
  });
  registry.register(provider);

  const lookup = fakeLookup({ 'publico.exemplo.com': { address: '93.184.216.34', family: 4 } });

  const media = await resolveUrl({ url: 'http://publico.exemplo.com/x' }, { registry, downloadStore, lookup });
  assert.equal(media.title, 'Vídeo válido');
});

// --- Etapa 6.2: downloadId por formato, opaco, criado só no fim ---

test('cada formato recebe o seu próprio downloadId, todos diferentes entre si', async () => {
  const registry = new ProviderRegistry();
  const { provider } = spyProvider('multi-formato', {
    resolveImpl: async () => ({
      title: 'Vídeo com vários formatos',
      thumbnail: null,
      duration: 5,
      formats: [
        { formatId: 'interno-720p', quality: '720p', format: 'mp4', sizeBytes: 100 },
        { formatId: 'interno-480p', quality: '480p', format: 'mp4', sizeBytes: 50 },
      ],
    }),
  });
  registry.register(provider);

  const lookup = fakeLookup({ 'publico.exemplo.com': { address: '93.184.216.34', family: 4 } });
  const media = await resolveUrl({ url: 'http://publico.exemplo.com/x' }, { registry, downloadStore, lookup });

  assert.equal(media.formats.length, 2);
  assert.notEqual(media.formats[0].downloadId, media.formats[1].downloadId);
  for (const format of media.formats) {
    assert.equal(typeof format.downloadId, 'string');
    assert.ok(format.downloadId.length >= 40);
  }
});

test('a resposta pública nunca inclui formatId — só downloadId, quality, format, sizeBytes', async () => {
  const registry = new ProviderRegistry();
  const { provider } = spyProvider('spy', {
    resolveImpl: async () => ({
      title: 'x',
      thumbnail: null,
      duration: null,
      formats: [{ formatId: 'formato-interno-secreto', quality: 'hd', format: 'mp4', sizeBytes: 10 }],
    }),
  });
  registry.register(provider);

  const lookup = fakeLookup({ 'publico.exemplo.com': { address: '93.184.216.34', family: 4 } });
  const media = await resolveUrl({ url: 'http://publico.exemplo.com/x' }, { registry, downloadStore, lookup });

  const format = media.formats[0];
  assert.equal(format.formatId, undefined);
  assert.deepEqual(Object.keys(format).sort(), ['downloadId', 'format', 'quality', 'sizeBytes']);
  assert.equal(JSON.stringify(media).includes('formato-interno-secreto'), false);
});

test('providerId/formatId enviados pelo cliente no corpo são simplesmente ignorados', async () => {
  const registry = new ProviderRegistry();
  const { provider } = spyProvider('spy', {
    resolveImpl: async () => ({
      title: 'x',
      thumbnail: null,
      duration: null,
      formats: [{ formatId: 'real', quality: 'hd', format: 'mp4', sizeBytes: 10 }],
    }),
  });
  registry.register(provider);

  const lookup = fakeLookup({ 'publico.exemplo.com': { address: '93.184.216.34', family: 4 } });
  const media = await resolveUrl(
    { url: 'http://publico.exemplo.com/x', providerId: 'outro-provider-qualquer', formatId: 'outro-formato' },
    { registry, downloadStore, lookup }
  );

  // O pedido teve sucesso normal, usando o provider real (encontrado
  // pelo registry a partir do URL) — os campos extra no corpo nunca
  // chegam a ser lidos em lado nenhum.
  assert.equal(media.title, 'x');
});

test('o registo interno criado no DownloadStore aponta para o provider e formatId reais', async () => {
  const registry = new ProviderRegistry();
  const { provider } = spyProvider('provider-real', {
    resolveImpl: async () => ({
      title: 'x',
      thumbnail: null,
      duration: null,
      formats: [{ formatId: 'formatId-interno-real', quality: 'hd', format: 'mp4', sizeBytes: 10 }],
    }),
  });
  registry.register(provider);

  const lookup = fakeLookup({ 'publico.exemplo.com': { address: '93.184.216.34', family: 4 } });
  const media = await resolveUrl({ url: 'http://publico.exemplo.com/x' }, { registry, downloadStore, lookup });

  const record = downloadStore.get(media.formats[0].downloadId);
  assert.ok(record, 'o downloadId devolvido tem de corresponder a um registo real');
  assert.equal(record.providerId, 'provider-real');
  assert.equal(record.formatId, 'formatId-interno-real');
  assert.equal(record.consumed, false);
});
