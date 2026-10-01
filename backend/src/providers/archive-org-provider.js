import { safeFetch } from '../security/ssrf-guard.js';
import { SecurityValidationError } from '../security/url-validator.js';
import { ProviderError } from './provider.interface.js';

/**
 * Internet Archive (archive.org) — primeiro provider real do VidSave.
 *
 * Usa exclusivamente a Metadata API oficial e pública
 * (https://archive.org/metadata/:identifier) e o endpoint de download
 * oficial (https://archive.org/download/:identifier/:filename) — nunca
 * faz scraping de HTML, nunca contorna nenhum mecanismo de acesso, e
 * nunca autentica. A forma exata destas respostas foi verificada
 * empiricamente (não só por documentação) antes de escrever isto.
 */

// "www." opcional; só http(s) (validateUrlSyntax/canHandle já garantem
// protocolo antes disto interessar).
const HOST_PATTERN = /^(www\.)?archive\.org$/i;

// Regra oficial de identifiers do Archive.org (archive.org/developers/
// metadata-schema): alfanumérico ASCII, '_', '-', '.'; primeiro carácter
// tem de ser alfanumérico; máximo 100 caracteres.
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

const DETAILS_PATH_PATTERN = /^\/details\/([^/]+)\/?$/;

// Extensões tratadas como "vídeo" para o VidSave — deliberadamente
// restrito a formatos de vídeo reais. Um item de vídeo no Archive.org
// também costuma ter legendas (.srt), ficheiros de metadata (.xml/.js),
// imagens de capa (.jpg) e torrents na mesma listagem — todos excluídos.
const VIDEO_EXTENSIONS = new Set(['mp4', 'ogv', 'ogg', 'webm', 'mpg', 'mpeg', 'm4v']);

const MAX_METADATA_BYTES = 5 * 1024 * 1024;

function extensionOf(filename) {
  const idx = filename.lastIndexOf('.');
  return idx === -1 ? '' : filename.slice(idx + 1).toLowerCase();
}

/**
 * O formatId nunca sai para o cliente (mesmo princípio já usado pelos
 * outros providers — só o downloadId opaco sai). Aqui codifica
 * identifier+filename para getDownloadStream() poder reconstruir o URL
 * de download sem ter de voltar a pedir a metadata (evita umaChamada
 * de rede extra e uma janela onde o item podia ter mudado entretanto).
 */
function encodeFormatId(identifier, filename) {
  return `${identifier}::${filename}`;
}

function isSafeFilename(filename) {
  // Nunca confiado às cegas, mesmo vindo de dentro de um formatId que
  // este próprio provider gerou — sem separadores de caminho, sem "..",
  // sem caracteres de controlo.
  if (typeof filename !== 'string' || filename === '' || filename.length > 255) return false;
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return false;
  return !/[\x00-\x1f]/.test(filename);
}

function decodeFormatId(formatId) {
  if (typeof formatId !== 'string') return null;
  const sepIndex = formatId.indexOf('::');
  if (sepIndex === -1) return null;
  const identifier = formatId.slice(0, sepIndex);
  const filename = formatId.slice(sepIndex + 2);
  if (!IDENTIFIER_PATTERN.test(identifier)) return null;
  if (!isSafeFilename(filename)) return null;
  return { identifier, filename };
}

