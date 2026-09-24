import { UpstreamCredentialRegistry, type UpstreamCredentialRegistrySnapshot } from '../credentials/registry';
import type { SingleHopUpstreamCredentialPolicy } from '../credentials/single-hop-execution';
import { createHostSecurityEpochAuthority, HostSecurityEpochError, type HostSecurityEpoch } from './host-security-epoch-authority';
import { createTrustedSingleHopNetworkExecution, type TrustedNetworkRegistration } from './trusted-single-hop-network-execution';
import { createNetworkPolicyCompiler } from './network-policy';
import { ControlledDnsError } from './controlled-dns';
import { pinnedRecord } from './pinned-http-connection';

/** Trusted host capability adapter. Missing adapter never authorizes a request.
 * consume must atomically consume an opaque proof bound to this exact context.
 * readEpoch must refer to the captured Provider version, not mutable env/file stats.
 * This module supplies no production issuer; scripts/metadata cannot supply evidence.
 */
export interface ParserHostProviderEvidence {
  consume(proof: unknown, context: Readonly<{ snapshot: UpstreamCredentialRegistrySnapshot; sourceServiceAssetId: string; providerEpoch: string }>): Readonly<{ expiresAt: number }> | undefined;
  readEpoch(snapshot: UpstreamCredentialRegistrySnapshot, sourceServiceAssetId: string): string;
}
const fail = (code: ControlledDnsError['code'] = 'upstream_network_policy_unavailable'): never => { throw new ControlledDnsError(code); };
/** Single-source, explicit in-process host composition. No DI, child IPC or default activation. */
export function createParserHostNetworkBridge(input: {
  registry: UpstreamCredentialRegistry; sourceServiceAssetId: string; compiler: ReturnType<typeof createNetworkPolicyCompiler>;
  servers: readonly string[]; ca?: string; registrations: readonly TrustedNetworkRegistration[]; providerEvidence?: ParserHostProviderEvidence;
}) {
  const raw = pinnedRecord(input, ['registry', 'sourceServiceAssetId', 'compiler', 'servers', 'ca', 'registrations', 'providerEvidence'], ['registry', 'sourceServiceAssetId', 'compiler', 'servers', 'registrations']);
  const registry = raw.registry as UpstreamCredentialRegistry, source = raw.sourceServiceAssetId as string;
  if (!(registry instanceof UpstreamCredentialRegistry) || typeof source !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(source)) return fail();
  const evidence = raw.providerEvidence === undefined ? undefined : pinnedRecord(raw.providerEvidence, ['consume', 'readEpoch'], ['consume', 'readEpoch']) as unknown as ParserHostProviderEvidence;
  if (evidence && (typeof evidence.consume !== 'function' || typeof evidence.readEpoch !== 'function')) return fail();
  const consume = evidence?.consume.bind(evidence), readEvidenceEpoch = evidence?.readEpoch.bind(evidence);
  const authority = createHostSecurityEpochAuthority({ maxSources: 1 });
  const expiryTimers = new Set<ReturnType<typeof setTimeout>>();
  let activating = false;
  let closed = false, signalEpoch: HostSecurityEpoch | undefined, signalController: AbortController | undefined, detachSignal: (() => void) | undefined;
  const registered = new WeakSet<UpstreamCredentialRegistrySnapshot>();
  const policyExpiries = new WeakMap<UpstreamCredentialRegistrySnapshot, number>();
  const attested = new WeakMap<UpstreamCredentialRegistrySnapshot, { epoch: string; expiresAt: number; monotonic: number }>();
  const assertOpen = () => { if (closed) return fail(); };
  const readHost = () => { assertOpen(); try { return authority.read(source); } catch (error) { return fail(error instanceof HostSecurityEpochError && error.code === 'policy_denied' ? 'upstream_network_policy_denied' : 'upstream_network_policy_unavailable'); } };
  const readProvider = (snapshot: UpstreamCredentialRegistrySnapshot) => {
    readHost(); const proof = attested.get(snapshot); if (!proof || !readEvidenceEpoch) return fail();
    if (Date.now() >= proof.expiresAt || performance.now() >= proof.monotonic) { authority.revoke(source); return fail('upstream_network_policy_denied'); }
    let observed: string;
    try { observed = readEvidenceEpoch(snapshot, source); } catch { authority.unavailable(source); return fail(); }
    if (observed !== proof.epoch) { authority.revoke(source); return fail('upstream_network_policy_denied'); }
    readHost(); return observed;
  };
  const checked = (items: readonly TrustedNetworkRegistration[]) => {
    assertOpen(); const snapshot = registry.captureSnapshot();
    if (!Array.isArray(items) || !items.length || items.some(item => item.snapshot !== snapshot || item.sourceServiceAssetId !== source)) return fail('upstream_network_policy_denied');
    return snapshot;
  };
  const initial = raw.registrations as readonly TrustedNetworkRegistration[], first = checked(initial);
  const credentialPolicy: SingleHopUpstreamCredentialPolicy = Object.freeze({ mode: 'single-hop', captureSnapshot: () => {
    assertOpen(); const snapshot = registry.captureSnapshot(); if (!registered.has(snapshot)) return fail(); readProvider(snapshot); return snapshot;
  } });
  const execution = createTrustedSingleHopNetworkExecution({ credentialPolicy, compiler: raw.compiler as ReturnType<typeof createNetworkPolicyCompiler>, servers: raw.servers as readonly string[],
    ...(raw.ca === undefined ? {} : { ca: raw.ca as string }), registrations: initial,
    operationLifecycle: { readSecurityEpoch: requestedSource => { if (requestedSource !== source) return fail('upstream_network_policy_denied'); return readHost().securityEpoch; }, readProviderEpoch: (snapshot, binding) => { if (binding.sourceServiceAssetId !== source) return fail('upstream_network_policy_denied'); return readProvider(snapshot); }, captureSignal: () => {
      const epoch = readHost(); if (epoch !== signalEpoch) {
        detachSignal?.(); signalEpoch = epoch; const controller = new AbortController(); signalController = controller;
        const abort = () => { let code: ControlledDnsError['code'] = 'upstream_network_policy_unavailable'; try { authority.read(source); } catch (error) { if (error instanceof HostSecurityEpochError && error.code === 'policy_denied') code = 'upstream_network_policy_denied'; }
          controller.abort(new ControlledDnsError(code)); };
        epoch.signal.addEventListener('abort', abort, { once: true }); detachSignal = () => epoch.signal.removeEventListener('abort', abort); if (epoch.signal.aborted) abort();
      } return signalController!.signal;
    } } });
  registered.add(first); policyExpiries.set(first, Math.min(...initial.map(item => item.policy.exception?.expiresAt ?? Infinity))); authority.observeRegistry(registry);
  return Object.freeze({ credentialPolicy, execution,
    registerCurrent(items: readonly TrustedNetworkRegistration[]): void { const snapshot = checked(items); if (registered.has(snapshot)) return fail('upstream_network_policy_denied'); for (const item of items) execution.register(item); registered.add(snapshot); policyExpiries.set(snapshot, Math.min(...items.map(item => item.policy.exception?.expiresAt ?? Infinity))); },
    activateCurrent(proof: unknown): void {
      assertOpen(); const snapshot = registry.captureSnapshot(); if (!registered.has(snapshot) || !consume || !readEvidenceEpoch) return fail();
      if (activating) return fail('upstream_network_policy_denied'); activating = true;
      try {
        const providerEpoch = readEvidenceEpoch(snapshot, source);
        if (typeof providerEpoch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(providerEpoch)) return fail();
        const rawReceipt = consume(proof, Object.freeze({ snapshot, sourceServiceAssetId: source, providerEpoch }));
        const receipt = rawReceipt === undefined ? undefined : pinnedRecord(rawReceipt, ['expiresAt'], ['expiresAt']) as unknown as { expiresAt: number };
        if (!receipt || !Number.isSafeInteger(receipt.expiresAt) || receipt.expiresAt <= Date.now()) return fail('upstream_network_policy_denied');
        if (expiryTimers.size >= 256) return fail();
        const expiresAt = Math.min(receipt.expiresAt, policyExpiries.get(snapshot) ?? Infinity, ...Object.values(snapshot.candidate.credentials).map(credential => credential.expiresAt ? Date.parse(credential.expiresAt) : Infinity));
        if (expiresAt <= Date.now()) return fail('upstream_network_policy_denied');
        assertOpen(); if (registry.captureSnapshot() !== snapshot || readEvidenceEpoch(snapshot, source) !== providerEpoch) return fail('upstream_network_policy_denied');
        // A new ordinary-reload Snapshot may be attested without cancelling pinned operations.
        let active = false; try { authority.read(source); active = true; } catch { /* Explicit proof is required to recover. */ }
        if (!active || attested.has(snapshot)) authority.activate(source, expiresAt);
        const captured = { epoch: providerEpoch, expiresAt, monotonic: performance.now() + expiresAt - Date.now() };
        const activationEpoch = authority.read(source).securityEpoch;
        attested.set(snapshot, captured);
        const expire = () => {
          if (closed || attested.get(snapshot) !== captured) return;
          try { if (authority.read(source).securityEpoch !== activationEpoch) return; } catch { return; }
          const remaining = Math.min(captured.expiresAt - Date.now(), captured.monotonic - performance.now());
          if (remaining <= 0) { authority.revoke(source); return; }
          const timer = setTimeout(() => { expiryTimers.delete(timer); expire(); }, Math.min(remaining, 2_147_483_647)); expiryTimers.add(timer); timer.unref?.();
        }; expire();
      } catch (error) { if (error instanceof ControlledDnsError) throw error; try { authority.unavailable(source); } catch { /* closed authority remains unavailable */ } return fail(); } finally { activating = false; }
    },
    revoke(): void { assertOpen(); authority.revoke(source); },
    unavailable(): void { assertOpen(); authority.unavailable(source); },
    close(): void { if (closed) return; closed = true; authority.close(); detachSignal?.(); for (const timer of expiryTimers) clearTimeout(timer); expiryTimers.clear(); },
  });
}
