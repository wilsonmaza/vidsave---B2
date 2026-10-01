import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DownloadStore,
  DOWNLOAD_STATE,
  generateDownloadId,
  isValidDownloadIdFormat,
  resolveDownloadTarget,
  DownloadCoordinator,
  DownloadError,
  DownloadNotFoundError,
} from '../../src/services/download.service.js';
import { ProviderRegistry } from '../../src/providers/registry.js';

function makeClock(start = 0) {
  let current = start;
  return { nowFn: () => current, advance: (ms) => { current += ms; } };
}

// --- generateDownloadId ---

test('gera IDs com comprimento consistente e caracteres seguros para URL', () => {
  const id = generateDownloadId();
  assert.equal(typeof id, 'string');
  assert.ok(id.length >= 40, 'devia ter entropia suficiente (32 bytes em base64url)');
  assert.match(id, /^[A-Za-z0-9_-]+$/, 'base64url não deve ter "+", "/" nem "="');
});

test('gera IDs diferentes em chamadas sucessivas (sem colisões óbvias)', () => {
  const ids = new Set();
  for (let i = 0; i < 1000; i += 1) {
    ids.add(generateDownloadId());
  }
  assert.equal(ids.size, 1000);
});

// --- Criação ---

test('create() exige providerId e formatId', () => {
  const store = new DownloadStore({ ttlMs: 1000 });
  try {
    assert.throws(() => store.create({ providerId: '', formatId: 'f1' }));
    assert.throws(() => store.create({ providerId: 'demo', formatId: '' }));
    assert.throws(() => store.create({}));
  } finally {
    store.stop();
  }
});

test('create() devolve um registo completo, não consumido, com expiração no futuro', () => {
  const clock = makeClock(1000);
  const store = new DownloadStore({ ttlMs: 60000, nowFn: clock.nowFn });
  try {
    const record = store.create({ providerId: 'demo', formatId: 'demo-video-1-720p' });

    assert.equal(typeof record.downloadId, 'string');
    assert.equal(record.providerId, 'demo');
    assert.equal(record.formatId, 'demo-video-1-720p');
    assert.equal(record.consumed, false);
    assert.equal(record.createdAt, 1000);
    assert.equal(record.expiresAt, 1000 + 60000);
  } finally {
    store.stop();
  }
});

// --- Consulta ---

test('get() devolve o registo criado, para um downloadId válido', () => {
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1' });
    const fetched = store.get(created.downloadId);
    assert.deepEqual(fetched, created);
  } finally {
    store.stop();
  }
});

test('mutar o resultado de get() não corrompe o estado interno do store', () => {
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1' });

    const first = store.get(created.downloadId);
    first.providerId = 'ALTERADO';
    first.formatId = 'ALTERADO';

    const second = store.get(created.downloadId);
    assert.equal(second.providerId, 'demo');
    assert.equal(second.formatId, 'f1');
  } finally {
    store.stop();
  }
});

// --- Inexistente / IDs inválidos ---

test('get() devolve null para um downloadId inexistente', () => {
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    assert.equal(store.get('nao-existe-nenhum-registo-com-este-id'), null);
  } finally {
    store.stop();
  }
});

test('get() devolve null para valores claramente inválidos, sem lançar', () => {
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    for (const bad of ['', '   ', null, undefined, 123, {}, []]) {
      assert.equal(store.get(bad), null, `devia devolver null para ${JSON.stringify(bad)}`);
    }
  } finally {
    store.stop();
  }
});

// --- Expiração ---

test('get() devolve null depois de o TTL expirar, e remove o registo', () => {
  const clock = makeClock();
  const store = new DownloadStore({ ttlMs: 1000, nowFn: clock.nowFn });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1' });
    assert.ok(store.get(created.downloadId));

    clock.advance(1000);

    assert.equal(store.get(created.downloadId), null);
    assert.equal(store.size, 0, 'o registo expirado devia ter sido removido, não só ignorado');
  } finally {
    store.stop();
  }
});

