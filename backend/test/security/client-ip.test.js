import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getClientIp, attachClientIp } from '../../src/security/client-ip.js';

function makeReq({ remoteAddress, xForwardedFor } = {}) {
  return {
    socket: { remoteAddress },
    headers: xForwardedFor !== undefined ? { 'x-forwarded-for': xForwardedFor } : {},
  };
}

test('ausência de IP devolve null', () => {
  assert.equal(getClientIp(makeReq({})), null);
});

test('IP válido do socket é devolvido tal como está', () => {
  assert.equal(getClientIp(makeReq({ remoteAddress: '203.0.113.5' })), '203.0.113.5');
});

test('desembrulha IPv4 mapeado em IPv6 vindo do socket (::ffff:x.x.x.x)', () => {
  assert.equal(getClientIp(makeReq({ remoteAddress: '::ffff:203.0.113.5' })), '203.0.113.5');
});

test('ignora X-Forwarded-For quando trustProxy não está configurado', () => {
  const req = makeReq({ remoteAddress: '203.0.113.5', xForwardedFor: '1.2.3.4' });
  assert.equal(getClientIp(req, { trustProxy: false }), '203.0.113.5');
  assert.equal(getClientIp(req), '203.0.113.5'); // trustProxy false é o default
});

test('usa X-Forwarded-For quando trustProxy está ativo e o header tem um único valor', () => {
  const req = makeReq({ remoteAddress: '10.0.0.1', xForwardedFor: '198.51.100.7' });
  assert.equal(getClientIp(req, { trustProxy: true }), '198.51.100.7');
});

test('com múltiplos valores no header, usa o último (o mais próximo do nosso proxy)', () => {
  const req = makeReq({ remoteAddress: '10.0.0.1', xForwardedFor: '198.51.100.7, 203.0.113.9' });
  assert.equal(getClientIp(req, { trustProxy: true }), '203.0.113.9');
});

test('cai para o IP do socket quando o header tem valores malformados', () => {
  const req = makeReq({ remoteAddress: '10.0.0.1', xForwardedFor: 'não-é-um-ip' });
  assert.equal(getClientIp(req, { trustProxy: true }), '10.0.0.1');
});

test('cai para o IP do socket quando trustProxy está ativo mas o header está ausente', () => {
  const req = makeReq({ remoteAddress: '10.0.0.1' });
  assert.equal(getClientIp(req, { trustProxy: true }), '10.0.0.1');
});

test('trata o header em formato array (múltiplos cabeçalhos com o mesmo nome)', () => {
  const req = makeReq({ remoteAddress: '10.0.0.1', xForwardedFor: ['198.51.100.7', '203.0.113.9'] });
  assert.equal(getClientIp(req, { trustProxy: true }), '203.0.113.9');
});

test('attachClientIp regista req.clientIp e chama next()', () => {
  const req = makeReq({ remoteAddress: '203.0.113.5' });
  let nextCalled = false;

  attachClientIp({ trustProxy: false })(req, {}, () => {
    nextCalled = true;
  });

  assert.equal(req.clientIp, '203.0.113.5');
  assert.equal(nextCalled, true);
});
