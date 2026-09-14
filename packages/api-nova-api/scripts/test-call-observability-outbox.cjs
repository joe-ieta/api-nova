'use strict';
process.env.DB_TYPE = 'sqlite';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ConfigService } = require('@nestjs/config');
const entities = require('../dist/src/database/entities/runtime-call-observability.entity.js');
const { RuntimeObservabilityEventEntity: Event } = require('../dist/src/database/entities/runtime-observability-event.entity.js');
const { CallObservabilityStore } = require('../dist/src/modules/call-observability/call-observability.store.js');
const { CallObservabilityOutboxService, OUTBOX_WORKER_STATE_ID } =
  require('../dist/src/modules/call-observability/call-observability-outbox.service.js');
const { sequenceKey } = require('../dist/src/modules/call-observability/call-observability-storage.js');

async function fixture(t) {
  const database = new DataSource({ type: 'sqljs', entities: [...entities.CALL_OBSERVABILITY_ENTITIES, Event],
    synchronize: true, logging: false });
  await database.initialize();
  const store = new CallObservabilityStore(database, {});
  const workers = [];
  const makeWorker = settings => {
    const worker = new CallObservabilityOutboxService(store, new ConfigService(settings || {}));
    workers.push(worker);
    return worker;
  };
  const worker = makeWorker();
  t.after(async () => { for (const item of workers) await item.onModuleDestroy(); await database.destroy(); });
  async function event(overrides = {}) {
    return store.transaction(async tx => {
      const row = Object.assign(new Event(), { id: randomUUID(), sequence: tx.nextSequence(), schemaVersion: '1.0',
        subjectId: randomUUID(), subjectVersion: 1, eventName: 'invocation.completed', runtimeAssetId: 'asset-a',
        eventFamily: 'runtime.request', severity: 'info', status: 'success', actorType: 'runtime',
        retentionClass: 'standard', occurredAt: new Date(tx.now), createdAt: new Date(tx.now),
        expiresAt: new Date(Date.parse(tx.now) + 14 * 86400000), dispatchState: 'pending',
        dimensions: { serverType: 'gateway', callerId: 'caller-a' },
        details: { spanKind: 'gateway_request', outcome: 'success', toolName: 'tool-a' }, ...overrides });
      await tx.manager.getRepository(Event).insert(row);
      return row;
    });
  }
  async function subscription({ id = randomUUID(), version = 1, from = '0', until = null,
    revoked = false, state = 'enabled', filter = {}, scope = { mode: 'assets', runtimeAssetIds: ['asset-a'] } } = {}) {
    const repository = database.getRepository(entities.RuntimeSubscriptionRevisionEntity);
    const row = repository.create({ id: randomUUID(), subscriptionId: id, version,
      effectiveFromSequence: sequenceKey(from), effectiveUntilSequence: until === null ? null : sequenceKey(until),
      config: { state, filter, scope }, revoked, createdAt: new Date().toISOString() });
    await repository.insert(row);
    return row;
  }
  return { database, store, worker, makeWorker, event, subscription,
    events: database.getRepository(Event), deliveries: database.getRepository(entities.RuntimeEventDeliveryEntity),
    states: database.getRepository(entities.RuntimePipelineStateEntity) };
}

test('only committed pending events become durable delivery jobs', async t => {
  const f = await fixture(t);
  const sub = await f.subscription();
  await assert.rejects(f.store.transaction(async tx => {
    const row = Object.assign(new Event(), { id: randomUUID(), sequence: tx.nextSequence(), schemaVersion: '1.0',
      eventName: 'invocation.completed', eventFamily: 'runtime.request', severity: 'info', status: 'success',
      actorType: 'runtime', retentionClass: 'standard', occurredAt: new Date(tx.now), createdAt: new Date(tx.now),
      expiresAt: new Date(Date.parse(tx.now) + 86400000), dispatchState: 'pending' });
    await tx.manager.getRepository(Event).insert(row);
    throw new Error('fixture rollback');
  }), /fixture rollback/);
  assert.equal(await f.events.count(), 0);
  const event = await f.event();
  const report = await f.worker.runOnce();
  assert.equal(report.claimed, 1);
  assert.equal(report.deliveriesCreated, 1);
  const delivery = await f.deliveries.findOneByOrFail({ eventId: event.id });
  assert.equal(delivery.subscriptionId, sub.subscriptionId);
  assert.equal(delivery.status, 'pending');
  assert.equal(delivery.attemptCount, 0);
  assert.equal(await f.database.getRepository(entities.RuntimeEventDeliveryAttemptEntity).count(), 0);
});

test('subscription revision time ranges, state, revocation, scope and filters are enforced', async t => {
  const f = await fixture(t);
  const firstId = randomUUID();
  await f.subscription({ id: firstId, from: '1', until: '2', filter: { eventTypes: ['invocation.completed'], outcomes: ['success'] } });
  await f.subscription({ id: firstId, version: 2, from: '2', state: 'disabled' });
  await f.subscription({ revoked: true });
  await f.subscription({ scope: { mode: 'assets', runtimeAssetIds: ['asset-b'] } });
  await f.subscription({ filter: { severities: ['warning'] } });
  const first = await f.event();
  const second = await f.event();
  await f.worker.runOnce();
  assert.equal(await f.deliveries.countBy({ eventId: first.id }), 1);
  assert.equal(await f.deliveries.countBy({ eventId: second.id }), 0);
});

test('global subscriptions receive unbound state events while scoped subscriptions do not', async t => {
  const f = await fixture(t);
  await f.subscription({ scope: { mode: 'all' }, filter: { eventTypes: ['pipeline.state_changed'] } });
  await f.subscription({ filter: { eventTypes: ['pipeline.state_changed'] } });
  const event = await f.event({ runtimeAssetId: null, eventName: 'pipeline.state_changed',
    dimensions: {}, details: { state: 'running' } });
  await f.worker.runOnce();
  assert.equal(await f.deliveries.countBy({ eventId: event.id }), 1);
});

