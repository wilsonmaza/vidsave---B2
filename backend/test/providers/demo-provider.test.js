import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { demoProvider } from '../../src/providers/demo-provider.js';

const URL_VIDEO_1 = 'https://sample.test/demo/video-1';
const URL_VIDEO_2 = 'https://sample.test/demo/video-2';

// --- canHandle() ---

test('canHandle aceita os URLs de demonstração conhecidos', () => {
  assert.equal(demoProvider.canHandle(URL_VIDEO_1), true);
  assert.equal(demoProvider.canHandle(URL_VIDEO_2), true);
});

test('canHandle rejeita hosts que não sejam o domínio de demonstração', () => {
  assert.equal(demoProvider.canHandle('https://youtube.com/demo/video-1'), false);
});

test('canHandle rejeita itens de demonstração inexistentes', () => {
  assert.equal(demoProvider.canHandle('https://sample.test/demo/video-999'), false);
});

test('canHandle rejeita URLs inválidos sem lançar', () => {
  assert.equal(demoProvider.canHandle('isto não é um url'), false);
});

// --- resolve() ---

test('resolve devolve título, thumbnail, duração e formatos para um item válido', async () => {
  const media = await demoProvider.resolve(URL_VIDEO_1);

  assert.equal(media.title, 'VidSave — vídeo de demonstração 1');
  assert.equal(media.thumbnail, null);
  assert.equal(media.duration, 5);
  assert.equal(Array.isArray(media.formats), true);
  assert.equal(media.formats.length, 2);
});

test('resolve rejeita um item de demonstração desconhecido', async () => {
  await assert.rejects(() => demoProvider.resolve('https://sample.test/demo/nao-existe'));
});

// --- Formatos retornados ---

test('cada formato tem formatId, quality, format e sizeBytes', async () => {
  const media = await demoProvider.resolve(URL_VIDEO_1);

  for (const format of media.formats) {
    assert.equal(typeof format.formatId, 'string');
    assert.equal(typeof format.quality, 'string');
    assert.equal(typeof format.format, 'string');
    assert.equal(typeof format.sizeBytes, 'number');
    assert.ok(format.sizeBytes > 0);
  }
});

// --- getDownloadStream() ---

test('getDownloadStream devolve um stream legível com o conteúdo real do ficheiro', async () => {
  const media = await demoProvider.resolve(URL_VIDEO_1);
  const { stream, contentType } = await demoProvider.getDownloadStream(media.formats[0].formatId);

  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const content = Buffer.concat(chunks).toString('utf-8');

  assert.match(content, /Item: video-1/);
  assert.equal(contentType, 'text/plain; charset=utf-8');
});

test('getDownloadStream rejeita um formatId desconhecido', async () => {
  await assert.rejects(() => demoProvider.getDownloadStream('formato-que-nao-existe'));
});

// --- Ausência de estado partilhado entre chamadas ---

test('mutar o resultado de uma chamada não afeta chamadas seguintes', async () => {
  const first = await demoProvider.resolve(URL_VIDEO_1);
  first.title = 'TÍTULO ALTERADO';
  first.formats.push({ formatId: 'fake', quality: 'fake', format: 'fake', sizeBytes: 0 });
  first.formats[0].quality = 'ALTERADO';

  const second = await demoProvider.resolve(URL_VIDEO_1);

  assert.equal(second.title, 'VidSave — vídeo de demonstração 1');
  assert.equal(second.formats.length, 2);
  assert.notEqual(second.formats[0].quality, 'ALTERADO');
});

test('resolve() concorrente para itens diferentes não mistura os resultados', async () => {
  const [resultA, resultB] = await Promise.all([
    demoProvider.resolve(URL_VIDEO_1),
    demoProvider.resolve(URL_VIDEO_2),
  ]);

  assert.equal(resultA.title, 'VidSave — vídeo de demonstração 1');
  assert.equal(resultB.title, 'VidSave — vídeo de demonstração 2');
  assert.notEqual(resultA.title, resultB.title);
});

test('muitas chamadas concorrentes e intercaladas devolvem sempre o resultado correto para cada URL', async () => {
  const calls = [];
  for (let i = 0; i < 20; i += 1) {
    calls.push(demoProvider.resolve(i % 2 === 0 ? URL_VIDEO_1 : URL_VIDEO_2));
  }

  const results = await Promise.all(calls);

  results.forEach((result, i) => {
    const expectedTitle = i % 2 === 0
      ? 'VidSave — vídeo de demonstração 1'
      : 'VidSave — vídeo de demonstração 2';
    assert.equal(result.title, expectedTitle);
  });
});

test('os ficheiros de fixture existem e não estão vazios (verificação de sanidade)', () => {
  const media1 = demoProvider.canHandle(URL_VIDEO_1);
  assert.equal(media1, true);
  // getDownloadStream já confirma a leitura real; isto só garante que o
  // teste acima não estava a ler um ficheiro vazio por acidente.
  const stat = fs.statSync(new URL('../../src/providers/fixtures/demo-video-1.txt', import.meta.url));
  assert.ok(stat.size > 0);
});
