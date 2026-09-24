import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { ObservabilityAuthorization } from './call-observability-access';
import { ObservabilityApiError } from './call-observability-api.contract';
import { ObservabilityFilter } from './call-observability-query';
import { canonicalJson, contentHash, publicSequence } from './call-observability-storage';

export const SERVER_STATE_SNAPSHOT_TTL_MS = 5 * 60 * 1000;
export const MAX_SERVER_STATE_SNAPSHOT_GRANTS = 1000;
const FILTER_KEYS = ['from', 'to', 'origin', 'timeBasis', 'serverType', 'runtimeAssetId'];

/** A process-local capability; deliberately unrelated to overview/event authorizers. */
@Injectable()
export class CallObservabilityServerStateSnapshotAuthorizer {
  private readonly grants = new Map<string, { binding: string; expiresAt: number; assetIds: readonly string[] }>();

  private binding(sequence: string, authorization: ObservabilityAuthorization, filter: ObservabilityFilter): string | null {
    try {
      if (!/^(0|[1-9][0-9]{0,19})$/.test(sequence) || publicSequence(sequence) !== sequence ||
        !authorization.principalId || !authorization.fingerprint || !authorization.requiredPermissions.includes('monitoring:read') ||
        !filter || Object.keys(filter).some(key => !FILTER_KEYS.includes(key)) ||
        !['external', 'test', 'probe', 'internal'].includes(String(filter.origin)) || filter.timeBasis !== 'startedAt' ||
        !Number.isFinite(Date.parse(String(filter.from))) || !Number.isFinite(Date.parse(String(filter.to))) ||
        Date.parse(String(filter.from)) >= Date.parse(String(filter.to)) ||
        (filter.serverType !== undefined && !['gateway', 'mcp'].includes(String(filter.serverType)))) return null;
      return contentHash(canonicalJson({ scope: 'server_state_v1', sequence, principalId: authorization.principalId,
        fingerprint: authorization.fingerprint, permissions: [...authorization.requiredPermissions].sort(),
        authorizedAssets: authorization.runtimeAssetIds === null ? null : [...authorization.runtimeAssetIds].sort(), filter }));
    } catch { return null; }
  }

  private prune(): void {
    for (const [token, grant] of this.grants) if (grant.expiresAt <= Date.now()) this.grants.delete(token);
  }

  /** Only after the status read transaction commits; no directory or legacy-state watermark is granted. */
  issue(sequence: string, authorization: ObservabilityAuthorization, filter: ObservabilityFilter, assetIds: readonly string[]) {
    const binding = this.binding(sequence, authorization, filter);
    const selected = [...new Set(assetIds)].sort();
    if (!binding || selected.some(id => !id || (authorization.runtimeAssetIds !== null && !authorization.runtimeAssetIds.includes(id)) ||
      (filter.runtimeAssetId !== undefined && id !== filter.runtimeAssetId))) throw new ObservabilityApiError('INVALID_QUERY', 'serverStateSnapshot');
    this.prune();
    while (this.grants.size >= MAX_SERVER_STATE_SNAPSHOT_GRANTS) this.grants.delete(this.grants.keys().next().value!);
    const token = randomBytes(32).toString('base64url'), expiresAt = Date.now() + SERVER_STATE_SNAPSHOT_TTL_MS;
    this.grants.set(token, { binding, expiresAt, assetIds: Object.freeze(selected) });
    return { scope: 'server_state_v1' as const, token, sequence, expiresAt: new Date(expiresAt).toISOString(),
      assetIds: [...selected], filter: { ...filter },
      evidenceScopes: ['managed_server_process_lifecycle', 'retained_business_in_flight'],
      excludedDomains: ['legacy_reported_state', 'runtime_asset_directory', 'management_heartbeat', 'global_multi_instance_state', 'unsequenced_lifecycle_history'],
      isPartial: true as const, historyComplete: false as const };
  }

  authorize(token: string, sequence: string, authorization: ObservabilityAuthorization, filter: ObservabilityFilter,
    assetIds: readonly string[]): boolean {
    if (typeof token !== 'string' || !Array.isArray(assetIds) || assetIds.some(id => typeof id !== 'string')) return false;
    this.prune();
    const grant = this.grants.get(token), binding = this.binding(sequence, authorization, filter);
    return !!grant && binding !== null && grant.binding === binding &&
      canonicalJson(grant.assetIds) === canonicalJson([...new Set(assetIds)].sort());
  }
}
