'use strict';
require('reflect-metadata');
require('ts-node').register({ project: require('node:path').join(__dirname, '../tsconfig.json'), transpileOnly: true });
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { normalizeRuntimeAuditRecord } = require('../../api-nova-parser/src/audit/runtime-observability-contract.ts');
const { calculateObservabilityMetrics: calculate } = require('../src/modules/call-observability/call-observability-metrics.ts');
const { CallObservabilityStatisticsService } = require('../src/modules/call-observability/call-observability-statistics.service.ts');
const { ObservabilityStatisticsMetricsDto } = require('../src/modules/call-observability/call-observability-statistics.dto.ts');
const window = { from: '2026-09-09T00:00:00.000Z', to: '2026-09-09T00:02:00.000Z', scope: 'business', origin: 'external', timeBasis: 'startedAt' };
function observation(cacheHit, overrides = {}, revision = 1) {
  const raw = { schemaVersion: 2, sourceInstanceId: 'cache-test',
    sourceSequence: 1, eventId: randomUUID(), invocationId: randomUUID(), recordVersion: 1,
    requestId: 'cache-test', phase: 'finished', serverType: 'gateway', spanKind: 'gateway_request',
    origin: 'external', startedAt: '2026-09-09T00:00:01.000Z', completedAt: '2026-09-09T00:00:02.000Z',
    outcome: 'success', ...overrides };
  if (cacheHit !== undefined) raw.cacheHit = cacheHit;
  if (overrides.transport !== undefined) raw.protocolTransport = overrides.transport;
  return { invocation: normalizeRuntimeAuditRecord(raw), revision };
}
const metrics = (rows, options = {}) => calculate(rows, { ...window, ...options }).metrics;
function expectCache(value, hits, misses, unknown) {
  assert.equal(value.cacheHits, hits);
  assert.equal(value.cacheMisses, misses);
  assert.equal(value.cacheUnknownRecords, unknown);
  assert.equal(value.cacheEligibleRecords, hits + misses + unknown);
  assert.equal(value.cacheObservedRecords, hits + misses);
  assert.equal(value.cacheHitRate, hits + misses ? hits / (hits + misses) : null);
  assert.equal(value.cacheCoveragePartial, unknown > 0);
}
test('true/false/missing have distinct counts and denominators; no evidence yields null', () => {
  expectCache(metrics([true, true, false, undefined].map(value => observation(value))), 2, 1, 1);
  expectCache(metrics([observation(false)]), 0, 1, 0);
  expectCache(metrics([observation(true)]), 1, 0, 0);
  expectCache(metrics([]), 0, 0, 0);
  expectCache(metrics([observation(undefined)]), 0, 0, 1);
});
test('invalid values and missingFields evidence never become hits or misses', () => {
  const rows = [null, undefined, 0, 1, '', 'false', 'true', {}, []].map(value => observation(value));
  rows.push(observation(false, { missingFields: ['cacheHit'] }), observation(true, { missingFields: ['cacheHit'] }));
  expectCache(metrics(rows), 0, 0, 11);
});
test('non-Gateway spans are excluded even with boolean cache metadata', () => {
  const rows = ['mcp_tool', 'mcp_protocol', 'upstream_api'].flatMap(spanKind =>
    [true, false, undefined].map(value => observation(value, { spanKind, serverType: 'mcp', transport: 'http' })));
  for (const scope of ['business', 'http_ingress', 'tool', 'protocol', 'upstream']) {
    expectCache(metrics(rows, { scope }), 0, 0, 0);
  }
  rows.push(observation(true), observation(undefined));
  expectCache(metrics(rows), 1, 0, 1);
  expectCache(metrics(rows, { scope: 'http_ingress' }), 1, 0, 1);
});
test('latest database revision replaces cache evidence before filtering', () => {
  const older = observation(false), invocationId = older.invocation.invocationId;
  const newer = observation(true, { invocationId }, 2);
  expectCache(metrics([newer, older, newer]), 1, 0, 0);
  expectCache(metrics([older, newer, observation(undefined, { invocationId }, 3)]), 0, 0, 1);
  for (const overrides of [{ origin: 'internal' }, { spanKind: 'upstream_api' }, { startedAt: window.to }]) {
    expectCache(metrics([older, observation(true, { invocationId, ...overrides }, 2)]), 0, 0, 0);
  }
});
test('half-open start/completion windows and origin filtering apply to cache evidence', () => {
  const rows = [observation(true, { startedAt: window.from }), observation(false, { startedAt: window.to }),
    observation(false, { origin: 'probe' }), observation(undefined, { completedAt: window.to })];
  expectCache(metrics(rows), 1, 0, 1);
  expectCache(metrics(rows, { timeBasis: 'completedAt' }), 1, 1, 0);
  expectCache(metrics(rows, { origin: 'probe' }), 0, 1, 0);
});
test('cache evidence is independent of success and lifecycle state; input is unchanged', () => {
  const rows = [observation(true, { outcome: 'error' }), observation(false, { outcome: 'rejected' }),
    observation(undefined, { phase: 'started', completedAt: null }),
    observation(undefined, { completionSource: 'reconciled', outcome: 'unknown' })];
  const before = JSON.stringify(rows);
  expectCache(metrics(rows), 1, 1, 2);
  assert.equal(JSON.stringify(rows), before);
});
test('summary, time-series, synthetic zero buckets and groups share the cache contract', () => {
  const service = new CallObservabilityStatisticsService({});
  const rows = [observation(true), observation(false), observation(undefined),
    observation(false, { spanKind: 'mcp_tool', serverType: 'mcp' })].map(({ invocation, revision }) => ({
      record: invocation, recordVersion: revision, startedAt: invocation.startedAt,
      completedAt: invocation.completedAt, serverType: invocation.serverType }));
  const common = service.aggregate(rows, window);
  expectCache(common.metrics, 1, 1, 1);
  const series = service.makeTimeSeries(rows, { ...window, interval: '1m', fill: 'zero' }, common, '1');
  assert.equal(series.items.length, 2);
  expectCache(series.items[0].metrics, 1, 1, 1);
  assert.equal(series.items[1].synthetic, true);
  expectCache(series.items[1].metrics, 0, 0, 0);
  const groups = service.makeGroups(rows, window, ['serverType'], common);
  expectCache(groups.items.find(item => item.dimensionValues.serverType === 'gateway').metrics, 1, 1, 1);
  expectCache(groups.items.find(item => item.dimensionValues.serverType === 'mcp').metrics, 0, 0, 0);
});
test('Swagger documents each cache field, nullable rate and coverage limitations', () => {
  for (const name of Object.keys(metrics([])).filter(key => key.startsWith('cache'))) {
    const property = Reflect.getMetadata('swagger/apiModelProperties', ObservabilityStatisticsMetricsDto.prototype, name);
    assert.ok(property?.description, name);
  }
  const rate = Reflect.getMetadata('swagger/apiModelProperties', ObservabilityStatisticsMetricsDto.prototype, 'cacheHitRate');
  assert.equal(rate.nullable, true);
  assert.equal(rate.minimum, 0);
  assert.equal(rate.maximum, 1);
});
test('real normalization preserves required booleans and all generated missing-field evidence', () => {
  const row = observation(undefined, { parentInvocationId: 'unknown-parent' });
  assert.equal(row.invocation.cacheHit, false);
  for (const field of ['cacheHit', 'traceId', 'runtimeAssetId', 'requestBytes', 'responseBytes']) {
    assert.ok(row.invocation.missingFields.includes(field), field);
  }
  expectCache(metrics([row]), 0, 0, 1);
  for (const cacheHit of [true, false]) {
    const known = observation(cacheHit);
    assert.equal(known.invocation.cacheHit, cacheHit);
    assert.equal(known.invocation.missingFields.includes('cacheHit'), false);
  }
});
test('legacy cache_hit outcomes remain observed hits through normalization and aggregation', () => {
  for (const value of [undefined, null, false, true]) {
    const row = observation(value, { outcome: 'cache_hit' });
    assert.equal(row.invocation.cacheHit, true);
    assert.equal(row.invocation.outcome, 'success');
    assert.equal(row.invocation.missingFields.includes('cacheHit'), false);
    expectCache(metrics([row]), 1, 0, 0);
  }
});