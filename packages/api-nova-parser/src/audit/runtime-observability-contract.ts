export const OBSERVABILITY_SCHEMA_VERSION = 2 as const;
export const INVOCATION_KINDS = ['gateway_request', 'mcp_protocol', 'mcp_tool', 'upstream_api'] as const;
export const INVOCATION_OUTCOMES = ['success', 'error', 'rejected', 'timeout', 'cancelled', 'incomplete', 'unknown'] as const;
export const OBSERVABILITY_ORIGINS = ['external', 'test', 'probe', 'internal'] as const;
export const OBSERVABILITY_EVENT_TYPES = ['invocation.completed', 'invocation.reconciled',
  'caller.discovered', 'server.state_changed', 'server.snapshot', 'metrics.bucket_updated',
  'pipeline.state_changed'] as const;
export type InvocationKind = typeof INVOCATION_KINDS[number];
export type InvocationOutcome = typeof INVOCATION_OUTCOMES[number];
export type ObservabilityOrigin = typeof OBSERVABILITY_ORIGINS[number];
export type AuditRecordPhase = 'started' | 'progress' | 'finished';
export type ByteMeasurement = 'observed_body' | 'serialized_payload' | 'unavailable';
export type ObservabilityScope = 'business' | 'http_ingress' | 'tool' | 'protocol' | 'upstream';

export interface InvocationBody {
  state: 'captured' | 'omitted' | 'incomplete' | 'expired' | 'unavailable';
  reason: string | null;
  contentType: string;
  encoding: 'utf8' | 'base64';
  observedBytes: number | null;
  capturedBytes: number;
  storedBytes: number;
  data?: string;
  capturedDigest?: string;
  digestScope: 'observed_raw' | 'partial' | 'unavailable';
  redacted: boolean;
  redactionPolicyVersion: string;
}

/** Normalized source evidence. Database sequence is assigned only on commit. */
export interface CanonicalInvocation {
  schemaVersion: 2;
  invocationId: string;
  sourceEventId: string;
  sourceInstanceId: string;
  sourceSequence: number | null;
  phase: AuditRecordPhase;
  recordVersion: number;
  spanKind: InvocationKind;
  serverType: 'gateway' | 'mcp';
  transport: string;
  origin: ObservabilityOrigin;
  traceId: string | null;
  rootInvocationId: string | null;
  parentInvocationId: string | null;
  requestId: string;
  clientRequestId: string | null;
  correlationId: string | null;
  runtimeAssetId: string | null;
  serverId: string | null;
  runtimeAssetEndpointBindingId: string | null;
  endpointDefinitionId: string | null;
  sourceServiceInstanceId: string | null;
  sourceServiceAssetId: string | null;
  operationId: string | null;
  toolName: string | null;
  callerId: string | null;
  credentialId: string | null;
  identitySource: string;
  authState: 'authenticated' | 'anonymous' | 'authentication_failed' | 'unknown';
  clientIp: string | null;
  peerIp: string | null;
  ipSource: string;
  proxyTrusted: boolean;
  sessionIdHash: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  outcome: InvocationOutcome | null;
  httpStatus: number | null;
  protocolErrorCode: number | null;
  toolIsError: boolean | null;
  errorCategory: string | null;
  errorCode: string | null;
  failureStage: string | null;
  method: string | null;
  path: string | null;
  url: string | null;
  upstreamOperationId: string | null;
  attemptIndex: number | null;
  redirectHopIndex: number | null;
  requestHeaders: Record<string, unknown>;
  responseHeaders: Record<string, unknown>;
  request: InvocationBody;
  response: InvocationBody;
  byteMeasurement: ByteMeasurement;
  measurementStage: string;
  completionSource: 'observed' | 'reconciled';
  cacheHit: boolean;
  missingFields: string[];
}

export class InvalidRuntimeAuditRecord extends Error {
  constructor(public readonly field: string) {
    super('Invalid runtime audit field: ' + field);
    this.name = 'InvalidRuntimeAuditRecord';
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidRuntimeAuditRecord('record');
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 240): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}
function requiredText(row: Record<string, unknown>, key: string): string {
  const value = text(row[key]);
  if (!value) throw new InvalidRuntimeAuditRecord(key);
  return value;
}
function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function integer(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}
function timestamp(value: unknown, field: string, required = false): string | null {
  if (value === undefined || value === null) {
    if (required) throw new InvalidRuntimeAuditRecord(field);
    return null;
  }
  if (typeof value !== 'string' || !/T.*(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value))) throw new InvalidRuntimeAuditRecord(field);
  return new Date(value).toISOString();
}

