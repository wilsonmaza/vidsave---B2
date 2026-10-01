import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isBlockedAddress,
  assertSafeHostname,
  createPinnedLookup,
  safeFetch,
} from '../../src/security/ssrf-guard.js';
import { SecurityValidationError } from '../../src/security/url-validator.js';

function fakeLookup(map) {
  return async (hostname) => {
    const entry = map[hostname];
    if (!entry) throw new Error(`fakeLookup: sem entrada para "${hostname}"`);
    return Array.isArray(entry) ? entry : [entry];
  };
}

function fakeRequestFn(responses) {
  let call = 0;
  return async () => {
    const response = responses[call];
    call += 1;
    if (!response) throw new Error('fakeRequestFn: sem mais respostas configuradas');
    return response;
  };
}

// --- Classificação de endereços IP (sem rede, sem DNS) ---

test('bloqueia IPv4 loopback', () => {
  assert.equal(isBlockedAddress('127.0.0.1'), true);
});

test('bloqueia 10.0.0.0/8', () => {
  assert.equal(isBlockedAddress('10.0.0.1'), true);
  assert.equal(isBlockedAddress('10.255.255.255'), true);
});

test('bloqueia 172.16.0.0/12 e respeita a fronteira exata do intervalo', () => {
  assert.equal(isBlockedAddress('172.16.0.1'), true);
  assert.equal(isBlockedAddress('172.31.255.255'), true);
  assert.equal(isBlockedAddress('172.32.0.1'), false); // fora do /12 — prova a máscara
  assert.equal(isBlockedAddress('172.15.255.255'), false);
});

test('bloqueia 192.168.0.0/16', () => {
  assert.equal(isBlockedAddress('192.168.1.1'), true);
});

test('bloqueia link-local e o endpoint de metadata de cloud (169.254.0.0/16)', () => {
  assert.equal(isBlockedAddress('169.254.169.254'), true);
  assert.equal(isBlockedAddress('169.254.1.1'), true);
});

test('bloqueia IPv6 loopback (::1)', () => {
  assert.equal(isBlockedAddress('::1'), true);
});

test('bloqueia IPv6 unique-local (fc00::/7) e link-local (fe80::/10)', () => {
  assert.equal(isBlockedAddress('fc00::1'), true);
  assert.equal(isBlockedAddress('fd12:3456::1'), true); // dentro do /7
  assert.equal(isBlockedAddress('fe80::1'), true);
});

test('bloqueia IPv4 privado mapeado em IPv6, em qualquer notação', () => {
  assert.equal(isBlockedAddress('::ffff:10.0.0.1'), true);
  assert.equal(isBlockedAddress('::ffff:a00:1'), true); // mesmo endereço, notação hex
});

test('não bloqueia endereços públicos normais', () => {
  assert.equal(isBlockedAddress('93.184.216.34'), false);
  assert.equal(isBlockedAddress('2606:2800:220:1:248:1893:25c8:1946'), false);
});

// --- Resolução de hostname (com DNS falso, injetado) ---

test('bloqueia "localhost" sem sequer consultar o DNS', async () => {
  let dnsCalled = false;
  const lookup = async () => {
    dnsCalled = true;
    return [{ address: '93.184.216.34', family: 4 }];
  };

  await assert.rejects(() => assertSafeHostname('localhost', { lookup }), SecurityValidationError);
  assert.equal(dnsCalled, false, 'o DNS não devia ser consultado para um hostname já bloqueado');
});

test('bloqueia hostname que resolve para um IP privado', async () => {
  const lookup = fakeLookup({ 'interno.exemplo.com': { address: '10.0.0.5', family: 4 } });
  await assert.rejects(() => assertSafeHostname('interno.exemplo.com', { lookup }), SecurityValidationError);
});

test('bloqueia hostname quando QUALQUER endereço do DNS (entre vários) for privado', async () => {
  const lookup = fakeLookup({
    'multi.exemplo.com': [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ],
  });
  await assert.rejects(() => assertSafeHostname('multi.exemplo.com', { lookup }), SecurityValidationError);
});

test('permite hostname cujos endereços são todos públicos', async () => {
  const lookup = fakeLookup({ 'publico.exemplo.com': { address: '93.184.216.34', family: 4 } });
  const result = await assertSafeHostname('publico.exemplo.com', { lookup });
  assert.equal(result.pinnedAddress, '93.184.216.34');
});