test('cleanupExpired remove só os registos expirados, mantém os válidos', () => {
  const clock = makeClock();
  const store = new DownloadStore({ ttlMs: 1000, nowFn: clock.nowFn });
  try {
    const old = store.create({ providerId: 'demo', formatId: 'antigo' });
    clock.advance(500);
    const recent = store.create({ providerId: 'demo', formatId: 'recente' });

    clock.advance(500); // "old" já passou dos 1000ms, "recent" só tem 500ms
    store.cleanupExpired();

    assert.equal(store.get(old.downloadId), null);
    assert.ok(store.get(recent.downloadId));
    assert.equal(store.size, 1);
  } finally {
    store.stop();
  }
});

// --- Isolamento entre downloads ---

test('registos de downloads diferentes não interferem entre si', () => {
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const a = store.create({ providerId: 'demo', formatId: 'video-1-720p' });
    const b = store.create({ providerId: 'demo', formatId: 'video-2-480p' });

    store.markConsumed(a.downloadId);

    assert.equal(store.get(a.downloadId).consumed, true);
    assert.equal(store.get(b.downloadId).consumed, false);

    store.delete(a.downloadId);
    assert.equal(store.get(a.downloadId), null);
    assert.ok(store.get(b.downloadId), 'apagar "a" não devia afetar "b"');
  } finally {
    store.stop();
  }
});

// --- Comportamento concorrente básico ---

test('muitas criações concorrentes produzem registos independentes e sem colisão de IDs', async () => {
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const records = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        Promise.resolve(store.create({ providerId: 'demo', formatId: `formato-${i}` }))
      )
    );

    const ids = new Set(records.map((r) => r.downloadId));
    assert.equal(ids.size, 50, 'todos os downloadIds gerados concorrentemente têm de ser únicos');

    records.forEach((record, i) => {
      const fetched = store.get(record.downloadId);
      assert.equal(fetched.formatId, `formato-${i}`, 'cada registo tem de manter o seu próprio formatId');
    });
  } finally {
    store.stop();
  }
});

test('leituras concorrentes ao mesmo downloadId devolvem sempre o mesmo registo', async () => {
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1' });

    const reads = await Promise.all(Array.from({ length: 20 }, () => Promise.resolve(store.get(created.downloadId))));

    for (const read of reads) {
      assert.deepEqual(read, created);
    }
  } finally {
    store.stop();
  }
});

// --- Estado "consumed", sem aplicar ainda a política de uso único ---

test('markConsumed regista o estado, mas get() continua a devolver o registo normalmente', () => {
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1' });
    assert.equal(created.consumed, false);

    store.markConsumed(created.downloadId);

    // Etapa 6.1: o estado fica registado, mas ainda não há nenhuma
    // política de "só pode ser usado uma vez" a ser aplicada aqui.
    const fetched = store.get(created.downloadId);
    assert.equal(fetched.consumed, true);
    assert.notEqual(fetched, null, 'get() ainda tem de devolver o registo mesmo já consumido, nesta etapa');
  } finally {
    store.stop();
  }
});

test('markConsumed num downloadId inexistente não lança nem cria nada', () => {
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    assert.doesNotThrow(() => store.markConsumed('nao-existe'));
    assert.equal(store.size, 0);
  } finally {
    store.stop();
  }
});

// ==================================================================
// Etapa 6.4 — API pública getValidIds()
// ==================================================================

test('getValidIds() retorna array de IDs válidos', () => {
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const id1 = store.create({ providerId: 'p1', formatId: 'f1' }).downloadId;
    const id2 = store.create({ providerId: 'p2', formatId: 'f2' }).downloadId;
    const id3 = store.create({ providerId: 'p3', formatId: 'f3' }).downloadId;

    const validIds = store.getValidIds();

    assert.equal(Array.isArray(validIds), true);
    assert.equal(validIds.length, 3);
    assert.ok(validIds.includes(id1));
    assert.ok(validIds.includes(id2));
    assert.ok(validIds.includes(id3));
  } finally {
    store.stop();
  }
});