export function normalizeInvocationBody(value: unknown, policyVersion = 'default-v1'): InvocationBody {
  const empty: InvocationBody = { state: 'unavailable', reason: 'not_captured',
    contentType: '', encoding: 'utf8', observedBytes: null, capturedBytes: 0,
    storedBytes: 0, digestScope: 'unavailable', redacted: false, redactionPolicyVersion: policyVersion };
  if (value === undefined || value === null) return empty;
  const body = object(value);
  const states: Record<string, InvocationBody['state']> = { complete: 'captured',
    empty: 'captured', captured: 'captured', omitted: 'omitted', incomplete: 'incomplete',
    unavailable: 'unavailable', expired: 'expired' };
  const state = typeof body.state === 'string' ? states[body.state] : undefined;
  if (!state) throw new InvalidRuntimeAuditRecord('body.state');
  const reason = text(body.reason, 200);
  const notRead = state === 'unavailable' || /not_read|not_consumed/.test(reason || '');
  const observedBytes = notRead ? null : integer(body.totalBytes ?? body.observedBytes);
  const encoding = body.encoding === 'base64' ? 'base64' : 'utf8';
  // Omitted bodies never retain even a fragment accidentally supplied by a producer.
  const data = state === 'captured' || state === 'incomplete'
    ? (typeof body.data === 'string' ? body.data : undefined) : undefined;
  return { state, reason, contentType: text(body.contentType, 500) || '', encoding,
    observedBytes, capturedBytes: data === undefined ? 0 : integer(body.capturedBytes) || 0,
    storedBytes: data === undefined ? 0 : Buffer.byteLength(data, 'utf8'), data,
    capturedDigest: text(body.sha256 ?? body.capturedDigest, 128) || undefined,
    digestScope: observedBytes === null ? 'unavailable' : state === 'incomplete' ? 'partial' : 'observed_raw',
    redacted: body.redacted === true, redactionPolicyVersion: policyVersion };
}

export function classifyInvocationError(code?: string | null): string | null {
  if (!code) return null;
  const value = code.toLowerCase();
  if (/timeout|timedout/.test(value)) return 'timeout';
  if (/enotfound|eai_again|dns/.test(value)) return 'dns';
  if (/tls|cert_|certificate|ssl/.test(value)) return 'tls';
  if (/econn|enet|ehost|socket/.test(value)) return 'connection';
  if (/cancel|aborted/.test(value)) return 'cancelled';
  if (/parse|invalid_json/.test(value)) return 'response_parse';
  if (/unauthor|forbidden|auth|scope/.test(value)) return 'authorization';
  return 'other';
}

function normalizeOutcome(row: Record<string, unknown>, phase: AuditRecordPhase): InvocationOutcome | null {
  if (phase !== 'finished') return null;
  if (row.completionSource === 'reconciled') return 'unknown';
  if (row.toolIsError === true || row.protocolErrorCode !== undefined && row.protocolErrorCode !== null) return 'error';
  if (row.outcome === 'cancelled') return 'cancelled';
  if (row.outcome === 'incomplete' || row.outcome === 'unknown') return row.outcome;
  const category = classifyInvocationError(text(row.errorCode));
  if (row.outcome === 'timeout' || category === 'timeout') return 'timeout';
  const status = integer(row.statusCode ?? row.httpStatus);
  if (row.outcome === 'rejected' || status !== null && [401, 403, 429].includes(status) && row.kind !== 'api' && row.spanKind !== 'upstream_api') return 'rejected';
  if (row.outcome === 'error' || status !== null && status >= 400) return 'error';
  if (row.outcome === 'success' || row.outcome === 'cache_hit') return 'success';
  return 'unknown';
}

