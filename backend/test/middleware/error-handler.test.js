import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapErrorToResponse } from '../../src/middleware/error-handler.js';
import { SecurityValidationError } from '../../src/security/url-validator.js';
import { ProviderError } from '../../src/providers/provider.interface.js';
import { ProviderNotFoundError } from '../../src/providers/registry.js';

test('SecurityValidationError mapeia para o seu status (400) e mensagem pública', () => {
  const err = new SecurityValidationError('motivo interno, nunca visível ao cliente');
  const { status, message } = mapErrorToResponse(err);
  assert.equal(status, 400);
  assert.equal(message, 'URL inválido ou não permitido.');
});

test('ProviderNotFoundError mapeia para 404 com a sua mensagem pública', () => {
  const err = new ProviderNotFoundError('https://exemplo.com/x');
  const { status, message } = mapErrorToResponse(err);
  assert.equal(status, 404);
  assert.equal(message, 'Não conseguimos processar este link.');
});

test('ProviderError com status 4xx válido é respeitado', () => {
  const err = new ProviderError('motivo interno', { publicMessage: 'Pedido inválido.', status: 422 });
  const { status, message } = mapErrorToResponse(err);
  assert.equal(status, 422);
  assert.equal(message, 'Pedido inválido.');
});

test('ProviderError com status inválido (fora de 4xx) cai no 500 genérico', () => {
  for (const badStatus of [999, 200, 500, -1, 'quatrocentos', null, undefined, 3.5]) {
    const err = new ProviderError('motivo interno', { publicMessage: 'não devia aparecer', status: badStatus });
    const { status, message } = mapErrorToResponse(err);
    assert.equal(status, 500, `status inválido ${badStatus} devia cair em 500`);
    assert.equal(message, 'Algo correu mal. Tenta novamente.');
  }
});

test('um Error comum (não uma das nossas classes) mapeia sempre para 500 genérico', () => {
  const err = new Error('mensagem de exceção que não deve ser exposta');
  const { status, message } = mapErrorToResponse(err);
  assert.equal(status, 500);
  assert.equal(message, 'Algo correu mal. Tenta novamente.');
});

test('um erro comum com um campo .status coincidente NUNCA é confiado', () => {
  // Simula um erro de uma biblioteca qualquer que por acaso tem um
  // campo "status" -- não é uma instância das nossas classes, por isso
  // não pode influenciar a resposta.
  const err = new Error('erro de uma dependência qualquer');
  err.status = 403;
  const { status, message } = mapErrorToResponse(err);
  assert.equal(status, 500);
  assert.equal(message, 'Algo correu mal. Tenta novamente.');
});

test('um valor lançado que nem sequer é um Error mapeia para 500 genérico', () => {
  for (const thrown of ['string simples', 42, { message: 'objeto qualquer' }, null, undefined]) {
    const { status, message } = mapErrorToResponse(thrown);
    assert.equal(status, 500);
    assert.equal(message, 'Algo correu mal. Tenta novamente.');
  }
});
