import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createArchiveOrgProvider } from '../../src/providers/archive-org-provider.js';
import { ProviderError } from '../../src/providers/provider.interface.js';
import { SecurityValidationError } from '../../src/security/url-validator.js';

function jsonFetch(status, bodyObj, { headers = {} } = {}) {
  return async () => ({ status, headers, stream: Readable.from([Buffer.from(JSON.stringify(bodyObj))]) });
}

function rawFetch(status, bytesOrString, { headers = {} } = {}) {
  const buf = typeof bytesOrString === 'string' ? Buffer.from(bytesOrString) : Buffer.from(bytesOrString);
  return async () => ({ status, headers, stream: Readable.from([buf]) });
}

function spyFetch(impl) {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    return impl(url, options);
  };
  return { fetchFn, calls };
}

const VALID_METADATA = {
  metadata: { title: 'A Trip to the Moon', runtime: '00:14:03' },
  files: [
    { name: 'trip_to_the_moon.mp4', format: 'h.264', size: '52428800' },
    { name: 'trip_to_the_moon.ogv', format: 'Ogg Video', size: '41943040' },
    { name: 'trip_to_the_moon.srt', format: 'SubRip', size: '2048' }, // não é vídeo
    { name: '__ia_thumb.jpg', format: 'Item Tile', size: '4096' }, // não é vídeo
  ],
};

// =====================================================================
// 1. canHandle()
// =====================================================================

test('canHandle: URL válida (details + identifier válido) -> true', () => {
  const provider = createArchiveOrgProvider();
  assert.equal(provider.canHandle('https://archive.org/details/night_of_the_living_dead'), true);
});

test('canHandle: www.archive.org -> true', () => {
  const provider = createArchiveOrgProvider();
  assert.equal(provider.canHandle('https://www.archive.org/details/Night.Of.The.Living.Dead_1080p'), true);
});

test('canHandle: host errado -> false', () => {
  const provider = createArchiveOrgProvider();
  assert.equal(provider.canHandle('https://example.com/details/night_of_the_living_dead'), false);
  assert.equal(provider.canHandle('https://not-archive.org/details/x'), false);
  assert.equal(provider.canHandle('https://archive.org.evil.com/details/x'), false);
});

test('canHandle: path errado -> false', () => {
  const provider = createArchiveOrgProvider();
  assert.equal(provider.canHandle('https://archive.org/download/x/y.mp4'), false);
  assert.equal(provider.canHandle('https://archive.org/details/'), false);
  assert.equal(provider.canHandle('https://archive.org/'), false);
  assert.equal(provider.canHandle('https://archive.org/search?query=x'), false);
});

test('canHandle: identifier inválido -> false', () => {
  const provider = createArchiveOrgProvider();
  assert.equal(provider.canHandle('https://archive.org/details/com espaço'), false);
  assert.equal(provider.canHandle('https://archive.org/details/_comeca-com-underscore'), false);
  assert.equal(provider.canHandle('https://archive.org/details/tem/barra'), false);
  assert.equal(provider.canHandle('https://archive.org/details/' + 'a'.repeat(101)), false); // máx 100
});

test('canHandle: URL sintaticamente inválido não lança, só devolve false', () => {
  const provider = createArchiveOrgProvider();
  assert.equal(provider.canHandle('isto não é um url'), false);
});

// =====================================================================
// 2. resolve()
// =====================================================================

test('resolve: metadata válida -> ResolvedMedia correto, só ficheiros de vídeo', async () => {
  const provider = createArchiveOrgProvider({ fetchFn: jsonFetch(200, VALID_METADATA) });
  const media = await provider.resolve('https://archive.org/details/trip-to-the-moon');

  assert.equal(media.title, 'A Trip to the Moon');
  assert.equal(media.duration, 14 * 60 + 3);
  assert.equal(media.thumbnail, 'https://archive.org/services/img/trip-to-the-moon');
  assert.equal(media.formats.length, 2); // só .mp4 e .ogv -- srt e jpg excluídos
  assert.deepEqual(
    media.formats.map((f) => f.format).sort(),
    ['mp4', 'ogv']
  );
});

test('resolve: vários ficheiros de vídeo -> um formato por ficheiro, sizeBytes correto', async () => {
  const provider = createArchiveOrgProvider({ fetchFn: jsonFetch(200, VALID_METADATA) });
  const media = await provider.resolve('https://archive.org/details/trip-to-the-moon');

  const mp4 = media.formats.find((f) => f.format === 'mp4');
  assert.equal(mp4.sizeBytes, 52428800);
  assert.equal(mp4.quality, 'h.264');
  const ogv = media.formats.find((f) => f.format === 'ogv');
  assert.equal(ogv.sizeBytes, 41943040);
});

