/**
 * Contrato que qualquer provider tem de cumprir. Não é uma interface real
 * (JS não tem isso), só validação de forma — o registry usa isto para
 * recusar um provider mal construído em vez de falhar de forma confusa
 * mais tarde, a meio de um pedido.
 *
 * @typedef {Object} ResolvedFormat
 * @property {string} formatId
 * @property {string} quality
 * @property {string} format
 * @property {number} sizeBytes
 *
 * @typedef {Object} ResolvedMedia
 * @property {string} title
 * @property {string|null} thumbnail
 * @property {number|null} duration
 * @property {ResolvedFormat[]} formats
 *
 * @typedef {Object} VideoProvider
 * @property {string} id
 * @property {(url: string) => boolean} canHandle
 * @property {(url: string) => Promise<ResolvedMedia>} resolve
 * @property {(formatId: string) => Promise<{ stream: unknown, contentType?: string }>} getDownloadStream
 */

const REQUIRED_METHODS = ['canHandle', 'resolve', 'getDownloadStream'];

/**
 * Erro genérico para qualquer falha relacionada com providers (validação
 * de forma, resolve() ou getDownloadStream() a falhar). Segue o mesmo
 * princípio do SecurityValidationError: mensagem pública fixa, motivo real
 * só em `detail`, para não vazar detalhes internos.
 */
export class ProviderError extends Error {
  constructor(detail, { publicMessage = 'Não foi possível processar este pedido.', status = 500 } = {}) {
    super(publicMessage);
    this.name = 'ProviderError';
    this.detail = detail;
    this.status = status;
  }
}

/**
 * @param {unknown} candidate
 * @returns {candidate is VideoProvider}
 */
export function isValidProvider(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  if (typeof candidate.id !== 'string' || candidate.id.trim() === '') return false;
  return REQUIRED_METHODS.every((method) => typeof candidate[method] === 'function');
}

/**
 * Como `isValidProvider`, mas lança um erro descritivo em vez de devolver
 * `false` — usado pelo registry ao registar um provider.
 * @param {unknown} candidate
 */
export function assertValidProvider(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    throw new ProviderError('Provider tem de ser um objeto.');
  }
  if (typeof candidate.id !== 'string' || candidate.id.trim() === '') {
    throw new ProviderError('Provider tem de ter um "id" (string não vazia).');
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof candidate[method] !== 'function') {
      throw new ProviderError(`Provider "${candidate.id}" não implementa "${method}()".`);
    }
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidResolvedFormat(format) {
  return (
    isPlainObject(format) &&
    typeof format.formatId === 'string' && format.formatId.trim() !== '' &&
    typeof format.quality === 'string' && format.quality.trim() !== '' &&
    typeof format.format === 'string' && format.format.trim() !== '' &&
    typeof format.sizeBytes === 'number' && Number.isFinite(format.sizeBytes) && format.sizeBytes >= 0
  );
}

/**
 * Valida a FORMA do que `provider.resolve()` devolveu, campo a campo —
 * não confia que um provider (nomeadamente um futuro provider externo)
 * respeitou o contrato só porque passou em `assertValidProvider`. Isto
 * corre sempre no service, para todos os providers, para que um provider
 * mal implementado nunca consiga devolver dados arbitrários ao cliente
 * nem partir o controller a meio.
 * @param {unknown} media
 * @returns {media is import('./provider.interface.js').ResolvedMedia}
 */
export function isValidResolvedMedia(media) {
  if (!isPlainObject(media)) return false;
  if (typeof media.title !== 'string' || media.title.trim() === '') return false;
  if (media.thumbnail !== null && typeof media.thumbnail !== 'string') return false;
  if (
    media.duration !== null &&
    !(typeof media.duration === 'number' && Number.isFinite(media.duration) && media.duration >= 0)
  ) {
    return false;
  }
  if (!Array.isArray(media.formats) || media.formats.length === 0) return false;
  return media.formats.every(isValidResolvedFormat);
}

/**
 * @param {unknown} media
 * @param {{ providerId?: string }} [context]
 */
export function assertValidResolvedMedia(media, { providerId } = {}) {
  if (!isValidResolvedMedia(media)) {
    throw new ProviderError(
      `Provider "${providerId ?? 'desconhecido'}" devolveu de resolve() um resultado que não respeita o contrato ResolvedMedia.`,
      { publicMessage: 'Não foi possível processar este pedido.', status: 500 }
    );
  }
}
