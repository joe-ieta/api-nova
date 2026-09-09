'use strict';
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { normalizeRuntimeAuditRecord, summarizeInvocations } = require('api-nova-parser');
const { calculateObservabilityMetrics: calculate, MAX_METRIC_OBSERVATIONS, METRIC_LATENCY_BOUNDS_MS } =
  require('../dist/src/modules/call-observability/call-observability-metrics.js');
const FROM = '2026-09-09T00:00:00.000Z', TO = '2026-09-09T00:01:00.000Z';
const window = { from: FROM, to: TO, scope: 'business' };
function observation(overrides = {}, extra = {}) {
  const raw = { schemaVersion: 2, sourceInstanceId: 'producer', sourceSequence: 1, eventId: randomUUID(),
    invocationId: randomUUID(), recordVersion: 1, requestId: 'private-request-id',
    phase: 'finished', serverType: 'gateway', spanKind: 'gateway_request', protocolTransport: 'http',
    origin: 'external', runtimeAssetId: 'asset-a', identitySource: 'authenticated',
    authState: 'authenticated', callerId: 'caller-a', credentialId: 'private-credential',
    startedAt: '2026-09-09T00:00:01.000Z', completedAt: '2026-09-09T00:00:01.010Z',
    durationMs: 10, outcome: 'success', statusCode: 200, byteMeasurement: 'observed_body',
    measurementStage: 'http_body', ...overrides };
  if (raw.phase !== 'finished') { delete raw.completedAt; delete raw.durationMs; }
  const reconciled = raw.completionSource === 'reconciled' && raw.completedAt === null;
  const invocation = normalizeRuntimeAuditRecord(reconciled
    ? { ...raw, phase: 'started', completedAt: undefined, durationMs: undefined, outcome: undefined, completionSource: undefined }
    : raw);
  if (reconciled) Object.assign(invocation, { phase: 'finished', outcome: 'unknown',
    completionSource: 'reconciled', completedAt: null, durationMs: null });
  for (const [side, size] of [['request', 10], ['response', 20]]) {
    invocation[side] = { ...invocation[side], state: 'captured', observedBytes: size,
      capturedBytes: size, storedBytes: size, data: 'private-payload', digestScope: 'observed_raw' };
  }
  return { revision: 1, invocation, ...extra };
}
const metrics = (rows, options = {}) => calculate(rows, { ...window, ...options }).metrics;

test('empty metrics preserve unknown coverage and null rates, bytes and durations', () => {
  const result = calculate([], window), value = result.metrics;
  assert.equal(value.selectedInvocations, 0); assert.equal(value.totalStarted, 0);
  assert.equal(value.knownCompleted, 0); assert.equal(value.successRate, null); assert.equal(value.errorRate, null);
  assert.equal(value.requestBytes, null); assert.equal(value.responseBytes, null);
  assert.equal(value.latency.sampleCount, 0); assert.equal(value.latency.sumMs, null);
  assert.equal(value.latency.p95, null); assert.equal(value.latency.meanMs, null);
  assert.deepEqual(result.coverage, { historyCompleteSince: null, isPartial: true, observationHealth: 'unknown' });
});

test('scope separates business, physical HTTP ingress, protocol, tool and upstream nodes', () => {
  const rows = [observation(), observation({ serverType: 'mcp', spanKind: 'mcp_protocol' }),
    observation({ serverType: 'mcp', spanKind: 'mcp_protocol', protocolTransport: 'stdio' }),
    observation({ serverType: 'mcp', spanKind: 'mcp_tool', protocolTransport: 'stdio', byteMeasurement: 'serialized_payload' }),
    observation({ spanKind: 'upstream_api' })];
  for (const [scope, count] of [['business', 2], ['http_ingress', 2], ['protocol', 2], ['tool', 1], ['upstream', 1]]) {
    assert.equal(metrics(rows, { scope }).selectedInvocations, count, scope);
  }
  assert.equal(metrics(rows).upstreamRequests, 0);
  assert.equal(metrics(rows, { scope: 'upstream' }).upstreamRequests, 1);
});

