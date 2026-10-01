import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createSizeGuardTransform, isSizeGuardExceededError, SIZE_GUARD_EXCEEDED_CODE } from '../../src/storage/size-guard.js';

/** Writable que só acumula o que lhe chega, para confirmar o que passou de facto. */
function collectingSink() {
  const chunks = [];
  return {
    chunks,
    totalBytes: () => chunks.reduce((n, c) => n + c.length, 0),
    sink: new Writable({
      write(chunk, encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    }),
  };
}

async function runThroughGuard(maxBytes, inputChunks) {
  const { sink, chunks, totalBytes } = collectingSink();
  const guard = createSizeGuardTransform(maxBytes);
  await pipeline(Readable.from(inputChunks.map((s) => Buffer.from(s))), guard, sink);
  return { chunks, totalBytes };
}

// --- Construção ---

test('createSizeGuardTransform rejeita maxBytes <= 0, NaN, Infinity e não-números', () => {
  for (const bad of [0, -1, -1000, NaN, Infinity, -Infinity, undefined, null, 'dez']) {
    assert.throws(() => createSizeGuardTransform(bad), undefined, `maxBytes=${JSON.stringify(bad)} devia ter sido rejeitado`);
  }
});

test('createSizeGuardTransform aceita qualquer inteiro positivo', () => {
  for (const good of [1, 10, 500 * 1024 * 1024]) {
    assert.doesNotThrow(() => createSizeGuardTransform(good));
  }
});

// --- Ponto C: limite exato ---

test('um único chunk de exatamente maxBytes passa sem erro', async () => {
  const { totalBytes } = await runThroughGuard(7, ['1234567']); // 7 bytes, limite=7
  assert.equal(totalBytes(), 7);
});

test('vários chunks cuja SOMA é exatamente maxBytes passam sem erro', async () => {
  const { totalBytes } = await runThroughGuard(10, ['123', '4567', '890']); // 3+4+3=10, limite=10
  assert.equal(totalBytes(), 10);
});

test('maxBytes + 1 (um único byte a mais) é rejeitado com o sinal correto', async () => {
  await assert.rejects(
    () => runThroughGuard(7, ['12345678']), // 8 bytes, limite=7
    (err) => isSizeGuardExceededError(err)
  );
});

// --- Ponto D (nível do módulo): chunk que ultrapassa não é encaminhado ---

test('o chunk que faz o total ultrapassar maxBytes NÃO é encaminhado para o destino', async () => {
  const { sink, chunks, totalBytes } = collectingSink();
  const guard = createSizeGuardTransform(10);
  await assert.rejects(
    () => pipeline(Readable.from([Buffer.from('12345'), Buffer.from('678901234')]), guard, sink), // 5 + 9 = 14 > 10
    (err) => isSizeGuardExceededError(err)
  );
  assert.equal(chunks.length, 1, 'só o 1º chunk (dentro do limite) devia ter chegado ao destino');
  assert.equal(totalBytes(), 5, 'o 2º chunk, que fazia 14>10, não pode ter passado nem um byte');
});

// --- Chunks que só ultrapassam o limite APÓS acumulação (obrigatório pelo pedido) ---

test('vários chunks individualmente pequenos só disparam quando a SOMA acumulada ultrapassa o limite, no chunk exato em que isso acontece', async () => {
  const { sink, chunks, totalBytes } = collectingSink();
  const guard = createSizeGuardTransform(25);
  // Cada chunk sozinho (10 bytes) está muito abaixo do limite (25). Só a
  // soma acumulada (10, 20, 30) ultrapassa o limite -- e só no 3º chunk.
  const tenBytes = () => Buffer.alloc(10, 'x');
  await assert.rejects(
    () => pipeline(Readable.from([tenBytes(), tenBytes(), tenBytes()]), guard, sink),
    (err) => isSizeGuardExceededError(err)
  );
  assert.equal(chunks.length, 2, 'os 2 primeiros chunks (10+10=20, dentro do limite) deviam ter passado');
  assert.equal(totalBytes(), 20, 'o total encaminhado tem de parar exatamente nos 20 bytes anteriores ao 3º chunk');
});

test('a mesma soma acumulada, dividida em MUITOS chunks pequenos, ainda para exatamente no ponto certo', async () => {
  const { totalBytes } = await (async () => {
    const { sink, chunks, totalBytes: total } = collectingSink();
    const guard = createSizeGuardTransform(10);
    // 11 chunks de 1 byte: soma só ultrapassa 10 no 11º chunk (bytesSeen passa de 10 para 11).
    const oneByteChunks = Array.from({ length: 11 }, () => Buffer.from('a'));
    await assert.rejects(() => pipeline(Readable.from(oneByteChunks), guard, sink), (err) => isSizeGuardExceededError(err));
    assert.equal(chunks.length, 10, 'os primeiros 10 chunks de 1 byte deviam ter passado');
    return { totalBytes: total };
  })();
  assert.equal(totalBytes(), 10);
});

// --- Sinal do erro ---

test('o erro emitido tem sempre err.code === SIZE_GUARD_EXCEEDED_CODE, reconhecido por isSizeGuardExceededError', async () => {
  const guard = createSizeGuardTransform(3);
  const { sink } = collectingSink();
  try {
    await pipeline(Readable.from([Buffer.from('abcd')]), guard, sink);
    assert.fail('devia ter lançado');
  } catch (err) {
    assert.equal(err.code, 'SIZE_GUARD_EXCEEDED');
    assert.equal(err.code, SIZE_GUARD_EXCEEDED_CODE);
    assert.equal(isSizeGuardExceededError(err), true);
    assert.equal(err.maxBytes, 3);
  }
});

test('isSizeGuardExceededError nunca confunde erros genéricos ou códigos nativos do fs com o sinal do Size Guard', () => {
  assert.equal(isSizeGuardExceededError(new Error('qualquer coisa')), false);
  assert.equal(isSizeGuardExceededError(Object.assign(new Error('sem espaço'), { code: 'ENOSPC' })), false);
  assert.equal(isSizeGuardExceededError(Object.assign(new Error('stream fechado cedo'), { code: 'ERR_STREAM_PREMATURE_CLOSE' })), false);
  assert.equal(isSizeGuardExceededError(null), false);
  assert.equal(isSizeGuardExceededError(undefined), false);
  assert.equal(isSizeGuardExceededError('string simples'), false);
});