test('getValidIds() retorna array vazio se nenhum registo', () => {
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const validIds = store.getValidIds();

    assert.equal(Array.isArray(validIds), true);
    assert.equal(validIds.length, 0);
  } finally {
    store.stop();
  }
});

test('getValidIds() exclui registos expirados', () => {
  const clock = makeClock();
  const expired = [];
  const store = new DownloadStore({
    ttlMs: 1000,
    nowFn: clock.nowFn,
    onExpire: (r) => expired.push(r.downloadId),
  });

  try {
    const id1 = store.create({ providerId: 'p1', formatId: 'f1' }).downloadId;
    const id2 = store.create({ providerId: 'p2', formatId: 'f2' }).downloadId;

    clock.advance(1000);

    const validIds = store.getValidIds();

    // Ambos expirados, nenhum válido
    assert.equal(validIds.length, 0);
    assert.equal(expired.length, 2);
    assert.ok(expired.includes(id1));
    assert.ok(expired.includes(id2));
  } finally {
    store.stop();
  }
});

test('getValidIds() não exclui registos ainda válidos', () => {
  const clock = makeClock();
  const store = new DownloadStore({
    ttlMs: 2000,
    nowFn: clock.nowFn,
  });

  try {
    const id1 = store.create({ providerId: 'p1', formatId: 'f1' }).downloadId;
    const id2 = store.create({ providerId: 'p2', formatId: 'f2' }).downloadId;

    clock.advance(1000); // Avança 1 segundo, mas TTL é 2

    const validIds = store.getValidIds();

    assert.equal(validIds.length, 2);
    assert.ok(validIds.includes(id1));
    assert.ok(validIds.includes(id2));
  } finally {
    store.stop();
  }
});

test('getValidIds() mix de válidos e expirados', () => {
  const clock = makeClock();
  const expired = [];
  const store = new DownloadStore({
    ttlMs: 1000,
    nowFn: clock.nowFn,
    onExpire: (r) => expired.push(r.downloadId),
  });

  try {
    const id1 = store.create({ providerId: 'p1', formatId: 'f1' }).downloadId;
    const id2 = store.create({ providerId: 'p2', formatId: 'f2' }).downloadId;

    clock.advance(500);
    const id3 = store.create({ providerId: 'p3', formatId: 'f3' }).downloadId;

    clock.advance(600); // id1 e id2 agora expirados, id3 ainda válido (100ms de idade)

    const validIds = store.getValidIds();

    assert.equal(validIds.length, 1);
    assert.ok(validIds.includes(id3));
    assert.equal(expired.length, 2);
    assert.ok(expired.includes(id1));
    assert.ok(expired.includes(id2));
  } finally {
    store.stop();
  }
});

test('getValidIds() pode ser chamado múltiplas vezes e devolve resultados consistentes', () => {
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const id1 = store.create({ providerId: 'p1', formatId: 'f1' }).downloadId;
    const id2 = store.create({ providerId: 'p2', formatId: 'f2' }).downloadId;

    const firstCall = store.getValidIds();
    const secondCall = store.getValidIds();

    // Ambas devem ser idênticas
    assert.deepEqual(firstCall.sort(), secondCall.sort());
    assert.equal(firstCall.length, 2);
  } finally {
    store.stop();
  }
});

test('getValidIds() devolve cópia (mutação não afeta store interno)', () => {
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const id1 = store.create({ providerId: 'p1', formatId: 'f1' }).downloadId;

    const validIds = store.getValidIds();
    validIds.push('fake-id-not-real-1234567890123456789012');

    // Chamar novamente deve ignorar a mutação anterior
    const validIds2 = store.getValidIds();

    assert.equal(validIds2.length, 1);
    assert.equal(validIds2[0], id1);
  } finally {
    store.stop();
  }
});

// ==================================================================
// Etapa 6.3.1 — máquina de estados explícita (claim/release)
// ==================================================================

