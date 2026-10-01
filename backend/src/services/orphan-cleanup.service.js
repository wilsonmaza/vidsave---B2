/**
 * Etapa 6.4 — Reconciliação e Cleanup de ficheiros órfãos.
 *
 * Serviço que periodicamente compara ficheiros em disco (via storage.listKeys)
 * com registos válidos no DownloadStore. Qualquer ficheiro em disco sem registo
 * é considerado órfão e deletado.
 *
 * Casos de uso:
 * - Restart do processo: DownloadStore é perdido em memória, mas ficheiros ficam
 *   em disco → são órfãos até o TTL expirar manualmente.
 * - Falha de storage.delete() após consumo: ficheiro fica órfão até TTL.
 * - Bugs/inconsistências: algum código deixou um ficheiro para trás.
 *
 * O serviço oferece retry limitado para delete() falhar, logging completo,
 * e pode ser ativado/desativado por configuração.
 */

export class OrphanCleanupService {
  constructor({
    storage,
    downloadStore,
    enabled = true,
    intervalMs = 5 * 60 * 1000,
    maxRetries = 3,
    retryDelayMs = 1000,
  } = {}) {
    this.storage = storage;
    this.downloadStore = downloadStore;
    this.enabled = enabled;
    this.intervalMs = intervalMs;
    this.maxRetries = maxRetries;
    this.retryDelayMs = retryDelayMs;

    this.cleanupTimer = null;
    this.stats = {
      runsCount: 0,
      orphansFound: 0,
      orphansDeleted: 0,
      deleteFailed: 0,
    };
  }

  /**
   * Inicia o timer periódico de cleanup. Se already running, é no-op.
   */
  start() {
    if (!this.enabled) return;
    if (this.cleanupTimer) return; // já a correr

    console.log(`[orphan-cleanup] Iniciado (intervalo: ${this.intervalMs}ms, retries: ${this.maxRetries})`);

    this.cleanupTimer = setInterval(() => {
      this.cleanupOnce().catch((err) => {
        console.error('[orphan-cleanup] erro durante cleanup', err);
      });
    }, this.intervalMs);

    // Timer não deve bloquear shutdown do processo.
    this.cleanupTimer.unref?.();
  }

  /**
   * Para o timer periódico. Já não serão feitas limpezas futuras até chamar
   * start() novamente.
   */
  stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      console.log('[orphan-cleanup] Parado');
    }
  }

  /**
   * Executa uma limpeza de órfãos uma única vez. Chamado pelo timer, mas
   * também pode ser usado para testes ou triggers manuais.
   */
  async cleanupOnce() {
    try {
      this.stats.runsCount += 1;

      // Lista ficheiros atualmente em disco.
      const filesOnDisk = await this.storage.listKeys();

      // Obtém os downloadIds válidos usando a API pública de DownloadStore.
      // Isto evita acesso directo a `downloadStore.records` (detalhe interno).
      const validIds = new Set(this.downloadStore.getValidIds());

      // Identifica órfãos: ficheiros em disco que não têm registo no DownloadStore.
      const orphans = filesOnDisk.filter((id) => !validIds.has(id));

      if (orphans.length === 0) {
        // Sem órfãos, nada a fazer.
        return;
      }

      this.stats.orphansFound += orphans.length;
      console.log(`[orphan-cleanup] Encontrados ${orphans.length} ficheiro(s) órfão(s)`);

      // Tenta deletar cada órfão com retry limitado.
      for (const orphanId of orphans) {
        try {
          await this.deleteWithRetry(orphanId);
          this.stats.orphansDeleted += 1;
        } catch (err) {
          this.stats.deleteFailed += 1;
          console.error(`[orphan-cleanup] Não conseguiu deletar órfão "${orphanId}" após ${this.maxRetries} tentativas:`, err.message);
        }
      }
    } catch (err) {
      console.error('[orphan-cleanup] falha durante limpeza:', err.message);
    }
  }

  /**
   * Deleta um ficheiro com retry limitado. Se delete falhar, aguarda
   * retryDelayMs e tenta novamente até maxRetries.
   *
   * @param {string} downloadId
   * @param {number} attempt - número da tentativa atual (0-indexed)
   * @throws {Error} se todas as tentativas falharem
   */
  async deleteWithRetry(downloadId, attempt = 0) {
    try {
      await this.storage.delete(downloadId);
      console.log(`[orphan-cleanup] Deletado órfão: "${downloadId}"`);
    } catch (err) {
      if (attempt < this.maxRetries - 1) {
        // Ainda há tentativas restantes — aguarda e tenta novamente.
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
        return this.deleteWithRetry(downloadId, attempt + 1);
      }

      // Sem mais tentativas — falha definitivamente.
      throw err;
    }
  }

  /**
   * Retorna estatísticas de limpeza acumuladas desde o início do serviço.
   */
  getStats() {
    return {
      ...this.stats,
    };
  }
}
