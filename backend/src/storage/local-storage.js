import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { StorageError } from './storage.interface.js';
import { isSizeGuardExceededError } from './size-guard.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// backend/src/storage/ -> backend/tmp/downloads — nunca dentro de src/,
// nunca servido por express.static (isso nem sequer está montado no
// app.js). O caminho é derivado da localização do módulo, não do CWD,
// para não depender de onde o processo foi arrancado.
const DEFAULT_DIR = path.join(HERE, '..', '..', 'tmp', 'downloads');

// As keys que este storage aceita são sempre downloadIds gerados por
// generateDownloadId() (base64url de 32 bytes) — nunca um título, nunca
// texto arbitrário do cliente. Esta validação é a única coisa que
// impede uma key de se tornar num caminho de ficheiro fora do diretório:
// não há "..", não há "/", não há nada que o path.join possa interpretar
// como navegação.
const SAFE_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const TMP_SUFFIX_BYTES = 8;

function resolveSafePath(baseDir, key) {
  if (typeof key !== 'string' || !SAFE_KEY_PATTERN.test(key)) {
    throw new StorageError(`Key de storage com formato inválido: "${key}".`);
  }

  const resolvedBase = path.resolve(baseDir) + path.sep;
  const resolvedTarget = path.resolve(baseDir, key);

  // Defesa em profundidade: mesmo que o regex acima tivesse uma falha,
  // isto garante que o caminho final nunca escapa do diretório base.
  if (!resolvedTarget.startsWith(resolvedBase)) {
    throw new StorageError(`Path traversal detetado para key "${key}".`);
  }

  return resolvedTarget;
}

function wrapFsError(err, action, key) {
  if (err instanceof StorageError) return err;
  // O Size Guard (ver size-guard.js) não é um erro de storage — é um
  // sinal de política de tamanho que quem chamou save() precisa de
  // reconhecer tal e qual, para o poder traduzir num DownloadTooLargeError
  // (ver DownloadCoordinator.ensureStored em download.service.js). Embrulhá-lo
  // aqui como um StorageError genérico perderia esse sinal e o cliente
  // acabava a ver um 500 em vez de um 413.
  if (isSizeGuardExceededError(err)) return err;
  return new StorageError(`Falha ao ${action} storage para key "${key}": ${err.message}`, { cause: err });
}

/**
 * @param {string} baseDir
 * @param {string} key
 * @param {NodeJS.ReadableStream} sourceStream
 * @param {{ transforms?: import('node:stream').Transform[] }} [options] -
 *   Transforms adicionais a inserir no pipeline de escrita, entre a
 *   origem e o ficheiro final — por exemplo, o SizeGuardTransform
 *   (ver size-guard.js), aplicado pelo chamador em download.service.js.
 *   Fazem TODOS parte do mesmo pipeline() (não um `.pipe()` manual à
 *   parte), para que um erro em qualquer estágio destrua corretamente
 *   todos os outros — incluindo a origem — e não só o mais próximo do
 *   fim. Vazio por omissão: quem não precisar de nenhum, não muda nada
 *   no comportamento já existente.
 */
async function save(baseDir, key, sourceStream, { transforms = [] } = {}) {
  const targetPath = resolveSafePath(baseDir, key);
  const tempPath = `${targetPath}.${crypto.randomBytes(TMP_SUFFIX_BYTES).toString('hex')}.tmp`;

  await fsp.mkdir(baseDir, { recursive: true });

  try {
    // 'wx' falha se o ficheiro temporário já existir — não devia
    // acontecer nunca, dado o sufixo aleatório, mas não custa nada.
    await pipeline(sourceStream, ...transforms, fs.createWriteStream(tempPath, { flags: 'wx' }));

    const stat = await fsp.stat(tempPath);

    // rename() dentro do mesmo diretório é atómico ao nível do SO: quem
    // ler `key` só alguma vez vê o ficheiro completo, nunca um estado a
    // meio de ser escrito.
    await fsp.rename(tempPath, targetPath);

    return { sizeBytes: stat.size };
  } catch (err) {
    // Se a escrita falhou a meio (erro na origem, num transform como o
    // Size Guard, ou no disco), o ficheiro temporário não pode
    // sobreviver como órfão — independentemente de QUAL estágio do
    // pipeline falhou.
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    throw wrapFsError(err, 'gravar', key);
  }
}

function createReadStreamImpl(baseDir, key) {
  const targetPath = resolveSafePath(baseDir, key);
  return fs.createReadStream(targetPath);
}

async function deleteFile(baseDir, key) {
  const targetPath = resolveSafePath(baseDir, key);
  try {
    await fsp.rm(targetPath, { force: true }); // idempotente: não é erro já não existir
  } catch (err) {
    throw wrapFsError(err, 'apagar', key);
  }
}

async function existsFile(baseDir, key) {
  const targetPath = resolveSafePath(baseDir, key);
  try {
    await fsp.access(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lista as keys atualmente guardadas (nunca inclui ficheiros `.tmp` de
 * escritas incompletas). Não faz parte do contrato genérico em
 * `storage.interface.js` — é uma capacidade extra específica do storage
 * local, para uma futura reconciliação de limpeza (Etapa 6.3/6.4) poder
 * comparar o que está em disco com o que o DownloadStore ainda considera
 * válido.
 */
async function listKeys(baseDir) {
  await fsp.mkdir(baseDir, { recursive: true });
  const entries = await fsp.readdir(baseDir);
  return entries.filter((name) => SAFE_KEY_PATTERN.test(name));
}

/**
 * @param {{ baseDir?: string }} [options]
 * @returns {import('./storage.interface.js').TempStorage & { listKeys: () => Promise<string[]> }}
 */
export function createLocalStorage({ baseDir = DEFAULT_DIR } = {}) {
  return {
    save: (key, sourceStream, options) => save(baseDir, key, sourceStream, options),
    createReadStream: (key) => createReadStreamImpl(baseDir, key),
    delete: (key) => deleteFile(baseDir, key),
    exists: (key) => existsFile(baseDir, key),
    listKeys: () => listKeys(baseDir),
  };
}