// --- Fixação de DNS / proteção contra rebinding ---

test('DNS rebinding: assertSafeHostname só consulta o DNS uma vez e fixa esse resultado', async () => {
  let calls = 0;
  const rebindingLookup = async () => {
    calls += 1;
    // 1ª "consulta": resposta pública. Uma 2ª consulta hipotética devolveria
    // um IP privado — típico de um ataque de rebinding.
    return calls === 1
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '10.0.0.1', family: 4 }];
  };

  const result = await assertSafeHostname('rebind.exemplo.com', { lookup: rebindingLookup });
  assert.equal(result.pinnedAddress, '93.184.216.34');
  assert.equal(calls, 1);
});

test('DNS rebinding: o lookup fixado ignora qualquer hostname e nunca reconsulta', () => {
  const pinnedLookup = createPinnedLookup('93.184.216.34', 4);

  pinnedLookup('hostname-completamente-diferente.com', {}, (err, address, family) => {
    assert.equal(err, null);
    assert.equal(address, '93.184.216.34');
    assert.equal(family, 4);
  });
});

// --- safeFetch: redirects, limites e timeouts ---

test('safeFetch rejeita protocolos não http/https', async () => {
  await assert.rejects(() => safeFetch('file:///etc/passwd'), SecurityValidationError);
});

test('safeFetch rejeita redirect para um IP privado', async () => {
  const lookup = fakeLookup({ 'publico.exemplo.com': { address: '93.184.216.34', family: 4 } });
  const requestFn = fakeRequestFn([{ status: 302, headers: { location: 'http://10.0.0.1/malicioso' } }]);

  await assert.rejects(
    () => safeFetch('http://publico.exemplo.com/video', { lookup, requestFn }),
    SecurityValidationError
  );
});

test('safeFetch rejeita redirect para hostname que resolve para IP privado', async () => {
  const lookup = fakeLookup({
    'publico.exemplo.com': { address: '93.184.216.34', family: 4 },
    'interno.exemplo.com': { address: '10.0.0.9', family: 4 },
  });
  const requestFn = fakeRequestFn([{ status: 302, headers: { location: 'http://interno.exemplo.com/x' } }]);

  await assert.rejects(
    () => safeFetch('http://publico.exemplo.com/video', { lookup, requestFn }),
    SecurityValidationError
  );
});

test('safeFetch segue um redirect seguro, revalidando o novo destino', async () => {
  const lookup = fakeLookup({
    'a.exemplo.com': { address: '93.184.216.34', family: 4 },
    'b.exemplo.com': { address: '93.184.216.35', family: 4 },
  });
  const requestFn = fakeRequestFn([
    { status: 302, headers: { location: 'http://b.exemplo.com/final' } },
    { status: 200, headers: {}, stream: null },
  ]);

  const response = await safeFetch('http://a.exemplo.com/inicio', { lookup, requestFn });
  assert.equal(response.status, 200);
});

test('safeFetch respeita o limite máximo de redirects', async () => {
  const lookup = fakeLookup({ 'loop.exemplo.com': { address: '93.184.216.34', family: 4 } });
  const requestFn = fakeRequestFn([
    { status: 302, headers: { location: 'http://loop.exemplo.com/1' } },
    { status: 302, headers: { location: 'http://loop.exemplo.com/2' } },
    { status: 302, headers: { location: 'http://loop.exemplo.com/3' } },
  ]);

  await assert.rejects(
    () => safeFetch('http://loop.exemplo.com/0', { lookup, requestFn, maxRedirects: 1 }),
    SecurityValidationError
  );
});

test('safeFetch rejeita quando o pedido excede o timeout', async () => {
  const lookup = fakeLookup({ 'lento.exemplo.com': { address: '93.184.216.34', family: 4 } });
  const requestFn = () => new Promise(() => {}); // nunca resolve

  await assert.rejects(
    () => safeFetch('http://lento.exemplo.com/x', { lookup, requestFn, timeoutMs: 30 }),
    SecurityValidationError
  );
});

test('safeFetch aplica a allowlist quando o chamador a injeta (regra de negócio fica fora do guard)', async () => {
  const lookup = fakeLookup({ 'nao-permitido.com': { address: '93.184.216.34', family: 4 } });
  const isHostAllowed = () => false;

  await assert.rejects(
    () => safeFetch('http://nao-permitido.com/x', { lookup, isHostAllowed }),
    SecurityValidationError
  );
});
