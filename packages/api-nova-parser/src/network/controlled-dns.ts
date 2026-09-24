import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { parseNetworkAddress, parseNetworkCidr } from './address-policy';
import { CompiledNetworkPolicy, createNetworkPolicyCompiler, NetworkTargetInput, normalizeNetworkUrl } from './network-policy';

type Compiler = ReturnType<typeof createNetworkPolicyCompiler>;
export class ControlledDnsError extends Error {
  constructor(readonly code: 'upstream_network_policy_denied' | 'upstream_network_policy_unavailable' | 'ETIMEDOUT' | 'ABORT_ERR') {
    super(code); this.name = 'ControlledDnsError';
  }
}
export interface ControlledDnsTarget extends NetworkTargetInput { readonly endpointAddresses?: readonly string[] }
export interface ControlledDnsRequest { readonly policy: CompiledNetworkPolicy; readonly target: ControlledDnsTarget; readonly deadline: number; readonly signal?: AbortSignal }
export interface ApprovedDnsResolution {
  readonly url: string; readonly host: string; readonly port: number; readonly policyIdentity: string;
  readonly addresses: readonly Readonly<{ address: string; family: 4 | 6 }>[];
}
function denied(): never { throw new ControlledDnsError('upstream_network_policy_denied'); }
function object(raw: unknown, keys: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Object.getPrototypeOf(raw) !== Object.prototype) return denied();
  const copy: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string' || !keys.includes(key)) return denied();
    const property = Object.getOwnPropertyDescriptor(raw, key)!;
    if (!('value' in property)) return denied(); copy[key] = property.value;
  }
  if (required.some(key => !Object.prototype.hasOwnProperty.call(copy, key))) return denied();
  return copy;
}
/** Host-only constructor. Fixed DNS servers, no OS lookup fallback, shared resolver or injected transport.
 * Answers are a one-attempt address authorization, never proof of public reachability or socket identity.
 * B2 must call revalidate immediately before handing a connected/verified socket to HTTP.
 */
