import { ProviderRegistry } from './registry.js';
import { demoProvider } from './demo-provider.js';
import { createArchiveOrgProvider } from './archive-org-provider.js';
import { isAllowedHost } from '../config/allowlist.js';

/**
 * Cria um registry com os providers ativos, de acordo com a configuração
 * recebida. É o único sítio da aplicação que decide "que providers estão
 * ligados" — controllers e rotas (quando existirem, na Etapa 5) só vão
 * pedir ao registry para encontrar um provider, nunca decidem isto sozinhos.
 *
 * @param {{
 *   demoProviderEnabled?: boolean,
 *   archiveOrgProviderEnabled?: boolean,
 *   isHostAllowed?: (hostname: string) => boolean,
 * }} [config]
 *   `isHostAllowed` (B2) é passado ao archive-org-provider, que o repassa
 *   ao safeFetch em todos os pedidos que faz. Por omissão usa a allowlist
 *   real (config/allowlist.js) — os testes podem injetar outra, ou uma
 *   sempre-verdadeira, sem tocar em configuração real.
 */
export function createProviderRegistry({
  demoProviderEnabled = true,
  archiveOrgProviderEnabled = true,
  isHostAllowed = isAllowedHost,
} = {}) {
  const registry = new ProviderRegistry();
  registry.register(demoProvider, { enabled: demoProviderEnabled });
  registry.register(createArchiveOrgProvider({ isHostAllowed }), { enabled: archiveOrgProviderEnabled });
  return registry;
}
