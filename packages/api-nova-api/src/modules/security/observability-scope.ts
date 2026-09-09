export type ObservabilityRoleScope =
  | { mode: 'all' }
  | { mode: 'assets'; runtimeAssetIds: string[] };

export const MAX_OBSERVABILITY_ASSETS = 1000;

/** Only role metadata managed by the security administration API is trusted. */
export function parseObservabilityRoleScope(value: unknown): ObservabilityRoleScope | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_OBSERVABILITY_SCOPE');
  const scope = value as Record<string, unknown>;
  if (scope.mode === 'all' && Object.keys(scope).length === 1) return { mode: 'all' };
  if (scope.mode !== 'assets' || Object.keys(scope).some(key => !['mode', 'runtimeAssetIds'].includes(key)) ||
    !Array.isArray(scope.runtimeAssetIds) || scope.runtimeAssetIds.length > MAX_OBSERVABILITY_ASSETS ||
    scope.runtimeAssetIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/.test(id))) {
    throw new Error('INVALID_OBSERVABILITY_SCOPE');
  }
  return { mode: 'assets', runtimeAssetIds: [...new Set(scope.runtimeAssetIds as string[])].sort() };
}

export function validateObservabilityRoleMetadata(metadata: unknown): void {
  if (metadata === undefined || metadata === null) return;
  if (typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('INVALID_OBSERVABILITY_SCOPE');
  parseObservabilityRoleScope((metadata as Record<string, unknown>).observabilityScope);
}