/** Current development format only. Old audit files are not imported into this dataset. */
export function normalizeRuntimeAuditRecord(input: unknown,
  source: { sourceInstanceId?: string } = {}): CanonicalInvocation {
  const row = object(input);
  if (row.schemaVersion !== OBSERVABILITY_SCHEMA_VERSION) throw new InvalidRuntimeAuditRecord('schemaVersion');
  const invocationId = requiredText(row, 'invocationId');
  const serverType = row.serverType ?? row.transport;
  if (serverType !== 'gateway' && serverType !== 'mcp') throw new InvalidRuntimeAuditRecord('serverType');
  const phase = row.phase;
  if (phase !== 'started' && phase !== 'progress' && phase !== 'finished') throw new InvalidRuntimeAuditRecord('phase');
  const spanKind = row.spanKind;
  if (!(INVOCATION_KINDS as readonly unknown[]).includes(spanKind)) throw new InvalidRuntimeAuditRecord('spanKind');
  const origin = row.origin ?? 'external';
  if (!(OBSERVABILITY_ORIGINS as readonly unknown[]).includes(origin)) throw new InvalidRuntimeAuditRecord('origin');
  const sourceInstanceId = text(source.sourceInstanceId) || text(row.sourceInstanceId) || requiredText(row, 'processId');
  const sourceEventId = requiredText(row, 'eventId');
  const startedAt = timestamp(row.startedAt, 'startedAt', true)!;
  const completedAt = timestamp(row.completedAt, 'completedAt', phase === 'finished');
  const parentInvocationId = text(row.parentInvocationId);
  const traceId = text(row.traceId) || (parentInvocationId ? null : invocationId);
  const authenticated = row.identitySource === 'authenticated' && text(row.callerId) !== null;
  const missingFields: string[] = [];
  if (!traceId) missingFields.push('traceId');
  if (!row.runtimeAssetId) missingFields.push('runtimeAssetId');
  const byteMeasurement = row.byteMeasurement ?? 'unavailable';
  if (!['observed_body', 'serialized_payload', 'unavailable'].includes(byteMeasurement as string)) {
    throw new InvalidRuntimeAuditRecord('byteMeasurement');
  }
  const sourceSequence = integer(row.sourceSequence ?? row.sequence);
  if (sourceSequence === null || sourceSequence < 1) throw new InvalidRuntimeAuditRecord('sourceSequence');
  const recordVersion = integer(row.recordVersion);
  if (recordVersion === null || recordVersion < 1) throw new InvalidRuntimeAuditRecord('recordVersion');
  const status = integer(row.statusCode ?? row.httpStatus);
  if (status !== null && (status < 100 || status > 599)) throw new InvalidRuntimeAuditRecord('httpStatus');
  const policy = text(row.redactionPolicyVersion) || 'default-v1';
  const request = normalizeInvocationBody(row.request, policy);
  const response = normalizeInvocationBody(row.response, policy);
  if (request.observedBytes === null) missingFields.push('requestBytes');
  if (response.observedBytes === null) missingFields.push('responseBytes');
  return { schemaVersion: row.schemaVersion, invocationId, sourceEventId, sourceInstanceId,
    sourceSequence, phase, recordVersion, spanKind: spanKind as InvocationKind,
    serverType, transport: text(row.protocolTransport) || 'unknown',
    origin: origin as ObservabilityOrigin, traceId,
    rootInvocationId: text(row.rootInvocationId) || (!parentInvocationId ? invocationId : null),
    parentInvocationId, requestId: requiredText(row, 'requestId'),
    clientRequestId: text(row.clientRequestId), correlationId: text(row.correlationId),
    runtimeAssetId: text(row.runtimeAssetId), serverId: text(row.serverId),
    runtimeAssetEndpointBindingId: text(row.runtimeAssetEndpointBindingId),
    endpointDefinitionId: text(row.endpointDefinitionId), sourceServiceInstanceId: text(row.sourceServiceInstanceId),
    sourceServiceAssetId: text(row.sourceServiceAssetId), operationId: text(row.operationId),
    toolName: text(row.toolName), callerId: authenticated ? text(row.callerId) : null,
    credentialId: authenticated ? text(row.credentialId) : null,
    identitySource: authenticated ? 'authenticated' : text(row.identitySource) || 'anonymous',
    authState: authenticated ? 'authenticated' : row.authState === 'authentication_failed'
      ? 'authentication_failed' : row.identitySource === 'anonymous' ? 'anonymous' : 'unknown',
    clientIp: text(row.clientIp, 64), peerIp: text(row.peerIp, 64),
    ipSource: text(row.ipSource) || 'unknown',
    proxyTrusted: row.proxyTrusted === true, sessionIdHash: text(row.sessionIdHash),
    startedAt, completedAt, durationMs: number(row.durationMs),
    outcome: normalizeOutcome(row, phase), httpStatus: status,
    protocolErrorCode: typeof row.protocolErrorCode === 'number' && Number.isSafeInteger(row.protocolErrorCode)
      ? row.protocolErrorCode : null, toolIsError: typeof row.toolIsError === 'boolean' ? row.toolIsError : null,
    errorCategory: text(row.errorCategory) || classifyInvocationError(text(row.errorCode)),
    errorCode: text(row.errorCode), failureStage: text(row.failureStage),
    method: text(row.method, 32), path: text(row.path, 4096), url: text(row.url, 8192),
    upstreamOperationId: text(row.upstreamOperationId), attemptIndex: integer(row.attemptIndex),
    redirectHopIndex: integer(row.redirectHopIndex),
    requestHeaders: row.requestHeaders ? object(row.requestHeaders) : {},
    responseHeaders: row.responseHeaders ? object(row.responseHeaders) : {}, request, response,
    byteMeasurement: byteMeasurement as ByteMeasurement, measurementStage: text(row.measurementStage) || 'unknown',
    completionSource: row.completionSource === 'reconciled' ? 'reconciled' : 'observed',
    cacheHit: row.cacheHit === true || row.outcome === 'cache_hit', missingFields };
}

