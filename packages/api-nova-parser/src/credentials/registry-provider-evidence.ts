import { randomUUID } from 'node:crypto';
import { createHostCredentialGenerationStore, HostCredentialGenerationError, type HostCredentialGeneration } from './host-credential-generations';
import type { UpstreamCredentialRegistrySnapshot } from './registry';
import type { UpstreamSecretProviderDescription } from './types';
import type { UpstreamSecretProvider } from './secret-provider';

export class RegistryProviderEvidenceError extends Error {
  constructor(readonly code: 'denied' | 'unavailable') { super('REGISTRY_PROVIDER_EVIDENCE_' + code.toUpperCase()); this.name = 'RegistryProviderEvidenceError'; }
}
export interface RegistryProviderEvidence {
  issue(snapshot: UpstreamCredentialRegistrySnapshot, sourceServiceAssetId: string, ttlMs?: number): object;
  readEpoch(snapshot: UpstreamCredentialRegistrySnapshot, sourceServiceAssetId: string): string;
  consume(proof: unknown, context: Readonly<{ snapshot: UpstreamCredentialRegistrySnapshot; sourceServiceAssetId: string; providerEpoch: string }>): Readonly<{ expiresAt: number }> | undefined;
  /** Stable per-generation signal; trusted consumers must map its host error reason. */
  readSignal(snapshot: UpstreamCredentialRegistrySnapshot, sourceServiceAssetId: string): AbortSignal;
  close(): void;
}
export interface CapturedRegistryProviderGeneration { readonly kind: 'captured-registry-provider-generation' }
type Store = ReturnType<typeof createHostCredentialGenerationStore>;
type Capture = { owner: State; generation: HostCredentialGeneration };
type Proof = { snapshot: UpstreamCredentialRegistrySnapshot; source: string; epoch: string; expiresAt: number; monotonic: number; runNonce: string; timer: ReturnType<typeof setTimeout> };
type SignalEntry = { controller: AbortController; detach: () => void };
type State = { signals: Map<HostCredentialGeneration, SignalEntry>; store: Store; closed: boolean; runNonce: string; snapshots: WeakMap<object, Capture>; proofs: WeakMap<object, Proof>; liveProofs: Set<Proof> };
const issuers = new WeakMap<RegistryProviderEvidence, State>(), captures = new WeakMap<CapturedRegistryProviderGeneration, Capture>();
const fail = (code: 'denied' | 'unavailable' = 'unavailable'): never => { throw new RegistryProviderEvidenceError(code); };
function state(issuer: RegistryProviderEvidence): State { const value = issuers.get(issuer); if (!value || value.closed) return fail(); return value; }
function describe(capture: Capture) {
  if (capture.owner.closed) return fail();
  try { return capture.owner.store.describe(capture.generation); }
  catch (error) { return fail(error instanceof HostCredentialGenerationError && error.code === 'denied' ? 'denied' : 'unavailable'); }
}
function bound(owner: State, snapshot: UpstreamCredentialRegistrySnapshot, source: string): Capture {
  const capture = snapshot && typeof snapshot === 'object' ? owner.snapshots.get(snapshot) : undefined;
  if (!capture || typeof source !== 'string' || !snapshot.candidate.sites.some(site => site.sourceServiceAssetId === source)) return fail('denied'); describe(capture); return capture;
}
/** In-process issuer for a real host-owned generation store; never proves env/file fresh reads. */
export function createRegistryProviderEvidence(store: Store): RegistryProviderEvidence {
  // Host injects the store itself; subsequent option mutation cannot replace its methods.
  const pinnedStore = Object.freeze({ capture: store.capture.bind(store), describe: store.describe.bind(store), resolve: store.resolve.bind(store) });
  const owner: State = { signals: new Map(), store: pinnedStore as Store, closed: false, runNonce: randomUUID(), snapshots: new WeakMap(), proofs: new WeakMap(), liveProofs: new Set() };
  const issuer: RegistryProviderEvidence = Object.freeze({
    issue(snapshot: UpstreamCredentialRegistrySnapshot, source: string, ttlMs = 30000) {
      state(issuer); const capture = bound(owner, snapshot, source), details = describe(capture);
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 60000 || owner.liveProofs.size >= 1024) return fail();
      const expiresAt = Math.min(Date.now() + ttlMs, details.expiresAt), proof = Object.freeze({ kind: 'registry-provider-proof' });
      const entry: Proof = { snapshot, source, epoch: details.generationId, expiresAt, monotonic: performance.now() + expiresAt - Date.now(), runNonce: owner.runNonce, timer: undefined! };
      entry.timer = setTimeout(() => { owner.liveProofs.delete(entry); }, Math.max(1, expiresAt - Date.now())); entry.timer.unref?.();
      owner.proofs.set(proof, entry); owner.liveProofs.add(entry); return proof;
    },
    readEpoch(snapshot: UpstreamCredentialRegistrySnapshot, source: string) { state(issuer); return describe(bound(owner, snapshot, source)).generationId; },
    readSignal(snapshot: UpstreamCredentialRegistrySnapshot, source: string): AbortSignal {
      state(issuer); const capture = bound(owner, snapshot, source), details = describe(capture);
      const existing = owner.signals.get(capture.generation); if (existing) return existing.controller.signal;
      if (owner.signals.size >= 256) return fail();
      const controller = new AbortController();
      const abort = () => {
        owner.signals.delete(capture.generation);
        details.signal.removeEventListener('abort', abort);
        // The store changes terminal state before dispatching. Never expose raw secrets/errors.
        const reason = details.signal.reason;
        controller.abort(new HostCredentialGenerationError(
          reason instanceof HostCredentialGenerationError && reason.code === 'unavailable' ? 'unavailable' : 'denied'));
      };
      const entry = { controller, detach: () => details.signal.removeEventListener('abort', abort) };
      owner.signals.set(capture.generation, entry);
      details.signal.addEventListener('abort', abort, { once: true });
      if (details.signal.aborted) abort();
      return controller.signal;
    },
    consume(proof: unknown, context: Readonly<{ snapshot: UpstreamCredentialRegistrySnapshot; sourceServiceAssetId: string; providerEpoch: string }>) {
      if (!proof || typeof proof !== 'object') return undefined;
      const entry = owner.proofs.get(proof); if (!entry) return undefined;
      owner.proofs.delete(proof); const live = owner.liveProofs.delete(entry); clearTimeout(entry.timer);
      try {
        state(issuer); if (!live || entry.runNonce !== owner.runNonce || !context || Object.getPrototypeOf(context) !== Object.prototype) return undefined;
        const descriptors = Object.getOwnPropertyDescriptors(context);
        if (Reflect.ownKeys(descriptors).length !== 3 || ['snapshot', 'sourceServiceAssetId', 'providerEpoch'].some(key => !descriptors[key] || !('value' in descriptors[key]))) return undefined;
        if (descriptors.snapshot.value !== entry.snapshot || descriptors.sourceServiceAssetId.value !== entry.source || descriptors.providerEpoch.value !== entry.epoch || Date.now() >= entry.expiresAt || performance.now() >= entry.monotonic) return undefined;
        if (describe(bound(owner, entry.snapshot, entry.source)).generationId !== entry.epoch) return undefined;
        return Object.freeze({ expiresAt: entry.expiresAt });
      } catch { return undefined; }
    },
    close() { if (owner.closed) return; owner.closed = true; owner.snapshots = new WeakMap(); owner.proofs = new WeakMap(); for (const proof of owner.liveProofs) clearTimeout(proof.timer); owner.liveProofs.clear();
      const signals = [...owner.signals.values()]; owner.signals.clear();
      for (const entry of signals) { entry.detach(); entry.controller.abort(new HostCredentialGenerationError('unavailable')); }
    },
  });
  issuers.set(issuer, owner); return issuer;
}
/** Registry integration only. The capture is fixed before the first await of a reload. */
export function captureRegistryProviderGeneration(issuer: RegistryProviderEvidence): CapturedRegistryProviderGeneration {
  const owner = state(issuer); let generation: HostCredentialGeneration;
  try { generation = owner.store.capture(); } catch { return fail(); }
  const capture = { owner, generation }; describe(capture); const token = Object.freeze({ kind: 'captured-registry-provider-generation' as const }); captures.set(token, capture); return token;
}
export function assertRegistryProviderEvidence(issuer: RegistryProviderEvidence): void { state(issuer); }
export function assertCapturedRegistryProviderGeneration(token: CapturedRegistryProviderGeneration): void { const capture = captures.get(token); if (!capture) return fail(); describe(capture); }
export function capturedRegistrySecretProvider(token: CapturedRegistryProviderGeneration, providerId: string, description: UpstreamSecretProviderDescription): UpstreamSecretProvider {
  const capture = captures.get(token); if (!capture) return fail(); describe(capture);
  return Object.freeze({ type: description.type, async resolve(key: string) { describe(capture); try { return capture.owner.store.resolve(capture.generation, providerId, key); } catch { return fail('denied'); } } });
}
/** Call only after Registry active swap, without await and before observer dispatch. */
export function associateRegistryProviderGeneration(token: CapturedRegistryProviderGeneration, snapshot: UpstreamCredentialRegistrySnapshot): void {
  const capture = captures.get(token); if (!capture) return fail(); capture.owner.snapshots.set(snapshot, capture);
}
