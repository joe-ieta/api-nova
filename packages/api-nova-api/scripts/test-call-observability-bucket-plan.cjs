'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const filename = path.join(__dirname, '../src/modules/call-observability/call-observability-bucket-plan.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
const subject = new Module(filename, module);
subject.filename = filename;
subject.paths = Module._nodeModulePaths(path.dirname(filename));
subject._compile(compiled, filename);
const { planBucketRevision: plan, BucketPlanError, PERSISTENT_BUCKET_INTERVALS,
  BUCKET_KEY_SCHEMA_VERSION, MAX_BUCKET_INVALIDATIONS_PER_REVISION } = subject.exports;

const revision = (recordVersion = 1, fields = {}) => ({ recordVersion, record: {
  invocationId: 'call-a', runtimeAssetId: 'asset-a', origin: 'external', spanKind: 'gateway_request', transport: 'http',
  startedAt: '2026-09-11T00:00:01.000Z', completedAt: '2026-09-11T00:00:04.000Z', ...fields,
} });
const keys = value => value.invalidations.map(item => item.bucket);
const ids = value => keys(value).map(key => key.bucketId);
const withBasis = (value, basis) => value.invalidations.filter(item => item.bucket.timeBasis === basis);
const safeError = code => error => error instanceof BucketPlanError && error.code === code && error.message === code;

test('initial completed Gateway revision plans sixteen isolated bucket memberships', () => {
  const value = plan(null, revision());
  assert.equal(value.status, 'apply');
  assert.equal(value.expectedRecordVersion, null);
  assert.equal(value.incomingRecordVersion, '1');
  assert.equal(value.invalidations.length, 16);
  assert.equal(value.invalidations.every(item => item.membershipChange === 'added' && item.action === 'recompute'), true);
  assert.equal(keys(value).every(key => key.keySchemaVersion === BUCKET_KEY_SCHEMA_VERSION), true);
});

test('unfinished calls plan start buckets without fabricated completion buckets', () => {
  const value = plan(null, revision(1, { completedAt: null }));
  assert.equal(value.invalidations.length, 8);
  assert.equal(keys(value).every(key => key.timeBasis === 'startedAt'), true);
});

test('scope membership separates business, protocol, tools and upstream requests', () => {
  for (const [spanKind, transport, expected] of [
    ['gateway_request', 'http', ['business', 'http_ingress']],
    ['mcp_tool', 'stdio', ['business', 'tool']],
    ['mcp_protocol', 'stdio', ['protocol']],
    ['mcp_protocol', 'http', ['http_ingress', 'protocol']],
    ['upstream_api', 'http', ['upstream']],
  ]) {
    const value = plan(null, revision(1, { spanKind, transport }));
    assert.deepEqual([...new Set(keys(value).map(key => key.scope))].sort(), expected);
    assert.equal(value.invalidations.length, expected.length * 8);
  }
});

test('only explicit HTTP protocol transports add physical ingress scope', () => {
  for (const transport of ['http', 'sse', 'streamable', 'streamable-http']) {
    assert.equal(plan(null, revision(1, { spanKind: 'mcp_protocol', transport })).invalidations.length, 16);
  }
  for (const transport of ['stdio', 'HTTP', 'websocket', null]) {
    assert.equal(plan(null, revision(1, { spanKind: 'mcp_protocol', transport })).invalidations.length, 8);
  }
});

test('origin partitions never share persistent bucket identities', () => {
  const sets = ['external', 'test', 'probe', 'internal'].map(origin => ids(plan(null, revision(1, { origin }))));
  assert.equal(new Set(sets.flat()).size, 64);
});

test('unassigned assets do not collide with literal null, wildcard or other opaque IDs', () => {
  const sets = [null, 'null', '*', 'asset-a', 'asset,a', 'asset|a'].map(runtimeAssetId =>
    ids(plan(null, revision(1, { runtimeAssetId }))));
  assert.equal(new Set(sets.flat()).size, 96);
  assert.deepEqual(ids(plan(null, revision(1, { runtimeAssetId: undefined }))), sets[0]);
});

test('interval and time basis are explicit even when their aligned starts coincide', () => {
  const value = plan(null, revision(1, {
    startedAt: '2026-09-11T00:00:00.000Z', completedAt: '2026-09-11T00:00:00.000Z',
  }));
  assert.equal(new Set(ids(value)).size, 16);
  assert.equal(new Set(keys(value).map(key => key.bucketStart)).size, 1);
  assert.equal(new Set(keys(value).map(key => key.timeBasis)).size, 2);
});

