import { SecurityValidationError } from '../security/url-validator.js';
import { ProviderError } from '../providers/provider.interface.js';
import { StorageError } from '../storage/storage.interface.js';
import { DownloadError } from '../services/download.service.js';

const GENERIC_MESSAGE = 'Algo correu mal. Tenta novamente.';
const MIN_CLIENT_STATUS = 400;
const MAX_CLIENT_STATUS = 499;

function isValidClientStatus(status) {
  return Number.isInteger(status) && status >= MIN_CLIENT_STATUS && status <= MAX_CLIENT_STATUS;
}

/**
 * Mapeamento explícito e fechado de erro -> resposta HTTP. Só instâncias
 * das nossas próprias classes de erro conhecidas podem influenciar o
 * status ou a mensagem devolvidos ao cliente:
 *   - SecurityValidationError (Etapa 2)
 *   - ProviderError e subclasses — ProviderNotFoundError, DuplicateProviderError (Etapa 4/5.1)
 *   - StorageError (Etapa 6.1)
 *   - DownloadError e subclasses — DownloadNotFoundError (Etapa 6.3)
 *
 * Qualquer outra coisa — um `Error` comum, uma exceção de uma
 * dependência, um valor lançado que nem sequer é um Error, ou um erro
 * conhecido cujo `.status` tenha sido corrompido/mal construído para um
 * valor fora do intervalo 4xx — cai sempre no 500 genérico. Nunca se
 * confia num `err.status` ou `err.message` só porque existem: têm de vir
 * de um tipo que reconhecemos, E o valor tem de ser um status de cliente
 * válido.
 *
 * @param {unknown} err
 * @returns {{ status: number, message: string }}
 */
export function mapErrorToResponse(err) {
  const isKnownErrorType =
    err instanceof SecurityValidationError ||
    err instanceof ProviderError ||
    err instanceof StorageError ||
    err instanceof DownloadError;

  if (isKnownErrorType && isValidClientStatus(err.status)) {
    return { status: err.status, message: err.message };
  }

  return { status: 500, message: GENERIC_MESSAGE };
}

export function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Rota não encontrada.' });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  // Log completo (incluindo `.detail`, quando existir) fica só no
  // servidor; o cliente nunca vê stack traces nem motivos internos.
  console.error('[erro]', err);

  const { status, message } = mapErrorToResponse(err);
  res.status(status).json({ error: message });
}
