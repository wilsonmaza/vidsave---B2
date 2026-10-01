import net from 'node:net';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { validateUrlSyntax, SecurityValidationError } from './url-validator.js';

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_REDIRECTS = 3;

// --- Camada 1: hostnames obviamente perigosos, bloqueados sem tocar em DNS ---

const BLOCKED_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /^metadata\.google\.internal$/i,
];

function isObviouslyBlockedHostname(hostname) {
  return BLOCKED_HOSTNAME_PATTERNS.some((pattern) => pattern.test(hostname));
}

// --- Camada 2: blocos de IPv4 reservados/privados ---
// Inclui privados clássicos (RFC1918), loopback, link-local (onde vive o
// endpoint de metadata 169.254.169.254 de AWS/GCP/Azure/DigitalOcean),
// carrier-grade NAT, e os blocos de documentação/benchmark/multicast.

const BLOCKED_IPV4_RANGES = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  ['255.255.255.255', 32],
];

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return null;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isBlockedIPv4(ip) {
  const value = ipv4ToInt(ip);
  if (value === null) return true; // não parseável -> bloqueado por defeito
  return BLOCKED_IPV4_RANGES.some(([base, prefix]) => {
    const baseValue = ipv4ToInt(base);
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return (value & mask) === (baseValue & mask);
  });
}

// --- Camada 3: blocos de IPv6 reservados/privados ---
// fc00::/7 cobre tanto o unique-local "normal" como o intervalo usado pelo
// IMDSv2 da AWS (fd00:ec2::/32) — não precisa de entrada própria.

const BLOCKED_IPV6_RANGES = [
  ['::1', 128],
  ['::', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
];

function ipv6ToGroups(ip) {
  let address = ip;

  // Endereços que terminam em notação IPv4 pontuada (ex: ::ffff:10.0.0.1)
  // são convertidos para grupos hexadecimais antes de continuar.
  const ipv4Tail = address.match(/^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (ipv4Tail) {
    const ipv4Int = ipv4ToInt(ipv4Tail[2]);
    if (ipv4Int === null) return null;
    const high = ((ipv4Int >>> 16) & 0xffff).toString(16);
    const low = (ipv4Int & 0xffff).toString(16);
    address = `${ipv4Tail[1]}${high}:${low}`;
  }

  if (address.includes('::')) {
    if (address.split('::').length > 2) return null; // '::' só pode aparecer uma vez
    const [head, tail] = address.split('::');
    const headGroups = head ? head.split(':').filter(Boolean) : [];
    const tailGroups = tail ? tail.split(':').filter(Boolean) : [];
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 0) return null;
    const groups = [...headGroups, ...new Array(missing).fill('0'), ...tailGroups];
    if (groups.length !== 8) return null;
    const parsed = groups.map((g) => parseInt(g, 16));
    return parsed.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff) ? null : parsed;
  }

  const groups = address.split(':');
  if (groups.length !== 8) return null;
  const parsed = groups.map((g) => parseInt(g, 16));
  return parsed.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff) ? null : parsed;
}

function ipv6ToBigInt(ip) {
  const groups = ipv6ToGroups(ip);
  if (!groups) return null;
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(group), 0n);
}

function isBlockedIPv6(ip) {
  const value = ipv6ToBigInt(ip);
  if (value === null) return true; // não parseável -> bloqueado por defeito

  // Endereços IPv4-mapeados (::ffff:0:0/96) escapariam aos blocos acima se
  // não fossem reavaliados como o IPv4 que realmente representam.
  const top96 = value >> 32n;
  if (top96 === 0xffffn) {
    const ipv4Value = Number(value & 0xffffffffn);
    const ipv4Str = [24, 16, 8, 0].map((shift) => (ipv4Value >>> shift) & 0xff).join('.');
    return isBlockedIPv4(ipv4Str);
  }

  return BLOCKED_IPV6_RANGES.some(([base, prefix]) => {
    const baseValue = ipv6ToBigInt(base);
    const fullMask = (1n << 128n) - 1n;
    const mask = prefix === 0 ? 0n : (fullMask << BigInt(128 - prefix)) & fullMask;
    return (value & mask) === (baseValue & mask);
  });
}

/**
 * @param {string} ip - endereço IP literal (não um hostname)
 * @returns {boolean}
 */
export function isBlockedAddress(ip) {
  if (net.isIPv4(ip)) return isBlockedIPv4(ip);
  if (net.isIPv6(ip)) return isBlockedIPv6(ip);
  return true; // não reconhecido -> bloqueado por defeito
}

// --- Resolução DNS controlada + fixação do IP ---

/**
 * Resolve TODOS os endereços de um hostname (A e AAAA). `lookup` é
 * injetável para testes, sem tocar em DNS real.
 */
export async function resolveAllAddresses(hostname, { lookup = dns.promises.lookup } = {}) {
  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new SecurityValidationError(`Falha ao resolver DNS para "${hostname}": ${err.message}`);
  }
  return Array.isArray(addresses) ? addresses : [addresses];
}