test('external default never includes test, probe or internal origins', () => {
  const rows = ['external', 'test', 'probe', 'internal'].map(origin => observation({ origin }));
  assert.equal(metrics(rows).selectedInvocations, 1);
  for (const origin of ['test', 'probe', 'internal']) assert.equal(metrics(rows, { origin }).selectedInvocations, 1);
});

test('completion outcomes and overlapping failure counters use the documented denominators', () => {
  const rows = ['success', 'error', 'rejected', 'timeout', 'cancelled', 'incomplete', 'unknown']
    .map(outcome => observation({ outcome }));
  rows.push(observation({ phase: 'started' }));
  const value = metrics(rows);
  assert.equal(value.selectedInvocations, 8); assert.equal(value.knownCompleted, 6);
  assert.equal(value.successes, 1); assert.equal(value.failures, 3);
  assert.equal(value.rejections, 1); assert.equal(value.timeouts, 1);
  assert.equal(value.cancelled, 1); assert.equal(value.incomplete, 1); assert.equal(value.unknown, 1);
  assert.equal(value.successRate, 1 / 6); assert.equal(value.errorRate, 3 / 4);
  assert.equal(value.unknownInFlight, 1);
});

test('unfinished nodes require explicit current live evidence and reconciled unknown is not a running success', () => {
  const rows = [observation({ phase: 'started' }, { producerState: 'live' }),
    observation({ phase: 'progress' }, { producerState: 'lost' }), observation({ phase: 'started' }),
    observation({ completionSource: 'reconciled', completedAt: null })];
  const value = metrics(rows);
  assert.equal(value.inFlight, 1); assert.equal(value.unknownInFlight, 2);
  assert.equal(value.unknown, 1); assert.equal(value.knownCompleted, 0);
  assert.equal(value.latency.sampleCount, 0); assert.equal(value.latency.excludedRecords, 4);
});

test('deduplication uses the database revision and never sums lifecycle phases or late correction twice', () => {
  const first = observation({ phase: 'started', recordVersion: 99 }, { revision: 1 });
  const id = first.invocation.invocationId;
  const inferred = observation({ invocationId: id, completionSource: 'reconciled', completedAt: null }, { revision: 2 });
  const actual = observation({ invocationId: id, outcome: 'success', recordVersion: 1 }, { revision: 3 });
  const result = metrics([actual, first, inferred, actual]);
  assert.equal(result.selectedInvocations, 1); assert.equal(result.successes, 1);
  assert.equal(result.unknown, 0); assert.equal(result.unknownInFlight, 0); assert.equal(result.requestBytes, 10);
  assert.deepEqual(result, metrics([first, inferred, actual]));
});

test('latest revision selection precedes scope, origin and time filtering', () => {
  const older = observation();
  const newer = observation({ invocationId: older.invocation.invocationId, origin: 'internal',
    spanKind: 'upstream_api', startedAt: '2026-09-09T00:02:00.000Z',
    completedAt: '2026-09-09T00:02:00.010Z' }, { revision: 2 });
  assert.equal(metrics([older, newer]).selectedInvocations, 0);
  const changed = metrics([older, newer], { origin: 'internal', scope: 'upstream',
    from: '2026-09-09T00:02:00.000Z', to: '2026-09-09T00:03:00.000Z' });
  assert.equal(changed.selectedInvocations, 1);
});

test('half-open start and completion windows do not fabricate start totals from completion selections', () => {
  const rows = [
    observation({ startedAt: FROM, completedAt: '2026-09-09T00:00:00.010Z' }),
    observation({ startedAt: TO, completedAt: '2026-09-09T00:01:00.010Z' }),
    observation({ startedAt: '2026-09-08T23:59:59.000Z', completedAt: '2026-09-09T00:00:30.000Z' }),
    observation({ completedAt: TO }), observation({ phase: 'started' }),
  ];
  assert.equal(metrics(rows).selectedInvocations, 3);
  const completed = metrics(rows, { timeBasis: 'completedAt' });
  assert.equal(completed.selectedInvocations, 2); assert.equal(completed.knownCompleted, 2);
  assert.equal(completed.totalStarted, null); assert.equal(completed.unknownInFlight, 0);
});

