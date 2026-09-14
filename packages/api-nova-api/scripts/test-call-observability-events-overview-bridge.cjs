'use strict';
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
require('ts-node').register({ project: require('node:path').join(__dirname, '../tsconfig.json'), transpileOnly: true });
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ConfigService } = require('@nestjs/config');
const base = '../src/modules/call-observability/';
const { CALL_OBSERVABILITY_ENTITIES } = require('../src/database/entities/runtime-call-observability.entity.ts');
const { RuntimeObservabilityEventEntity: Event } = require('../src/database/entities/runtime-observability-event.entity.ts');
const { CallObservabilityStore: Store } = require(base + 'call-observability.store.ts');
const { ObservabilityCursorService: Cursors } = require(base + 'call-observability-cursor.service.ts');
const { CallObservabilityEventsService: Events, EVENT_TYPES, MAX_EVENT_SCAN, EVENTS_SNAPSHOT_AUTHORIZER } =
  require(base + 'call-observability-events.service.ts');
const { CallObservabilityOverviewSnapshotAuthorizer: Grants } = require(base + 'call-observability-overview-snapshot-authorizer.service.ts');
const scope = { principalId: 'reader', runtimeAssetIds: ['a'], requiredPermissions: ['monitoring:read'],
  fingerprint: createHash('sha256').update('scope-a').digest('hex') };