function truthy(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

/**
 * Etapa 3 — fail-closed. Usa só sinais reais, confirmados na API:
 * `is_dark` (item completamente removido/oculto) e
 * `metadata['access-restricted-item']` (acesso condicionado a
 * login/lending — mecanismo real do Archive.org para "controlled
 * digital lending"). A ausência destes campos é o estado normal da
 * esmagadora maioria dos itens públicos — não é tratada como ambígua;
 * só a PRESENÇA de um sinal positivo de restrição é.
 */
function isAccessRestricted(json) {
  if (truthy(json?.is_dark)) return true;
  if (truthy(json?.metadata?.['access-restricted-item'])) return true;
  return false;
}

function parseRuntimeToSeconds(runtime) {
  if (typeof runtime !== 'string') return null;
  const match = /^(\d+):(\d{2}):(\d{2})$/.exec(runtime.trim());
  if (!match) return null;
  const [, h, m, s] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

async function readStreamAsString(stream, { maxBytes = MAX_METADATA_BYTES } = {}) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new ProviderError('Resposta do Internet Archive excede o tamanho máximo aceite para metadata.', {
        status: 500,
      });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseIdentifierFromDetailsUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!HOST_PATTERN.test(parsed.hostname)) return null;
  const match = DETAILS_PATH_PATTERN.exec(parsed.pathname);
  if (!match) return null;
  let identifier;
  try {
    identifier = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return IDENTIFIER_PATTERN.test(identifier) ? identifier : null;
}

/**
 * @param {{
 *   fetchFn?: typeof safeFetch,
 *   isHostAllowed?: (hostname: string) => boolean,
 * }} [options]
 *   `fetchFn` é injetável para testes correrem sem depender da internet
 *   real (por omissão, o safeFetch real). `isHostAllowed` é passado a
 *   TODOS os pedidos que este provider faz — resolve() e
 *   getDownloadStream() — incluindo em cada salto de redirect (o
 *   safeFetch já revalida isto por si em cada hop).
 */
export function createArchiveOrgProvider({ fetchFn = safeFetch, isHostAllowed } = {}) {
  return {
    id: 'archive-org',

    canHandle(url) {
      return parseIdentifierFromDetailsUrl(url) !== null;
    },

    async resolve(url) {
      const identifier = parseIdentifierFromDetailsUrl(url);
      if (!identifier) {
        throw new ProviderError(`URL não corresponde a um item válido do Internet Archive: "${url}".`, {
          status: 400,
          publicMessage: 'URL inválido ou não permitido.',
        });
      }

      const metadataUrl = `https://archive.org/metadata/${identifier}`;
      let response;
      try {
        response = await fetchFn(metadataUrl, { isHostAllowed });
      } catch (err) {
        if (err instanceof SecurityValidationError) throw err; // deixa passar tal e qual
        throw new ProviderError(`Falha ao contactar o Internet Archive para "${identifier}": ${err.message}`, {
          status: 500,
        });
      }

      if (response.status === 404) {
        throw new ProviderError(`Item "${identifier}" não encontrado no Internet Archive.`, {
          status: 404,
          publicMessage: 'Item não encontrado.',
        });
      }
      if (response.status !== 200) {
        throw new ProviderError(
          `Internet Archive devolveu status ${response.status} para a metadata de "${identifier}".`,
          { status: 500 }
        );
      }

      const body = await readStreamAsString(response.stream);
      let json;
      try {
        json = JSON.parse(body);
      } catch {
        throw new ProviderError(`Resposta inválida (JSON malformado) do Internet Archive para "${identifier}".`, {
          status: 500,
        });
      }

      // A Metadata API devolve {} para um identifier que nunca existiu
      // (200 OK, corpo vazio) — não é garantido que venha sempre um 404.
      if (!json || typeof json !== 'object' || Object.keys(json).length === 0) {
        throw new ProviderError(`Item "${identifier}" não encontrado no Internet Archive.`, {
          status: 404,
          publicMessage: 'Item não encontrado.',
        });
      }

      // Etapa 3 — fail-closed: qualquer sinal real de restrição, e o
      // item inteiro é tratado como indisponível. Nunca autentica, nunca
      // tenta contornar. A resposta pública é indistinguível de "não
      // encontrado" — não confirma ao cliente que o item existe mas está
      // restrito.
      if (isAccessRestricted(json)) {
        throw new ProviderError(`Item "${identifier}" está marcado como restrito/indisponível publicamente.`, {
          status: 404,
          publicMessage: 'Item não encontrado.',
        });
      }

      const files = Array.isArray(json.files) ? json.files : [];
      const videoFiles = files.filter(
        (f) => f && typeof f === 'object' && typeof f.name === 'string' && VIDEO_EXTENSIONS.has(extensionOf(f.name))
      );

      if (videoFiles.length === 0) {
        throw new ProviderError(`Item "${identifier}" não tem nenhum ficheiro de vídeo suportado.`, {
          status: 404,
          publicMessage: 'Este item não tem nenhum vídeo disponível.',
        });
      }

      const formats = videoFiles.map((f) => {
        // Etapa 5: "ficheiro sem tamanho" — a Metadata API às vezes omite
        // `size` (sobretudo em ficheiros derivados/em processamento).
        // sizeBytes é obrigatório no contrato ResolvedFormat (número >=
        // 0) — um valor ausente/inválido vira 0, nunca é inventado nem
        // faz o formato inteiro ser descartado. O Size Guard continua a
        // ser a defesa real durante a gravação, independentemente disto.
        const parsedSize = Number.parseInt(f.size, 10);
        const sizeBytes = Number.isFinite(parsedSize) && parsedSize >= 0 ? parsedSize : 0;

        return {
          formatId: encodeFormatId(identifier, f.name),
          quality: typeof f.format === 'string' && f.format.trim() !== '' ? f.format : extensionOf(f.name).toUpperCase(),
          format: extensionOf(f.name),
          sizeBytes,
        };
      });

      const title =
        typeof json.metadata?.title === 'string' && json.metadata.title.trim() !== '' ? json.metadata.title : identifier;

      return {
        title,
        thumbnail: `https://archive.org/services/img/${identifier}`,
        duration: parseRuntimeToSeconds(json.metadata?.runtime),
        formats,
      };
    },

    async getDownloadStream(formatId) {
      const decoded = decodeFormatId(formatId);
      if (!decoded) {
        throw new ProviderError(`formatId inválido ou corrompido: "${formatId}".`, { status: 404 });
      }
      const { identifier, filename } = decoded;

      // Sempre o endpoint "locate" oficial (/download/:id/:filename), nunca
      // um host de armazenamento hardcoded — é a própria documentação do
      // Internet Archive que recomenda isto, e é o que garante que o
      // redirect (para o nó real, ex. iaXXXXXX.us.archive.org) passa pela
      // validação completa do safeFetch, incluindo isHostAllowed.
      const downloadUrl = `https://archive.org/download/${identifier}/${encodeURIComponent(filename)}`;

      let response;
      try {
        response = await fetchFn(downloadUrl, { isHostAllowed });
      } catch (err) {
        if (err instanceof SecurityValidationError) throw err;
        throw new ProviderError(`Falha ao descarregar do Internet Archive ("${identifier}/${filename}"): ${err.message}`, {
          status: 500,
        });
      }

      if (response.status !== 200) {
        throw new ProviderError(
          `Internet Archive devolveu status ${response.status} ao descarregar "${identifier}/${filename}".`,
          { status: 404 }
        );
      }

      return { stream: response.stream, contentType: response.headers?.['content-type'] ?? null };
    },
  };
}
