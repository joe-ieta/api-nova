import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { NETWORK_ADDRESS_TABLE_VERSION, rejectNetworkPolicy, parseNetworkAddress, parseNetworkCidr, classifyNetworkAddress, normalizeExceptionCidr, cidrContains } from './address-policy';

function record(raw: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Object.getPrototypeOf(raw) !== Object.prototype) return rejectNetworkPolicy();
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string' || ![...required, ...optional].includes(key)) return rejectNetworkPolicy();
    const descriptor = Object.getOwnPropertyDescriptor(raw, key)!; if (!('value' in descriptor)) return rejectNetworkPolicy(); result[key] = descriptor.value;
  }
  if (required.some(key => !Object.prototype.hasOwnProperty.call(result, key))) return rejectNetworkPolicy();
  return result;
}
function string(raw: unknown, max = 128): string { if (typeof raw !== 'string' || !raw || raw.length > max || raw.trim() !== raw || /[\x00-\x1f\x7f]/.test(raw)) return rejectNetworkPolicy(); return raw; }
function id(raw: unknown): string { const value = string(raw); if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)) return rejectNetworkPolicy(); return value; }
function array(raw: unknown): unknown[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype || raw.length > 128) return rejectNetworkPolicy();
  for (const key of Reflect.ownKeys(raw)) { if (typeof key !== 'string' || key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key) || !('value' in Object.getOwnPropertyDescriptor(raw, key)!)) return rejectNetworkPolicy(); }
  return Array.from(raw);
}
export interface NormalizedNetworkUrl { readonly url: string; readonly origin: string; readonly scheme: 'http' | 'https'; readonly host: string; readonly port: number; readonly path: string }
/** Reject ambiguous literals before WHATWG can convert shortened/octal/hex IPv4. */
export function normalizeNetworkUrl(raw: unknown): Readonly<NormalizedNetworkUrl> {
  const value = string(raw, 4096);
  if (/[\s\\#]/u.test(value) || /%(?:2e|2f|5c)/iu.test(value)) return rejectNetworkPolicy();
  const match = /^(https?):\/\/([^/?#]+)(.*)$/iu.exec(value); if (!match) return rejectNetworkPolicy();
  const authority = match[2]; if (authority.includes('@') || authority.includes('%')) return rejectNetworkPolicy();
  const hostMatch = /^(\[[^\]]+\]|[^:]+)(?::([1-9][0-9]{0,4}))?$/.exec(authority); if (!hostMatch) return rejectNetworkPolicy();
  const rawHost = hostMatch[1], unbracketed = rawHost.startsWith('[') ? rawHost.slice(1, -1) : rawHost;
  const rawFamily = isIP(unbracketed);
  if (rawHost.startsWith('[') && rawFamily !== 6) return rejectNetworkPolicy();
  if (!rawFamily && /^(?:[0-9]+|0x[0-9a-f]+)(?:\.(?:[0-9]+|0x[0-9a-f]+))*$/iu.test(rawHost)) return rejectNetworkPolicy();
  let parsed: URL; try { parsed = new URL(value); } catch { return rejectNetworkPolicy(); }
  let host = parsed.hostname.toLowerCase();
  if (host.endsWith('.') || parsed.username || parsed.password || parsed.hash) return rejectNetworkPolicy();
  if (rawFamily) host = parseNetworkAddress(unbracketed).canonical;
  else {
    if (isIP(host) || host.length > 253 || host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return rejectNetworkPolicy();
  }
  const scheme = parsed.protocol.slice(0, -1) as 'http' | 'https';
  const port = hostMatch[2] ? Number(hostMatch[2]) : scheme === 'https' ? 443 : 80;
  if (port > 65535) return rejectNetworkPolicy();
  const origin = `${scheme}://${host.includes(':') ? '[' + host + ']' : host}:${port}`;
  return Object.freeze({ url: origin + parsed.pathname + parsed.search, origin, scheme, host, port, path: parsed.pathname });
}
function origin(raw: unknown): string {
  if (typeof raw !== 'string' || !/^https?:\/\/[^/?#]+\/?$/iu.test(raw)) return rejectNetworkPolicy();
  const result = normalizeNetworkUrl(raw);
  if (result.path !== '/' || new URL(string(raw, 4096)).search) return rejectNetworkPolicy();
  return result.origin;
}
function instant(raw: unknown): number {
  if (typeof raw !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(raw)) return rejectNetworkPolicy();
  const time = Date.parse(raw); if (!Number.isFinite(time) || new Date(time).toISOString() !== raw.replace(/Z$/, raw.includes('.') ? 'Z' : '.000Z')) return rejectNetworkPolicy();
  return time;
}
export interface CompiledNetworkPolicy {
  readonly version: 1; readonly id: string; readonly revision: string; readonly sourceServiceAssetId: string; readonly siteId: string;
  readonly origin: string; readonly mode: 'public' | 'private-exception'; readonly connection: 'direct'; readonly tableVersion: string; readonly identity: string;
  readonly exception?: Readonly<{ id: string; revision: string; addresses: readonly string[]; issuedAt: number; expiresAt: number; purpose: string; owner: string; approvalRef: string }>;
}
export interface NetworkTargetInput { sourceServiceAssetId: string; siteId: string; url: string }
export interface NetworkDestinationInput extends NetworkTargetInput { address: string; endpointAddresses?: readonly string[] }
/** Host constructs this once at boot. No network, request, OpenAPI or metadata discovery occurs here.
 * Compiled objects are instance-local capabilities, not JSON-restorable enforcement claims.
 * Loopback is only enabled in explicitly marked isolated tests; production isolation needs a later host integration.
 */
export function createNetworkPolicyCompiler(hostInput: unknown) {
  const host = record(hostInput, ['deniedDestinations', 'loopback']);
  if (host.loopback !== 'deny' && host.loopback !== 'test-only') return rejectNetworkPolicy();
  const loopback = host.loopback;
  const denies = array(host.deniedDestinations).map(raw => {
    const entry = record(raw, ['address'], ['ports']); const range = parseNetworkCidr(entry.address);
    const ports = entry.ports === undefined ? undefined : array(entry.ports).map(port => { if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) return rejectNetworkPolicy(); return Number(port); });
    if (ports?.length === 0) return rejectNetworkPolicy();
    return { range, ports };
  });
  // These known metadata destinations remain forbidden even inside private exceptions.
  const builtins = ['169.254.169.254', 'fd00:ec2::254'].map(parseNetworkAddress);
  const compiled = new WeakSet<CompiledNetworkPolicy>();
  const hostDigest = createHash('sha256').update(JSON.stringify([loopback, denies.map(item => [item.range.canonical, item.ports])])).digest('hex');
  function compile(raw: unknown, now = Date.now()): CompiledNetworkPolicy {
    if (!Number.isFinite(now)) return rejectNetworkPolicy();
    const value = record(raw, ['version', 'id', 'revision', 'sourceServiceAssetId', 'siteId', 'origin', 'mode', 'connection'], ['privateException']);
    if (value.version !== 1 || value.connection !== 'direct' || (value.mode !== 'public' && value.mode !== 'private-exception')) return rejectNetworkPolicy();
    const base = { version: 1 as const, id: id(value.id), revision: id(value.revision), sourceServiceAssetId: id(value.sourceServiceAssetId), siteId: id(value.siteId), origin: origin(value.origin),
      mode: value.mode as 'public' | 'private-exception', connection: 'direct' as const, tableVersion: NETWORK_ADDRESS_TABLE_VERSION };
    let exception: CompiledNetworkPolicy['exception'];
    if (base.mode === 'public') { if (Object.prototype.hasOwnProperty.call(value, 'privateException')) return rejectNetworkPolicy(); }
    else {
      const e = record(value.privateException, ['id', 'revision', 'sourceServiceAssetId', 'siteId', 'origin', 'addresses', 'purpose', 'owner', 'approvalRef', 'issuedAt', 'expiresAt']);
      if (id(e.sourceServiceAssetId) !== base.sourceServiceAssetId || id(e.siteId) !== base.siteId || origin(e.origin) !== base.origin) return rejectNetworkPolicy();
      const issuedAt = instant(e.issuedAt), expiresAt = instant(e.expiresAt);
      if (issuedAt > now || expiresAt <= now || expiresAt <= issuedAt || expiresAt - issuedAt > 30 * 86400000) return rejectNetworkPolicy();
      const addresses = [...new Set(array(e.addresses).map(normalizeExceptionCidr))].sort(); if (!addresses.length) return rejectNetworkPolicy();
      const destination = normalizeNetworkUrl(base.origin);
      if (addresses.some(cidr => { const range = parseNetworkCidr(cidr); return builtins.some(address => cidrContains(range, address))
        || denies.some(deny => (!deny.ports || deny.ports.includes(destination.port)) && deny.range.family === range.family && deny.range.value <= range.last && range.value <= deny.range.last); })) return rejectNetworkPolicy();
      if (loopback === 'deny' && addresses.some(cidr => classifyNetworkAddress(cidr.split('/')[0]).category === 'loopback')) return rejectNetworkPolicy();
      exception = Object.freeze({ id: id(e.id), revision: id(e.revision), addresses: Object.freeze(addresses), issuedAt, expiresAt, purpose: string(e.purpose, 1000), owner: string(e.owner, 256), approvalRef: string(e.approvalRef, 1000) });
    }
    const payload = { ...base, ...(exception ? { exception } : {}) };
    const result = Object.freeze({ ...payload, identity: createHash('sha256').update(JSON.stringify([hostDigest, payload])).digest('hex') });
    compiled.add(result); return result;
  }
  /** Instance capability and target scope, deliberately independent of DNS/address selection. */
  function authorizeTarget(policy: CompiledNetworkPolicy, input: NetworkTargetInput, now = Date.now()): boolean {
    try {
      if (!compiled.has(policy) || !Number.isFinite(now)) return false;
      const value = record(input, ['sourceServiceAssetId', 'siteId', 'url']);
      const target = normalizeNetworkUrl(value.url);
      if (value.sourceServiceAssetId !== policy.sourceServiceAssetId || value.siteId !== policy.siteId || target.origin !== policy.origin) return false;
      return policy.mode === 'public' || !!policy.exception && now >= policy.exception.issuedAt && now < policy.exception.expiresAt;
    } catch { return false; }
  }
  function allows(policy: CompiledNetworkPolicy, input: NetworkDestinationInput, now = Date.now()): boolean {
    try {
      if (!compiled.has(policy) || !Number.isFinite(now)) return false;
      const value = record(input, ['sourceServiceAssetId', 'siteId', 'url', 'address'], ['endpointAddresses']);
      const target = normalizeNetworkUrl(value.url), address = parseNetworkAddress(value.address), classification = classifyNetworkAddress(value.address);
      if (!authorizeTarget(policy, { sourceServiceAssetId: value.sourceServiceAssetId as string, siteId: value.siteId as string, url: value.url as string }, now)) return false;
      if (isIP(target.host) && parseNetworkAddress(target.host).canonical !== address.canonical) return false;
      if (builtins.some(item => item.family === address.family && item.value === address.value) || denies.some(item => cidrContains(item.range, address) && (!item.ports || item.ports.includes(target.port)))) return false;
      if (!['public', 'private', 'loopback'].includes(classification.category)) return false;
      if (classification.category === 'loopback' && loopback !== 'test-only') return false;
      if (value.endpointAddresses !== undefined && !array(value.endpointAddresses).map(parseNetworkCidr).some(range => cidrContains(range, address))) return false;
      if (policy.mode === 'public') return classification.category === 'public';
      const e = policy.exception!;
      return now >= e.issuedAt && now < e.expiresAt && e.addresses.map(parseNetworkCidr).some(range => cidrContains(range, address));
    } catch { return false; }
  }
  return Object.freeze({ compile, authorizeTarget, allows });
}
