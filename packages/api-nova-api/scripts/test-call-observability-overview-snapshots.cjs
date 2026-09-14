'use strict';
require('reflect-metadata');
require('ts-node').register({ project: require('node:path').join(__dirname, '../tsconfig.json'), transpileOnly: true });
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CallObservabilityOverviewSnapshotAuthorizer: Authorizer, OVERVIEW_SNAPSHOT_TTL_MS: TTL,
  MAX_OVERVIEW_SNAPSHOT_GRANTS: CAP } = require('../src/modules/call-observability/call-observability-overview-snapshot-authorizer.service.ts');
const scope = { principalId: 'reader', fingerprint: 'scope-v1', runtimeAssetIds: ['a'],
  requiredPermissions: ['monitoring:read'] };
const filter = { origin: 'external', serverType: 'mcp', runtimeAssetId: 'a' };
test('knowing a sequence is insufficient; grants bind principal, fingerprint, asset scope and permissions', async () => {
  const authorizer = new Authorizer();
  assert.equal(await authorizer.authorize('7', scope, filter), false);
  authorizer.issue('7', scope, filter);
  assert.equal(await authorizer.authorize('7', scope, filter), true);
  assert.equal(await authorizer.authorize('8', scope, filter), false);
  for (const changed of [{ principalId: 'other' }, { fingerprint: 'scope-v2' },
    { runtimeAssetIds: null }, { runtimeAssetIds: [] }, { runtimeAssetIds: ['b'] },
    { requiredPermissions: ['monitoring:read', 'monitoring:source:read'] }]) {
    assert.equal(await authorizer.authorize('7', { ...scope, ...changed }, filter), false);
  }
});
test('bound event dimensions match exactly, require origin and allow only known extra narrowing predicates', async () => {
  const authorizer = new Authorizer();
  authorizer.issue('7', scope, { ...filter, from: 'window-from', to: 'window-to', timeBasis: 'startedAt' });
  for (const key of ['origin', 'serverType', 'runtimeAssetId']) {
    const removed = { ...filter }; delete removed[key];
    assert.equal(await authorizer.authorize('7', scope, removed), false);
  }
  for (const changed of [{ origin: 'probe' }, { serverType: 'gateway' }, { runtimeAssetId: 'b' },
    { origin: ['external'] }, { arbitrary: 'value' }]) {
    assert.equal(await authorizer.authorize('7', scope, { ...filter, ...changed }), false);
  }
  assert.equal(await authorizer.authorize('7', scope, { ...filter, eventTypes: 'invocation.completed' }), true);
  assert.equal(await authorizer.authorize('7', scope, { ...filter, outcomes: 'error', toolName: 'tool' }), true);
});
test('TTL expires at its exact boundary and authorization does not extend it', async t => {
  const original = Date.now;
  let now = 1000000; Date.now = () => now;
  t.after(() => { Date.now = original; });
  const authorizer = new Authorizer();
  assert.equal(authorizer.issue('7', scope, filter), new Date(now + TTL).toISOString());
  now += TTL - 1;
  assert.equal(await authorizer.authorize('7', scope, filter), true);
  now++;
  assert.equal(await authorizer.authorize('7', scope, filter), false);
  authorizer.issue('7', scope, filter);
  assert.equal(await authorizer.authorize('7', scope, filter), true);
});
test('capacity evicts oldest issuance and reissuing refreshes issuance order', async () => {
  const authorizer = new Authorizer();
  for (let i = 0; i < CAP; i++) authorizer.issue(String(i), scope, filter);
  authorizer.issue('0', scope, filter);
  authorizer.issue(String(CAP), scope, filter);
  assert.equal(await authorizer.authorize('0', scope, filter), true);
  assert.equal(await authorizer.authorize('1', scope, filter), false);
  assert.equal(await authorizer.authorize(String(CAP), scope, filter), true);
});
test('restart has no grant memory and renewed grants do not authorize broader event filters', async () => {
  const original = new Authorizer();
  original.issue('7', scope, filter);
  assert.equal(await new Authorizer().authorize('7', scope, filter), false);
  assert.equal(await original.authorize('7', scope, { origin: 'external' }), false);
});
test('malformed and noncanonical sequence strings cannot alias registered grants', async () => {
  const authorizer = new Authorizer();
  authorizer.issue('7', scope, filter);
  for (const sequence of ['07', '-1', '7.0', '7e0', '', '123456789012345678901']) {
    assert.equal(await authorizer.authorize(sequence, scope, filter), false);
  }
});