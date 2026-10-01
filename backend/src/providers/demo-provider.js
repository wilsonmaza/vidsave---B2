import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderError } from './provider.interface.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, 'fixtures');

// Domínio reservado pela IANA para documentação/testes (RFC 2606) — nunca
// resolve na internet real. Escolhido de propósito: não há forma de isto
// ser confundido com uma plataforma real ou um mecanismo de bypass.
const DEMO_HOSTNAME = 'sample.test';

/**
 * Dados fixos, definidos pelo próprio projeto — não vêm de nenhuma rede
 * nem de scraping. Cada item tem dois formatos "falsos" que apontam para
 * o mesmo tipo de ficheiro de exemplo, só para provar que a escolha de
 * formato por `formatId` funciona.
 */
const DEMO_ITEMS = {
  'video-1': {
    title: 'VidSave — vídeo de demonstração 1',
    duration: 5,
    fixtureFile: 'demo-video-1.txt',
  },
  'video-2': {
    title: 'VidSave — vídeo de demonstração 2',
    duration: 8,
    fixtureFile: 'demo-video-2.txt',
  },
};

const QUALITIES = [
  { suffix: '720p', quality: '720p' },
  { suffix: '480p', quality: '480p' },
];

/**
 * Índice formatId -> caminho do ficheiro, construído uma vez a partir de
 * DEMO_ITEMS (que nunca é alterado depois disto). Não guarda nada
 * relativo a um pedido específico — só mapeia um formatId estático para
 * um ficheiro estático.
 */
const FORMAT_INDEX = new Map();
for (const [itemKey, item] of Object.entries(DEMO_ITEMS)) {
  const fixturePath = path.join(FIXTURES_DIR, item.fixtureFile);
  for (const { suffix } of QUALITIES) {
    const formatId = `demo-${itemKey}-${suffix}`;
    FORMAT_INDEX.set(formatId, fixturePath);
  }
}

function buildFormatsFor(itemKey) {
  const fixturePath = path.join(FIXTURES_DIR, DEMO_ITEMS[itemKey].fixtureFile);
  const sizeBytes = fs.statSync(fixturePath).size;

  // Devolve sempre um array novo, com objetos novos — nunca uma
  // referência partilhada que uma chamada pudesse mutar e afetar outra.
  return QUALITIES.map(({ suffix, quality }) => ({
    formatId: `demo-${itemKey}-${suffix}`,
    quality,
    format: 'txt', // ficheiro de exemplo, não um formato de vídeo real
    sizeBytes,
  }));
}

function extractItemKey(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== DEMO_HOSTNAME) return null;

  const match = parsed.pathname.match(/^\/demo\/([a-z0-9-]+)\/?$/i);
  return match ? match[1] : null;
}

export const demoProvider = {
  id: 'demo',

  canHandle(url) {
    const itemKey = extractItemKey(url);
    return itemKey !== null && itemKey in DEMO_ITEMS;
  },

  async resolve(url) {
    const itemKey = extractItemKey(url);
    const item = itemKey ? DEMO_ITEMS[itemKey] : undefined;

    if (!item) {
      throw new ProviderError(`demo-provider: item desconhecido para "${url}".`, {
        publicMessage: 'Não conseguimos processar este vídeo de demonstração.',
      });
    }

    // Objeto novo em cada chamada — nada aqui vem de `this` nem de uma
    // variável partilhada que outra chamada concorrente possa ter mudado.
    return {
      title: item.title,
      thumbnail: null,
      duration: item.duration,
      formats: buildFormatsFor(itemKey),
    };
  },

  async getDownloadStream(formatId) {
    const fixturePath = FORMAT_INDEX.get(formatId);
    if (!fixturePath) {
      throw new ProviderError(`demo-provider: formatId desconhecido "${formatId}".`, {
        publicMessage: 'Este formato já não está disponível.',
      });
    }

    return {
      stream: fs.createReadStream(fixturePath),
      contentType: 'text/plain; charset=utf-8',
    };
  },
};
