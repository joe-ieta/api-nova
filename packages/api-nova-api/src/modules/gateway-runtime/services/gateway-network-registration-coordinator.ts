import { createNetworkPolicyCompiler, type CompiledNetworkPolicy, type UpstreamCredentialRegistrySnapshot } from 'api-nova-parser';
import { assertGatewayHostCredentialRegistry, type GatewayHostCredentialRegistry } from './gateway-host-credential-registry';
import { inspectGatewayActiveRouteCapture, type GatewayActiveRouteCapture, type GatewayCapturedActiveRoute } from './gateway-active-route-capture';
import { GatewayRouteSnapshotService } from './gateway-route-snapshot.service';

export interface GatewayNetworkRegistrationBundle { readonly kind: 'gateway-network-registration-bundle'; readonly signal: AbortSignal }
export type GatewayNetworkRegistration = Readonly<{
  captured: GatewayCapturedActiveRoute; snapshot: UpstreamCredentialRegistrySnapshot;
  siteId: string; policy: CompiledNetworkPolicy; providerEpoch: string;
}>;
const bundles = new WeakMap<object, { inspect(): readonly GatewayNetworkRegistration[]; close(): void }>();
const fail = (): never => { throw new Error('gateway_network_registration_unavailable'); };
export function inspectGatewayNetworkRegistrationBundle(bundle: GatewayNetworkRegistrationBundle): readonly GatewayNetworkRegistration[] {
  const state = bundle && typeof bundle === 'object' ? bundles.get(bundle) : undefined;
  if (!state) return fail(); return state.inspect();
}
export function closeGatewayNetworkRegistrationBundle(bundle: GatewayNetworkRegistrationBundle): void {
  const state = bundle && typeof bundle === 'object' ? bundles.get(bundle) : undefined;
  if (!state) return fail(); state.close();
}
/** Explicit host-only assembly. No DI, network send, candidate activation or automatic renewal. */
export function createGatewayNetworkRegistrationBundle(input: {
  routes: GatewayRouteSnapshotService; capture: GatewayActiveRouteCapture; host: GatewayHostCredentialRegistry;
  compiler: ReturnType<typeof createNetworkPolicyCompiler>;
  policies: readonly { routeBindingId: string; siteId: string; policy: CompiledNetworkPolicy }[];
  proofs: readonly { sourceServiceAssetId: string; providerEpoch: string; proof: object }[];
}): GatewayNetworkRegistrationBundle {
  assertGatewayHostCredentialRegistry(input.host);
  const host = input.host, service = input.routes, compiler = input.compiler;
  const capture = input.capture, captured = inspectGatewayActiveRouteCapture(capture);
  const catalog = service.readActiveRouteCatalog(), snapshot = host.captureSnapshot();
  if (!captured.length || capture.catalogVersion !== catalog.version) return fail();
  const controller = new AbortController();
  let closed = false, expiry = Infinity, timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup: (() => void)[] = [];
  const close = () => {
    if (closed) return; closed = true;
    // State is closed before observers can synchronously re-enter on abort.
    controller.abort(); if (timer) clearTimeout(timer);
    for (const detach of cleanup.splice(0)) detach();
  };
  const listen = (signal: AbortSignal) => {
    if (signal.aborted) { close(); return fail(); }
    signal.addEventListener('abort', close, { once: true });
    cleanup.push(() => signal.removeEventListener('abort', close));
  };
  try {
    const subscription = service.observeActiveRouteCatalog(close);
    cleanup.push(() => subscription.close()); listen(subscription.signal);
    const exactCurrent = () => {
      if (closed || Date.now() >= expiry || service.readActiveRouteCatalog() !== catalog) return fail();
      assertGatewayHostCredentialRegistry(host);
      if (host.captureSnapshot() !== snapshot) return fail();
      const current = inspectGatewayActiveRouteCapture(service.captureActiveRouteCatalog(catalog));
      const original = inspectGatewayActiveRouteCapture(capture);
      if (current.length !== captured.length || original !== captured || current.some((entry, i) => entry.route !== captured[i].route || entry.identity !== captured[i].identity)) return fail();
    };
    exactCurrent();
    if (input.policies.length !== captured.length) return fail();
    const policies = new Map(input.policies.map(value => [value.routeBindingId, { ...value }]));
    if (policies.size !== captured.length) return fail();
    const sources = new Set(captured.map(entry => entry.route.sourceServiceAsset?.id));
    if (sources.has(undefined) || input.proofs.length !== sources.size) return fail();
    const proofs = new Map(input.proofs.map(value => [value.sourceServiceAssetId, { ...value }]));
    if (proofs.size !== sources.size || [...proofs.keys()].some(source => !sources.has(source))) return fail();
    const registrations = Object.freeze(captured.map(entry => {
      const source = entry.route.sourceServiceAsset.id, policy = policies.get(entry.identity.routeBindingId), proof = proofs.get(source);
      const site = policy && snapshot.candidate.sites.find(site => site.id === policy.siteId && site.sourceServiceAssetId === source);
      if (!policy || !proof || !site || !site.endpoints.some(endpoint => 'endpointDefinitionId' in endpoint && endpoint.endpointDefinitionId === entry.route.endpointDefinition?.id) ||
          !compiler.authorizeTarget(policy.policy, { sourceServiceAssetId: source, siteId: policy.siteId, url: entry.route.upstreamBaseUrl }) ||
          host.readEpoch(source) !== proof.providerEpoch) return fail();
      // A real compiled capability for another origin must not borrow this Registry Site.
      const origin = new URL(policy.policy.origin);
      const hostName = origin.hostname.replace(/^\[|\]$/g, '');
      if (!['http', 'https'].includes(site.match.scheme) || site.match.host.includes('*') ||
          origin.protocol !== site.match.scheme + ':' || hostName !== site.match.host.replace(/^\[|\]$/g, '') ||
          Number(origin.port || (origin.protocol === 'https:' ? 443 : 80)) !== site.match.port) return fail();
      if (policy.policy.exception) expiry = Math.min(expiry, policy.policy.exception.expiresAt);
      return Object.freeze({ captured: entry, snapshot, siteId: policy.siteId, policy: policy.policy, providerEpoch: proof.providerEpoch });
    }));
    for (const source of sources) {
      const proof = proofs.get(source)!;
      listen(host.readSignal(source));
      expiry = Math.min(expiry, host.consumeProof(proof.proof, source, proof.providerEpoch).expiresAt);
    }
    const check = () => {
      exactCurrent();
      for (const entry of registrations) {
        const source = entry.captured.route.sourceServiceAsset.id;
        if (host.readEpoch(source) !== entry.providerEpoch || host.readSignal(source).aborted ||
          !compiler.authorizeTarget(entry.policy, { sourceServiceAssetId: source, siteId: entry.siteId, url: entry.captured.route.upstreamBaseUrl })) return fail();
      }
      return registrations;
    };
    check();
    const bundle = Object.freeze({ kind: 'gateway-network-registration-bundle' as const, signal: controller.signal });
    bundles.set(bundle, { inspect: () => { try { return check(); } catch { close(); return fail(); } }, close });
    timer = setTimeout(close, Math.max(0, expiry - Date.now())); timer.unref?.();
    return bundle;
  } catch { close(); return fail(); }
}
