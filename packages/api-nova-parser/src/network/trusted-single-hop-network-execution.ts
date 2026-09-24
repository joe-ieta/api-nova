import { randomUUID } from 'node:crypto';
import { createNetworkOperationAuthority, type NetworkOperationHandle } from './network-operation-authority';
import type { UpstreamCredentialRegistrySnapshot } from '../credentials/registry';
import { compileSingleHopUpstreamCredentials, ResolvedSingleHopCredentials, SingleHopUpstreamCredentialPolicy } from '../credentials/single-hop-execution';
import type { TrustedOperationBinding } from '../credentials/trusted-operation-bindings';
import { CompiledNetworkPolicy, createNetworkPolicyCompiler, normalizeNetworkUrl } from './network-policy';
import { ControlledDnsError } from './controlled-dns';
import { createPinnedHttpTransport, PinnedHttpResponse } from './pinned-http-transport';
import { pinnedRecord } from './pinned-http-connection';
import { SerializedBoundedRequest, serializeBoundedNetworkRequest } from './bounded-network-serialization';
export interface TrustedNetworkRegistration { readonly snapshot: UpstreamCredentialRegistrySnapshot; readonly sourceServiceAssetId: string; readonly siteId: string; readonly policy: CompiledNetworkPolicy }
export interface TrustedSingleHopNetworkPlan { readonly credentials: ResolvedSingleHopCredentials; readonly signal?: AbortSignal }
export interface TrustedNetworkOperationLifecycle {
  readonly readSecurityEpoch: (sourceServiceAssetId: string) => string;
  /** Trusted host observation, not a claim of atomic env/file Provider versions. */
  readonly readProviderEpoch: (snapshot: UpstreamCredentialRegistrySnapshot, binding: Readonly<TrustedOperationBinding>) => string;
  readonly captureSignal?: () => AbortSignal | undefined;
}
export interface TrustedSingleHopNetworkExecution {
  register(registration: TrustedNetworkRegistration): void;
  revoke(sourceServiceAssetId: string): void;
  close(plan: TrustedSingleHopNetworkPlan): void;
  prepare(binding: Readonly<TrustedOperationBinding> | undefined, request: SerializedBoundedRequest, deadline: number): Promise<TrustedSingleHopNetworkPlan>;
  send(plan: TrustedSingleHopNetworkPlan, headers: Readonly<Record<string, string>>): Promise<PinnedHttpResponse>;
}
const authorities = new WeakMap<TrustedSingleHopNetworkExecution, SingleHopUpstreamCredentialPolicy>();
const trustedFailure = (failure: unknown): ControlledDnsError => failure instanceof ControlledDnsError && ['upstream_network_policy_denied', 'upstream_network_policy_unavailable'].includes(failure.code) ? new ControlledDnsError(failure.code) : new ControlledDnsError('upstream_network_policy_unavailable');
const denied = (): never => { throw new ControlledDnsError('upstream_network_policy_denied'); };
/** Constructor identity check, not a metadata/revision comparison. */
export function assertTrustedSingleHopNetworkExecution(value: TrustedSingleHopNetworkExecution, policy: SingleHopUpstreamCredentialPolicy | undefined): void {
  if (!policy || authorities.get(value) !== policy) return denied();
}
/** Explicit host registration only. Does not enable production defaults, child propagation or revoke epochs. */
export function createTrustedSingleHopNetworkExecution(input: {
  credentialPolicy: SingleHopUpstreamCredentialPolicy; compiler: ReturnType<typeof createNetworkPolicyCompiler>;
  servers: readonly string[]; ca?: string; operationLifecycle?: TrustedNetworkOperationLifecycle; registrations: readonly TrustedNetworkRegistration[];
}): TrustedSingleHopNetworkExecution {
  const options = pinnedRecord(input, ['credentialPolicy', 'compiler', 'servers', 'ca', 'registrations', 'operationLifecycle'], ['credentialPolicy', 'compiler', 'servers', 'registrations']);
  const credentialPolicy = options.credentialPolicy as SingleHopUpstreamCredentialPolicy;
  compileSingleHopUpstreamCredentials(credentialPolicy);
  const captureSnapshot = Object.getOwnPropertyDescriptor(credentialPolicy, 'captureSnapshot')!.value as () => UpstreamCredentialRegistrySnapshot;
  const compiler = options.compiler as ReturnType<typeof createNetworkPolicyCompiler>;
  const servers = Object.freeze([...(options.servers as readonly string[])]), ca = options.ca as string | undefined;
  const transport = createPinnedHttpTransport({ compiler, servers, ...(ca === undefined ? {} : { ca }) });
  const lifecycle = options.operationLifecycle === undefined ? undefined : pinnedRecord(options.operationLifecycle, ['readSecurityEpoch', 'readProviderEpoch', 'captureSignal'], ['readSecurityEpoch', 'readProviderEpoch']) as unknown as TrustedNetworkOperationLifecycle;
  if (lifecycle && (typeof lifecycle.readSecurityEpoch !== 'function' || typeof lifecycle.readProviderEpoch !== 'function' || lifecycle.captureSignal !== undefined && typeof lifecycle.captureSignal !== 'function')) return denied();
  if (!Array.isArray(options.registrations) || !options.registrations.length || options.registrations.length > 256) return denied();
  const registered = new WeakMap<UpstreamCredentialRegistrySnapshot, Map<string, TrustedNetworkRegistration>>();
  const key = (source: string, site: string) => JSON.stringify([source, site]);
  const register = (raw: TrustedNetworkRegistration) => {
    const value = pinnedRecord(raw, ['snapshot', 'sourceServiceAssetId', 'siteId', 'policy'], ['snapshot', 'sourceServiceAssetId', 'siteId', 'policy']) as unknown as TrustedNetworkRegistration;
    const { snapshot, sourceServiceAssetId, siteId, policy } = value;
    if (!snapshot || !Object.isFrozen(snapshot) || !Object.isFrozen(snapshot.candidate) || !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 1) return denied();
    const site = snapshot.candidate.sites.find(item => item.id === siteId && item.sourceServiceAssetId === sourceServiceAssetId);
    if (!site || !compiler.authorizeTarget(policy, { sourceServiceAssetId, siteId, url: policy.origin })) return denied();
    const host = site.match.host.includes(':') ? '[' + site.match.host + ']' : site.match.host;
    if (normalizeNetworkUrl(`${site.match.scheme}://${host}:${site.match.port}/`).origin !== policy.origin) return denied();
    const entries = registered.get(snapshot) ?? new Map<string, TrustedNetworkRegistration>();
    if (entries.has(key(sourceServiceAssetId, siteId))) return denied();
    entries.set(key(sourceServiceAssetId, siteId), Object.freeze({ snapshot, sourceServiceAssetId, siteId, policy })); registered.set(snapshot, entries);
  }
  ;
  for (const registration of options.registrations) register(registration);
  type Pending = { binding: Readonly<TrustedOperationBinding>; request: SerializedBoundedRequest; credentials?: ResolvedSingleHopCredentials; snapshot?: UpstreamCredentialRegistrySnapshot; registration?: TrustedNetworkRegistration };
  const pending = new Map<string, Pending>();
  const capture = async (value: Pending) => {
    const snapshot = captureSnapshot(); if (!registered.has(snapshot)) return denied();
    let providerEpoch = 'legacy';
    try { if (lifecycle) providerEpoch = lifecycle.readProviderEpoch(snapshot, value.binding); } catch (failure) { throw trustedFailure(failure); }
    const credentials = await compileSingleHopUpstreamCredentials({ mode: 'single-hop', captureSnapshot: () => snapshot }).resolve(value.binding, value.request.url, value.binding.method);
    if (lifecycle) { let after: string; try { after = lifecycle.readProviderEpoch(snapshot, value.binding); } catch (failure) { throw trustedFailure(failure); } if (after !== providerEpoch) return denied(); }
    const registration = registered.get(snapshot)!.get(key(value.binding.sourceServiceAssetId, credentials.siteId));
    if (!registration || credentials.generation !== snapshot.generation || credentials.revision !== snapshot.candidate.metadata.revision || !compiler.authorizeTarget(registration.policy, { sourceServiceAssetId: value.binding.sourceServiceAssetId, siteId: credentials.siteId, url: value.request.url })) return denied();
    Object.assign(value, { credentials, snapshot, registration });
    return { snapshot, policy: registration.policy, sourceServiceAssetId: value.binding.sourceServiceAssetId, siteId: credentials.siteId,
      endpointDefinitionId: value.binding.endpointDefinitionId, targetUrl: value.request.url, method: value.binding.method, providerEpoch, credentialHeaders: { ...credentials.headers } };
  };
  const authority = lifecycle ? createNetworkOperationAuthority({ compiler, readSecurityEpoch: lifecycle.readSecurityEpoch,
    captureAuthorizedContext: async selector => { const value = pending.get(selector.operationKey); if (!value || value.binding.sourceServiceAssetId !== selector.sourceServiceAssetId) return denied(); return capture(value); } }) : undefined;
  const plans = new WeakMap<TrustedSingleHopNetworkPlan, { binding: TrustedOperationBinding; snapshot: UpstreamCredentialRegistrySnapshot; registration: TrustedNetworkRegistration; url: string; body?: Buffer; deadline: number; used: boolean; handle?: NetworkOperationHandle }>();
  const result: TrustedSingleHopNetworkExecution = Object.freeze({
    register,
    revoke(source: string) { if (!authority) return denied(); authority.revoke(source); },
    close(plan: TrustedSingleHopNetworkPlan) { const value = plans.get(plan); if (!value) return denied(); value.used = true; value.body = undefined; if (value.handle) authority!.close(value.handle); },
    async prepare(binding: Readonly<TrustedOperationBinding> | undefined, request: SerializedBoundedRequest, deadline: number) {
      try {
        if (!binding || typeof deadline !== 'number' || !Number.isFinite(deadline)) return denied();
        if (deadline <= Date.now()) { if (authority) throw new ControlledDnsError('ETIMEDOUT'); return denied(); }
        const identity = pinnedRecord(binding, ['method', 'path', 'endpointDefinitionId', 'sourceServiceAssetId'], ['method', 'path', 'endpointDefinitionId', 'sourceServiceAssetId']) as unknown as TrustedOperationBinding;
        if (typeof identity.method !== 'string' || !/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE)$/.test(identity.method) || typeof identity.path !== 'string' || !identity.path.startsWith('/')) return denied();
        const capturedBinding = Object.freeze({ ...identity });
        const serialized = serializeBoundedNetworkRequest(request.url, {}, request.body);
        const value: Pending = { binding: capturedBinding, request: serialized };
        let handle: NetworkOperationHandle | undefined;
        if (authority) {
          const nonce = randomUUID(); pending.set(nonce, value);
          try { let signal: AbortSignal | undefined; try { signal = lifecycle!.captureSignal?.(); } catch (failure) { throw trustedFailure(failure); }
            handle = await authority.begin({ sourceServiceAssetId: capturedBinding.sourceServiceAssetId, operationKey: nonce, deadline, signal }); }
          finally { pending.delete(nonce); }
        } else await capture(value);
        const { credentials, snapshot, registration } = value;
        const plan = Object.freeze({ credentials: credentials!, ...(handle ? { signal: handle.signal } : {}) });
        plans.set(plan, { binding: capturedBinding, snapshot: snapshot!, registration: registration!, url: serialized.url, body: serialized.body, deadline, used: false, handle });
        return plan;
      } catch (failure) { if (authority && failure instanceof ControlledDnsError) throw failure; return denied(); }
    },
    async send(plan: TrustedSingleHopNetworkPlan, inputHeaders: Readonly<Record<string, string>>) {
      const context = plans.get(plan); if (!context || context.used) return denied(); context.used = true;
      let guardFailure: ControlledDnsError | undefined;
      const assertOperation = () => {
        if (!context.handle) return undefined;
        try {
          const fixed = authority!.assertCurrent(context.handle);
          let observed: string; try { observed = lifecycle!.readProviderEpoch(context.snapshot, context.binding); } catch (failure) { throw trustedFailure(failure); }
          if (observed !== fixed.providerEpoch) { authority!.revoke(context.binding.sourceServiceAssetId); return denied(); }
          return fixed;
        } catch (failure) { guardFailure = failure instanceof ControlledDnsError ? failure : new ControlledDnsError('upstream_network_policy_unavailable'); authority!.close(context.handle); throw guardFailure; }
      };
      try {
        assertOperation();
        const { registration, binding, snapshot } = context;
        if (registered.get(snapshot)?.get(key(binding.sourceServiceAssetId, plan.credentials.siteId)) !== registration || plan.credentials.generation !== snapshot.generation || plan.credentials.revision !== snapshot.candidate.metadata.revision) return denied();
        if (!inputHeaders || Object.getPrototypeOf(inputHeaders) !== Object.prototype) return denied();
        const headers: Record<string, string> = {};
        const managed = new Set(plan.credentials.managedHeaderNames.map(name => name.toLowerCase()));
        for (const name of Reflect.ownKeys(inputHeaders)) {
          if (typeof name !== 'string') return denied(); const descriptor = Object.getOwnPropertyDescriptor(inputHeaders, name)!;
          if (!('value' in descriptor) || typeof descriptor.value !== 'string') return denied();
          if (!managed.has(name.toLowerCase()) && name.toLowerCase() !== 'accept-encoding') Object.defineProperty(headers, name, { value: descriptor.value, enumerable: true });
        }
        const operation = assertOperation();
        Object.assign(headers, operation?.credentialHeaders ?? plan.credentials.headers, { 'accept-encoding': 'identity' });
        const selectedTransport = context.handle ? createPinnedHttpTransport({ compiler: { ...compiler,
          authorizeTarget: (...args: Parameters<typeof compiler.authorizeTarget>) => { try { assertOperation(); return compiler.authorizeTarget(...args); } catch { return false; } },
          allows: (...args: Parameters<typeof compiler.allows>) => { try { assertOperation(); return compiler.allows(...args); } catch { return false; } },
        }, servers, ...(ca === undefined ? {} : { ca }) }) : transport;
        return await selectedTransport.send({ policy: registration.policy, target: { sourceServiceAssetId: binding.sourceServiceAssetId, siteId: registration.siteId, url: context.url },
          deadline: context.deadline, ...(context.handle ? { signal: context.handle.signal } : {}), method: binding.method, headers, ...(context.body === undefined ? {} : { body: context.body }) });
      } catch (failure) {
        if (guardFailure) throw guardFailure;
        if (context?.handle?.signal.aborted && context.handle.signal.reason instanceof ControlledDnsError) throw context.handle.signal.reason;
        if (failure instanceof ControlledDnsError) throw failure; return denied();
      } finally { if (context?.handle) authority!.close(context.handle); }
    },
  });
  authorities.set(result, credentialPolicy); return result;
}
