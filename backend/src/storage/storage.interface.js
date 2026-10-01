/**
 * Contrato que qualquer storage temporário tem de cumprir. Tal como
 * `provider.interface.js`, não é uma interface real (JS não tem isso) —
 * é validação de forma, para recusar uma implementação mal construída
 * em vez de falhar de forma confusa a meio de um download.
 *
 * @typedef {Object} SaveResult
 * @property {number} sizeBytes
 *
 * @typedef {Object} TempStorage
 * @property {(key: string, sourceStream: NodeJS.ReadableStream) => Promise<SaveResult>} save
 * @property {(key: string) => NodeJS.ReadableStream} createReadStream
 * @property {(key: string) => Promise<void>} delete
 * @property {(key: string) => Promise<boolean>} exists
 */

const REQUIRED_METHODS = ['save', 'createReadStream', 'delete', 'exists'];

/**
 * Mesmo princípio do ProviderError: mensagem pública fixa, motivo real
 * só em `detail`, para nunca vazar caminhos de ficheiros ou detalhes de
 * I/O ao cliente.
 *
 * `cause`, quando passado, fica no `err.cause` nativo (Error cause,
 * suportado desde o Node 16.9) — nunca em `detail` nem na mensagem
 * pública. Serve só para diagnóstico em logs de servidor (o
 * console.error('[erro]', err) em error-handler.js já imprime a cause
 * recursivamente); o cliente continua a nunca ver nada disto. Omitido
 * por omissão para não alterar o comportamento de quem já construía um
 * StorageError sem esta opção.
 */
export class StorageError extends Error {
  constructor(detail, { publicMessage = 'Não foi possível processar este pedido.', status = 500, cause } = {}) {
    super(publicMessage, cause === undefined ? undefined : { cause });
    this.name = 'StorageError';
    this.detail = detail;
    this.status = status;
  }
}

/**
 * @param {unknown} candidate
 * @returns {candidate is TempStorage}
 */
export function isValidStorage(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  return REQUIRED_METHODS.every((method) => typeof candidate[method] === 'function');
}

/**
 * @param {unknown} candidate
 */
export function assertValidStorage(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    throw new StorageError('Storage tem de ser um objeto.');
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof candidate[method] !== 'function') {
      throw new StorageError(`Storage não implementa "${method}()".`);
    }
  }
}
