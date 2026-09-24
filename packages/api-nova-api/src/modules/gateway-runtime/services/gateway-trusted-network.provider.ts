import { BadGatewayException, GatewayTimeoutException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ControlledDnsError, createNetworkOperationAuthority, createNetworkPolicyCompiler, createPinnedHttpStreamTransport, type AuthorizedNetworkOperationContext, type NetworkOperationHandle, type NetworkOperationSelector, type CompiledNetworkPolicy, type UpstreamCredentialRegistrySnapshot, type PinnedHttpStreamRequest } from 'api-nova-parser';
import type { GatewayResolvedRoute } from '../types/gateway-route-snapshot.types';
import { inspectGatewayCredentialProvenance, type GatewayUpstreamCredentialHeaders } from './gateway-upstream-credential-resolver';
export const GATEWAY_TRUSTED_NETWORK_PROVIDER = Symbol('GATEWAY_TRUSTED_NETWORK_PROVIDER');
export interface GatewayNetworkLease { readonly strict: true }
type Authority = ReturnType<typeof createNetworkOperationAuthority>;
type Capture = (selector: Readonly<NetworkOperationSelector>, signal: AbortSignal, providerEpoch: string) => Promise<AuthorizedNetworkOperationContext>;
type StreamInput = Pick<PinnedHttpStreamRequest, 'headers' | 'body' | 'framing' | 'signal'>;
export interface GatewayTrustedNetworkProvider {
  requires(route: GatewayResolvedRoute): boolean;
  prepare(route: GatewayResolvedRoute, url: string, resolve: () => Promise<GatewayUpstreamCredentialHeaders>, options: { deadline: number; signal?: AbortSignal }): Promise<{ lease: GatewayNetworkLease; credentials: GatewayUpstreamCredentialHeaders }>;
  send(lease: GatewayNetworkLease, input: StreamInput): ReturnType<ReturnType<typeof createPinnedHttpStreamTransport>['send']>;
  close(lease: GatewayNetworkLease): void;
  revoke(routeId: string): void;
}
const providers = new WeakSet<GatewayTrustedNetworkProvider>();
const unavailable = (): never => { throw new ServiceUnavailableException('upstream_network_policy_unavailable'); };
const denied = (): never => { throw new BadGatewayException('upstream_network_policy_denied'); };
export function assertGatewayTrustedNetworkProvider(provider: GatewayTrustedNetworkProvider): void { if (!providers.has(provider)) unavailable(); }
/** Explicit host-only construction, with no production DI, metadata selector or event registration. */
export function createGatewayTrustedNetworkProvider(input: {
  compiler: ReturnType<typeof createNetworkPolicyCompiler>; servers: readonly string[]; ca?: string;
  createOperationAuthority: (capture: Capture) => Authority;
  registrations: readonly { route: GatewayResolvedRoute; snapshot: UpstreamCredentialRegistrySnapshot; siteId: string; policy: CompiledNetworkPolicy;
    captureSnapshot: () => UpstreamCredentialRegistrySnapshot; captureRouteBinding: () => object | undefined }[];
}): GatewayTrustedNetworkProvider {
  const compiler = input.compiler, servers = Object.freeze([...input.servers]), ca = input.ca;
  if (typeof input.createOperationAuthority !== 'function') unavailable();
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
  type Entry = NonNullable<ReturnType<typeof entries.get>>;
  // Current registration is checked at admission only. Ordinary reload never replaces an admitted context.
  const admit = (entry: Entry) => {
    let current: boolean;
    try { current = entry.active && entry.captureSnapshot() === entry.snapshot && entry.captureRouteBinding() === entry.route.routeBinding && signature(entry.route) === entry.signature; }
    catch { return unavailable(); }
    if (!current) denied();
  };
  const pending = new Map<string, { entry: Entry; route: GatewayResolvedRoute; url: string; resolve: () => Promise<GatewayUpstreamCredentialHeaders>; credentials?: GatewayUpstreamCredentialHeaders }>();
  const authority = input.createOperationAuthority(async (selector, signal, providerEpoch) => {
    const item = pending.get(selector.operationKey);
    if (!item || selector.sourceServiceAssetId !== item.route.sourceServiceAsset.id || signal.aborted) throw new ControlledDnsError('upstream_network_policy_denied');
    const { entry, route, url } = item;
    try { admit(entry); } catch (failure) { throw new ControlledDnsError(failure instanceof BadGatewayException ? 'upstream_network_policy_denied' : 'upstream_network_policy_unavailable'); }
    const credentials = await item.resolve();
    if (signal.aborted) throw new ControlledDnsError('ABORT_ERR');
    if (!entry.active || signature(route) !== entry.signature) throw new ControlledDnsError('upstream_network_policy_denied');
    if (inspectGatewayCredentialProvenance(credentials, route, url) !== entry.snapshot || !credentials.compiledHeaderPolicy ||
      credentials.registrySiteId !== entry.siteId || credentials.registryGeneration !== entry.snapshot.generation || credentials.registryRevision !== entry.snapshot.candidate.metadata.revision ||
      !compiler.authorizeTarget(entry.policy, { sourceServiceAssetId: route.sourceServiceAsset.id, siteId: entry.siteId, url })) throw new ControlledDnsError('upstream_network_policy_denied');
    item.credentials = credentials;
    // The host authority owns epoch capture; this callback only binds the current authorized snapshot.
    return { snapshot: entry.snapshot, policy: entry.policy, sourceServiceAssetId: route.sourceServiceAsset.id, siteId: entry.siteId,
      endpointDefinitionId: route.endpointDefinition.id, targetUrl: url, method: route.routeBinding.upstreamMethod,
      providerEpoch, credentialHeaders: { ...credentials.headers } };
  });
  const leases = new WeakMap<GatewayNetworkLease, { entry: Entry; handle: NetworkOperationHandle; credentials: GatewayUpstreamCredentialHeaders; used: boolean; closed: boolean }>();
  const close = (lease: GatewayNetworkLease) => { const context = leases.get(lease); if (!context || context.closed) return; context.closed = true; authority.close(context.handle); };
  const provider: GatewayTrustedNetworkProvider = Object.freeze({
    requires(route: GatewayResolvedRoute) { return bindings.has(route.routeBinding) || entries.has(route.routeBinding.id) || scopes.has(scope(route)); },
    async prepare(route, url, resolve, options) {
      const entry = entries.get(route.routeBinding.id);
      if (!entry || route.routeBinding !== entry.route.routeBinding || signature(route) !== entry.signature) return denied();
      admit(entry);
      const operationKey = randomUUID(), item = { entry, route, url, resolve, credentials: undefined as GatewayUpstreamCredentialHeaders | undefined };
      pending.set(operationKey, item);
      let handle: NetworkOperationHandle | undefined;
      try {
        handle = await authority.begin({ sourceServiceAssetId: route.sourceServiceAsset.id, operationKey, ...options });
        authority.assertCurrent(handle);
        if (!item.credentials) return denied();
        const lease = Object.freeze({ strict: true as const }); leases.set(lease, { entry, handle, credentials: item.credentials, used: false, closed: false });
        return { lease, credentials: item.credentials };
      } catch (failure) {
        if (handle) authority.close(handle);
        if (failure instanceof ControlledDnsError) {
          if (failure.code === 'ETIMEDOUT') throw new GatewayTimeoutException('gateway_network_timeout');
          if (failure.code === 'upstream_network_policy_denied') return denied();
          return unavailable();
        }
        throw failure;
      } finally { pending.delete(operationKey); }
    },
    async send(lease, request) {
      const context = leases.get(lease); if (!context || context.used || context.closed) return denied(); context.used = true;
      const cancel = () => close(lease);
      request.signal?.addEventListener('abort', cancel, { once: true });
      const detach = () => request.signal?.removeEventListener('abort', cancel);
      let guardFailure: ControlledDnsError | undefined;
      const check = () => { try { authority.assertCurrent(context.handle); return true; } catch (failure) { guardFailure = failure instanceof ControlledDnsError ? failure : new ControlledDnsError('upstream_network_policy_unavailable'); return false; } };
      const guardedCompiler = { ...compiler,
        authorizeTarget: (...args: Parameters<typeof compiler.authorizeTarget>) => check() && compiler.authorizeTarget(...args),
        allows: (...args: Parameters<typeof compiler.allows>) => check() && compiler.allows(...args) };
      const transport = createPinnedHttpStreamTransport({ compiler: guardedCompiler, servers, ...(ca === undefined ? {} : { ca }) });
      try {
        if (request.signal?.aborted) cancel();
        const captured = authority.assertCurrent(context.handle);
        const headers: Record<string, string> = {};
        const managed = new Set(context.credentials.managedHeaderNames.map(name => name.toLowerCase()));
        for (const [name, value] of Object.entries(request.headers ?? {})) {
          if (!managed.has(name.toLowerCase())) Object.defineProperty(headers, name, { value, enumerable: true, configurable: true, writable: true });
        }
        Object.assign(headers, captured.credentialHeaders);
        const response = await transport.send({ ...request, headers, deadline: context.handle.deadline, signal: context.handle.signal,
          rejectInformationalResponses: true, method: captured.method, policy: captured.policy,
          target: { sourceServiceAssetId: captured.sourceServiceAssetId, siteId: captured.siteId, url: captured.targetUrl } });
        const completed = response.completed.catch(failure => { try { authority.assertCurrent(context.handle); } catch (reason) { throw reason; } throw failure; }).finally(() => { detach(); close(lease); });
        // The consumer awaits completed; attach a handler immediately for early disconnects.
        void completed.catch(() => {});
        return { ...response, completed };
      } catch (failure) {
        let reason: unknown = guardFailure ?? failure;
        try { authority.assertCurrent(context.handle); } catch (current) { reason = current; }
        detach(); close(lease); throw reason;
      }
    },
    close,
    revoke(id: string) { const entry = entries.get(id); if (entry) { entry.active = false; authority.revoke(entry.route.sourceServiceAsset.id); } },
  });
  providers.add(provider); return provider;
}