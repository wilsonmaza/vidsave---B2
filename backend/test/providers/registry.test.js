import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRegistry, ProviderNotFoundError, DuplicateProviderError } from '../../src/providers/registry.js';
import { ProviderError } from '../../src/providers/provider.interface.js';

function fakeProvider(id, { handles = () => true } = {}) {
  return {
    id,
    canHandle: handles,
    resolve: async () => ({ title: id, thumbnail: null, duration: null, formats: [] }),
    getDownloadStream: async () => ({ stream: null }),
  };
}

test('registry sem providers lança erro controlado ao procurar', () => {
  const registry = new ProviderRegistry();
  assert.throws(() => registry.findForUrl('https://example.com/x'), ProviderNotFoundError);
});

test('registry com um provider compatível devolve esse provider', () => {
  const registry = new ProviderRegistry();
  const provider = fakeProvider('a');
  registry.register(provider);

  assert.equal(registry.findForUrl('https://example.com/x'), provider);
});

test('URL sem nenhum provider compatível lança erro controlado', () => {
  const registry = new ProviderRegistry();
  registry.register(fakeProvider('a', { handles: () => false }));

  assert.throws(() => registry.findForUrl('https://example.com/x'), ProviderNotFoundError);
});

test('recusa registar um provider com id duplicado', () => {
  const registry = new ProviderRegistry();
  registry.register(fakeProvider('a'));

  assert.throws(() => registry.register(fakeProvider('a')), DuplicateProviderError);
});

test('recusa registar algo que não cumpra o contrato de provider', () => {
  const registry = new ProviderRegistry();
  assert.throws(() => registry.register({ id: 'incompleto' }), ProviderError);
});

test('um provider desativado é ignorado na procura', () => {
  const registry = new ProviderRegistry();
  registry.register(fakeProvider('a'), { enabled: false });

  assert.throws(() => registry.findForUrl('https://example.com/x'), ProviderNotFoundError);
});

test('setEnabled reativa um provider previamente desativado', () => {
  const registry = new ProviderRegistry();
  const provider = fakeProvider('a');
  registry.register(provider, { enabled: false });

  assert.equal(registry.isEnabled('a'), false);
  registry.setEnabled('a', true);
  assert.equal(registry.isEnabled('a'), true);
  assert.equal(registry.findForUrl('https://example.com/x'), provider);
});

test('com vários providers, escolhe o primeiro cujo canHandle aceite o URL', () => {
  const registry = new ProviderRegistry();
  const a = fakeProvider('a', { handles: () => false });
  const b = fakeProvider('b', { handles: () => true });
  registry.register(a);
  registry.register(b);

  assert.equal(registry.findForUrl('https://example.com/x'), b);
});
