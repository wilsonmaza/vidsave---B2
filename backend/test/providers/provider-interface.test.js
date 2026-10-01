import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidProvider, assertValidProvider, ProviderError } from '../../src/providers/provider.interface.js';

function validProvider(overrides = {}) {
  return {
    id: 'test-provider',
    canHandle: () => true,
    resolve: async () => ({}),
    getDownloadStream: async () => ({}),
    ...overrides,
  };
}

test('aceita um provider com forma correta', () => {
  assert.equal(isValidProvider(validProvider()), true);
  assert.doesNotThrow(() => assertValidProvider(validProvider()));
});

test('rejeita um provider sem id', () => {
  const provider = validProvider({ id: undefined });
  assert.equal(isValidProvider(provider), false);
  assert.throws(() => assertValidProvider(provider), ProviderError);
});

test('rejeita um provider com id vazio', () => {
  const provider = validProvider({ id: '  ' });
  assert.equal(isValidProvider(provider), false);
});

test('rejeita um provider a que falte canHandle', () => {
  const provider = validProvider({ canHandle: undefined });
  assert.equal(isValidProvider(provider), false);
});

test('rejeita um provider a que falte resolve', () => {
  const provider = validProvider({ resolve: undefined });
  assert.equal(isValidProvider(provider), false);
});

test('rejeita um provider a que falte getDownloadStream', () => {
  const provider = validProvider({ getDownloadStream: undefined });
  assert.equal(isValidProvider(provider), false);
});

test('rejeita valores que nem sequer são objetos', () => {
  assert.equal(isValidProvider(null), false);
  assert.equal(isValidProvider('provider'), false);
  assert.equal(isValidProvider(42), false);
});
