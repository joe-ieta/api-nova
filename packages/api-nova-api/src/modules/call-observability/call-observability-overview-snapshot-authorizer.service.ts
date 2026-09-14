import { Injectable } from '@nestjs/common';
import type { EventsSnapshotAuthorizer } from './call-observability-events.service';
import { ObservabilityAuthorization } from './call-observability-access';
import { ObservabilityApiError } from './call-observability-api.contract';
import { ObservabilityFilter } from './call-observability-query';
import { canonicalJson, contentHash, publicSequence } from './call-observability-storage';

export const OVERVIEW_SNAPSHOT_TTL_MS = 5 * 60 * 1000;
export const MAX_OVERVIEW_SNAPSHOT_GRANTS = 1000;
const BOUND_KEYS = ['origin', 'serverType', 'runtimeAssetId'] as const;
const NARROWING_KEYS = ['eventTypes', 'severities', 'spanKinds', 'outcomes', 'callerId', 'endpointDefinitionId', 'toolName'];

/**
 * Process-local proof that this principal actually obtained an invocation snapshot.
 * Register this SAME instance as EVENTS_SNAPSHOT_AUTHORIZER via useExisting.
 * Restart, TTL expiry or oldest-issuance eviction requires a new overview.
 * The grant does not replace event authorization and never covers legacy server state.
 */
@Injectable()
export class CallObservabilityOverviewSnapshotAuthorizer implements EventsSnapshotAuthorizer {
  private readonly grants = new Map<string, number>();

  private prune(now: number): void {
    for (const [key, expiresAt] of this.grants) if (expiresAt <= now) this.grants.delete(key);
  }

  private key(sequence: string, scope: ObservabilityAuthorization, filter: ObservabilityFilter): string | null {
    if (!/^(0|[1-9][0-9]{0,19})$/.test(sequence)) return null;
    try { if (publicSequence(sequence) !== sequence) return null; } catch { return null; }
    if (!['external', 'test', 'probe', 'internal'].includes(String(filter.origin))) return null;
    if (filter.serverType !== undefined && !['gateway', 'mcp'].includes(String(filter.serverType))) return null;
    for (const field of BOUND_KEYS) {
      const value = filter[field];
      if (value !== undefined && (typeof value !== 'string' || !value || value.length > 500 ||
        /[\u0000-\u001f\u007f]/.test(value))) return null;
    }
    return contentHash(canonicalJson({ sequence, principalId: scope.principalId, fingerprint: scope.fingerprint,
      runtimeAssetIds: scope.runtimeAssetIds === null ? null : [...scope.runtimeAssetIds].sort(),
      requiredPermissions: [...scope.requiredPermissions].sort(),
      filter: Object.fromEntries(BOUND_KEYS.filter(key => filter[key] !== undefined).map(key => [key, filter[key]])) }));
  }

  /** Call only AFTER the overview read transaction has completed successfully. */
  issue(sequence: string, scope: ObservabilityAuthorization, filter: ObservabilityFilter): string {
    const key = this.key(sequence, scope, filter);
    if (!key) throw new ObservabilityApiError('INVALID_QUERY', 'snapshot');
    const now = Date.now(), expiresAt = now + OVERVIEW_SNAPSHOT_TTL_MS;
    this.prune(now);
    // Reissuing the same grant renews its TTL and moves it to the newest issuance.
    this.grants.delete(key);
    while (this.grants.size >= MAX_OVERVIEW_SNAPSHOT_GRANTS) {
      this.grants.delete(this.grants.keys().next().value!);
    }
    this.grants.set(key, expiresAt);
    return new Date(expiresAt).toISOString();
  }

  async authorize(sequence: string, scope: ObservabilityAuthorization, filter: ObservabilityFilter): Promise<boolean> {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return false;
    // Event-side validation still owns value validation. Known extra predicates may
    // narrow the stream; they cannot drop or broaden the three bound dimensions.
    if (Object.keys(filter).some(key => !(BOUND_KEYS as readonly string[]).includes(key) &&
      !NARROWING_KEYS.includes(key))) return false;
    const now = Date.now();
    this.prune(now);
    const key = this.key(sequence, scope, filter);
    return key !== null && (this.grants.get(key) ?? 0) > now;
  }
}
