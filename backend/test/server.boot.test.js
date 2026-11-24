import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Teste de arranque: sobe o server.js REAL como processo separado.
//
// Existe porque todos os outros testes usam createApp() diretamente e nunca
// executam server.js — foi assim que um `ReferenceError` no arranque
// (`isHostAllowed` não definido) chegou ao repositório sem nenhum teste a
// falhar, deixando o backend incapaz de arrancar.

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForReady(child, getOutput, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`servidor não arrancou em ${timeoutMs} ms.\n${getOutput()}`));
    }, timeoutMs);

    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`servidor terminou no arranque (código ${code}).\n${getOutput()}`));
    });

    const check = setInterval(() => {
      if (getOutput().includes('a ouvir na porta')) {
        clearInterval(check);
        clearTimeout(timer);
        resolve();
      }
    }, 50);
    child.once('exit', () => clearInterval(check));
  });
}

test('server.js arranca de verdade e responde a /api/health', async () => {
  const port = await getFreePort();
  let output = '';

  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: backendDir,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      ORPHAN_CLEANUP_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  try {
    await waitForReady(child, () => output, 10_000);

    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 2000).unref();
    });
  }
});

test('server.js em arranque real aplica a allowlist (host fora da lista -> 400)', async () => {
  const port = await getFreePort();
  let output = '';

  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: backendDir,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      ORPHAN_CLEANUP_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  try {
    await waitForReady(child, () => output, 10_000);

    const res = await fetch(`http://127.0.0.1:${port}/api/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://exemplo-fora-da-allowlist.com/video' }),
    });
    assert.equal(res.status, 400);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 2000).unref();
    });
  }
});
