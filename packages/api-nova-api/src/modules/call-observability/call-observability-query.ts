import { ObservabilityApiError } from './call-observability-api.contract';
import { publicSequence } from './call-observability-storage';

type QueryValue = string | number | boolean | string[];
export type ObservabilityFilter = Record<string, QueryValue>;
const ENUMS: Record<string, readonly string[]> = {
  origin: ['external', 'test', 'probe', 'internal'],
  authState: ['authenticated', 'anonymous', 'authentication_failed', 'unknown'],
  serverType: ['gateway', 'mcp'],
  spanKind: ['gateway_request', 'mcp_protocol', 'mcp_tool', 'upstream_api'],
  outcome: ['success', 'error', 'rejected', 'timeout', 'cancelled', 'incomplete', 'unknown'],
  timeBasis: ['startedAt', 'completedAt'],
  scope: ['business', 'http_ingress', 'tool', 'protocol', 'upstream'],
  interval: ['1m', '5m', '1h', '1d'],
  fill: ['none', 'zero'],
  orderBy: ['selectedInvocations', 'failures', 'successes', 'uniqueCallers', 'upstreamRequests'],
};
const TEXT = [
  'runtimeAssetId', 'callerId', 'sourceId', 'endpointDefinitionId', 'toolName',
  'sourceServiceInstanceId', 'errorCategory', 'traceId', 'requestId',
];
const PAGING = ['cursor', 'after', 'afterSequence', 'limit', 'includeTotal'];
const KNOWN = [...Object.keys(ENUMS), ...TEXT, ...PAGING, 'from', 'to', 'groupBy', 'top'];
const DEFAULTS: Record<string, string> = {
  origin: 'external', timeBasis: 'startedAt', limit: '50', includeTotal: 'false', top: '20', fill: 'none', orderBy: 'selectedInvocations',
};

function invalid(field: string): never { throw new ObservabilityApiError('INVALID_QUERY', field); }
function utc(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return invalid(field);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return invalid(field);
  const normalized = new Date(ms).toISOString();
  if (normalized.slice(0,19) !== value.slice(0,19)) return invalid(field);
  return normalized;
}

/**
 * Each endpoint supplies its own allowlist. On resume, pass ONLY an authenticated
 * cursor's filter as previousFilter, then assert the normalized filter matches it.
 */
export function parseObservabilityQuery(
  raw: Record<string, unknown>,
  allowed: readonly string[],
  options: { previousFilter?: ObservabilityFilter; now?: number; maxRangeMs?: number } = {},
): { filter: ObservabilityFilter; page: { limit?: number; includeTotal?: boolean; cursor?: string; after?: string; afterSequence?: string } } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > 40 ||
    allowed.some(key => !KNOWN.includes(key))) invalid('query');
  const values: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(options.previousFilter || {})) {
    if (!allowed.includes(key) || PAGING.includes(key)) invalid('cursor');
    values[key] = Array.isArray(value) ? value.join(',') : String(value);
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.includes(key) || typeof value !== 'string' || !value || value.length > (['cursor','after'].includes(key) ? 8192 : 1000)) invalid(key);
    values[key] = value as string;
  }
  for (const [key,value] of Object.entries(DEFAULTS)) {
    if (allowed.includes(key) && values[key] === undefined) values[key] = value;
  }
  if ((raw.from === undefined) !== (raw.to === undefined)) invalid('from');
  if (allowed.includes('from') && allowed.includes('to') && values.from === undefined && values.to === undefined) {
    const now = options.now ?? Date.now();
    values.from = new Date(now - 3600000).toISOString();
    values.to = new Date(now).toISOString();
  }
  const parsed: Record<string, QueryValue> = Object.create(null);
  for (const [key,value] of Object.entries(values)) {
    if (ENUMS[key]) {
      if (!ENUMS[key].includes(value)) invalid(key);
      parsed[key] = value;
    } else if (TEXT.includes(key)) {
      if (value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) invalid(key);
      parsed[key] = value;
    } else if (key === 'from' || key === 'to') parsed[key] = utc(value, key);
    else if (key === 'limit' || key === 'top') {
      const max = key === 'limit' ? 200 : 100;
      if (!/^[1-9]\d{0,2}$/.test(value) || Number(value) > max) invalid(key);
      parsed[key] = Number(value);
    } else if (key === 'includeTotal') {
      if (!['true','false'].includes(value)) invalid(key);
      parsed[key] = value === 'true';
    } else if (key === 'groupBy') {
      const dimensions = value.split(',');
      if (dimensions.length > 2 || new Set(dimensions).size !== dimensions.length ||
        dimensions.some(item => !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(item))) invalid(key);
      parsed[key] = dimensions;
    } else if (key === 'afterSequence') {
      try {
        if (!/^(0|[1-9]\d{0,19})$/.test(value)) invalid(key);
        parsed[key] = publicSequence(value);
      } catch { invalid(key); }
    } else parsed[key] = value;
  }
  if ((parsed.from === undefined) !== (parsed.to === undefined)) invalid('from');
  if (parsed.from !== undefined) {
    const range = Date.parse(parsed.to as string) - Date.parse(parsed.from as string);
    if (range <= 0 || range > (options.maxRangeMs ?? 30 * 86400000)) invalid('from');
    if (parsed.interval) {
      const bucket = { '1m': 60000, '5m': 300000, '1h': 3600000, '1d': 86400000 }[parsed.interval as string];
      const count = Math.ceil(Date.parse(parsed.to as string) / bucket) - Math.floor(Date.parse(parsed.from as string) / bucket);
      if (count > 1440) throw new ObservabilityApiError('QUERY_TOO_LARGE', 'interval');
    }
  }
  if (['cursor','after','afterSequence'].filter(key => parsed[key] !== undefined).length > 1) invalid('cursor');
  const filter = Object.fromEntries(Object.entries(parsed).filter(([key]) => !PAGING.includes(key)));
  const page = Object.fromEntries(Object.entries(parsed).filter(([key]) => PAGING.includes(key)));
  return { filter, page };
}