export function invocationMatchesScope(row: CanonicalInvocation, scope: ObservabilityScope): boolean {
  switch (scope) {
    case 'business': return row.spanKind === 'gateway_request' || row.spanKind === 'mcp_tool';
    case 'upstream': return row.spanKind === 'upstream_api';
    case 'tool': return row.spanKind === 'mcp_tool';
    case 'protocol': return row.spanKind === 'mcp_protocol';
    case 'http_ingress': return row.spanKind === 'gateway_request' ||
      row.spanKind === 'mcp_protocol' && ['http', 'sse', 'streamable', 'streamable-http'].includes(row.transport);
  }
}

/** Reference counting contract, also usable for bounded detail-window aggregations. */
export function summarizeInvocations(records: CanonicalInvocation[], scope: ObservabilityScope,
  origin: ObservabilityOrigin = 'external') {
  const latest = new Map<string, CanonicalInvocation>();
  for (const row of records) {
    const current = latest.get(row.invocationId);
    if (!current || row.recordVersion > current.recordVersion) latest.set(row.invocationId, row);
  }
  const rows = [...latest.values()].filter(row => row.origin === origin && invocationMatchesScope(row, scope));
  const outcomes: Record<InvocationOutcome, number> = { success: 0, error: 0, rejected: 0,
    timeout: 0, cancelled: 0, incomplete: 0, unknown: 0 };
  const callers = new Set<string>();
  const retries = new Set<string>();
  let inFlight = 0;
  const byteGroups = new Map<string, { byteMeasurement: ByteMeasurement; measurementStage: string; requestBytes: bigint; responseBytes: bigint }>();
  let measuredRecords = 0;
  let unmeasuredRecords = 0;
  let partialRecords = 0;
  for (const row of rows) {
    if (row.callerId && row.authState === 'authenticated') callers.add(row.callerId);
    if (row.phase !== 'finished') inFlight++;
    else outcomes[row.outcome || 'unknown']++;
    if (row.upstreamOperationId && row.attemptIndex !== null && row.attemptIndex > 1) {
      retries.add(row.upstreamOperationId + ':' + row.attemptIndex);
    }
    if (row.byteMeasurement === 'unavailable' || row.request.observedBytes === null || row.response.observedBytes === null) {
      unmeasuredRecords++;
    } else {
      measuredRecords++;
    }
    if (row.byteMeasurement !== 'unavailable') {
      const key = row.byteMeasurement + ':' + row.measurementStage;
      const group = byteGroups.get(key) || { byteMeasurement: row.byteMeasurement,
        measurementStage: row.measurementStage, requestBytes: 0n, responseBytes: 0n };
      group.requestBytes += BigInt(row.request.observedBytes || 0);
      group.responseBytes += BigInt(row.response.observedBytes || 0);
      byteGroups.set(key, group);
    }
    if (row.request.state === 'incomplete' || row.response.state === 'incomplete') partialRecords++;
  }
  const knownCompleted = outcomes.success + outcomes.error + outcomes.rejected + outcomes.timeout +
    outcomes.cancelled + outcomes.incomplete;
  const failures = outcomes.error + outcomes.timeout + outcomes.incomplete;
  const safe = (value: bigint): number | string => value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  const byteTotals = [...byteGroups.values()].map(group => ({ ...group,
    requestBytes: safe(group.requestBytes), responseBytes: safe(group.responseBytes) }));
  return { totalStarted: rows.length, knownCompleted, outcomes, inFlight, uniqueCallers: callers.size,
    failures, retryAttempts: retries.size, byteTotals,
    requestBytes: byteTotals.length === 1 ? byteTotals[0].requestBytes : null,
    responseBytes: byteTotals.length === 1 ? byteTotals[0].responseBytes : null,
    measuredRecords, unmeasuredRecords, partialRecords,
    successRate: knownCompleted ? outcomes.success / knownCompleted : null,
    errorRate: outcomes.success + failures ? failures / (outcomes.success + failures) : null };
}
