import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapErrorToResponse } from '../../src/middleware/error-handler.js';
import { DownloadTooLargeError, DownloadError } from '../../src/services/download.service.js';

// --- Ponto F: DownloadTooLargeError, testada diretamente ---

test('DownloadTooLargeError tem sempre status 413, independentemente do detail interno', () => {
  const err = new DownloadTooLargeError('detalhe interno: downloadId=xyz, provider=acme, sizeBytes=999999999');
  assert.equal(err.status, 413);
  assert.equal(err.name, 'DownloadTooLargeError');
  assert.ok(err instanceof DownloadError, 'tem de seguir a hierarquia existente (DownloadError), não uma segunda hierarquia');
});

test('DownloadTooLargeError usa sempre a mesma mensagem pública fixa, nunca o detail interno', () => {
  const err1 = new DownloadTooLargeError('detalhe A, nunca visível ao cliente');
  const err2 = new DownloadTooLargeError('detalhe B completamente diferente');
  assert.equal(err1.message, 'O ficheiro excede o tamanho máximo permitido.');
  assert.equal(err1.message, err2.message);
  assert.equal(err1.message.includes('detalhe A'), false);
});

// --- Ponto F: mapeamento através de mapErrorToResponse() ---

test('mapErrorToResponse mapeia DownloadTooLargeError para 413 com a mensagem pública, sem qualquer alteração a error-handler.js', () => {
  const err = new DownloadTooLargeError('downloadId=abc123, sizeBytes=999999999, maxDownloadSizeBytes=524288000');
  const { status, message } = mapErrorToResponse(err);
  assert.equal(status, 413);
  assert.equal(message, 'O ficheiro excede o tamanho máximo permitido.');
  assert.equal(JSON.stringify({ status, message }).includes('999999999'), false, 'o detail interno nunca pode vazar para a resposta');
});

test('mapErrorToResponse reconhece DownloadTooLargeError pela mesma verificação "instanceof DownloadError" que já cobre DownloadNotFoundError -- não por um caso especial novo', () => {
  // Se error-handler.js tivesse sido alterado para adicionar um caso
  // especial só para DownloadTooLargeError, isso seria uma segunda
  // implementação/hierarquia de erros. Este teste confirma que o
  // reconhecimento vem só da hierarquia já existente: um DownloadError
  // "genérico" com status 413 (não a subclasse) é mapeado exatamente da
  // mesma forma.
  class OutraSubclasseDownloadError extends DownloadError {
    constructor(detail) {
      super(detail, { publicMessage: 'mensagem genérica de teste', status: 413 });
    }
  }
  const err = new OutraSubclasseDownloadError('qualquer detail');
  const { status, message } = mapErrorToResponse(err);
  assert.equal(status, 413);
  assert.equal(message, 'mensagem genérica de teste');
});
