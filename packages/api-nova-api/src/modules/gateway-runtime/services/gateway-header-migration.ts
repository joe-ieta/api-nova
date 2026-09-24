import { normalizeHeaderPolicyV1 } from 'api-nova-parser';

/** Persisted in GatewayRouteBinding.upstreamConfig and copied into verified snapshots. */
export type GatewayHeaderMigration =
  | { version: 1; mode: 'v1'; source: 'inline' | 'registry' }
  | { version: 1; mode: 'legacy'; routeId: string; owner: string; reason: string; issuedAt: string; expiresAt: string; rollbackEvidence: string };
const fail = (): never => { throw new Error('GATEWAY_HEADER_MIGRATION_INVALID'); };
export function normalizeGatewayHeaderMigration(raw: unknown, routeId: string, now = Date.now()): GatewayHeaderMigration {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return fail();
  const value = raw as Record<string, unknown>;
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !('value' in Object.getOwnPropertyDescriptor(value, key)!))) return fail();
  const allowed = value.mode === 'v1' ? ['version', 'mode', 'source'] : ['version', 'mode', 'routeId', 'owner', 'reason', 'issuedAt', 'expiresAt', 'rollbackEvidence'];
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key) || !('value' in Object.getOwnPropertyDescriptor(value, key)!)) || Object.keys(value).length !== allowed.length || value.version !== 1) return fail();
  if (value.mode === 'v1') {
    if (value.source !== 'inline' && value.source !== 'registry') return fail();
    return Object.freeze({ version: 1, mode: 'v1', source: value.source });
  }
  if (value.mode !== 'legacy' || value.routeId !== routeId) return fail();
  for (const key of ['routeId', 'owner', 'reason', 'rollbackEvidence']) if (typeof value[key] !== 'string' || !String(value[key]).trim() || String(value[key]).length > 1000) return fail();
  for (const key of ['issuedAt', 'expiresAt']) if (typeof value[key] !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(String(value[key])) || !Number.isFinite(Date.parse(String(value[key])))) return fail();
  for (const key of ['issuedAt', 'expiresAt']) if (new Date(String(value[key])).toISOString() !== String(value[key]).replace(/Z$/, String(value[key]).includes('.') ? 'Z' : '.000Z')) return fail();
  const issued = Date.parse(String(value.issuedAt)), expires = Date.parse(String(value.expiresAt));
  if (issued > now || expires <= now || expires <= issued || expires - issued > 30 * 86400000) return fail();
  return Object.freeze({ ...value } as GatewayHeaderMigration);
}

/** Only the new-binding creation path may call this; never normalize old records with it. */
export function newGatewayHeaderPolicyDraft(config?: Record<string, unknown>): Record<string, unknown> {
  if (config?.headerPolicy !== undefined || config?.headerPolicyMigration !== undefined) throw new Error('GATEWAY_HEADER_POLICY_NOT_READY');
  return { ...config, headerPolicy: { version: 1 }, headerPolicyMigration: { version: 1, mode: 'v1', source: 'inline' } };
}

/** Migration contract, not an activation switch. Existing NOT_READY gates remain authoritative. */
export function assertGatewayHeaderMigrationTransition(previous: Record<string, unknown> | undefined, next: Record<string, unknown> | undefined,
  context: { routeId: string; registryConfigured: boolean; now?: number }): void {
  const before = previous?.headerPolicyMigration === undefined ? undefined : normalizeGatewayHeaderMigration(previous.headerPolicyMigration, context.routeId, context.now);
  const after = next?.headerPolicyMigration === undefined ? undefined : normalizeGatewayHeaderMigration(next.headerPolicyMigration, context.routeId, context.now);
  if (previous?.headerPolicy !== undefined && next?.headerPolicy === undefined) return fail();
  if (before && !after) return fail();
  if (before?.mode === 'v1' && (after?.mode !== 'v1' || after.source !== before.source)) return fail();
  if (!after) return; // Historical records are not silently converted into v1.
  if (after.mode === 'legacy') { if (next?.headerPolicy !== undefined) return fail(); return; }
  if (after.source === 'registry') {
    if (!context.registryConfigured || next?.headerPolicy !== undefined) return fail();
  } else {
    if (context.registryConfigured || next?.headerPolicy === undefined) return fail();
    normalizeHeaderPolicyV1(next.headerPolicy);
  }
}