test('create() começa em AVAILABLE', () => {
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1' });
    assert.equal(created.state, DOWNLOAD_STATE.AVAILABLE);
  } finally {
    store.stop();
  }
});

test('claim() transita AVAILABLE -> CONSUMING e devolve o registo', () => {
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1' });

    const result = store.claim(created.downloadId);

    assert.equal(result.claimed, true);
    assert.equal(result.record.state, DOWNLOAD_STATE.CONSUMING);
    assert.equal(store.get(created.downloadId).state, DOWNLOAD_STATE.CONSUMING);
  } finally {
    store.stop();
  }
});

test('um segundo claim() ao MESMO downloadId, ainda em CONSUMING, falha (não pode consumir o mesmo recurso duas vezes)', () => {
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1' });

    const first = store.claim(created.downloadId);
    const second = store.claim(created.downloadId);

    assert.equal(first.claimed, true);
    assert.equal(second.claimed, false);
    // O estado continua CONSUMING (do primeiro claim) — o segundo não
    // teve nenhum efeito.
    assert.equal(store.get(created.downloadId).state, DOWNLOAD_STATE.CONSUMING);
  } finally {
    store.stop();
  }
});

test('claim() falha para um downloadId já CONSUMED', () => {
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1' });
    store.markConsumed(created.downloadId);

    const result = store.claim(created.downloadId);
    assert.equal(result.claimed, false);
  } finally {
    store.stop();
  }
});

test('claim() falha para um downloadId inexistente', () => {
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    assert.equal(store.claim(generateDownloadId()).claimed, false);
  } finally {
    store.stop();
  }
});

test('claim() falha para um downloadId expirado, e remove + onExpire tal como get()', () => {
  const clock = makeClock();
  const expired = [];
  const store = new DownloadStore({ ttlMs: 1000, nowFn: clock.nowFn, onExpire: (r) => expired.push(r.downloadId) });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1' });
    clock.advance(1000);

    const result = store.claim(created.downloadId);
    assert.equal(result.claimed, false);
    assert.deepEqual(expired, [created.downloadId]);
    assert.equal(store.size, 0);
  } finally {
    store.stop();
  }
});

test('claim() em duas chamadas síncronas seguidas, sem await pelo meio, comporta-se como dois pedidos concorrentes: só a primeira ganha', () => {
  // Isto é precisamente a propriedade que garante que não há janela de
  // corrida: como não há `await` entre as duas chamadas, não há
  // nenhuma forma de outro código correr "no meio" delas.
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1' });
    const results = [store.claim(created.downloadId), store.claim(created.downloadId)];
    const claimedCount = results.filter((r) => r.claimed).length;
    assert.equal(claimedCount, 1, 'exatamente um dos dois claims tem de ter sucesso');
  } finally {
    store.stop();
  }
});

test('release() devolve CONSUMING -> AVAILABLE, permitindo um novo claim()', () => {
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1' });
    store.claim(created.downloadId);

    store.release(created.downloadId);

    assert.equal(store.get(created.downloadId).state, DOWNLOAD_STATE.AVAILABLE);
    assert.equal(store.claim(created.downloadId).claimed, true, 'depois de libertado, um novo claim tem de conseguir');
  } finally {
    store.stop();
  }
});

test('release() não faz nada a um downloadId AVAILABLE (nunca reivindicado)', () => {
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1' });
    store.release(created.downloadId);
    assert.equal(store.get(created.downloadId).state, DOWNLOAD_STATE.AVAILABLE);
  } finally {
    store.stop();
  }
});

test('release() não "reabre" um downloadId já CONSUMED', () => {
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1' });
    store.claim(created.downloadId);
    store.markConsumed(created.downloadId);

    store.release(created.downloadId);

    assert.equal(store.get(created.downloadId).state, DOWNLOAD_STATE.CONSUMED, 'release() não pode desfazer um consumo já concluído');
  } finally {
    store.stop();
  }
});

test('release() num downloadId inexistente não lança', () => {
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    assert.doesNotThrow(() => store.release('nao-existe'));
  } finally {
    store.stop();
  }
});