test('duplicate runs and a restarted worker do not duplicate deliveries', async t => {
  const f = await fixture(t);
  await f.subscription();
  const event = await f.event();
  await f.worker.runOnce();
  await f.worker.runOnce();
  await f.makeWorker().runOnce();
  assert.equal(await f.deliveries.countBy({ eventId: event.id }), 1);
  assert.equal((await f.events.findOneByOrFail({ id: event.id })).dispatchState, 'materialized');
});

test('expired leases are recovered and active leases remain owned', async t => {
  const f = await fixture(t);
  await f.subscription();
  const expired = await f.event({ dispatchState: 'leased', dispatchLeaseOwner: 'crashed',
    dispatchLeaseUntil: new Date(Date.now() - 1000) });
  const active = await f.event({ dispatchState: 'leased', dispatchLeaseOwner: 'active',
    dispatchLeaseUntil: new Date(Date.now() + 60000) });
  const report = await f.worker.runOnce();
  assert.equal(report.recoveredLeases, 1);
  assert.equal(await f.deliveries.countBy({ eventId: expired.id }), 1);
  assert.equal(await f.deliveries.countBy({ eventId: active.id }), 0);
  assert.equal((await f.events.findOneByOrFail({ id: active.id })).dispatchLeaseOwner, 'active');
});

test('concurrent local workers share claims and preserve unique jobs', async t => {
  const f = await fixture(t);
  await f.subscription();
  const events = await Promise.all(Array.from({ length: 12 }, () => f.event()));
  await Promise.all([f.worker.runOnce(8), f.makeWorker().runOnce(8)]);
  assert.equal(await f.deliveries.count(), 12);
  assert.equal(new Set((await f.deliveries.find()).map(row => row.id)).size, 12);
  assert.ok(events.every(Boolean));
});

test('delivery insert failure rolls back event completion and retries after restart', async t => {
  const f = await fixture(t);
  await f.subscription();
  const event = await f.event();
  await f.database.query("CREATE TRIGGER reject_delivery BEFORE INSERT ON runtime_event_deliveries BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  await assert.rejects(() => f.worker.runOnce(), /fixture failure/);
  assert.equal((await f.events.findOneByOrFail({ id: event.id })).dispatchState, 'leased');
  assert.equal(await f.deliveries.count(), 0);
  await f.database.query('DROP TRIGGER reject_delivery');
  await f.events.update(event.id, { dispatchLeaseUntil: new Date(Date.now() - 1000) });
  await f.makeWorker().runOnce();
  assert.equal(await f.deliveries.count(), 1);
  assert.equal((await f.events.findOneByOrFail({ id: event.id })).dispatchState, 'materialized');
});

test('suppressed, expired and noncanonical events never become delivery work', async t => {
  const f = await fixture(t);
  await f.subscription({ scope: { mode: 'all' } });
  await f.event({ dispatchState: 'suppressed' });
  await f.event({ expiresAt: new Date(Date.now() - 1000) });
  await f.event({ schemaVersion: '0.9' });
  assert.equal((await f.worker.runOnce()).claimed, 0);
  assert.equal(await f.deliveries.count(), 0);
});

test('watermark stops before an active lease and advances after recovery without gaps', async t => {
  const f = await fixture(t);
  await f.subscription();
  await f.event();
  const blocked = await f.event({ dispatchState: 'leased', dispatchLeaseOwner: 'active',
    dispatchLeaseUntil: new Date(Date.now() + 60000) });
  await f.event();
  let report = await f.worker.runOnce();
  assert.equal(report.watermark, '1');
  await f.events.update(blocked.id, { dispatchLeaseUntil: new Date(Date.now() - 1000) });
  report = await f.makeWorker().runOnce();
  assert.equal(report.watermark, '3');
  const state = await f.states.findOneByOrFail({ id: OUTBOX_WORKER_STATE_ID });
  assert.equal(state.value.watermark, '3');
});

test('invalid limits and malformed revision configs fail safely', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.worker.runOnce(0), /INVALID_OUTBOX_LIMIT/);
  await assert.rejects(() => f.worker.runOnce(257), /INVALID_OUTBOX_LIMIT/);
  await f.subscription({ filter: { eventTypes: 'invocation.completed' } });
  await f.subscription({ scope: { mode: 'assets', runtimeAssetIds: 'asset-a' } });
  await f.event();
  const report = await f.worker.runOnce();
  assert.equal(report.deliveriesCreated, 0);
});

test('opt-in background lifecycle materializes and shutdown waits for active work', async t => {
  const f = await fixture(t);
  await f.subscription();
  await f.event();
  const worker = f.makeWorker({ API_NOVA_OBSERVABILITY_OUTBOX_ENABLED: 'true' });
  worker.onApplicationBootstrap();
  for (let i = 0; i < 50 && await f.deliveries.count() === 0; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await worker.onModuleDestroy();
  assert.equal(await f.deliveries.count(), 1);
});


test('delivery history retains 30 days independently of the shorter event lifetime', async t => {
  const f = await fixture(t);
  await f.subscription();
  const event = await f.event({ expiresAt: new Date(Date.now() + 60000) });
  await f.worker.runOnce();
  const delivery = await f.deliveries.findOneByOrFail({ eventId: event.id });
  assert.equal(Date.parse(delivery.expiresAt) - Date.parse(delivery.createdAt), 30 * 86400000);
  assert.ok(Date.parse(delivery.expiresAt) > event.expiresAt.getTime());
  assert.ok(await f.events.findOneBy({ id: event.id }));
});
