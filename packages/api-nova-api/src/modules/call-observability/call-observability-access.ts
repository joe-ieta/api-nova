import { User } from '../../database/entities/user.entity';
import { parseObservabilityRoleScope } from '../security/observability-scope';
import { canonicalJson, contentHash } from './call-observability-storage';
import { ObservabilityApiError } from './call-observability-api.contract';

export const OBSERVABILITY_PERMISSIONS = [
  'monitoring:read', 'monitoring:manage', 'monitoring:payload:read',
  'monitoring:source:read', 'monitoring:subscription:manage', 'monitoring:delivery:retry',
] as const;
export type ObservabilityPermission = typeof OBSERVABILITY_PERMISSIONS[number];

export interface ObservabilityAuthorization {
  readonly principalId: string;
  /** null means explicitly global; [] means no visible assets. */
  readonly runtimeAssetIds: readonly string[] | null;
  readonly requiredPermissions: readonly ObservabilityPermission[];
  readonly fingerprint: string;
}

type AssetSet = Set<string> | null;
function union(left: AssetSet, right: AssetSet): AssetSet {
  return left === null || right === null ? null : new Set([...left, ...right]);
}
function intersect(left: AssetSet, right: AssetSet): AssetSet {
  if (left === null) return right;
  if (right === null) return left;
  return new Set([...left].filter(id => right.has(id)));
}

/** Fresh database roles, never JWT permission arrays or user-editable profile fields. */
export function authorizeObservability(user: User, additional: readonly ObservabilityPermission[] = []): ObservabilityAuthorization {
  if (!user || typeof user.id !== 'string' || !user.id || !user.isActive || user.isLocked) {
    throw new ObservabilityApiError('UNAUTHENTICATED');
  }
  if (additional.some(permission => !OBSERVABILITY_PERMISSIONS.includes(permission))) {
    throw new ObservabilityApiError('FORBIDDEN');
  }
  const required = [...new Set<ObservabilityPermission>(['monitoring:read', ...additional])].sort();
  const roles = (user.roles || []).filter(role => role.enabled === true);
  const superAdmin = roles.some(role => role.type === 'system' && ['super_admin', 'SUPER_ADMIN'].includes(role.name));
  let effective: AssetSet = null;
  if (!superAdmin) {
    for (const name of required) {
      let granted = false;
      let assets: AssetSet = new Set();
      for (const role of roles) {
        const permission = role.permissions?.find(item => item.name === name && item.enabled === true);
        // Unsupported conditional grants must not silently become unconditional grants.
        if (!permission || (permission.conditions != null && (typeof permission.conditions !== 'object' ||
          Array.isArray(permission.conditions) || Object.keys(permission.conditions).length > 0))) continue;
        let scope;
        try { scope = parseObservabilityRoleScope(role.metadata?.observabilityScope); }
        catch { continue; }
        if (!scope) continue;
        granted = true;
        assets = union(assets, scope.mode === 'all' ? null : new Set(scope.runtimeAssetIds));
      }
      if (!granted) throw new ObservabilityApiError('FORBIDDEN');
      effective = intersect(effective, assets);
    }
  }
  const runtimeAssetIds = effective === null ? null : Object.freeze([...effective].sort());
  const fingerprint = contentHash(canonicalJson({ principalId: user.id, required, runtimeAssetIds }));
  return Object.freeze({
    principalId: user.id, runtimeAssetIds, requiredPermissions: Object.freeze(required), fingerprint,
  });
}

export function assertObservabilityAsset(scope: ObservabilityAuthorization, runtimeAssetId: string | null | undefined): void {
  if (scope.runtimeAssetIds !== null && (!runtimeAssetId || !scope.runtimeAssetIds.includes(runtimeAssetId))) {
    throw new ObservabilityApiError('NOT_FOUND');
  }
}

export function requireGlobalObservabilityScope(scope: ObservabilityAuthorization): void {
  if (scope.runtimeAssetIds !== null) throw new ObservabilityApiError('FORBIDDEN');
}

/** A list service must translate [] to FALSE, not omit its authorization predicate. */
export function intersectObservabilityAssets(scope: ObservabilityAuthorization, requested?: readonly string[]): readonly string[] | null {
  if (requested === undefined) return scope.runtimeAssetIds;
  return [...new Set(requested)].filter(id => scope.runtimeAssetIds === null || scope.runtimeAssetIds.includes(id)).sort();
}
