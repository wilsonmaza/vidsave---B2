import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCorsOrigin } from '../../src/config/env.js';

test("parseCorsOrigin: sem valor, vazio ou '*' -> '*' (modo desenvolvimento)", () => {
  assert.equal(parseCorsOrigin(undefined), '*');
  assert.equal(parseCorsOrigin(''), '*');
  assert.equal(parseCorsOrigin('   '), '*');
  assert.equal(parseCorsOrigin('*'), '*');
});

test('parseCorsOrigin: uma origem devolve uma string', () => {
  assert.equal(parseCorsOrigin('https://vidsave.vercel.app'), 'https://vidsave.vercel.app');
});

test('parseCorsOrigin: remove a barra final (o browser envia a origem sem barra)', () => {
  assert.equal(parseCorsOrigin('https://vidsave.vercel.app/'), 'https://vidsave.vercel.app');
  assert.equal(parseCorsOrigin('https://vidsave.vercel.app///'), 'https://vidsave.vercel.app');
});

test('parseCorsOrigin: várias origens separadas por vírgula devolvem uma lista limpa', () => {
  assert.deepEqual(
    parseCorsOrigin(' https://a.vercel.app/ , https://www.exemplo.com ,, '),
    ['https://a.vercel.app', 'https://www.exemplo.com']
  );
});

test("parseCorsOrigin: '*' no meio de uma lista continua a significar qualquer origem", () => {
  assert.equal(parseCorsOrigin('https://a.vercel.app,*'), '*');
});

test('parseCorsOrigin: só vírgulas/espaços não deixa a lista vazia (que bloquearia tudo)', () => {
  assert.equal(parseCorsOrigin(' , , '), '*');
});