export function createControlledDns(hostInput: { compiler: Compiler; servers: readonly string[] }) {
  const host = object(hostInput, ['compiler', 'servers'], ['compiler', 'servers']);
  const compiler = host.compiler as Compiler;
  if (!compiler || typeof compiler.authorizeTarget !== 'function' || typeof compiler.allows !== 'function') return denied();
  if (!Array.isArray(host.servers) || !host.servers.length || host.servers.length > 8) return denied();
  const servers = host.servers.map(raw => {
    if (typeof raw !== 'string') return denied();
    // Server ports are only a host/test configuration; DNS names are never allowed here.
    const match = /^(\[[^\]]+\]|[^:]+)(?::([1-9][0-9]{0,4}))?$/.exec(raw);
    if (isIP(raw)) return parseNetworkAddress(raw).canonical;
    if (!match || match[2] && Number(match[2]) > 65535) return denied();
    const address = match[1].startsWith('[') ? match[1].slice(1, -1) : match[1];
    if (!isIP(address)) return denied(); parseNetworkAddress(address);
    return raw;
  });
  // Validate once without making DNS traffic. Each resolve below creates a fresh instance.
  try { new Resolver().setServers(servers); } catch { return denied(); }
  const approved = new WeakMap<ApprovedDnsResolution, { request: ControlledDnsRequest; monotonicDeadline: number }>();
  function revalidate(resolution: ApprovedDnsResolution): boolean {
    try {
      const saved = approved.get(resolution); if (!saved) return false;
      const { request, monotonicDeadline } = saved;
      if (request.signal?.aborted || Date.now() >= request.deadline || performance.now() >= monotonicDeadline) return false;
      const { sourceServiceAssetId, siteId, url } = request.target;
      if (!compiler.authorizeTarget(request.policy, { sourceServiceAssetId, siteId, url })) return false;
      return resolution.addresses.every(item => compiler.allows(request.policy, { ...request.target, address: item.address }));
    } catch { return false; }
  }
  async function resolve(input: ControlledDnsRequest): Promise<ApprovedDnsResolution> {
    let resolver: Resolver | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined, signal: AbortSignal | undefined;
    try {
      const raw = object(input, ['policy', 'target', 'deadline', 'signal'], ['policy', 'target', 'deadline']);
      const targetRaw = object(raw.target, ['sourceServiceAssetId', 'siteId', 'url', 'endpointAddresses'], ['sourceServiceAssetId', 'siteId', 'url']);
      const { sourceServiceAssetId, siteId, url } = targetRaw as unknown as NetworkTargetInput;
      const policy = raw.policy as CompiledNetworkPolicy;
      if (!compiler.authorizeTarget(policy, { sourceServiceAssetId, siteId, url })) return denied();
      let endpointAddresses: readonly string[] | undefined;
      if (targetRaw.endpointAddresses !== undefined) {
        if (!Array.isArray(targetRaw.endpointAddresses) || !targetRaw.endpointAddresses.length || targetRaw.endpointAddresses.length > 128) return denied();
        endpointAddresses = Object.freeze(targetRaw.endpointAddresses.map(value => parseNetworkCidr(value).canonical));
      }
      const target = Object.freeze({ sourceServiceAssetId, siteId, url, ...(endpointAddresses ? { endpointAddresses } : {}) });
      const deadline = raw.deadline;
      if (typeof deadline !== 'number' || !Number.isFinite(deadline)) return denied();
      signal = raw.signal as AbortSignal | undefined;
      if (signal !== undefined && !(signal instanceof AbortSignal)) return denied();
      if (signal?.aborted) throw new ControlledDnsError('ABORT_ERR');
      const remaining = deadline - Date.now(), monotonicDeadline = performance.now() + remaining;
      if (remaining <= 0) throw new ControlledDnsError('ETIMEDOUT');
      const normalized = normalizeNetworkUrl(url);
      let addresses: string[];
      if (isIP(normalized.host)) addresses = [normalized.host];
      else {
        const budget = Math.min(5000, remaining);
        resolver = new Resolver({ timeout: Math.max(1, Math.ceil(budget)), tries: 1 }); resolver.setServers(servers);
        const query = async (family: 4 | 6): Promise<string[]> => {
          try { return await (family === 4 ? resolver!.resolve4(normalized.host) : resolver!.resolve6(normalized.host)); }
          catch (error) {
            // Only a successful DNS no-data result may omit one family. NXDOMAIN and partial failures deny all.
            if ((error as NodeJS.ErrnoException).code === 'ENODATA') return [];
            if ((error as NodeJS.ErrnoException).code === 'ETIMEOUT') throw new ControlledDnsError('ETIMEDOUT');
            throw new ControlledDnsError('upstream_network_policy_unavailable');
          }
        };
        const stop = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ControlledDnsError('ETIMEDOUT')), budget);
          abort = () => reject(new ControlledDnsError('ABORT_ERR'));
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
        const records = await Promise.race([Promise.all([query(4), query(6)]), stop]);
        addresses = records.flat();
      }
      if (signal?.aborted) throw new ControlledDnsError('ABORT_ERR');
      if (Date.now() >= deadline || performance.now() >= monotonicDeadline) throw new ControlledDnsError('ETIMEDOUT');
      if (!addresses.length || addresses.length > 256) return denied();
      const unique = new Map<string, Readonly<{ address: string; family: 4 | 6 }>>();
      for (const candidate of addresses) {
        const parsed = parseNetworkAddress(candidate);
        if (!compiler.allows(policy, { ...target, address: parsed.canonical })) return denied();
        unique.set(parsed.canonical, Object.freeze({ address: parsed.canonical, family: parsed.family }));
      }
      const result = Object.freeze({ url: normalized.url, host: normalized.host, port: normalized.port, policyIdentity: policy.identity, addresses: Object.freeze([...unique.values()]) });
      approved.set(result, { request: { policy, target, deadline, signal }, monotonicDeadline });
      if (!revalidate(result)) return denied();
      return result;
    } catch (error) {
      if (error instanceof ControlledDnsError) throw error;
      // Never retain DNS error text, hostname, IP, query, or native cause on the public error.
      throw new ControlledDnsError('upstream_network_policy_denied');
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
      resolver?.cancel();
    }
  }
  return Object.freeze({ resolve, revalidate });
}