test('caller unions remain distinct across servers and reject untrusted caller fields', () => {
  const rows = [observation(), observation({ runtimeAssetId: 'asset-b' }),
    observation({ callerId: 'caller-b' }), observation({ identitySource: 'anonymous', authState: 'anonymous' })];
  rows[3].invocation.callerId = 'forged-caller';
  const value = metrics(rows);
  assert.equal(value.uniqueCallers, 2); assert.equal(value.unidentifiedCallerRecords, 1);
  assert.equal(value.selectedInvocations, 4);
});

test('anonymous sources are registered source unions, not IP-based people or overflow buckets', () => {
  const anon = { identitySource: 'anonymous', authState: 'anonymous' };
  const rows = [observation(anon, { sourceId: 'source-a' }), observation(anon, { sourceId: 'source-a' }),
    observation({ identitySource: 'unknown', authState: 'authentication_failed' }, { sourceId: 'source-b' }),
    observation(anon), observation(anon, { sourceId: 'overflow', sourceOverflow: true }),
    observation(anon, { sourceId: 'overflow', sourceOverflow: true }), observation({}, { sourceId: 'authenticated-source' })];
  const value = metrics(rows);
  assert.equal(value.anonymousSources, 2); assert.equal(value.anonymousSourceOverflowRecords, 2);
  assert.equal(value.unidentifiedSourceRecords, 1); assert.equal(value.anonymousSourceCoveragePartial, true);
  assert.equal(value.uniqueCallers, 1);
});

test('retry attempts deduplicate redirects and never count non-upstream metadata as physical attempts', () => {
  const up = { spanKind: 'upstream_api', upstreamOperationId: 'operation', attemptIndex: 2 };
  const rows = [observation({ ...up, attemptIndex: 1, redirectHopIndex: 0 }),
    observation({ ...up, redirectHopIndex: 0 }), observation({ ...up, redirectHopIndex: 1 }),
    observation({ ...up, upstreamOperationId: null, attemptIndex: 3 }),
    observation({ upstreamOperationId: 'not-upstream', attemptIndex: 2 })];
  const value = metrics(rows, { scope: 'upstream' });
  assert.equal(value.upstreamRequests, 4); assert.equal(value.retryAttempts, 1);
  assert.equal(value.unlinkedRetryRecords, 1); assert.equal(metrics(rows).retryAttempts, 0);
});

test('one-sided missing bytes remain null while observed empty bytes are actual zeros', () => {
  const missing = observation();
  missing.invocation.request.observedBytes = null;
  const value = metrics([missing]);
  assert.equal(value.requestBytes, null); assert.equal(value.responseBytes, 20);
  assert.equal(value.measuredRecords, 0); assert.equal(value.unmeasuredRecords, 1);
  assert.equal(value.byteGroups[0].request.unmeasuredRecords, 1);
  assert.equal(value.byteGroups[0].request.isLowerBound, true);
  const empty = observation(); empty.invocation.request.observedBytes = 0; empty.invocation.response.observedBytes = 0;
  assert.equal(metrics([empty]).requestBytes, 0); assert.equal(metrics([empty]).responseBytes, 0);
  assert.equal(metrics([empty]).measuredRecords, 1);
});

test('partial bodies and partial digests expose known lower bounds without double counting coverage', () => {
  const a = observation(), b = observation();
  a.invocation.request.state = 'incomplete'; a.invocation.request.observedBytes = 5;
  b.invocation.response.digestScope = 'partial';
  const value = metrics([a, b]);
  assert.equal(value.requestBytes, 15); assert.equal(value.responseBytes, 40);
  assert.equal(value.partialRecords, 2); assert.equal(value.measuredRecords, 2);
  assert.equal(value.byteGroups[0].request.partialRecords, 1);
  assert.equal(value.byteGroups[0].response.partialRecords, 1);
  assert.equal(value.byteGroups[0].request.isLowerBound, true);
  assert.equal(value.byteGroups[0].response.isLowerBound, true);
});

