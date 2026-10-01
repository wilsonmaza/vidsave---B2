import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateUrlSyntax, SecurityValidationError } from '../../src/security/url-validator.js';

test('aceita http e https válidos', () => {
  assert.doesNotThrow(() => validateUrlSyntax('http://example.com'));
  assert.doesNotThrow(() => validateUrlSyntax('https://example.com/video/123'));
});

test('rejeita URL sintaticamente inválido', () => {
  assert.throws(() => validateUrlSyntax('isto não é um url'), SecurityValidationError);
  assert.throws(() => validateUrlSyntax(''), SecurityValidationError);
  assert.throws(() => validateUrlSyntax(null), SecurityValidationError);
});

test('rejeita protocolos que não sejam http/https', () => {
  for (const url of [
    'file:///etc/passwd',
    'ftp://example.com/file',
    'data:text/plain;base64,AA==',
    'javascript:alert(1)',
  ]) {
    assert.throws(() => validateUrlSyntax(url), SecurityValidationError, `devia rejeitar: ${url}`);
  }
});

test('rejeita URL excessivamente longo', () => {
  const longUrl = 'http://example.com/' + 'a'.repeat(3000);
  assert.throws(() => validateUrlSyntax(longUrl), SecurityValidationError);
});

test('rejeita URL com credenciais embutidas', () => {
  assert.throws(() => validateUrlSyntax('http://user:pass@example.com'), SecurityValidationError);
});

test('a mensagem pública do erro nunca revela o motivo exato', () => {
  try {
    validateUrlSyntax('ftp://internal-host/secret');
    assert.fail('devia ter lançado');
  } catch (err) {
    assert.equal(err.message, 'URL inválido ou não permitido.');
    assert.match(err.detail, /ftp/i); // o detalhe fica só no campo interno
  }
});