test('resolve: ficheiro sem tamanho -> sizeBytes=0, formato mantido (não descartado)', async () => {
  const metadata = {
    metadata: { title: 'x' },
    files: [{ name: 'a.mp4', format: 'h.264' }], // sem "size"
  };
  const provider = createArchiveOrgProvider({ fetchFn: jsonFetch(200, metadata) });
  const media = await provider.resolve('https://archive.org/details/x');

  assert.equal(media.formats.length, 1);
  assert.equal(media.formats[0].sizeBytes, 0);
});

test('resolve: item sem nenhum ficheiro de vídeo -> ProviderError 404', async () => {
  const metadata = { metadata: { title: 'x' }, files: [{ name: 'a.srt', format: 'SubRip', size: '10' }] };
  const provider = createArchiveOrgProvider({ fetchFn: jsonFetch(200, metadata) });
  await assert.rejects(
    () => provider.resolve('https://archive.org/details/x'),
    (err) => err instanceof ProviderError && err.status === 404
  );
});

test('resolve: item restrito (access-restricted-item) -> ProviderError 404, tratado como não encontrado', async () => {
  const metadata = {
    metadata: { title: 'Livro Emprestado', 'access-restricted-item': 'true' },
    files: [{ name: 'a.mp4', format: 'h.264', size: '100' }],
  };
  const provider = createArchiveOrgProvider({ fetchFn: jsonFetch(200, metadata) });
  await assert.rejects(
    () => provider.resolve('https://archive.org/details/x'),
    (err) => err instanceof ProviderError && err.status === 404 && err.message === 'Item não encontrado.'
  );
});

test('resolve: item "dark" (is_dark) -> ProviderError 404', async () => {
  const metadata = { is_dark: true, metadata: {}, files: [{ name: 'a.mp4', size: '100' }] };
  const provider = createArchiveOrgProvider({ fetchFn: jsonFetch(200, metadata) });
  await assert.rejects(
    () => provider.resolve('https://archive.org/details/x'),
    (err) => err instanceof ProviderError && err.status === 404
  );
});

test('resolve: item sem sinal de restrição continua a resolver normalmente (não é falso positivo)', async () => {
  const provider = createArchiveOrgProvider({ fetchFn: jsonFetch(200, VALID_METADATA) });
  await assert.doesNotReject(() => provider.resolve('https://archive.org/details/x'));
});

test('resolve: resposta 404 -> ProviderError 404', async () => {
  const provider = createArchiveOrgProvider({ fetchFn: jsonFetch(404, {}) });
  await assert.rejects(
    () => provider.resolve('https://archive.org/details/nao-existe'),
    (err) => err instanceof ProviderError && err.status === 404
  );
});

test('resolve: identifier inexistente devolve 200 com corpo vazio {} -> tratado como 404', async () => {
  // A Metadata API real não garante sempre um 404 HTTP -- um identifier
  // que nunca existiu também pode devolver 200 com {} vazio.
  const provider = createArchiveOrgProvider({ fetchFn: jsonFetch(200, {}) });
  await assert.rejects(
    () => provider.resolve('https://archive.org/details/nunca-existiu'),
    (err) => err instanceof ProviderError && err.status === 404
  );
});

test('resolve: resposta inválida (JSON malformado) -> ProviderError 500', async () => {
  const provider = createArchiveOrgProvider({ fetchFn: rawFetch(200, 'isto não é json {{{') });
  await assert.rejects(
    () => provider.resolve('https://archive.org/details/x'),
    (err) => err instanceof ProviderError && err.status === 500
  );
});

test('resolve: erro de rede -> ProviderError 500, sem detalhe interno na mensagem pública', async () => {
  const provider = createArchiveOrgProvider({
    fetchFn: async () => {
      throw new Error('ECONNRESET simulado');
    },
  });
  try {
    await provider.resolve('https://archive.org/details/x');
    assert.fail('devia ter lançado');
  } catch (err) {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.status, 500);
    assert.equal(err.message.includes('ECONNRESET'), false);
  }
});

test('resolve: SecurityValidationError (SSRF/allowlist) do fetchFn passa tal e qual, não vira ProviderError', async () => {
  const provider = createArchiveOrgProvider({
    fetchFn: async () => {
      throw new SecurityValidationError('bloqueado pelo guard');
    },
  });
  await assert.rejects(() => provider.resolve('https://archive.org/details/x'), SecurityValidationError);
});

test('resolve: status HTTP inesperado (ex: 500 do próprio Archive.org) -> ProviderError 500', async () => {
  const provider = createArchiveOrgProvider({ fetchFn: jsonFetch(500, {}) });
  await assert.rejects(
    () => provider.resolve('https://archive.org/details/x'),
    (err) => err instanceof ProviderError && err.status === 500
  );
});

