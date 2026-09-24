import { randomUUID } from 'node:crypto';
import type { UserService } from '../../security/services/user.service';
import { securityDigest } from './upstream-security-reconciliation';
import type { TrustedChallengeIntentAuthority } from './upstream-authentication-challenge-orchestrator';
export const UPSTREAM_CHALLENGE_PERMISSION = 'upstream:challenge';
export interface TrustedChallengeSessionAuthority {
  /** Only a capability established by the management authentication host is valid. */
  resolve(session: unknown): Promise<{ actorId: string; authenticationEpoch: string } | undefined>;
}
export interface TrustedChallengeOwnership {
  /** Must enforce actor scope and endpoint→source ownership in authoritative storage.
   * The existing editable source.owner label is explicitly not such an authority. */
  resolve(actorId: string, ids: { sourceServiceAssetId: string; endpointDefinitionId: string }): Promise<{ revision: string } | undefined>;
}
export interface ChallengeIntentAudit {
  record(event: { event: 'issued' | 'consumed' | 'denied' | 'passed' | 'failed'; operationId: string; actorId?: string; sourceServiceAssetId?: string; endpointDefinitionId?: string }): Promise<void>;
}
declare const trustedChallengeIntent: unique symbol;
export type TrustedChallengeIntent = { readonly [trustedChallengeIntent]: true };
/** Internal host-only issuer. No controller, DI registration, seed or implicit grant. */
export function createTrustedChallengeIntentAuthority(options: {
  sessions: TrustedChallengeSessionAuthority;
  users: Pick<UserService, 'findUserById'>;
  ownership?: TrustedChallengeOwnership;
  audit: ChallengeIntentAudit;
  leaseMs?: number;
  now?: () => number;
}): TrustedChallengeIntentAuthority & {
  issue(session: unknown, ids: { sourceServiceAssetId: string; endpointDefinitionId: string }): Promise<TrustedChallengeIntent>;
  complete(intent: TrustedChallengeIntent, status: 'passed' | 'failed'): Promise<void>;
} {
  const now = options.now ?? Date.now, leaseMs = options.leaseMs ?? 5000;
  if (!Number.isFinite(leaseMs) || leaseMs < 1 || leaseMs > 30000) throw Error('CHALLENGE_INTENT_CONFIGURATION');
  type Entry = { session: unknown; ids: { sourceServiceAssetId: string; endpointDefinitionId: string }; actorId: string; fingerprint: string; operationId: string; expiresAt: number; consumed: boolean; completing?: boolean; scope: string };
  const entries = new WeakMap<TrustedChallengeIntent, Entry>();
  const leases = new Map<string, { token: TrustedChallengeIntent; expiresAt: number }>();
  const denied = () => new Error('CHALLENGE_INTENT_DENIED');
  const valid = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
  async function evaluate(session: unknown, ids: Entry['ids']) {
    const authenticated = await options.sessions.resolve(session);
    if (!authenticated || !valid(authenticated.actorId) || !valid(authenticated.authenticationEpoch) || !options.ownership) throw denied();
    const user = await options.users.findUserById(authenticated.actorId);
    if (!user || user.id !== authenticated.actorId || !user.isActive || user.isLocked) throw denied();
    const grants = (user.roles || []).filter(role => role.enabled === true).flatMap(role => (role.permissions || []).filter(permission =>
      permission.name === UPSTREAM_CHALLENGE_PERMISSION && permission.enabled === true &&
      (permission.conditions == null || typeof permission.conditions === 'object' && !Array.isArray(permission.conditions) && !Object.keys(permission.conditions).length)
    ).map(permission => ({ role: role.id, permission: permission.id, roleUpdatedAt: role.updatedAt, permissionUpdatedAt: permission.updatedAt })));
    if (!grants.length) throw denied();
    const ownership = await options.ownership.resolve(user.id, Object.freeze({ ...ids }));
    if (!ownership || !valid(ownership.revision)) throw denied();
    return { actorId: user.id, fingerprint: securityDigest({ authenticationEpoch: authenticated.authenticationEpoch, actorId: user.id, grants, ownership: ownership.revision, ids }) };
  }
  function release(token: TrustedChallengeIntent, scope: string) { if (leases.get(scope)?.token === token) leases.delete(scope); }
  return Object.freeze({
    async issue(session: unknown, ids: Entry['ids']): Promise<TrustedChallengeIntent> {
      const operationId = randomUUID(); let scope: string | undefined, token: TrustedChallengeIntent | undefined;
      try {
        if (!ids || Object.keys(ids).sort().join(',') !== 'endpointDefinitionId,sourceServiceAssetId' || !valid(ids.sourceServiceAssetId) || !valid(ids.endpointDefinitionId)) throw denied();
        const captured = Object.freeze({ sourceServiceAssetId: ids.sourceServiceAssetId, endpointDefinitionId: ids.endpointDefinitionId }); scope = JSON.stringify(captured);
        for (const [key, lease] of leases) if (now() >= lease.expiresAt) leases.delete(key);
        if (leases.has(scope) || leases.size >= 128) throw denied();
        token = Object.freeze({}) as TrustedChallengeIntent; const expiresAt = now() + leaseMs; leases.set(scope, { token, expiresAt });
        const first = await evaluate(session, captured);
        await options.audit.record({ event: 'issued', operationId, actorId: first.actorId, ...captured });
        const second = await evaluate(session, captured);
        if (first.fingerprint !== second.fingerprint || now() >= expiresAt || leases.get(scope)?.token !== token) throw denied();
        entries.set(token, { session, ids: captured, ...second, operationId, expiresAt, consumed: false, scope }); return token;
      } catch {
        if (scope && token) release(token, scope);
        try { await options.audit.record({ event: 'denied', operationId }); } catch { /* No unaudited authorization escapes. */ }
        throw denied();
      }
    },
    async resolve(input: unknown) {
      const token = input as TrustedChallengeIntent, entry = entries.get(token);
      if (!entry || entry.consumed || now() >= entry.expiresAt || leases.get(entry.scope)?.token !== token) {
        try { await options.audit.record({ event: 'denied', operationId: entry?.operationId ?? randomUUID(), ...(entry ? { actorId: entry.actorId, ...entry.ids } : {}) }); } catch { /* Rejection remains closed if audit is unavailable. */ }
        throw denied();
      }
      entry.consumed = true;
      try {
        const first = await evaluate(entry.session, entry.ids);
        if (first.fingerprint !== entry.fingerprint) throw denied();
        await options.audit.record({ event: 'consumed', operationId: entry.operationId, actorId: entry.actorId, ...entry.ids });
        const second = await evaluate(entry.session, entry.ids);
        if (second.fingerprint !== entry.fingerprint || now() >= entry.expiresAt || leases.get(entry.scope)?.token !== token) throw denied();
        return Object.freeze({ intentId: entry.operationId, actorId: entry.actorId, ...entry.ids });
      } catch {
        release(token, entry.scope);
        try { await options.audit.record({ event: 'denied', operationId: entry.operationId, actorId: entry.actorId, ...entry.ids }); } catch { /* Fail closed. */ }
        throw denied();
      }
    },
    async complete(token: TrustedChallengeIntent, status: 'passed' | 'failed'): Promise<void> {
      const entry = entries.get(token);
      if (!entry?.consumed || entry.completing || !['passed', 'failed'].includes(status) || leases.get(entry.scope)?.token !== token) throw denied();
      entry.completing = true;
      try { await options.audit.record({ event: status, operationId: entry.operationId, actorId: entry.actorId, ...entry.ids }); }
      catch { throw denied(); }
      entries.delete(token); release(token, entry.scope);
    },
  });
}