test('unavailable and invalid byte measurements cannot turn unobserved traffic into zero', () => {
  const rows = [observation({ byteMeasurement: 'unavailable' }), observation(), observation()];
  rows[1].invocation.request.observedBytes = -1;
  rows[2].invocation.request.observedBytes = Number.MAX_SAFE_INTEGER + 1;
  const unavailable = metrics([rows[0]]);
  assert.equal(unavailable.requestBytes, null); assert.equal(unavailable.responseBytes, null);
  const invalid = metrics(rows.slice(1));
  assert.equal(invalid.requestBytes, null); assert.equal(invalid.responseBytes, 40);
  assert.equal(invalid.unmeasuredRecords, 2);
});

test('span, measurement kind and measurement stage partition byte totals instead of mixing boundaries', () => {
  const g = observation(), tool = observation({ serverType: 'mcp', spanKind: 'mcp_tool',
    byteMeasurement: 'serialized_payload', measurementStage: 'mcp_payload' });
  const changedStage = observation({ measurementStage: 'decoded_body' });
  const value = metrics([g, tool, changedStage]);
  assert.equal(value.byteGroups.length, 3); assert.equal(value.requestBytes, null); assert.equal(value.responseBytes, null);
  assert.equal(value.measuredRecords, 3);
  assert.ok(value.byteGroups.every(group => group.request.observedBytes === 10));
});

test('byte accumulation preserves integers beyond Number.MAX_SAFE_INTEGER without serializing bigint', () => {
  const rows = [observation(), observation()];
  for (const row of rows) row.invocation.request.observedBytes = Number.MAX_SAFE_INTEGER;
  const value = metrics(rows);
  assert.equal(value.requestBytes, (2n * BigInt(Number.MAX_SAFE_INTEGER)).toString());
  assert.equal(value.responseBytes, 40);
  assert.doesNotThrow(() => JSON.stringify(value));
});

test('fixed histogram boundaries are inclusive only at the stated ends and retain exact bin counts', () => {
  const durations = [0, ...METRIC_LATENCY_BOUNDS_MS];
  const value = metrics(durations.map(durationMs => observation({ durationMs }))).latency;
  assert.equal(value.sampleCount, 15); assert.equal(value.histogram.length, 15);
  assert.equal(value.histogram[0].count, 2); assert.equal(value.histogram[0].lowerInclusive, true);
  assert.ok(value.histogram.slice(1, 14).every(bucket => bucket.count === 1 && !bucket.lowerInclusive));
  assert.equal(value.histogram[14].count, 0);
  assert.equal(value.p95.upperBoundMs, 60000); assert.equal(value.p95.estimateMs, 60000);
  const adjacent = metrics([observation({ durationMs: 1.0001 })]).latency;
  assert.equal(adjacent.histogram[0].count, 0); assert.equal(adjacent.histogram[1].count, 1);
});

test('overflow percentiles return an explicit open interval instead of a fake finite estimate', () => {
  const value = metrics([observation({ durationMs: 60001 })]).latency;
  assert.equal(value.algorithm, 'fixed_histogram_upper_bound_v1'); assert.equal(value.approximate, true);
  for (const p of [value.p50, value.p95, value.p99]) {
    assert.equal(p.lowerBoundMs, 60000); assert.equal(p.lowerInclusive, false);
    assert.equal(p.upperBoundMs, null); assert.equal(p.estimateMs, null); assert.equal(p.overflow, true);
  }
  assert.equal(value.maxMs, 60001); assert.equal(JSON.stringify(value).includes('Infinity'), false);
});

