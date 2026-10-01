import { assertValidProvider, ProviderError } from './provider.interface.js';

export class ProviderNotFoundError extends ProviderError {
  constructor(url) {
    super(`Nenhum provider ativo consegue tratar: ${url}`, {
      publicMessage: 'Não conseguimos processar este link.',
      status: 404,
    });
    this.name = 'ProviderNotFoundError';
  }
}

export class DuplicateProviderError extends ProviderError {
  constructor(id) {
    super(`Provider "${id}" já estava registado.`, {
      publicMessage: 'Não foi possível processar este pedido.',
    });
    this.name = 'DuplicateProviderError';
  }
}

/**
 * Mantém a lista de providers disponíveis e decide qual deles trata um
 * URL. O resto da aplicação só fala com o registry — nunca precisa de
 * conhecer um provider específico.
 */
export class ProviderRegistry {
  constructor() {
    this.entries = new Map(); // id -> { provider, enabled }
  }

  /**
   * @param {import('./provider.interface.js').VideoProvider} provider
   * @param {{ enabled?: boolean }} [options]
   */
  register(provider, { enabled = true } = {}) {
    assertValidProvider(provider);
    if (this.entries.has(provider.id)) {
      throw new DuplicateProviderError(provider.id);
    }
    this.entries.set(provider.id, { provider, enabled });
  }

  unregister(id) {
    this.entries.delete(id);
  }

  setEnabled(id, enabled) {
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.enabled = enabled;
    return true;
  }

  isEnabled(id) {
    return this.entries.get(id)?.enabled ?? false;
  }

  has(id) {
    return this.entries.has(id);
  }

  /**
   * Obtém um provider diretamente pelo `id`, sem olhar para nenhum URL.
   * Usado pelo fluxo de download (Etapa 6.3): o providerId já está
   * guardado no registo do DownloadStore, e o URL original não deve ser
   * resolvido outra vez nesta fase. Devolve `null` se o provider não
   * existir ou estiver desativado — tal como `findForUrl`, um provider
   * desativado é tratado como se não existisse.
   * @param {string} id
   * @returns {import('./provider.interface.js').VideoProvider | null}
   */
  getById(id) {
    const entry = this.entries.get(id);
    if (!entry || !entry.enabled) return null;
    return entry.provider;
  }

  list() {
    return [...this.entries.entries()].map(([id, { enabled }]) => ({ id, enabled }));
  }

  /**
   * Percorre os providers ativos, na ordem em que foram registados, e
   * devolve o primeiro cujo `canHandle(url)` seja verdadeiro. Providers
   * desativados são ignorados por completo.
   * @param {string} url
   * @returns {import('./provider.interface.js').VideoProvider}
   */
  findForUrl(url) {
    for (const { provider, enabled } of this.entries.values()) {
      if (enabled && provider.canHandle(url)) {
        return provider;
      }
    }
    throw new ProviderNotFoundError(url);
  }
}
