import { randomUUID } from 'node:crypto';
import type { UpstreamCredentialRegistry } from '../credentials/registry';
import type { RegistrySecuritySubscription } from '../credentials/registry-security-events';

export class HostSecurityEpochError extends Error {
  constructor(readonly code: 'policy_denied' | 'policy_unavailable') { super(code); this.name = 'HostSecurityEpochError'; }
}
export interface HostSecurityEpoch {
  readonly securityEpoch: string;
  readonly providerEpoch: string;
  readonly signal: AbortSignal;
}
interface Entry { epoch: HostSecurityEpoch; controller: AbortController; state: 'active' | 'denied' | 'unavailable'; expiresAt?: number; expiresMonotonic?: number; timer?: ReturnType<typeof setTimeout>; }
/**
 * Opt-in host authority. Activation attests a trusted provider capture; this module
 * never derives a provider revision from an environment value, file stat or secret.
 * D2/D3 must connect atomic provider updates and admission to these methods.
 */
export function createHostSecurityEpochAuthority(options: { maxSources?: number } = {}) {
  const max = options.maxSources ?? 128;
  if (!Number.isSafeInteger(max) || max < 1 || max > 4096) throw new HostSecurityEpochError('policy_unavailable');
  const entries = new Map<string, Entry>();
  let subscription: RegistrySecuritySubscription | undefined, unsubscribeFailure: (() => void) | undefined, closed = false, transitioning = false;
  const valid = (source: string) => { if (typeof source !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(source)) throw new HostSecurityEpochError('policy_unavailable'); };
  const stop = (entry: Entry, state: 'denied' | 'unavailable') => {
    // Epoch advances and state closes before synchronous abort observers execute.
    entry.state = state;
    entry.epoch = Object.freeze({ securityEpoch: randomUUID(), providerEpoch: randomUUID(), signal: entry.controller.signal });
    clearTimeout(entry.timer); entry.timer = undefined;
    const previousTransition = transitioning; transitioning = true;
    try { entry.controller.abort(new HostSecurityEpochError(state === 'denied' ? 'policy_denied' : 'policy_unavailable')); }
    finally { transitioning = previousTransition; }
  };
  const healthy = () => {
    if (closed) throw new HostSecurityEpochError('policy_unavailable');
    try { subscription?.assertAvailable(); }
    catch { for (const entry of entries.values()) if (entry.state === 'active') stop(entry, 'unavailable'); throw new HostSecurityEpochError('policy_unavailable'); }
  };
  const schedule = (entry: Entry) => {
    if (entry.expiresAt === undefined || entry.state !== 'active') return;
    const remaining = Math.min(entry.expiresAt - Date.now(), entry.expiresMonotonic! - performance.now());
    if (remaining <= 0) { stop(entry, 'denied'); return; }
    entry.timer = setTimeout(() => schedule(entry), Math.min(remaining, 2_147_483_647));
    entry.timer.unref?.();
  };
  return Object.freeze({
    /** Call only after host captures provider material atomically. Always creates fresh tokens. */
    activate(source: string, expiresAt?: number): HostSecurityEpoch {
      healthy(); valid(source);
      if (transitioning) throw new HostSecurityEpochError('policy_denied');
      if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())) throw new HostSecurityEpochError('policy_denied');
      if (!entries.has(source) && entries.size >= max) throw new HostSecurityEpochError('policy_unavailable');
      const old = entries.get(source); if (old) stop(old, 'denied');
      // A reentrant abort listener may close the authority. Never reopen it implicitly.
      healthy();
      const controller = new AbortController();
      const epoch = Object.freeze({ securityEpoch: randomUUID(), providerEpoch: randomUUID(), signal: controller.signal });
      const entry: Entry = { epoch, controller, state: 'active', expiresAt, expiresMonotonic: expiresAt === undefined ? undefined : performance.now() + expiresAt - Date.now() }; entries.set(source, entry); schedule(entry);
      return epoch;
    },
    read(source: string): HostSecurityEpoch {
      healthy(); valid(source); const entry = entries.get(source);
      if (!entry) throw new HostSecurityEpochError('policy_unavailable');
      if (entry.state === 'active' && entry.expiresAt !== undefined && (Date.now() >= entry.expiresAt || performance.now() >= entry.expiresMonotonic!)) stop(entry, 'denied');
      if (entry.state !== 'active') throw new HostSecurityEpochError(entry.state === 'denied' ? 'policy_denied' : 'policy_unavailable');
      return entry.epoch;
    },
    revoke(source: string): void { healthy(); valid(source); const entry = entries.get(source); if (entry) stop(entry, 'denied'); },
    unavailable(source: string): void { healthy(); valid(source); const entry = entries.get(source); if (entry) stop(entry, 'unavailable'); },
    /** A real Registry instance is host-owned. No replay or automatic provider activation. */
    observeRegistry(registry: UpstreamCredentialRegistry): void {
      healthy(); if (subscription) throw new HostSecurityEpochError('policy_unavailable');
      subscription = registry.observeSecurityCommits(event => {
        for (const change of event.changes) {
          const entry = entries.get(change.sourceServiceAssetId);
          if (entry && change.kind !== 'reload') stop(entry, 'denied');
        }
      });
      const onFailure = () => { for (const entry of entries.values()) if (entry.state === 'active') stop(entry, 'unavailable'); };
      subscription.signal.addEventListener('abort', onFailure, { once: true });
      unsubscribeFailure = () => subscription?.signal.removeEventListener('abort', onFailure);
      if (subscription.signal.aborted) onFailure();
    },
    close(): void {
      if (closed) return; closed = true; unsubscribeFailure?.(); subscription?.close();
      for (const entry of entries.values()) stop(entry, 'unavailable'); entries.clear();
    },
  });
}
