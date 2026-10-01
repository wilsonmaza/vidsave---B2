import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderRegistry } from '../../src/providers/bootstrap.js';
import { ProviderNotFoundError } from '../../src/providers/registry.js';

test('com a configuração por defeito, o demo provider fica ativo', () => {
  const registry = createProviderRegistry();
  assert.equal(registry.isEnabled('demo'), true);
  assert.doesNotThrow(() => registry.findForUrl('https://sample.test/demo/video-1'));
});

test('DEMO_PROVIDER_ENABLED=false desativa o demo provider sem o remover', () => {
  const registry = createProviderRegistry({ demoProviderEnabled: false });
  assert.equal(registry.has('demo'), true);
  assert.equal(registry.isEnabled('demo'), false);
  assert.throws(() => registry.findForUrl('https://sample.test/demo/video-1'), ProviderNotFoundError);
});
