'use strict';
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const root = process.env.OBS_EVENTS_SOURCE === '1' ? '../src/' : '../dist/src/';
if (process.env.OBS_EVENTS_SOURCE === '1') require('ts-node').register({ transpileOnly: true,
  compilerOptions: { module: 'commonjs', experimentalDecorators: true, emitDecoratorMetadata: true } });
const entities = require(root + 'database/entities/runtime-call-observability.entity');
const { RuntimeObservabilityEventEntity: Event } = require(root + 'database/entities/runtime-observability-event.entity');
const { CallObservabilityStore } = require(root + 'modules/call-observability/call-observability.store');
const { CallObservabilityEventsDispatcher: Dispatcher, EVENTS_DISPATCH_CHECKPOINT: checkpointId } = require(root + 'modules/call-observability/call-observability-events.dispatcher');
const { sequenceKey } = require(root + 'modules/call-observability/call-observability-storage');
const { RuntimeEventSubscriptionEntity: Subscription, RuntimeSubscriptionRevisionEntity: Revision,
  RuntimeEventDeliveryEntity: Delivery, RuntimePipelineStateEntity: State } = entities;
async function fixture(t) {
  const db = await new DataSource({ type: 'sqljs', entities: [...entities.CALL_OBSERVABILITY_ENTITIES, Event], synchronize: true }).initialize();
  t.after(() => db.destroy());
  const store = new CallObservabilityStore(db, {});
  const auth = { resolve: async ownerId => ({ principalId: ownerId, runtimeAssetIds: ['a'], requiredPermissions: ['monitoring:read'] }) };
  const dispatcher = new Dispatcher(store, auth);
  async function subscription(config = {}, extra = {}) {
    const id = randomUUID(), now = new Date().toISOString();
    await db.getRepository(Subscription).insert({ id, ownerId: 'owner', name: 'test', version: 1, state: 'active',
      destination: 'https://example.invalid/events', secretRef: 'secret-ref', filter: {}, scope: {},
      effectiveFromSequence: sequenceKey('0'), createdAt: now, updatedAt: now, ...extra });
    await db.getRepository(Revision).insert({ id: randomUUID(), subscriptionId: id, version: 1,
      effectiveFromSequence: sequenceKey('0'), effectiveUntilSequence: null,
      config: { enabled: true, scope: { mode: 'assets', runtimeAssetIds: ['a'] }, filter: {}, ...config }, revoked: false, createdAt: now });
    return id;
  }
  async function event(extra = {}) {
    return store.transaction(async tx => {
      const id = randomUUID();
      await tx.manager.getRepository(Event).insert({ id, sequence: tx.nextSequence(), runtimeAssetId: 'a',
        eventName: 'invocation.completed', eventFamily: 'runtime.request', dispatchState: 'pending',
        occurredAt: new Date(tx.now), expiresAt: new Date(Date.now() + 86400000),
        dimensions: { serverType: 'gateway' }, details: { outcome: 'success' }, ...extra });
      return id;
    });
  }
  return { db, store, auth, dispatcher, subscription, event };
}
test('atomic bounded scan resumes across instances; replay and parallel invocations do not duplicate', async t => {
  const f = await fixture(t); await f.subscription(); await f.event(); await f.event();
  const first = await f.dispatcher.dispatchBatch(1);
  assert.equal(first.created, 1); assert.equal(first.hasMore, true);
  await new Dispatcher(f.store, f.auth).dispatchBatch();
  assert.equal(await f.db.getRepository(Delivery).count(), 2);
  await f.db.getRepository(State).delete(checkpointId);
  await Promise.all([f.dispatcher.dispatchBatch(), new Dispatcher(f.store, f.auth).dispatchBatch()]);
  assert.equal(await f.db.getRepository(Delivery).count(), 2);
});
test('suppressed, expired and unauthorized events are scanned without delivery', async t => {
  const f = await fixture(t); await f.subscription();
  await f.event({ dispatchState: 'suppressed' }); await f.event({ expiresAt: new Date(0) });
  await f.event({ runtimeAssetId: 'b' }); await f.event({ runtimeAssetId: null });
  const result = await f.dispatcher.dispatchBatch();
  assert.equal(result.created, 0); assert.equal(result.skipped, 2); assert.equal(result.checkpoint, '4');
  assert.equal((await f.db.getRepository(Event).findOneBy({ dispatchState: 'suppressed' })).dispatchState, 'suppressed');
});
test('pause revisions, revocation and active configuration windows select the original revision', async t => {
  const f = await fixture(t), id = await f.subscription();
  await f.db.getRepository(Revision).update({ subscriptionId: id }, { effectiveUntilSequence: sequenceKey('1') });
  const base = { subscriptionId: id, revoked: false, createdAt: new Date().toISOString() };
  await f.db.getRepository(Revision).insert({ ...base, id: randomUUID(), version: 2,
    effectiveFromSequence: sequenceKey('1'), effectiveUntilSequence: sequenceKey('2'),
    config: { enabled: false, scope: { mode: 'all' }, filter: {} } });
  await f.db.getRepository(Revision).insert({ ...base, id: randomUUID(), version: 3,
    effectiveFromSequence: sequenceKey('2'), effectiveUntilSequence: null,
    config: { enabled: true, scope: { mode: 'all' }, filter: {} } });
  await f.event(); await f.event(); await f.event();
  await f.dispatcher.dispatchBatch();
  const deliveries = await f.db.getRepository(Delivery).find({ order: { eventSequence: 'ASC' } });
  assert.deepEqual(deliveries.map(item => item.subscriptionRevision), [1, 3]);
  await f.db.getRepository(Revision).update({ subscriptionId: id, version: 3 }, { revoked: true });
  await f.event(); assert.equal((await f.dispatcher.dispatchBatch()).created, 0);
});
test('current pause/deletion and current permission revocation deny dispatch', async t => {
  const f = await fixture(t); await f.subscription({}, { state: 'paused' });
  await f.subscription({}, { deletedAt: new Date().toISOString() }); await f.subscription();
  f.auth.resolve = async () => null; await f.event();
  assert.equal((await f.dispatcher.dispatchBatch()).created, 0);
});
test('configuration failure rolls back earlier deliveries, event states and checkpoint', async t => {
  const f = await fixture(t); await f.subscription(); await f.event(); await f.event({ dispatchState: 'invalid' });
  await assert.rejects(f.dispatcher.dispatchBatch(), error => error.code === 'UNSUPPORTED_EVENT_DISPATCH_STATE');
  assert.equal(await f.db.getRepository(Delivery).count(), 0);
  assert.equal(await f.db.getRepository(State).findOneBy({ id: checkpointId }), null);
  assert.equal(await f.db.getRepository(Event).countBy({ dispatchState: 'pending' }), 1);
});
test('filter fields combine AND, values OR; inapplicable fields never match', async t => {
  const f = await fixture(t); await f.subscription({ filter: { eventTypes: ['invocation.completed', 'server.snapshot'], outcomes: ['success'] } });
  await f.event(); await f.event({ eventName: 'server.snapshot', details: {} });
  await f.event({ details: { outcome: 'error' } });
  assert.equal((await f.dispatcher.dispatchBatch()).created, 1);
});
test('missing authorizer and malformed immutable configuration fail closed without checkpoint', async t => {
  const f = await fixture(t); await f.subscription({ filter: { unknownField: ['a'] } }); await f.event();
  await assert.rejects(new Dispatcher(f.store).dispatchBatch(), error => error.code === 'AUTHORIZER_UNAVAILABLE');
  await assert.rejects(f.dispatcher.dispatchBatch(), error => error.code === 'INVALID_SUBSCRIPTION_REVISION_CONFIG');
  assert.equal(await f.db.getRepository(State).findOneBy({ id: checkpointId }), null);
});
test('creation boundary excludes historical events and immutable scope cannot exceed current owner scope', async t => {
  const f = await fixture(t), id = await f.subscription({ scope: { mode: 'assets', runtimeAssetIds: ['b'] } });
  await f.event();
  assert.equal((await f.dispatcher.dispatchBatch()).created, 0);
  await f.db.getRepository(Revision).update({ subscriptionId: id }, {
    effectiveFromSequence: sequenceKey('2'), config: { enabled: true, scope: { mode: 'all' }, filter: {} },
  });
  await f.event(); await f.event();
  const result = await f.dispatcher.dispatchBatch();
  assert.equal(result.created, 1);
  assert.equal((await f.db.getRepository(Delivery).findOneBy({ subscriptionId: id })).eventSequence, sequenceKey('3'));
});
test('overlapping revision intervals roll back without choosing an arbitrary destination revision', async t => {
  const f = await fixture(t), id = await f.subscription();
  await f.db.getRepository(Revision).insert({ id: randomUUID(), subscriptionId: id, version: 2,
    effectiveFromSequence: sequenceKey('0'), effectiveUntilSequence: null, revoked: false,
    createdAt: new Date().toISOString(), config: { enabled: true, scope: { mode: 'all' }, filter: {} } });
  await f.event();
  await assert.rejects(f.dispatcher.dispatchBatch(), error => error.code === 'OVERLAPPING_SUBSCRIPTION_REVISIONS');
  assert.equal(await f.db.getRepository(Delivery).count(), 0);
  assert.equal(await f.db.getRepository(State).findOneBy({ id: checkpointId }), null);
});
