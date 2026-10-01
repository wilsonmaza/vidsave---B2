const MAX_URL_LENGTH = 2048;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Erro genérico e seguro para qualquer falha de validação de URL ou SSRF.
 * A mensagem pública nunca varia com o motivo exato (evita dar pistas sobre
 * a rede interna a quem estiver a sondar o endpoint). O motivo real fica só
 * em `detail`, para logs do servidor.
 */
export class SecurityValidationError extends Error {
  constructor(detail, { status = 400 } = {}) {
    super('URL inválido ou não permitido.');
    this.name = 'SecurityValidationError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Valida a sintaxe e o protocolo de um URL. Não faz DNS nem verifica
 * allowlist — isso é responsabilidade do ssrf-guard e do chamador.
 * @param {string} rawUrl
 * @returns {URL}
 */
export function validateUrlSyntax(rawUrl, { maxLength = MAX_URL_LENGTH } = {}) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    throw new SecurityValidationError('URL vazio ou não é uma string.');
  }

  if (rawUrl.length > maxLength) {
    throw new SecurityValidationError(
      `URL excede o comprimento máximo de ${maxLength} caracteres (tinha ${rawUrl.length}).`
    );
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SecurityValidationError(`URL sintaticamente inválido: "${rawUrl}".`);
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new SecurityValidationError(`Protocolo não permitido: "${parsed.protocol}".`);
  }

  if (!parsed.hostname) {
    throw new SecurityValidationError('URL sem hostname.');
  }

  if (parsed.username || parsed.password) {
    throw new SecurityValidationError('URL com credenciais embutidas não é permitido.');
  }

  return parsed;
}