test('every interval uses UTC floor alignment and an exact exclusive end', () => {
  const value = plan(null, revision(1, { startedAt: '2026-09-11T12:34:56.789Z' }));
  for (const key of keys(value)) {
    const width = PERSISTENT_BUCKET_INTERVALS[key.interval];
    const at = Date.parse(key.timeBasis === 'startedAt' ? '2026-09-11T12:34:56.789Z' : '2026-09-11T00:00:04.000Z');
    assert.equal(Date.parse(key.bucketStart), Math.floor(at / width) * width);
    assert.equal(Date.parse(key.bucketEnd) - Date.parse(key.bucketStart), width);
    assert.ok(Date.parse(key.bucketStart) <= at && at < Date.parse(key.bucketEnd));
  }
});

test('timestamps at a bucket boundary move to the next half-open bucket', () => {
  const value = plan(null, revision(1, { startedAt: '2026-09-11T00:01:00.000Z' }));
  for (const item of withBasis(value, 'startedAt').filter(item => item.bucket.interval === '1m')) {
    assert.equal(item.bucket.bucketStart, '2026-09-11T00:01:00.000Z');
    assert.equal(item.bucket.bucketEnd, '2026-09-11T00:02:00.000Z');
  }
});

test('same database revision produces no new invalidation', () => {
  const value = plan(revision(), revision('1'));
  assert.equal(value.status, 'duplicate');
  assert.equal(value.expectedRecordVersion, '1');
  assert.deepEqual(value.invalidations, []);
});

test('older database revisions are stale even when they would move bucket membership', () => {
  const value = plan(revision(3), revision(2, { runtimeAssetId: 'asset-b' }));
  assert.equal(value.status, 'stale');
  assert.equal(value.expectedRecordVersion, '3');
  assert.equal(value.incomingRecordVersion, '2');
  assert.deepEqual(value.invalidations, []);
});

test('uint64 database versions retain exact ordering and JSON-safe output', () => {
  const value = plan(revision('18446744073709551614'), revision('18446744073709551615'));
  assert.equal(value.status, 'apply');
  assert.equal(value.incomingRecordVersion, '18446744073709551615');
  assert.equal(JSON.parse(JSON.stringify(value)).expectedRecordVersion, '18446744073709551614');
  assert.equal(plan(revision('9007199254740993'), revision('9007199254740992')).status, 'stale');
});

test('unsafe, malformed, noncanonical and overflowing database versions fail closed', () => {
  for (const recordVersion of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '', '0', '01', '-1', '1e2',
    '18446744073709551616', {}, null, undefined]) {
    const value = revision();
    value.recordVersion = recordVersion;
    assert.throws(() => plan(null, value), safeError('INVALID_BUCKET_REVISION'));
  }
});

test('revisions from different invocations cannot be compared or merged', () => {
  assert.throws(() => plan(revision(2), revision(1, { invocationId: 'call-b' })), safeError('BUCKET_INVOCATION_MISMATCH'));
});

test('a newer revision dirties all shared buckets without treating it as another call', () => {
  const value = plan(revision(1), revision(2));
  assert.equal(value.status, 'apply');
  assert.equal(value.expectedRecordVersion, '1');
  assert.equal(value.invalidations.length, 16);
  assert.equal(value.invalidations.every(item => item.membershipChange === 'updated'), true);
});

test('late completion updates start buckets and adds completion buckets exactly once', () => {
  const value = plan(revision(1, { completedAt: null }), revision(2));
  assert.equal(value.invalidations.length, 16);
  assert.equal(withBasis(value, 'startedAt').every(item => item.membershipChange === 'updated'), true);
  assert.equal(withBasis(value, 'completedAt').every(item => item.membershipChange === 'added'), true);
  assert.equal(plan(revision(2), revision(2)).invalidations.length, 0);
});

test('a completion correction removes old membership and adds the newly touched minute', () => {
  const value = plan(revision(1), revision(2, { completedAt: '2026-09-11T00:01:04.000Z' }));
  assert.equal(value.invalidations.length, 18);
  assert.equal(value.invalidations.filter(item => item.membershipChange === 'removed').length, 2);
  assert.equal(value.invalidations.filter(item => item.membershipChange === 'added').length, 2);
  assert.equal(withBasis(value, 'startedAt').length, 8);
  assert.equal(withBasis(value, 'startedAt').every(item => item.membershipChange === 'updated'), true);
});

test('a start correction does not relocate the independently selected completion basis', () => {
  const value = plan(revision(1), revision(2, { startedAt: '2026-09-11T00:01:01.000Z' }));
  assert.equal(value.invalidations.length, 18);
  assert.equal(withBasis(value, 'completedAt').length, 8);
  assert.equal(withBasis(value, 'completedAt').every(item => item.membershipChange === 'updated'), true);
});

