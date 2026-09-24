import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import { ControlledDnsError, createNetworkPolicyCompiler, createPinnedHttpStreamTransport, type CompiledNetworkPolicy, type UpstreamCredentialRegistrySnapshot, type PinnedHttpStreamRequest } from 'api-nova-parser';
import type { GatewayResolvedRoute } from '../types/gateway-route-snapshot.types';
import { inspectGatewayCredentialProvenance, type GatewayUpstreamCredentialHeaders } from './gateway-upstream-credential-resolver';
export const GATEWAY_TRUSTED_NETWORK_PROVIDER = Symbol('GATEWAY_TRUSTED_NETWORK_PROVIDER');
export interface GatewayNetworkLease { readonly strict: true }
export interface GatewayTrustedNetworkProvider {
  requires(route: GatewayResolvedRoute): boolean;
  authorize(route: GatewayResolvedRoute, url: string, credentials: GatewayUpstreamCredentialHeaders): GatewayNetworkLease;
  send(lease: GatewayNetworkLease, input: Pick<PinnedHttpStreamRequest, 'headers' | 'body' | 'framing' | 'deadline' | 'signal'>): ReturnType<ReturnType<typeof createPinnedHttpStreamTransport>['send']>;
  revoke(routeId: string): void;
}
const providers = new WeakSet<GatewayTrustedNetworkProvider>();
const unavailable = (): never => { throw new ServiceUnavailableException('upstream_network_policy_unavailable'); };
const denied = (): never => { throw new BadGatewayException('upstream_network_policy_denied'); };
export function assertGatewayTrustedNetworkProvider(provider: GatewayTrustedNetworkProvider): void { if (!providers.has(provider)) unavailable(); }
/** Explicit host-only registration. No DI default, config/metadata flag or management endpoint. */
export function createGatewayTrustedNetworkProvider(input: {
  compiler: ReturnType<typeof createNetworkPolicyCompiler>; servers: readonly string[]; ca?: string;
  registrations: readonly { route: GatewayResolvedRoute; snapshot: UpstreamCredentialRegistrySnapshot; siteId: string; policy: CompiledNetworkPolicy;
    captureSnapshot: () => UpstreamCredentialRegistrySnapshot; captureRouteBinding: () => object | undefined }[];
}): GatewayTrustedNetworkProvider {
  const compiler = input.compiler, servers = Object.freeze([...input.servers]), ca = input.ca;
  const bindings = new WeakSet<object>(), scopes = new Set<string>();
  const scope = (route: GatewayResolvedRoute) => JSON.stringify([route.runtimeAsset.id, route.membership.id]);
  const entries = new Map<string, { route: GatewayResolvedRoute; signature: string; snapshot: UpstreamCredentialRegistrySnapshot; siteId: string; policy: CompiledNetworkPolicy;
    captureSnapshot: () => UpstreamCredentialRegistrySnapshot; captureRouteBinding: () => object | undefined; active: boolean }>();
  const signature = (route: GatewayResolvedRoute) => JSON.stringify([route.routeBinding, route.sourceServiceAsset.id, route.endpointDefinition.id, route.upstreamBaseUrl]);
  for (const value of input.registrations) {
    const id = value.route.routeBinding.id;
    if (!id || entries.has(id) || !Object.isFrozen(value.snapshot) || typeof value.captureSnapshot !== 'function' || typeof value.captureRouteBinding !== 'function') unavailable();
    const site = value.snapshot.candidate.sites.find(site => site.id === value.siteId && site.sourceServiceAssetId === value.route.sourceServiceAsset.id);
    if (!site || !compiler.authorizeTarget(value.policy, { sourceServiceAssetId: value.route.sourceServiceAsset.id, siteId: value.siteId, url: value.route.upstreamBaseUrl })) unavailable();
    bindings.add(value.route.routeBinding); scopes.add(scope(value.route));
    entries.set(id, { ...value, signature: signature(value.route), active: true });
  }
  const state = (entry: NonNullable<ReturnType<typeof entries.get>>): 'active' | 'denied' | 'unavailable' => {
    try { return entry.active && entry.captureSnapshot() === entry.snapshot && entry.captureRouteBinding() === entry.route.routeBinding && signature(entry.route) === entry.signature ? 'active' : 'denied'; }
    catch { return 'unavailable'; }
  };
  const requireCurrent = (entry: NonNullable<ReturnType<typeof entries.get>>) => {
    const observed = state(entry); if (observed === 'unavailable') unavailable(); if (observed !== 'active') denied();
  };
  const leases = new WeakMap<GatewayNetworkLease, { entry: NonNullable<ReturnType<typeof entries.get>>; url: string; method: string; used: boolean }>();
  const provider: GatewayTrustedNetworkProvider = Object.freeze({
    requires(route: GatewayResolvedRoute) { return bindings.has(route.routeBinding) || entries.has(route.routeBinding.id) || scopes.has(scope(route)); },
    authorize(route: GatewayResolvedRoute, url: string, credentials: GatewayUpstreamCredentialHeaders) {
      const entry = entries.get(route.routeBinding.id);
      if (!entry) return denied(); requireCurrent(entry);
      if (route.routeBinding !== entry.route.routeBinding || signature(route) !== entry.signature ||
        inspectGatewayCredentialProvenance(credentials, route, url) !== entry.snapshot || !credentials.compiledHeaderPolicy ||
        credentials.registrySiteId !== entry.siteId || credentials.registryGeneration !== entry.snapshot.generation || credentials.registryRevision !== entry.snapshot.candidate.metadata.revision ||
        !compiler.authorizeTarget(entry.policy, { sourceServiceAssetId: route.sourceServiceAsset.id, siteId: entry.siteId, url })) return denied();
      const lease = Object.freeze({ strict: true as const }); leases.set(lease, { entry, url, method: route.routeBinding.upstreamMethod, used: false }); return lease;
    },
    async send(lease: GatewayNetworkLease, request: Pick<PinnedHttpStreamRequest, 'headers' | 'body' | 'framing' | 'deadline' | 'signal'>) {
      const context = leases.get(lease); if (!context || context.used) return denied(); context.used = true; requireCurrent(context.entry);
      const { entry, url, method } = context;
      // Revalidate host identity at each B1/B3a check, including after DNS/TLS and before bytes.
      let guardUnavailable = false;
      const check = () => { const observed = state(entry); if (observed === 'unavailable') guardUnavailable = true; return !guardUnavailable && observed === 'active'; };
      const guardedCompiler = { ...compiler,
        authorizeTarget: (...args: Parameters<typeof compiler.authorizeTarget>) => check() && compiler.authorizeTarget(...args),
        allows: (...args: Parameters<typeof compiler.allows>) => check() && compiler.allows(...args) };
      const transport = createPinnedHttpStreamTransport({ compiler: guardedCompiler, servers, ...(ca === undefined ? {} : { ca }) });
      try { return await transport.send({ ...request, rejectInformationalResponses: true, method, policy: entry.policy, target: { sourceServiceAssetId: entry.route.sourceServiceAsset.id, siteId: entry.siteId, url } }); }
      catch (failure) {
        if (guardUnavailable && failure instanceof ControlledDnsError && ['upstream_network_policy_denied', 'upstream_network_policy_unavailable'].includes(failure.code)) throw new ControlledDnsError('upstream_network_policy_unavailable');
        throw failure;
      }
    },
    revoke(id: string) { const entry = entries.get(id); if (entry) entry.active = false; },
  });
  providers.add(provider); return provider;
}