// ==================================================================
// Etapa 6.3
// ==================================================================

// --- isValidDownloadIdFormat ---

test('isValidDownloadIdFormat aceita um downloadId real gerado por generateDownloadId', () => {
  assert.equal(isValidDownloadIdFormat(generateDownloadId()), true);
});

test('isValidDownloadIdFormat rejeita valores mal formados', () => {
  for (const bad of ['', 'curto', 'a'.repeat(200), 'tem espaço', 'tem/barra', 'tem;ponto;virgula', null, undefined, 123, {}]) {
    assert.equal(isValidDownloadIdFormat(bad), false, `devia rejeitar ${JSON.stringify(bad)}`);
  }
});

// --- DownloadStore: hook onExpire ---

test('onExpire é chamado quando get() encontra um registo expirado', () => {
  const clock = makeClock();
  const expired = [];
  const store = new DownloadStore({ ttlMs: 1000, nowFn: clock.nowFn, onExpire: (r) => expired.push(r.downloadId) });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1' });
    clock.advance(1000);

    store.get(created.downloadId);
    assert.deepEqual(expired, [created.downloadId]);
  } finally {
    store.stop();
  }
});

test('onExpire é chamado pela varredura periódica (cleanupExpired)', () => {
  const clock = makeClock();
  const expired = [];
  const store = new DownloadStore({ ttlMs: 1000, nowFn: clock.nowFn, onExpire: (r) => expired.push(r.downloadId) });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1' });
    clock.advance(1000);

    store.cleanupExpired();
    assert.deepEqual(expired, [created.downloadId]);
  } finally {
    store.stop();
  }
});

test('onExpire NÃO é chamado para delete() explícito nem para um registo ainda válido', () => {
  const clock = makeClock();
  const expired = [];
  const store = new DownloadStore({ ttlMs: 60000, nowFn: clock.nowFn, onExpire: (r) => expired.push(r.downloadId) });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1' });
    store.delete(created.downloadId);
    assert.deepEqual(expired, []);
  } finally {
    store.stop();
  }
});

test('sem onExpire passado, o comportamento por defeito não lança (retrocompatível com a Etapa 6.1)', () => {
  const clock = makeClock();
  const store = new DownloadStore({ ttlMs: 1000, nowFn: clock.nowFn }); // sem onExpire
  try {
    store.create({ providerId: 'demo', formatId: 'f1' });
    clock.advance(1000);
    assert.doesNotThrow(() => store.cleanupExpired());
  } finally {
    store.stop();
  }
});

// --- resolveDownloadTarget ---

function fakeProvider(id) {
  return {
    id,
    canHandle: () => true,
    resolve: async () => ({ title: id, thumbnail: null, duration: null, formats: [] }),
    getDownloadStream: async () => ({ stream: null }),
  };
}

test('resolveDownloadTarget rejeita downloadId com formato inválido (400)', () => {
  const registry = new ProviderRegistry();
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    assert.throws(
      () => resolveDownloadTarget('curto-demais', { downloadStore: store, registry }),
      (err) => err instanceof DownloadError && err.status === 400
    );
  } finally {
    store.stop();
  }
});

test('resolveDownloadTarget rejeita downloadId inexistente (404)', () => {
  const registry = new ProviderRegistry();
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    assert.throws(
      () => resolveDownloadTarget(generateDownloadId(), { downloadStore: store, registry }),
      DownloadNotFoundError
    );
  } finally {
    store.stop();
  }
});

test('resolveDownloadTarget rejeita downloadId expirado (404)', () => {
  const clock = makeClock();
  const registry = new ProviderRegistry();
  const store = new DownloadStore({ ttlMs: 1000, nowFn: clock.nowFn });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1' });
    clock.advance(1000);
    assert.throws(
      () => resolveDownloadTarget(created.downloadId, { downloadStore: store, registry }),
      DownloadNotFoundError
    );
  } finally {
    store.stop();
  }
});

