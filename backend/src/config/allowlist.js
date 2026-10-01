// B2 — Internet Archive (archive.org) é o primeiro provider real. A
// correspondência em isAllowedHost() é por sufixo (ver função abaixo), o
// que já cobre os nós de armazenamento reais do Archive.org (confirmado
// empiricamente: redirects de /download/ vão para subdomínios como
// "ia601507.us.archive.org", que termina em ".archive.org") sem precisar
// de listar hosts de CDN à parte.
//
// "sample.test" é o domínio reservado (RFC 2606) do demo provider — tem
// de continuar na allowlist para o demo provider continuar a funcionar
// quando a allowlist estiver realmente ligada em produção (ver server.js).
export const allowedDomains = ['archive.org', 'sample.test'];

/**
 * @param {string} hostname
 * @returns {boolean}
 */
export function isAllowedHost(hostname) {
  const normalized = hostname.toLowerCase();
  return allowedDomains.some(
    (domain) => normalized === domain || normalized.endsWith(`.${domain}`)
  );
}