const filter = { origin: 'external', runtimeAssetId: 'a', serverType: 'gateway' };
const error = code => value => value.code === code;
async function fixture(t) {
  const db = await new DataSource({ type: 'sqljs', entities: [...CALL_OBSERVABILITY_ENTITIES, Event], synchronize: true }).initialize();
  t.after(() => db.destroy());
  const store = new Store(db, {}), grants = new Grants();
  const cursors = new Cursors(new ConfigService({ API_NOVA_OBSERVABILITY_CURSOR_SECRET: randomUUID() + randomUUID() }));
  const events = new Events(store, cursors, grants);
  async function insert(specs = [{}]) {
    return store.transaction(async tx => {
      const rows = specs.map(spec => ({ id: randomUUID(), sequence: tx.nextSequence(), schemaVersion: '1.0',
        eventName: 'invocation.completed', eventFamily: 'runtime.request', runtimeAssetId: 'a', severity: 'info',
        status: 'success', actorType: 'runtime', retentionClass: 'standard', dispatchState: 'pending',
        subjectId: randomUUID(), subjectVersion: 1, occurredAt: new Date(tx.now), createdAt: new Date(tx.now),
        expiresAt: new Date(Date.now() + 600000), dimensions: { serverType: 'gateway' },
        details: { origin: 'external', spanKind: 'gateway_request', outcome: 'success' }, ...spec }));
      for (let i = 0; i < rows.length; i += 50) await tx.manager.getRepository(Event).insert(rows.slice(i, i + 50));
      return rows;
    });
  }
  return { db, store, events, grants, cursors, insert };
}
test('bridge rejects unknown grants, optional-provider absence, malformed starts and changed filters', async t => {
  const f = await fixture(t);
  assert.equal(typeof EVENTS_SNAPSHOT_AUTHORIZER, 'symbol');
  await assert.rejects(f.events.list({ ...filter, afterSequence: '0' }, scope), error('CURSOR_SCOPE_MISMATCH'));
  f.grants.issue('0', scope, filter);
  await assert.rejects(new Events(f.store, f.cursors).list({ ...filter, afterSequence: '0' }, scope), error('CURSOR_SCOPE_MISMATCH'));
  for (const value of ['-1', '00', '1.0', '18446744073709551616']) {
    await assert.rejects(f.events.list({ ...filter, afterSequence: value }, scope), error('INVALID_QUERY'));
  }
  await assert.rejects(f.events.list({ ...filter, afterSequence: '0', after: 'not-a-cursor' }, scope), error('INVALID_QUERY'));
  await assert.rejects(f.events.list({ ...filter, afterSequence: '0', origin: 'external,probe' }, scope), error('INVALID_QUERY'));
  await assert.rejects(f.events.list({ ...filter, afterSequence: '0', origin: 'probe' }, scope), error('CURSOR_SCOPE_MISMATCH'));
  const omitted = { ...filter, afterSequence: '0' }; delete omitted.origin;
  await assert.rejects(f.events.list(omitted, scope), error('CURSOR_SCOPE_MISMATCH'));
  await assert.rejects(f.events.list({ ...filter, afterSequence: '0' }, { ...scope, principalId: 'other' }), error('CURSOR_SCOPE_MISMATCH'));
  f.grants.issue('9', scope, filter);
  await assert.rejects(f.events.list({ ...filter, afterSequence: '9' }, scope), error('CURSOR_SCOPE_MISMATCH'));
});
test('remote event types remain available without origin; optional origin never classifies missing evidence as external', async t => {
  const f = await fixture(t);
  assert.deepEqual(EVENT_TYPES, ['invocation.completed', 'invocation.reconciled', 'caller.discovered',
    'server.state_changed', 'server.snapshot', 'metrics.bucket_updated', 'pipeline.state_changed']);
  await f.insert(EVENT_TYPES.map(eventName => ({ eventName })));
  await f.insert([{ details: { origin: 'probe' } }, { details: {} },
    { details: {}, dimensions: { serverType: 'gateway', origin: 'external' } }, { runtimeAssetId: 'hidden' }]);
  assert.equal((await f.events.list({}, scope)).data.items.length, 10);
  const data = (await f.events.list(filter, scope)).data;
  assert.equal(data.items.length, 8);
  assert.ok(data.items.some(item => item.eventType === 'server.snapshot'));
  assert.equal(data.items.find(item => item.eventType === 'metrics.bucket_updated').data.refreshRequired, true);
});
test('afterSequence preserves the 1000 scan bound and complete-cursor polling across fixed snapshots', async t => {
  const f = await fixture(t);
  assert.equal(MAX_EVENT_SCAN, 1000);
  f.grants.issue('0', scope, filter);
  await f.insert([...Array.from({ length: 1000 }, () => ({ details: { origin: 'probe' } })), {}]);
  const first = (await f.events.list({ ...filter, afterSequence: '0' }, scope)).data;
  assert.equal(first.items.length, 0); assert.equal(first.scannedEvents, 1000); assert.equal(first.hasMore, true);
  assert.equal(first.highWatermark, '1001');
  await f.insert();
  const second = (await f.events.list({ after: first.nextCursor }, scope)).data;
  assert.deepEqual(second.items.map(row => row.sequence), ['1001']);
  assert.equal(second.highWatermark, '1001'); assert.equal(second.hasMore, false);
  const third = (await f.events.list({ after: second.nextCursor }, scope)).data;
  assert.deepEqual(third.items.map(row => row.sequence), ['1002']);
  assert.equal(third.hasMore, false);
});
test('signed until and full cursor filter binding are retained with a snapshot start', async t => {
  const f = await fixture(t); f.grants.issue('0', scope, filter);
  await f.insert([{}, {}]);
  const first = (await f.events.list(filter, scope)).data;
  await f.insert();
  const bounded = (await f.events.list({ ...filter, afterSequence: '0', until: first.highWatermarkCursor }, scope)).data;
  assert.deepEqual(bounded.items.map(row => row.sequence), ['1', '2']);
  assert.equal(bounded.highWatermark, '2');
  await assert.rejects(f.events.list({ after: bounded.nextCursor, origin: 'probe' }, scope), error('CURSOR_SCOPE_MISMATCH'));
});
test('snapshot starts retain expired-event detection and remote resnapshot metadata', async t => {
  const f = await fixture(t); f.grants.issue('0', scope, filter);
  await f.insert([{ expiresAt: new Date(Date.now() - 1000) }, {}]);
  await assert.rejects(f.events.list({ ...filter, afterSequence: '0' }, scope), failure => {
    assert.equal(failure.code, 'EVENT_CURSOR_EXPIRED');
    assert.equal(failure.resourceMetadata.resnapshotRequired, true);
    assert.equal(failure.resourceMetadata.availableFrom, '2');
    return true;
  });
});
test('existing signed-after expiration handling remains intact', async t => {
  const f = await fixture(t); await f.insert();
  const initial = (await f.events.list(filter, scope)).data;
  await f.insert([{ expiresAt: new Date(Date.now() - 1000) }]);
  await assert.rejects(f.events.list({ after: initial.nextCursor }, scope), error('EVENT_CURSOR_EXPIRED'));
});