test('resolveDownloadTarget rejeita downloadId já consumido (404, igual ao inexistente)', () => {
  const registry = new ProviderRegistry();
  registry.register(fakeProvider('demo'));
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1' });
    store.markConsumed(created.downloadId);

    assert.throws(
      () => resolveDownloadTarget(created.downloadId, { downloadStore: store, registry }),
      DownloadNotFoundError
    );
  } finally {
    store.stop();
  }
});

test('resolveDownloadTarget devolve o provider e o formatId internos para um downloadId válido', () => {
  const registry = new ProviderRegistry();
  const provider = fakeProvider('demo');
  registry.register(provider);
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'formato-interno' });
    const target = resolveDownloadTarget(created.downloadId, { downloadStore: store, registry });

    assert.equal(target.provider, provider);
    assert.equal(target.formatId, 'formato-interno');
  } finally {
    store.stop();
  }
});

test('resolveDownloadTarget trata provider inexistente/desativado como erro interno (500), não 404', () => {
  const registry = new ProviderRegistry();
  registry.register(fakeProvider('demo'), { enabled: false }); // desativado
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1' });
    assert.throws(
      () => resolveDownloadTarget(created.downloadId, { downloadStore: store, registry }),
      (err) => err instanceof DownloadError && !(err instanceof DownloadNotFoundError) && err.status === 500
    );
  } finally {
    store.stop();
  }
});

// --- resolveDownloadTarget: claim atómico (Etapa 6.3.1) ---

test('resolveDownloadTarget deixa o downloadId em CONSUMING depois de resolver com sucesso', () => {
  const registry = new ProviderRegistry();
  const provider = fakeProvider('demo');
  registry.register(provider);
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1' });
    resolveDownloadTarget(created.downloadId, { downloadStore: store, registry });

    assert.equal(store.get(created.downloadId).state, DOWNLOAD_STATE.CONSUMING);
  } finally {
    store.stop();
  }
});

test('uma segunda chamada a resolveDownloadTarget, para o mesmo downloadId ainda em CONSUMING, recebe 404 (não pode consumir o mesmo recurso duas vezes)', () => {
  const registry = new ProviderRegistry();
  const provider = fakeProvider('demo');
  registry.register(provider);
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1' });

    const first = resolveDownloadTarget(created.downloadId, { downloadStore: store, registry });
    assert.equal(first.provider, provider);

    assert.throws(
      () => resolveDownloadTarget(created.downloadId, { downloadStore: store, registry }),
      DownloadNotFoundError
    );
  } finally {
    store.stop();
  }
});

test('depois de downloadStore.release(), resolveDownloadTarget volta a conseguir resolver o mesmo downloadId', () => {
  const registry = new ProviderRegistry();
  const provider = fakeProvider('demo');
  registry.register(provider);
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1' });

    resolveDownloadTarget(created.downloadId, { downloadStore: store, registry });
    store.release(created.downloadId); // simula o `finally` do controller depois de uma falha

    const retry = resolveDownloadTarget(created.downloadId, { downloadStore: store, registry });
    assert.equal(retry.provider, provider);
  } finally {
    store.stop();
  }
});

test('resolveDownloadTarget liberta o claim quando o provider referenciado não existe (500), permitindo nova tentativa depois de corrigido', () => {
  const registry = new ProviderRegistry();
  const store = new DownloadStore({ ttlMs: 60000 });
  try {
    const created = store.create({ providerId: 'demo', formatId: 'f1' }); // "demo" ainda não registado

    assert.throws(
      () => resolveDownloadTarget(created.downloadId, { downloadStore: store, registry }),
      (err) => err instanceof DownloadError && err.status === 500
    );
    assert.equal(store.get(created.downloadId).state, DOWNLOAD_STATE.AVAILABLE, 'o claim tinha de ter sido libertado, não deixado preso em CONSUMING');

    // Depois de o provider ser registado, o mesmo downloadId consegue
    // finalmente ser resolvido.
    registry.register(fakeProvider('demo'));
    const retry = resolveDownloadTarget(created.downloadId, { downloadStore: store, registry });
    assert.equal(retry.formatId, 'f1');
  } finally {
    store.stop();
  }
});

