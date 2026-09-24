import type { UpstreamCredentialRegistrySnapshot } from '../credentials/registry';
import { compileSingleHopUpstreamCredentials, ResolvedSingleHopCredentials, SingleHopUpstreamCredentialPolicy } from '../credentials/single-hop-execution';
import type { TrustedOperationBinding } from '../credentials/trusted-operation-bindings';
import { CompiledNetworkPolicy, createNetworkPolicyCompiler, normalizeNetworkUrl } from './network-policy';
import { ControlledDnsError } from './controlled-dns';
import { createPinnedHttpTransport, PinnedHttpResponse } from './pinned-http-transport';
import { pinnedRecord } from './pinned-http-connection';
import { SerializedBoundedRequest, serializeBoundedNetworkRequest } from './bounded-network-serialization';
export interface TrustedNetworkRegistration { readonly snapshot: UpstreamCredentialRegistrySnapshot; readonly sourceServiceAssetId: string; readonly siteId: string; readonly policy: CompiledNetworkPolicy }
export interface TrustedSingleHopNetworkPlan { readonly credentials: ResolvedSingleHopCredentials }
export interface TrustedSingleHopNetworkExecution {
  prepare(binding: Readonly<TrustedOperationBinding> | undefined, request: SerializedBoundedRequest, deadline: number): Promise<TrustedSingleHopNetworkPlan>;
  send(plan: TrustedSingleHopNetworkPlan, headers: Readonly<Record<string, string>>): Promise<PinnedHttpResponse>;
}
const authorities = new WeakMap<TrustedSingleHopNetworkExecution, SingleHopUpstreamCredentialPolicy>();
const denied = (): never => { throw new ControlledDnsError('upstream_network_policy_denied'); };
/** Constructor identity check, not a metadata/revision comparison. */
export function assertTrustedSingleHopNetworkExecution(value: TrustedSingleHopNetworkExecution, policy: SingleHopUpstreamCredentialPolicy | undefined): void {
  if (!policy || authorities.get(value) !== policy) return denied();
}
/** Explicit host registration only. Does not enable production defaults, child propagation or revoke epochs. */
export function createTrustedSingleHopNetworkExecution(input: {
  credentialPolicy: SingleHopUpstreamCredentialPolicy; compiler: ReturnType<typeof createNetworkPolicyCompiler>;
  servers: readonly string[]; ca?: string; registrations: readonly TrustedNetworkRegistration[];
}): TrustedSingleHopNetworkExecution {
  const options = pinnedRecord(input, ['credentialPolicy', 'compiler', 'servers', 'ca', 'registrations'], ['credentialPolicy', 'compiler', 'servers', 'registrations']);
  const credentialPolicy = options.credentialPolicy as SingleHopUpstreamCredentialPolicy;
  compileSingleHopUpstreamCredentials(credentialPolicy);
  const captureSnapshot = Object.getOwnPropertyDescriptor(credentialPolicy, 'captureSnapshot')!.value as () => UpstreamCredentialRegistrySnapshot;
  const compiler = options.compiler as ReturnType<typeof createNetworkPolicyCompiler>;
  const transport = createPinnedHttpTransport({ compiler, servers: options.servers as readonly string[], ...(options.ca === undefined ? {} : { ca: options.ca as string }) });
  if (!Array.isArray(options.registrations) || !options.registrations.length || options.registrations.length > 256) return denied();
  const registered = new WeakMap<UpstreamCredentialRegistrySnapshot, Map<string, TrustedNetworkRegistration>>();
  const key = (source: string, site: string) => JSON.stringify([source, site]);
  for (const raw of options.registrations) {
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
  const plans = new WeakMap<TrustedSingleHopNetworkPlan, { binding: TrustedOperationBinding; snapshot: UpstreamCredentialRegistrySnapshot; registration: TrustedNetworkRegistration; url: string; body?: Buffer; deadline: number; used: boolean }>();
  const result: TrustedSingleHopNetworkExecution = Object.freeze({
    async prepare(binding: Readonly<TrustedOperationBinding> | undefined, request: SerializedBoundedRequest, deadline: number) {
      try {
        if (!binding || typeof deadline !== 'number' || !Number.isFinite(deadline) || deadline <= Date.now()) return denied();
        const identity = pinnedRecord(binding, ['method', 'path', 'endpointDefinitionId', 'sourceServiceAssetId'], ['method', 'path', 'endpointDefinitionId', 'sourceServiceAssetId']) as unknown as TrustedOperationBinding;
        if (typeof identity.method !== 'string' || !/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE)$/.test(identity.method) || typeof identity.path !== 'string' || !identity.path.startsWith('/')) return denied();
        const capturedBinding = Object.freeze({ ...identity });
        const serialized = serializeBoundedNetworkRequest(request.url, {}, request.body);
        const snapshot = captureSnapshot(); if (!registered.has(snapshot)) return denied();
        const credentials = await compileSingleHopUpstreamCredentials({ mode: 'single-hop', captureSnapshot: () => snapshot }).resolve(capturedBinding, serialized.url, identity.method);
        const registration = registered.get(snapshot)!.get(key(identity.sourceServiceAssetId, credentials.siteId));
        if (!registration || credentials.generation !== snapshot.generation || credentials.revision !== snapshot.candidate.metadata.revision || !compiler.authorizeTarget(registration.policy, { sourceServiceAssetId: identity.sourceServiceAssetId, siteId: credentials.siteId, url: serialized.url })) return denied();
        const plan = Object.freeze({ credentials });
        plans.set(plan, { binding: capturedBinding, snapshot, registration, url: serialized.url, body: serialized.body, deadline, used: false });
        return plan;
      } catch { return denied(); }
    },
    async send(plan: TrustedSingleHopNetworkPlan, inputHeaders: Readonly<Record<string, string>>) {
      try {
        const context = plans.get(plan); if (!context || context.used) return denied(); context.used = true;
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
        Object.assign(headers, plan.credentials.headers, { 'accept-encoding': 'identity' });
        return await transport.send({ policy: registration.policy, target: { sourceServiceAssetId: binding.sourceServiceAssetId, siteId: registration.siteId, url: context.url },
          deadline: context.deadline, method: binding.method, headers, ...(context.body === undefined ? {} : { body: context.body }) });
      } catch (failure) { if (failure instanceof ControlledDnsError) throw failure; return denied(); }
    },
  });
  authorities.set(result, credentialPolicy); return result;
}