test('duration coverage excludes unfinished, unknown and reconciled nodes and distinguishes missing samples', () => {
  const rows = [null, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(value => {
    const row = observation(); row.invocation.durationMs = value; return row;
  });
  rows.push(observation({ phase: 'started' }), observation({ outcome: 'unknown' }),
    observation({ completionSource: 'reconciled', completedAt: null }));
  const value = metrics(rows).latency;
  assert.equal(value.sampleCount, 0); assert.equal(value.unmeasuredRecords, 5); assert.equal(value.excludedRecords, 3);
  assert.equal(value.p50, null); assert.equal(value.sumMs, null);
});

test('duration totals mark unsafe sums unavailable while preserving finite mean, maximum and overflow interval', () => {
  const rows = [observation({ durationMs: Number.MAX_SAFE_INTEGER }), observation({ durationMs: Number.MAX_SAFE_INTEGER })];
  const value = metrics(rows).latency;
  assert.equal(value.sumOverflow, true); assert.equal(value.sumMs, null);
  assert.equal(value.meanMs, Number.MAX_SAFE_INTEGER); assert.equal(value.maxMs, Number.MAX_SAFE_INTEGER);
  const small = metrics([1, 2, 3].map(durationMs => observation({ durationMs }))).latency;
  assert.equal(small.sumMs, 6); assert.equal(small.meanMs, 2); assert.equal(small.maxMs, 3);
  assert.equal(small.p50.estimateMs, 5); assert.equal(small.p50.lowerBoundMs, 1);
});

test('pure kernel requires an explicit bounded UTC window and rejects unsupported input shapes', () => {
  for (const raw of [{}, { from: FROM, to: TO }, { ...window, scope: 'all' },
    { ...window, from: TO, to: FROM }, { ...window, from: '2026-01-01T00:00:00.000Z' },
    { ...window, limit: '1' }, { ...window, scope: ['business'] }]) {
    assert.throws(() => calculate([], raw), error => error.code === 'INVALID_QUERY');
  }
  for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => calculate([observation({}, { revision })], window),
      error => error.code === 'OBSERVABILITY_UNAVAILABLE');
  }
});

test('exact observation budget is accepted and overflow fails explicitly rather than truncating', () => {
  const base = observation();
  const rows = Array.from({ length: MAX_METRIC_OBSERVATIONS }, (_, index) =>
    ({ ...base, invocation: { ...base.invocation, invocationId: 'budget-' + index } }));
  assert.equal(metrics(rows).selectedInvocations, MAX_METRIC_OBSERVATIONS);
  assert.throws(() => metrics([...rows, observation()]), error => error.code === 'QUERY_TOO_LARGE');
});

test('metric calculation neither mutates evidence nor discloses body, credential, source or caller identifiers', () => {
  const rows = [observation({}, { sourceId: 'private-source' })];
  rows[0].invocation.clientIp = '192.0.2.20';
  const before = JSON.stringify(rows), encoded = JSON.stringify(calculate(rows, window));
  assert.equal(JSON.stringify(rows), before);
  for (const secret of ['private-payload', 'private-credential', 'private-request-id', 'private-source',
    'caller-a', 'asset-a', '192.0.2.20', rows[0].invocation.invocationId]) {
    assert.equal(encoded.includes(secret), false, secret);
  }
});

test('small known samples retain the shared reference counting contract without reusing its missing-byte totals', () => {
  const rows = [observation(), observation({ outcome: 'error' }), observation({ outcome: 'rejected' }),
    observation({ outcome: 'timeout' }), observation({ phase: 'started' })];
  const expected = summarizeInvocations(rows.map(item => item.invocation), 'business');
  const value = metrics(rows);
  for (const key of ['totalStarted', 'knownCompleted', 'outcomes', 'uniqueCallers', 'failures', 'successRate', 'errorRate']) {
    assert.deepEqual(value[key], expected[key], key);
  }
  assert.equal(value.inFlight + value.unknownInFlight, expected.inFlight);
});