// --- DownloadCoordinator (single-flight) ---

function fakeStorage() {
  const saved = new Set();
  return {
    saved,
    save: async (key) => {
      saved.add(key);
      return { sizeBytes: 1 };
    },
    exists: async (key) => saved.has(key),
    createReadStream: () => null,
    delete: async (key) => { saved.delete(key); },
  };
}

function countingProvider(id, { streamResult, delayMs = 0 } = {}) {
  let calls = 0;
  return {
    calls: () => calls,
    provider: {
      id,
      canHandle: () => true,
      resolve: async () => ({ title: id, thumbnail: null, duration: null, formats: [] }),
      async getDownloadStream() {
        calls += 1;
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        return streamResult ?? { stream: { pipe() {}, on() {} }, contentType: 'text/plain' };
      },
    },
  };
}

test('ensureStored chama o provider e grava no storage na primeira vez', async () => {
  const coordinator = new DownloadCoordinator();
  const storage = fakeStorage();
  const { provider, calls } = countingProvider('demo');

  const result = await coordinator.ensureStored({ downloadId: 'id-1', provider, formatId: 'f1', storage });

  assert.equal(calls(), 1);
  assert.equal(storage.saved.has('id-1'), true);
  assert.equal(result.contentType, 'text/plain');
});

test('pedidos concorrentes ao MESMO downloadId partilham a mesma operação (só 1 chamada ao provider)', async () => {
  const coordinator = new DownloadCoordinator();
  const storage = fakeStorage();
  const { provider, calls } = countingProvider('demo', { delayMs: 20 });

  const [a, b, c] = await Promise.all([
    coordinator.ensureStored({ downloadId: 'id-concorrente', provider, formatId: 'f1', storage }),
    coordinator.ensureStored({ downloadId: 'id-concorrente', provider, formatId: 'f1', storage }),
    coordinator.ensureStored({ downloadId: 'id-concorrente', provider, formatId: 'f1', storage }),
  ]);

  assert.equal(calls(), 1, 'o provider só devia ser chamado uma vez para 3 pedidos concorrentes ao mesmo id');
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test('downloadIds diferentes continuam independentes (uma chamada ao provider cada)', async () => {
  const coordinator = new DownloadCoordinator();
  const storage = fakeStorage();
  const { provider, calls } = countingProvider('demo');

  await Promise.all([
    coordinator.ensureStored({ downloadId: 'id-a', provider, formatId: 'f1', storage }),
    coordinator.ensureStored({ downloadId: 'id-b', provider, formatId: 'f1', storage }),
  ]);

  assert.equal(calls(), 2);
});

test('a entrada da map é removida depois de terminar com sucesso (sem promises órfãs)', async () => {
  const coordinator = new DownloadCoordinator();
  const storage = fakeStorage();
  const { provider } = countingProvider('demo');

  await coordinator.ensureStored({ downloadId: 'id-1', provider, formatId: 'f1', storage });
  assert.equal(coordinator.inFlightCount, 0);
});

test('a entrada da map é removida mesmo quando a operação falha', async () => {
  const coordinator = new DownloadCoordinator();
  const storage = fakeStorage();
  const provider = {
    id: 'quebrado',
    canHandle: () => true,
    resolve: async () => ({}),
    getDownloadStream: async () => {
      throw new Error('falha simulada do provider');
    },
  };

  await assert.rejects(() => coordinator.ensureStored({ downloadId: 'id-1', provider, formatId: 'f1', storage }));
  assert.equal(coordinator.inFlightCount, 0, 'não pode sobrar nenhuma promise órfã depois de uma falha');
});

test('se o ficheiro já existir em storage (pedido anterior já terminado), não chama o provider outra vez', async () => {
  const coordinator = new DownloadCoordinator();
  const storage = fakeStorage();
  storage.saved.add('ja-existe'); // simula um pedido anterior, já concluído
  const { provider, calls } = countingProvider('demo');

  const result = await coordinator.ensureStored({ downloadId: 'ja-existe', provider, formatId: 'f1', storage });

  assert.equal(calls(), 0, 'não devia chamar o provider outra vez para algo já gravado');
  assert.equal(result.contentType, null);
});

test('rejeita quando o provider devolve um stream que não é sequer stream-like', async () => {
  const coordinator = new DownloadCoordinator();
  const storage = fakeStorage();
  const { provider } = countingProvider('demo', { streamResult: { stream: 'não sou um stream', contentType: 'text/plain' } });

  await assert.rejects(
    () => coordinator.ensureStored({ downloadId: 'id-1', provider, formatId: 'f1', storage }),
    DownloadError
  );
  assert.equal(storage.saved.has('id-1'), false, 'não devia ter gravado nada com um stream inválido');
});

test('rejeita quando o provider devolve um contentType de tipo inválido', async () => {
  const coordinator = new DownloadCoordinator();
  const storage = fakeStorage();
  const { provider } = countingProvider('demo', {
    streamResult: { stream: { pipe() {}, on() {} }, contentType: 12345 },
  });

  await assert.rejects(
    () => coordinator.ensureStored({ downloadId: 'id-1', provider, formatId: 'f1', storage }),
    DownloadError
  );
});

// --- DownloadCoordinator: cache de contentType (correção da Etapa 6.3.1) ---

test('uma chamada a ensureStored() DEPOIS da primeira já ter terminado (storage.exists() = true) devolve o contentType original, não null', async () => {
  const coordinator = new DownloadCoordinator();
  const storage = fakeStorage();
  const { provider, calls } = countingProvider('demo', { streamResult: { stream: { pipe() {}, on() {} }, contentType: 'video/mp4' } });

  const first = await coordinator.ensureStored({ downloadId: 'id-1', provider, formatId: 'f1', storage });
  assert.equal(first.contentType, 'video/mp4');
  assert.equal(coordinator.inFlightCount, 0, 'a primeira operação já tem de ter terminado (não está mais in-flight)');

  // Simula uma nova tentativa (por exemplo, depois de um release() no
  // downloadStore) para o MESMO downloadId, já com o ficheiro gravado —
  // storage.exists() vai ser true e o provider não devia ser chamado
  // outra vez, mas o contentType não se pode perder.
  const second = await coordinator.ensureStored({ downloadId: 'id-1', provider, formatId: 'f1', storage });

  assert.equal(calls(), 1, 'o provider não devia ser chamado outra vez para um ficheiro já gravado');
  assert.equal(second.contentType, 'video/mp4', 'o contentType original não podia ter-se perdido');
});

test('forgetContentType() limpa a cache — uma chamada seguinte, sem o provider ter sido chamado outra vez, volta a devolver null', async () => {
  const coordinator = new DownloadCoordinator();
  const storage = fakeStorage();
  const { provider } = countingProvider('demo', { streamResult: { stream: { pipe() {}, on() {} }, contentType: 'video/mp4' } });

  await coordinator.ensureStored({ downloadId: 'id-1', provider, formatId: 'f1', storage });
  coordinator.forgetContentType('id-1');

  // O ficheiro continua "gravado" do ponto de vista do storage fake
  // (não foi apagado), mas já não há nada em cache para o contentType —
  // este é exatamente o estado esperado depois de storage.delete() +
  // forgetContentType() no controller (a próxima vez que um downloadId
  // for reutilizado, é sempre um downloadId NOVO, nunca este).
  const result = await coordinator.ensureStored({ downloadId: 'id-1', provider, formatId: 'f1', storage });
  assert.equal(result.contentType, null);
});

test('forgetContentType() num downloadId sem nada em cache não lança', () => {
  const coordinator = new DownloadCoordinator();
  assert.doesNotThrow(() => coordinator.forgetContentType('nao-existe'));
});
