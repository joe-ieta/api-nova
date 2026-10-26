import { inspectGatewayNetworkRegistrationBundle, type GatewayNetworkRegistrationBundle } from './gateway-network-registration-coordinator';
import { BadGatewayException, GatewayTimeoutException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ControlledDnsError, auditNetworkFailure, createNetworkOperationAuthority, createNetworkPolicyCompiler, createPinnedHttpStreamTransport, toNetworkFailure, type AuthorizedNetworkOperationContext, type NetworkDenialAuditRecord, type NetworkFailureStage, type NetworkOperationHandle, type NetworkOperationSelector, type CompiledNetworkPolicy, type UpstreamCredentialRegistrySnapshot, type PinnedHttpStreamRequest } from 'api-nova-parser';
import type { GatewayResolvedRoute } from '../types/gateway-route-snapshot.types';
import { createGatewayUpstreamCredentialResolver, type GatewayUpstreamCredentialResolver, inspectGatewayCredentialProvenance, type GatewayUpstreamCredentialHeaders } from './gateway-upstream-credential-resolver';
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
  failureAudit?: (record: Readonly<NetworkDenialAuditRecord>) => unknown;
  registrations: readonly { route: GatewayResolvedRoute; snapshot: UpstreamCredentialRegistrySnapshot; siteId: string; policy: CompiledNetworkPolicy;
    captureSnapshot: () => UpstreamCredentialRegistrySnapshot; captureRouteBinding: () => object | undefined }[];
}): GatewayTrustedNetworkProvider {
  const compiler = input.compiler, servers = Object.freeze([...input.servers]), ca = input.ca;
  if (typeof input.createOperationAuthority !== 'function') unavailable();
  const failureAudit = input.failureAudit;
  if (failureAudit !== undefined && typeof failureAudit !== 'function') unavailable();
  const bindings = new WeakSet<object>(), scopes = new Set<string>();
  let revocationEpoch = 0;
  const scope = (route: GatewayResolvedRoute) => JSON.stringify([route.runtimeAsset.id, route.membership.id]);
  const entries = new Map<string, { route: GatewayResolvedRoute; signature: string; snapshot: UpstreamCredentialRegistrySnapshot; siteId: string; policy: CompiledNetworkPolicy;
    captureSnapshot: () => UpstreamCredentialRegistrySnapshot; captureRouteBinding: () => object | undefined; active: boolean }>();
  const signature = (route: GatewayResolvedRoute) => JSON.stringify([route.routeBinding, route.sourceServiceAsset.id, route.endpointDefinition.id, route.upstreamBaseUrl]);
  /** Single audit emission point per network failure; identity comes from the trusted registration only. */
  const auditFailure = (failure: unknown, stage: NetworkFailureStage, operationId: string,
    entry?: { route: GatewayResolvedRoute; siteId: string; policy: CompiledNetworkPolicy }) => {
    if (!failureAudit || !entry) return;
    auditNetworkFailure(toNetworkFailure(failure), {
      operationId,
      sourceServiceAssetId: entry.route.sourceServiceAsset.id,
      siteId: entry.siteId,
      endpointDefinitionId: entry.route.endpointDefinition.id,
      policyId: entry.policy.id,
      revision: entry.policy.revision,
      revocationEpoch: String(revocationEpoch),
      redirectHopIndex: 0,
      attemptIndex: 1,
      stage,
    }, failureAudit);
  };
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
          auditFailure(failure, failure.code === 'ETIMEDOUT' ? 'deadline' : 'admission',
            handle?.operationId ?? randomUUID(), entry);
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
        const completed = response.completed.catch(failure => {
          const stage: NetworkFailureStage = request.signal?.aborted ? 'cancel'
            : context.handle.signal.aborted ? 'revocation' : 'send';
          try { authority.assertCurrent(context.handle); } catch (reason) { auditFailure(reason, stage, context.handle.operationId, context.entry); throw reason; }
          auditFailure(failure, stage, context.handle.operationId, context.entry);
          throw failure;
        }).finally(() => { detach(); close(lease); });
        // The consumer awaits completed; attach a handler immediately for early disconnects.
        void completed.catch(() => {});
        return { ...response, completed };
      } catch (failure) {
        let reason: unknown = guardFailure ?? failure;
        try { authority.assertCurrent(context.handle); } catch (current) { reason = current; }
        detach(); close(lease);
        auditFailure(reason, context.handle.signal.aborted ? 'revocation'
          : request.signal?.aborted ? 'cancel' : 'send', context.handle.operationId, context.entry);
        throw reason;
      }
    },
    close,
    revoke(id: string) { const entry = entries.get(id); if (entry) { revocationEpoch += 1; entry.active = false; authority.revoke(entry.route.sourceServiceAsset.id); } },
  });
  providers.add(provider); return provider;
}
export interface GatewayNetworkHostInstallation {
  readonly bundle: GatewayNetworkRegistrationBundle;
  readonly compiler: ReturnType<typeof createNetworkPolicyCompiler>;
  readonly servers: readonly string[];
  readonly ca?: string;
  readonly failureAudit?: (record: Readonly<NetworkDenialAuditRecord>) => unknown;
}
/** Stable host-owned facade. Installation is explicit and never renews a proof. */
export function createGatewayTrustedNetworkFacade() {
  type Pair = { provider: GatewayTrustedNetworkProvider; resolver: GatewayUpstreamCredentialResolver; check(): void; stop(): void; pending: number; leases: Set<GatewayNetworkLease>; retired: boolean };
  let current: Pair | undefined, closed = false, quarantined = false;
  const installed = new WeakSet<object>();
  const pairs = new Set<Pair>(), routeIds = new Set<string>(), scopes = new Set<string>(), assetIds = new Set<string>();
  const leases = new WeakMap<GatewayNetworkLease, { pair: Pair; inner: GatewayNetworkLease; closed: boolean; sent: boolean }>();
  const scope = (route: GatewayResolvedRoute) => JSON.stringify([route.runtimeAsset.id, route.membership.id]);
  const protectedRoute = (route: GatewayResolvedRoute) => quarantined || assetIds.has(route.runtimeAsset.id) || routeIds.has(route.routeBinding.id) || scopes.has(scope(route));
  const reap = (pair: Pair) => { if (pair.retired && pair.pending === 0 && pair.leases.size === 0) { pair.stop(); pairs.delete(pair); } };
  const closeLease = (lease: GatewayNetworkLease) => {
    const item = leases.get(lease); if (!item || item.closed) return;
    item.closed = true; item.pair.leases.delete(lease); item.pair.provider.close(item.inner); reap(item.pair);
  };
  const provider: GatewayTrustedNetworkProvider = Object.freeze({
    requires: protectedRoute,
    async prepare(route, url, _unpairedResolver, options) {
      const pair = current;
      if (closed || quarantined || !pair || !protectedRoute(route)) return unavailable();
      pair.check(); pair.pending++;
      try {
        // The callback supplied by Proxy may reference another DI generation. Never use it.
        const prepared = await pair.provider.prepare(route, url, () => pair.resolver.resolve(route, url, route.routeBinding.upstreamMethod), options);
        try { pair.check(); } catch { pair.provider.close(prepared.lease); return unavailable(); }
        const lease = Object.freeze({ strict: true as const });
        leases.set(lease, { pair, inner: prepared.lease, closed: false, sent: false }); pair.leases.add(lease);
        return { lease, credentials: prepared.credentials };
      } finally { pair.pending--; reap(pair); }
    },
    async send(lease, request) {
      const item = leases.get(lease);
      if (!item || item.closed || item.sent) return denied(); item.sent = true;
      try {
        item.pair.check();
        const response = await item.pair.provider.send(item.inner, request);
        const completed = response.completed.finally(() => closeLease(lease)); void completed.catch(() => {});
        return { ...response, completed };
      } catch (error) { closeLease(lease); throw error; }
    },
    close: closeLease,
    revoke(routeId) { for (const pair of [...pairs]) { pair.provider.revoke(routeId); } },
  });
  providers.add(provider);
  const resolver: GatewayUpstreamCredentialResolver = Object.freeze({
    headerPolicyEnabled: true,
    resolve(route, url, method) {
      const pair = current;
      if (closed || quarantined || !pair || !protectedRoute(route)) return unavailable();
      pair.check(); return pair.resolver.resolve(route, url, method);
    },
  });
  return Object.freeze({ provider, resolver,
    install(input: GatewayNetworkHostInstallation) {
      if (closed || quarantined || pairs.size >= 128 || installed.has(input.bundle)) return unavailable();
      const registrations = inspectGatewayNetworkRegistrationBundle(input.bundle);
      const ids = new Set([...routeIds, ...registrations.map(value => value.captured.identity.routeBindingId)]);
      const nextScopes = new Set([...scopes, ...registrations.map(value => scope({ ...value.captured.route, params: {} }))]);
      const nextAssets = new Set([...assetIds, ...registrations.map(value => value.captured.identity.runtimeAssetId)]);
      if (ids.size > 1024 || nextScopes.size > 1024 || nextAssets.size > 1024) {
        // No eviction can make a previously protected or newly rejected asset fall back.
        quarantined = true; current = undefined; for (const pair of [...pairs]) pair.stop(); return unavailable();
      }
      const snapshot = registrations[0]?.snapshot;
      if (!snapshot || registrations.some(value => value.snapshot !== snapshot)) return unavailable();
      let active = true;
      const epoch = randomUUID(), bundle = input.bundle, compiler = input.compiler;
      const check = () => {
        if (!active || bundle.signal.aborted || inspectGatewayNetworkRegistrationBundle(bundle) !== registrations) return unavailable();
      };
      const ownResolver = createGatewayUpstreamCredentialResolver(() => { check(); return snapshot; }, { enableHeaderPolicy: true, requirePersistedV1: true });
      const inner = createGatewayTrustedNetworkProvider({ compiler, servers: input.servers, ca: input.ca,
        failureAudit: input.failureAudit,
        createOperationAuthority: capture => createNetworkOperationAuthority({ compiler,
          readSecurityEpoch: source => { check(); if (!registrations.some(value => value.captured.route.sourceServiceAsset.id === source)) return unavailable(); return epoch; },
          captureAuthorizedContext: (selector, signal) => {
            check(); const registration = registrations.find(value => value.captured.route.sourceServiceAsset.id === selector.sourceServiceAssetId);
            if (!registration) return unavailable(); return capture(selector, signal, registration.providerEpoch);
          },
        }),
        registrations: registrations.map(value => ({ route: { ...value.captured.route, params: {} }, snapshot, siteId: value.siteId, policy: value.policy,
          captureSnapshot: () => { check(); return snapshot; }, captureRouteBinding: () => { check(); return value.captured.route.routeBinding; } })),
      });
      const stop = () => {
        if (!active) return; active = false;
        bundle.signal.removeEventListener('abort', stop);
        if (current === pair) current = undefined;
        for (const value of registrations) inner.revoke(value.captured.identity.routeBindingId);
        for (const lease of [...pair.leases]) closeLease(lease);
        pair.retired = true; if (!pair.pending) pairs.delete(pair);
      };
      const pair: Pair = { provider: inner, resolver: ownResolver, check, stop, pending: 0, leases: new Set(), retired: false };
      bundle.signal.addEventListener('abort', stop, { once: true });
      try {
        check(); // No await between final brand/epoch/capture check and the single pointer swap.
        const previous = current;
        ids.forEach(id => routeIds.add(id)); nextScopes.forEach(value => scopes.add(value)); nextAssets.forEach(id => assetIds.add(id));
        installed.add(bundle); pairs.add(pair); current = pair;
        if (previous) { previous.retired = true; reap(previous); }
      } catch (error) { stop(); throw error; }
    },
    close() { if (closed) return; closed = true; current = undefined; for (const pair of [...pairs]) pair.stop(); },
  });
}
