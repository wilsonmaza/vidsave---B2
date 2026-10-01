import { Transform } from 'node:stream';

/**
 * Etapa 6.4 — Size Guard.
 *
 * Código usado para marcar um erro como "o Size Guard disparou" — mesmo
 * princípio já usado no controller para reconhecer ERR_STREAM_PREMATURE_CLOSE
 * (código nativo do Node, ver download.controller.js): um `.code` estável,
 * verificável por quem precisar de reagir a isto de forma diferente de um
 * erro de I/O comum. Este módulo é deliberadamente neutro em relação às
 * hierarquias de erro de StorageError (storage.interface.js) e DownloadError
 * (download.service.js) — não depende de nenhuma das duas, nem sabe nada
 * sobre limites configurados ou políticas de negócio. Quem tiver de
 * traduzir isto num erro de domínio (DownloadTooLargeError) fá-lo mais
 * acima, com este código como sinal (ver DownloadCoordinator.ensureStored
 * em download.service.js).
 */
export const SIZE_GUARD_EXCEEDED_CODE = 'SIZE_GUARD_EXCEEDED';

/**
 * Transform que conta bytes à medida que atravessam o stream e, ao
 * ultrapassar `maxBytes`, destrói-se a si próprio com um erro marcado
 * (`err.code === SIZE_GUARD_EXCEEDED_CODE`) — nunca deixa passar um único
 * byte a mais depois do limite ser excedido.
 *
 * É uma defesa DURANTE a gravação (provider -> storage), independente de
 * qualquer `sizeBytes` que o provider tenha declarado no /resolve (correto,
 * incorreto, ou ausente) — ver download.service.js para a rejeição
 * antecipada baseada no valor declarado, que é uma camada diferente e
 * anterior a esta: aquela decide ANTES de sequer chamar o provider; esta
 * corre em paralelo com a escrita real, byte a byte, e é a única das duas
 * que não pode ser enganada por um valor declarado incorreto.
 *
 * Não apaga nenhum ficheiro — quem estiver a escrever o resultado em disco
 * é responsável pela limpeza do `.tmp` (ver local-storage.js save(), que já
 * o faz para qualquer erro do pipeline, incluindo este).
 *
 * @param {number} maxBytes
 * @returns {import('node:stream').Transform}
 */
export function createSizeGuardTransform(maxBytes) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error('createSizeGuardTransform requer um maxBytes positivo.');
  }

  let bytesSeen = 0;

  return new Transform({
    transform(chunk, encoding, callback) {
      bytesSeen += chunk.length;
      if (bytesSeen > maxBytes) {
        const err = new Error(`Stream excedeu o limite de ${maxBytes} bytes.`);
        err.code = SIZE_GUARD_EXCEEDED_CODE;
        err.maxBytes = maxBytes;
        callback(err);
        return;
      }
      callback(null, chunk);
    },
  });
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isSizeGuardExceededError(err) {
  return Boolean(err) && err.code === SIZE_GUARD_EXCEEDED_CODE;
}