test('resolve: chama fetchFn com o URL de metadata correto e repassa isHostAllowed', async () => {
  const isHostAllowed = () => true;
  const { fetchFn, calls } = spyFetch(async () => ({
    status: 200,
    headers: {},
    stream: Readable.from([Buffer.from(JSON.stringify(VALID_METADATA))]),
  }));
  const provider = createArchiveOrgProvider({ fetchFn, isHostAllowed });
  await provider.resolve('https://archive.org/details/trip-to-the-moon');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://archive.org/metadata/trip-to-the-moon');
  assert.equal(calls[0].options.isHostAllowed, isHostAllowed);
});

// =====================================================================
// 3. getDownloadStream()
// =====================================================================

test('getDownloadStream: formatId válido -> stream + contentType corretos, URL certo', async () => {
  const { fetchFn, calls } = spyFetch(async () => ({
    status: 200,
    headers: { 'content-type': 'video/mp4' },
    stream: Readable.from([Buffer.from('bytes de video')]),
  }));
  const provider = createArchiveOrgProvider({ fetchFn });

  // formatId opaco -- gerado pelo próprio provider em resolve(), nunca
  // pelo cliente. Reconstrói-se aqui para o teste, do mesmo formato.
  const formatId = 'trip-to-the-moon::trip_to_the_moon.mp4';
  const result = await provider.getDownloadStream(formatId);

  assert.equal(result.contentType, 'video/mp4');
  assert.equal(calls[0].url, 'https://archive.org/download/trip-to-the-moon/trip_to_the_moon.mp4');
});

test('getDownloadStream: confirma que safeFetch recebe isHostAllowed', async () => {
  const isHostAllowed = () => true;
  const { fetchFn, calls } = spyFetch(async () => ({ status: 200, headers: {}, stream: Readable.from([Buffer.from('x')]) }));
  const provider = createArchiveOrgProvider({ fetchFn, isHostAllowed });

  await provider.getDownloadStream('id::file.mp4');
  assert.equal(calls[0].options.isHostAllowed, isHostAllowed);
});

test('getDownloadStream: formatId adulterado (sem separador) -> ProviderError 404, fetchFn nunca chamado', async () => {
  const { fetchFn, calls } = spyFetch(async () => ({ status: 200, headers: {}, stream: Readable.from([]) }));
  const provider = createArchiveOrgProvider({ fetchFn });

  await assert.rejects(
    () => provider.getDownloadStream('formatId-sem-separador'),
    (err) => err instanceof ProviderError && err.status === 404
  );
  assert.equal(calls.length, 0);
});

test('getDownloadStream: identifier inválido dentro do formatId -> ProviderError 404, fetchFn nunca chamado', async () => {
  const { fetchFn, calls } = spyFetch(async () => ({ status: 200, headers: {}, stream: Readable.from([]) }));
  const provider = createArchiveOrgProvider({ fetchFn });

  await assert.rejects(
    () => provider.getDownloadStream('_invalido-comeca-com-underscore::file.mp4'),
    (err) => err instanceof ProviderError && err.status === 404
  );
  assert.equal(calls.length, 0);
});

test('getDownloadStream: filename inválido (path traversal) -> ProviderError 404, fetchFn nunca chamado', async () => {
  const { fetchFn, calls } = spyFetch(async () => ({ status: 200, headers: {}, stream: Readable.from([]) }));
  const provider = createArchiveOrgProvider({ fetchFn });

  for (const badFilename of ['../../etc/passwd', 'a/b.mp4', 'a\\b.mp4', '..']) {
    await assert.rejects(
      () => provider.getDownloadStream(`identifier-valido::${badFilename}`),
      (err) => err instanceof ProviderError && err.status === 404,
      `devia ter rejeitado o filename "${badFilename}"`
    );
  }
  assert.equal(calls.length, 0);
});

test('getDownloadStream: 404 do Internet Archive -> ProviderError 404', async () => {
  const provider = createArchiveOrgProvider({ fetchFn: async () => ({ status: 404, headers: {}, stream: Readable.from([]) }) });
  await assert.rejects(
    () => provider.getDownloadStream('id::ficheiro-que-desapareceu.mp4'),
    (err) => err instanceof ProviderError && err.status === 404
  );
});

test('getDownloadStream: erro de rede -> ProviderError 500', async () => {
  const provider = createArchiveOrgProvider({
    fetchFn: async () => {
      throw new Error('timeout simulado');
    },
  });
  await assert.rejects(
    () => provider.getDownloadStream('id::file.mp4'),
    (err) => err instanceof ProviderError && err.status === 500
  );
});

test('getDownloadStream: SecurityValidationError do fetchFn passa tal e qual', async () => {
  const provider = createArchiveOrgProvider({
    fetchFn: async () => {
      throw new SecurityValidationError('host não permitido');
    },
  });
  await assert.rejects(() => provider.getDownloadStream('id::file.mp4'), SecurityValidationError);
});
