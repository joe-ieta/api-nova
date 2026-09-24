import type { UpstreamCredentialRegistrySnapshot } from '../credentials/registry';
import { compileSingleHopUpstreamCredentials, type ResolvedSingleHopCredentials } from '../credentials/single-hop-execution';
import type { TrustedOperationBinding } from '../credentials/trusted-operation-bindings';
import { ControlledDnsError } from './controlled-dns';
import { pinnedRecord } from './pinned-http-connection';
import { createNetworkPolicyCompiler, normalizeNetworkUrl, type CompiledNetworkPolicy, type NormalizedNetworkUrl } from './network-policy';

export interface TrustedRedirectTargetRegistration {
  readonly siteId: string; readonly method: 'GET' | 'HEAD'; readonly path: string;
  readonly endpointDefinitionId: string; readonly policy: CompiledNetworkPolicy;
}
export interface TrustedRedirectTarget {
  readonly url: string; readonly binding: Readonly<TrustedOperationBinding>;
  readonly policy: CompiledNetworkPolicy; readonly credentials: ResolvedSingleHopCredentials;
}
const denied = (): never => { throw new ControlledDnsError('upstream_network_policy_denied'); };
/** Exact concrete paths only. No OpenAPI template inference, network I/O, redirect loop or runtime registration. */
export function createTrustedRedirectTargetSelector(input: {
  snapshot: UpstreamCredentialRegistrySnapshot; sourceServiceAssetId: string;
  compiler: ReturnType<typeof createNetworkPolicyCompiler>; targets: readonly TrustedRedirectTargetRegistration[];
}) {
  const options = pinnedRecord(input, ['snapshot', 'sourceServiceAssetId', 'compiler', 'targets'], ['snapshot', 'sourceServiceAssetId', 'compiler', 'targets']);
  const snapshot = options.snapshot as UpstreamCredentialRegistrySnapshot, source = options.sourceServiceAssetId;
  const compiler = options.compiler as ReturnType<typeof createNetworkPolicyCompiler>;
  if (typeof source !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(source) ||
    !snapshot || !Object.isFrozen(snapshot) || !Object.isFrozen(snapshot.candidate) || !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 1 ||
    !Array.isArray(options.targets) || options.targets.length < 1 || options.targets.length > 1024) return denied();
  const siteFor = (url: Readonly<NormalizedNetworkUrl>) => {
    const sites = snapshot.candidate.sites.filter(site => site.sourceServiceAssetId === source && site.match.scheme === url.scheme &&
      site.match.host === url.host && site.match.port === url.port && site.allowedHosts.includes(url.host) &&
      (site.match.basePath === '/' || url.path === site.match.basePath || url.path.startsWith(site.match.basePath + '/')))
      .sort((a, b) => b.match.basePath.length - a.match.basePath.length);
    if (!sites.length || sites.length > 1 && sites[0].match.basePath.length === sites[1].match.basePath.length) return denied();
    return sites[0];
  };
  const key = (site: string, method: string, path: string) => JSON.stringify([site, method, path]);
  const directory = new Map<string, Readonly<TrustedRedirectTargetRegistration>>();
  for (const name of Reflect.ownKeys(options.targets)) {
    const descriptor = Object.getOwnPropertyDescriptor(options.targets, name)!;
    if (typeof name !== 'string' || name !== 'length' && !/^(0|[1-9][0-9]*)$/.test(name) || !('value' in descriptor)) return denied();
  }
  for (const raw of options.targets) {
    const value = pinnedRecord(raw, ['siteId', 'method', 'path', 'endpointDefinitionId', 'policy'], ['siteId', 'method', 'path', 'endpointDefinitionId', 'policy']) as unknown as TrustedRedirectTargetRegistration;
    if (!['GET', 'HEAD'].includes(value.method) || typeof value.path !== 'string' || !value.path.startsWith('/') || /[{}?#\\\s]/.test(value.path) ||
      typeof value.endpointDefinitionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.endpointDefinitionId)) return denied();
    const site = snapshot.candidate.sites.find(site => site.id === value.siteId && site.sourceServiceAssetId === source);
    if (!site || site.endpoints.filter(endpoint => 'endpointDefinitionId' in endpoint && endpoint.endpointDefinitionId === value.endpointDefinitionId).length !== 1) return denied();
    const host = site.match.host.includes(':') ? '[' + site.match.host + ']' : site.match.host;
    const target = normalizeNetworkUrl(`${site.match.scheme}://${host}:${site.match.port}${value.path}`);
    if (target.path !== value.path || siteFor(target).id !== site.id || !compiler.authorizeTarget(value.policy, { sourceServiceAssetId: source, siteId: site.id, url: target.url })) return denied();
    const identity = key(site.id, value.method, value.path);
    if (directory.has(identity)) return denied();
    directory.set(identity, Object.freeze({ ...value }));
  }
  const selected = new WeakSet<TrustedRedirectTarget>();
  const credentials = compileSingleHopUpstreamCredentials({ mode: 'single-hop', captureSnapshot: () => snapshot });
  return Object.freeze({
    async select(previousUrl: string, location: string, method: 'GET' | 'HEAD'): Promise<TrustedRedirectTarget> {
      try {
        if (!['GET', 'HEAD'].includes(method) || typeof location !== 'string' || !location || location.length > 4096 || /[\s\\#]/.test(location) || /%(?:2e|2f|5c)/i.test(location)) return denied();
        const previous = normalizeNetworkUrl(previousUrl); siteFor(previous);
        const next = normalizeNetworkUrl(new URL(location, previous.url).href);
        if (previous.scheme === 'https' && next.scheme === 'http') return denied();
        const site = siteFor(next), registered = directory.get(key(site.id, method, next.path));
        if (!registered || !compiler.authorizeTarget(registered.policy, { sourceServiceAssetId: source, siteId: site.id, url: next.url })) return denied();
        const binding = Object.freeze({ sourceServiceAssetId: source, endpointDefinitionId: registered.endpointDefinitionId, method, path: registered.path });
        const resolved = await credentials.resolve(binding, next.url, method);
        if (resolved.siteId !== site.id || resolved.generation !== snapshot.generation || resolved.revision !== snapshot.candidate.metadata.revision ||
          !compiler.authorizeTarget(registered.policy, { sourceServiceAssetId: source, siteId: site.id, url: next.url })) return denied();
        const result = Object.freeze({ url: next.url, binding, policy: registered.policy, credentials: resolved }); selected.add(result); return result;
      } catch { return denied(); }
    },
    rebuildHeaders(target: TrustedRedirectTarget, previous: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
      try {
        if (!selected.has(target) || !previous || typeof previous !== 'object' || Object.getPrototypeOf(previous) !== Object.prototype) return denied();
        const names = Reflect.ownKeys(previous);
        if (names.length > 128) return denied();
        const managed = new Set(target.credentials.managedHeaderNames.map(name => name.toLowerCase()));
        const headers: Record<string, string> = Object.create(null);
        const seen = new Set<string>();
        for (const name of names) {
          if (typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) return denied();
          const descriptor = Object.getOwnPropertyDescriptor(previous, name);
          if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string' || descriptor.value.length > 8192 || /[\r\n\x00]/.test(descriptor.value)) return denied();
          const normalized = name.toLowerCase();
          if (seen.has(normalized)) return denied(); seen.add(normalized);
          if (!managed.has(normalized) && !['host', 'content-length', 'transfer-encoding', 'accept-encoding'].includes(normalized)) headers[normalized] = descriptor.value;
        }
        Object.assign(headers, target.credentials.headers, { 'accept-encoding': 'identity' });
        return Object.freeze(headers);
      } catch { return denied(); }
    },
  });
}