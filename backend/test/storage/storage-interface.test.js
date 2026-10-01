import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidStorage, assertValidStorage, StorageError } from '../../src/storage/storage.interface.js';

function validStorage(overrides = {}) {
  return {
    save: async () => ({ sizeBytes: 0 }),
    createReadStream: () => null,
    delete: async () => {},
    exists: async () => false,
    ...overrides,
  };
}

test('aceita um storage com forma correta', () => {
  assert.equal(isValidStorage(validStorage()), true);
  assert.doesNotThrow(() => assertValidStorage(validStorage()));
});

test('rejeita valores que nem sequer são objetos', () => {
  assert.equal(isValidStorage(null), false);
  assert.equal(isValidStorage('storage'), false);
  assert.equal(isValidStorage(42), false);
  assert.throws(() => assertValidStorage(null), StorageError);
});

test('rejeita um storage a que falte save', () => {
  assert.equal(isValidStorage(validStorage({ save: undefined })), false);
});

test('rejeita um storage a que falte createReadStream', () => {
  assert.equal(isValidStorage(validStorage({ createReadStream: undefined })), false);
});

test('rejeita um storage a que falte delete', () => {
  assert.equal(isValidStorage(validStorage({ delete: undefined })), false);
});

test('rejeita um storage a que falte exists', () => {
  assert.equal(isValidStorage(validStorage({ exists: undefined })), false);
});
