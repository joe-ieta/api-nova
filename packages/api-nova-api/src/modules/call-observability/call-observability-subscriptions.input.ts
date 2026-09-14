import { ObservabilityApiError } from './call-observability-api.contract';

export interface ObservabilitySubscriptionInput {
  name: string;
  destination: string;
  secretRef: string;
  signingKeyId: string;
  enabled: boolean;
  scope: { mode: 'all' } | { mode: 'assets'; runtimeAssetIds: string[] };
  filter: Record<string, string[]>;
}
const FIELDS = ['name', 'destination', 'secretRef', 'signingKeyId', 'enabled', 'scope', 'filter'];
const FILTERS = ['runtimeAssetIds', 'serverTypes', 'eventTypes', 'severities', 'spanKinds', 'outcomes',
  'callerIds', 'endpointDefinitionIds', 'toolNames'];
const ENUMS: Record<string, readonly string[]> = {
  serverTypes: ['gateway', 'mcp'],
  eventTypes: ['invocation.completed', 'invocation.reconciled', 'caller.discovered', 'server.state_changed',
    'server.snapshot', 'metrics.bucket_updated', 'pipeline.state_changed'],
  severities: ['debug', 'info', 'warning', 'error', 'critical'],
  spanKinds: ['gateway_request', 'mcp_protocol', 'mcp_tool', 'upstream_api'],
};
function invalid(field = 'body'): never { throw new ObservabilityApiError('INVALID_QUERY', field); }
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(field);
  return value as Record<string, unknown>;
}
function token(value: unknown, field: string, ref = false): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 240 ||
      !(ref ? /^[A-Za-z0-9._:/-]+$/ : /^[A-Za-z0-9._:-]+$/).test(value)) invalid(field);
  return value;
}
function values(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) invalid(field);
  const items = value.map(item => {
    if (typeof item !== 'string' || !item.trim() || item.length > 240 || /[\u0000-\u001f\u007f]/.test(item)) invalid(field);
    return item;
  });
  if (new Set(items).size !== items.length) invalid(field);
  return items.sort();
}

/** Internal complete replacement input, not the public PATCH DTO.
 * Performs syntax validation only; current ownership/scope, destination allowlist and
 * secret authorization MUST be checked inside the management command policy.
 */
export function normalizeObservabilitySubscription(raw: unknown): ObservabilitySubscriptionInput {
  const input = object(raw, 'body');
  if (Object.keys(input).length !== FIELDS.length || Object.keys(input).some(key => !FIELDS.includes(key))) invalid();
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(input.name)) invalid('name');
  if (typeof input.enabled !== 'boolean') invalid('enabled');
  if (typeof input.destination !== 'string' || input.destination.length > 4096 ||
      !input.destination.startsWith('https://') || !/^[\x21-\x7e]+$/.test(input.destination) ||
      /[?#\\]/.test(input.destination)) invalid('destination');
  let destination: URL;
  try { destination = new URL(input.destination); } catch { return invalid('destination'); }
  if (destination.protocol !== 'https:' || destination.username || destination.password ||
      input.destination.slice(8).split('/')[0].includes('@')) invalid('destination');
  const scope = object(input.scope, 'scope');
  let normalizedScope: ObservabilitySubscriptionInput['scope'];
  if (scope.mode === 'all' && Object.keys(scope).length === 1) normalizedScope = { mode: 'all' };
  else if (scope.mode === 'assets' && Object.keys(scope).length === 2 && 'runtimeAssetIds' in scope) {
    const ids = values(scope.runtimeAssetIds, 'scope');
    ids.forEach(id => token(id, 'scope'));
    normalizedScope = { mode: 'assets', runtimeAssetIds: ids };
  } else return invalid('scope');
  const rawFilter = object(input.filter, 'filter');
  const filter: Record<string, string[]> = {};
  for (const key of Object.keys(rawFilter).sort()) {
    if (!FILTERS.includes(key)) invalid('filter');
    const items = values(rawFilter[key], 'filter');
    if (ENUMS[key] && items.some(item => !ENUMS[key].includes(item))) invalid('filter');
    if (key !== 'toolNames' && !ENUMS[key]) items.forEach(item => token(item, 'filter'));
    filter[key] = items;
  }
  if (normalizedScope.mode === 'assets' && filter.runtimeAssetIds?.some(id =>
      !(normalizedScope as { mode: 'assets'; runtimeAssetIds: string[] }).runtimeAssetIds.includes(id))) invalid('filter');
  return { name: input.name.trim(), destination: destination.href,
    secretRef: token(input.secretRef, 'secretRef', true), signingKeyId: token(input.signingKeyId, 'signingKeyId'),
    enabled: input.enabled, scope: normalizedScope, filter };
}