/**
 * Valida um hostname por completo: bloqueia hostnames óbvios, resolve DNS,
 * e rejeita se QUALQUER endereço devolvido for privado/reservado — mesmo
 * que outro endereço da mesma resposta seja público. Isto cobre o caso de
 * um hostname com múltiplos registos DNS, um público e um privado.
 */
export async function assertSafeHostname(hostname, { lookup } = {}) {
  if (isObviouslyBlockedHostname(hostname)) {
    throw new SecurityValidationError(`Hostname bloqueado explicitamente: "${hostname}".`);
  }

  const addresses = await resolveAllAddresses(hostname, { lookup });
  if (addresses.length === 0) {
    throw new SecurityValidationError(`DNS não devolveu nenhum endereço para "${hostname}".`);
  }

  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new SecurityValidationError(`Endereço bloqueado para "${hostname}": ${address}.`);
    }
  }

  // Fixa o primeiro endereço já validado. A ligação real (ver
  // createPinnedLookup) nunca volta a consultar o DNS — é isto que fecha a
  // janela de DNS rebinding entre esta validação e o pedido feito a seguir.
  const [{ address: pinnedAddress, family }] = addresses;
  return { pinnedAddress, family, allAddresses: addresses };
}

/**
 * Devolve uma função `lookup` (mesma assinatura que `dns.lookup`) que
 * ignora por completo o hostname pedido e responde sempre com o endereço
 * já validado. Usada no Agent do http/https para que a ligação TCP real
 * nunca dependa de uma segunda resolução de DNS.
 */
export function createPinnedLookup(pinnedAddress, family) {
  return (hostname, optionsOrCallback, maybeCallback) => {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    callback(null, pinnedAddress, family);
  };
}

export function createPinnedAgent({ pinnedAddress, family, protocol }) {
  const AgentClass = protocol === 'https:' ? https.Agent : http.Agent;
  return new AgentClass({ lookup: createPinnedLookup(pinnedAddress, family) });
}

// --- Pedido HTTP real (usado quando não há requestFn injetado nos testes) ---

function performRequest(parsedUrl, { agent, timeoutMs }) {
  const client = parsedUrl.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.request(parsedUrl, { agent, timeout: timeoutMs }, (res) => {
      resolve({ status: res.statusCode, headers: res.headers, stream: res });
    });

    // Timeout ao nível do socket, como defesa adicional à do safeFetch.
    req.on('timeout', () => req.destroy(new SecurityValidationError('Pedido excedeu o tempo limite (socket).')));
    req.on('error', reject);
    req.end();
  });
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new SecurityValidationError('Pedido excedeu o tempo limite.')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Envolve uma função de lookup com um mapa de overrides estáticos para
 * hostnames conhecidos (ex.: domínios de teste reservados que nunca têm
 * DNS real). Qualquer hostname fora do mapa cai para a função de
 * fallback (por defeito, `dns.promises.lookup` real).
 *
 * Isto não enfraquece a proteção: um hostname com override ainda passa
 * pelo mesmo bloqueio de IP em `assertSafeHostname` — só evita uma
 * consulta de DNS real para hostnames que já conhecemos de antemão. Não
 * sabe nada sobre o VidSave especificamente; quem decide que overrides
 * usar é o chamador.
 */
export function createLookupWithOverrides(overrides, { fallback = dns.promises.lookup } = {}) {
  return async (hostname, options) => {
    if (Object.prototype.hasOwnProperty.call(overrides, hostname)) {
      return overrides[hostname];
    }
    return fallback(hostname, options);
  };
}

/**
 * Ponto de entrada principal. Valida sintaxe, (opcionalmente) allowlist,
 * resolve e fixa o DNS, faz o pedido, e — se vier um redirect — repete todo
 * o ciclo de validação para o novo destino, do zero, até `maxRedirects`.
 *
 * `isHostAllowed` é opcional e injetado pelo chamador: o ssrf-guard não
 * conhece a allowlist do VidSave, só sabe verificar se uma rede é segura.
 */
export async function safeFetch(rawUrl, {
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  lookup,
  requestFn = performRequest,
  isHostAllowed,
} = {}) {
  let currentUrl = rawUrl;
  let redirectCount = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const parsed = validateUrlSyntax(currentUrl);

    if (isHostAllowed && !isHostAllowed(parsed.hostname)) {
      throw new SecurityValidationError(`Domínio não permitido: "${parsed.hostname}".`);
    }

    const { pinnedAddress, family } = await assertSafeHostname(parsed.hostname, { lookup });
    const agent = createPinnedAgent({ pinnedAddress, family, protocol: parsed.protocol });

    const response = await withTimeout(requestFn(parsed, { agent, timeoutMs }), timeoutMs);

    const isRedirect = response.status >= 300 && response.status < 400 && response.headers?.location;
    if (!isRedirect) {
      return response;
    }

    redirectCount += 1;
    if (redirectCount > maxRedirects) {
      throw new SecurityValidationError(`Número máximo de redirects excedido (${maxRedirects}).`);
    }

    // Resolve o Location contra o URL atual (cobre redirects relativos) e
    // volta ao topo do ciclo — o novo destino passa por TODA a validação,
    // exatamente como o pedido original.
    currentUrl = new URL(response.headers.location, parsed).toString();
  }
}