test('an asset move invalidates both isolated domains within the fixed thirty-two bucket bound', () => {
  const value = plan(revision(1), revision(2, { runtimeAssetId: 'asset-b' }));
  assert.equal(value.invalidations.length, MAX_BUCKET_INVALIDATIONS_PER_REVISION);
  assert.equal(value.invalidations.filter(item => item.membershipChange === 'removed').length, 16);
  assert.equal(value.invalidations.filter(item => item.membershipChange === 'added').length, 16);
  for (const item of value.invalidations) {
    assert.equal(item.bucket.runtimeAssetId, item.membershipChange === 'removed' ? 'asset-a' : 'asset-b');
  }
});

test('scope and origin corrections invalidate old and new domains rather than mixing totals', () => {
  const value = plan(revision(1), revision(2, { spanKind: 'mcp_tool', origin: 'internal' }));
  assert.equal(value.invalidations.length, 32);
  assert.equal(value.invalidations.filter(item => item.membershipChange === 'removed').every(item => item.bucket.origin === 'external'), true);
  assert.equal(value.invalidations.filter(item => item.membershipChange === 'added').every(item => item.bucket.origin === 'internal'), true);
});

test('removing a completion invalidates its old buckets without inventing a replacement completion', () => {
  const value = plan(revision(1), revision(2, { completedAt: null }));
  assert.equal(value.invalidations.length, 16);
  assert.equal(withBasis(value, 'completedAt').every(item => item.membershipChange === 'removed'), true);
  assert.equal(withBasis(value, 'startedAt').every(item => item.membershipChange === 'updated'), true);
});

test('outcome, byte and identity corrections still require recomputation when keys are unchanged', () => {
  const value = plan(revision(1, { outcome: 'unknown', requestBytes: null }),
    revision(2, { outcome: 'error', requestBytes: 100, callerId: 'corrected-caller' }));
  assert.equal(value.invalidations.length, 16);
  assert.equal(value.invalidations.every(item => item.action === 'recompute' && item.membershipChange === 'updated'), true);
  assert.equal(JSON.stringify(value).includes('corrected-caller'), false);
});

test('bucket IDs are deterministic, unique and returned in canonical order', () => {
  const value = plan(revision(1), revision(2, { runtimeAssetId: 'asset-b' }));
  const actual = ids(value);
  assert.equal(new Set(actual).size, actual.length);
  assert.deepEqual(actual, [...actual].sort());
  assert.equal(actual.every(id => /^bkt_[0-9a-f]{64}$/.test(id)), true);
  assert.deepEqual(plan(revision(1), revision(2, { runtimeAssetId: 'asset-b' })), value);
});

test('plans copy no headers, payloads, caller IDs, source IPs or storage references', () => {
  const value = plan(null, revision(1, { request: { password: 'private-marker' }, authorization: 'Bearer secret',
    callerId: 'private-caller', clientIp: '192.0.2.1', sourceId: 'private-source', payloadRef: 'private-file' }));
  assert.doesNotMatch(JSON.stringify(value), /private-marker|Bearer secret|private-caller|192\.0\.2\.1|private-source|private-file/);
});

test('planning leaves frozen evidence unchanged and contains no committed bucket version claim', () => {
  const before = revision(1);
  const next = revision(2);
  Object.freeze(before.record); Object.freeze(before);
  Object.freeze(next.record); Object.freeze(next);
  const original = JSON.stringify([before, next]);
  const value = plan(before, next);
  assert.equal(JSON.stringify([before, next]), original);
  assert.equal(JSON.stringify(value).includes('bucketVersion'), false);
  assert.equal(JSON.stringify(value).includes('dataWatermark'), false);
});

test('invalid metadata and timestamps yield safe errors without echoing input', () => {
  for (const fields of [
    { invocationId: '' }, { invocationId: 'private-marker\n' }, { invocationId: 'a'.repeat(257) },
    { runtimeAssetId: {} }, { origin: 'unknown' }, { spanKind: 'arbitrary' }, { transport: [] },
    { startedAt: '2026-02-30T00:00:00.000Z' }, { startedAt: '2026-09-11T00:00:00Z' },
    { startedAt: '2026-09-11T08:00:00.000+08:00' }, { completedAt: '' }, { completedAt: 0 },
  ]) assert.throws(() => plan(null, revision(1, fields)), safeError('INVALID_BUCKET_REVISION'));
  for (const value of [null, undefined, [], {}, { recordVersion: 1, record: [] }]) {
    assert.throws(() => plan(null, value), safeError('INVALID_BUCKET_REVISION'));
  }
});
