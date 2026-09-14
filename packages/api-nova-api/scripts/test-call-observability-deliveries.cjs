'use strict';
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ConfigService } = require('@nestjs/config');
const entities = require('../dist/src/database/entities/runtime-call-observability.entity');
const { RuntimeObservabilityEventEntity } = require('../dist/src/database/entities/runtime-observability-event.entity');
const { CallObservabilityStore } = require('../dist/src/modules/call-observability/call-observability.store');
const { ObservabilityCommandStore } = require('../dist/src/modules/call-observability/call-observability-command.store');
const { ObservabilityCursorService } = require('../dist/src/modules/call-observability/call-observability-cursor.service');
const { CallObservabilitySubscriptionsService } = require('../dist/src/modules/call-observability/call-observability-subscriptions.service');
const { CallObservabilityDeliveriesService } = require('../dist/src/modules/call-observability/call-observability-deliveries.service');

const configValues = {
  API_NOVA_OBSERVABILITY_IDEMPOTENCY_SECRET: 'i'.repeat(32),
  API_NOVA_OBSERVABILITY_CURSOR_SECRET: 'c'.repeat(32),
  API_NOVA_OBSERVABILITY_CURSOR_KEY_ID: 'v1',
  API_NOVA_OBSERVABILITY_WEBHOOK_ALLOWED_HOSTS: 'monitor.example',
  API_NOVA_OBSERVABILITY_WEBHOOK_SECRET_REFS: 'webhook-key',
};
const scoped = { principalId: randomUUID(), runtimeAssetIds: ['runtime-a'],
  requiredPermissions: ['monitoring:read', 'monitoring:subscription:manage'], fingerprint: 'a'.repeat(64) };
const retryScope = { ...scoped, requiredPermissions: [...scoped.requiredPermissions, 'monitoring:delivery:retry'],
  fingerprint: 'b'.repeat(64) };
const other = { ...scoped, runtimeAssetIds: ['runtime-b'], fingerprint: 'd'.repeat(64) };

async function fixture(t) {
  const database = new DataSource({ type: 'sqljs',
    entities: [...entities.CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity],
    synchronize: true, logging: false });
  await database.initialize();
  t.after(() => database.destroy());
  const store = new CallObservabilityStore(database, {});
  const config = new ConfigService(configValues);
  const auditEntries = [];
  const audit = { async log(entry) { auditEntries.push(entry); return { id: randomUUID() }; } };
  const commands = new ObservabilityCommandStore(store, config);
  const cursors = new ObservabilityCursorService(config);
  return {
    database, store, auditEntries,
    subscriptions: new CallObservabilitySubscriptionsService(store, commands, config, audit, cursors),
    deliveries: new CallObservabilityDeliveriesService(store, commands, cursors, audit),
    deliveryRows: database.getRepository(entities.RuntimeEventDeliveryEntity),
    events: database.getRepository(RuntimeObservabilityEventEntity),
    attempts: database.getRepository(entities.RuntimeEventDeliveryAttemptEntity),
  };
}
async function subscription(f, authorization = scoped, enabled = true) {
  return f.subscriptions.create({
    name: 'Runtime events',
    destination: { type: 'webhook', url: 'https://monitor.example/events' },
    secretRef: 'webhook-key', filter: { runtimeAssetIds: [...authorization.runtimeAssetIds] }, enabled,
  }, {}, undefined, authorization, randomUUID());
}
function code(expected) { return error => error?.code === expected; }

test('subscription test atomically creates one explicit event and one controlled delivery', async t => {
  const f = await fixture(t), created = await subscription(f);
  const result = await f.deliveries.testSubscription(
    created.data.id, { reason: 'receiver check' }, {}, undefined, scoped, randomUUID());
  assert.equal(result.data.status, 'pending');
  assert.equal(result.data.subscriptionId, created.data.id);
  assert.equal(result.data.suspendedBySubscription, false);
  const event = await f.events.findOneByOrFail({ id: result.data.eventId });
  assert.equal(event.eventName, 'subscription.test');
  assert.equal(Date.parse(result.data.expiresAt) - Date.parse(result.data.createdAt), 30 * 86400000);
  assert.ok(Date.parse(result.data.expiresAt) > event.expiresAt.getTime());
  assert.equal(event.details.test, true);
  assert.equal(event.dispatchState, 'materialized');
  assert.equal(await f.deliveryRows.countBy({ eventId: event.id }), 1);
  assert.equal(f.auditEntries.at(-1).details.reasonProvided, true);
});

test('optional test idempotency replays the original delivery without duplicating the event', async t => {
  const f = await fixture(t), created = await subscription(f);
  const first = await f.deliveries.testSubscription(created.data.id, {}, {}, 'test-once', scoped, randomUUID());
  const replay = await f.deliveries.testSubscription(created.data.id, {}, {}, 'test-once', scoped, randomUUID());
  assert.equal(replay.data.deliveryId, first.data.deliveryId);
  assert.equal(replay.data.replayed, true);
  assert.equal(await f.deliveryRows.count(), 1);
  assert.equal(await f.events.count(), 1);
});

test('testing a paused subscription queues a suspended delivery without resuming it', async t => {
  const f = await fixture(t), created = await subscription(f, scoped, false);
  const result = await f.deliveries.testSubscription(created.data.id, undefined, {}, undefined, scoped, randomUUID());
  assert.equal(result.data.status, 'pending');
  assert.equal(result.data.suspendedBySubscription, true);
  assert.equal((await f.subscriptions.get(created.data.id, {}, scoped)).data.state, 'paused');
});

test('delivery list filters and signed cursors preserve scope', async t => {
  const f = await fixture(t);
  const firstSubscription = await subscription(f), secondSubscription = await subscription(f, other);
  const first = await f.deliveries.testSubscription(firstSubscription.data.id, {}, {}, undefined, scoped, randomUUID());
  await f.deliveries.testSubscription(secondSubscription.data.id, {}, {}, undefined, other, randomUUID());
  assert.deepEqual((await f.deliveries.list({ status: 'pending' }, scoped)).data.items.map(item => item.deliveryId),
    [first.data.deliveryId]);
  const global = { ...scoped, runtimeAssetIds: null, fingerprint: 'e'.repeat(64) };
  const page = await f.deliveries.list({ limit: '1' }, global);
  assert.equal(page.data.items.length, 1);
  assert.equal(page.data.hasMore, true);
  assert.ok(page.data.nextCursor);
  const next = await f.deliveries.list({ cursor: page.data.nextCursor }, global);
  assert.equal(next.data.items.length, 1);
  assert.notEqual(next.data.items[0].deliveryId, page.data.items[0].deliveryId);
  await assert.rejects(() => f.deliveries.list({ cursor: page.data.nextCursor, status: 'dead' }, global),
    code('CURSOR_SCOPE_MISMATCH'));
});

test('delivery detail bounds attempt pages and redacts common secret forms', async t => {
  const f = await fixture(t), created = await subscription(f);
  const delivery = await f.deliveries.testSubscription(created.data.id, {}, {}, undefined, scoped, randomUUID());
  for (let attemptNo = 1; attemptNo <= 3; attemptNo++) {
    await f.attempts.insert({ id: randomUUID(), deliveryId: delivery.data.deliveryId, attemptNo,
      startedAt: new Date().toISOString(), completedAt: null, result: 'failed', durationMs: null,
      httpStatus: 500, errorCategory: 'response',
      responseSummary: 'authorization=private-token status=500' });
  }
  const first = await f.deliveries.get(delivery.data.deliveryId, { attemptsLimit: '2' }, scoped);
  assert.deepEqual(first.data.attempts.map(item => item.attemptNo), [3, 2]);
  assert.equal(first.data.hasMoreAttempts, true);
  assert.ok(first.data.nextAttemptsCursor);
  assert.equal(JSON.stringify(first.data).includes('private-token'), false);
  const next = await f.deliveries.get(delivery.data.deliveryId,
    { attemptsCursor: first.data.nextAttemptsCursor }, scoped);
  assert.deepEqual(next.data.attempts.map(item => item.attemptNo), [1]);
});

test('dead retry requires idempotency and preserves event, delivery and attempts', async t => {
  const f = await fixture(t), created = await subscription(f);
  const result = await f.deliveries.testSubscription(created.data.id, {}, {}, undefined, scoped, randomUUID());
  const row = await f.deliveryRows.findOneByOrFail({ id: result.data.deliveryId });
  Object.assign(row, { status: 'dead', version: 2, attemptCount: 1, lastError: { category: 'response' } });
  await f.deliveryRows.save(row);
  await f.attempts.insert({ id: randomUUID(), deliveryId: row.id, attemptNo: 1, startedAt: row.createdAt,
    completedAt: row.updatedAt, result: 'failed', durationMs: 1, httpStatus: 500,
    errorCategory: 'response', responseSummary: 'status=500' });
  await assert.rejects(() => f.deliveries.retry(
    row.id, { reason: 'operator retry' }, {}, undefined, retryScope, randomUUID()), code('INVALID_QUERY'));
  const retried = await f.deliveries.retry(
    row.id, { reason: 'operator retry' }, {}, 'retry-once', retryScope, randomUUID());
  assert.equal(retried.data.deliveryId, row.id);
  assert.equal(retried.data.eventId, row.eventId);
  assert.equal(retried.data.status, 'pending');
  assert.equal(retried.data.replayGeneration, 1);
  assert.equal(retried.data.attemptCount, 1);
  assert.equal(await f.attempts.countBy({ deliveryId: row.id }), 1);
  const replay = await f.deliveries.retry(
    row.id, { reason: 'operator retry' }, {}, 'retry-once', retryScope, randomUUID());
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.replayGeneration, 1);
});

test('active delivery and expired event fail with stable conflict and gone errors', async t => {
  const f = await fixture(t), created = await subscription(f);
  const result = await f.deliveries.testSubscription(created.data.id, {}, {}, undefined, scoped, randomUUID());
  await assert.rejects(() => f.deliveries.retry(
    result.data.deliveryId, { reason: 'too early' }, {}, 'active', retryScope, randomUUID()),
  code('DELIVERY_NOT_RETRYABLE'));
  const row = await f.deliveryRows.findOneByOrFail({ id: result.data.deliveryId });
  row.status = 'dead';
  await f.deliveryRows.save(row);
  const event = await f.events.findOneByOrFail({ id: row.eventId });
  event.expiresAt = new Date(Date.now() - 1000);
  await f.events.save(event);
  await assert.rejects(() => f.deliveries.retry(
    row.id, { reason: 'expired' }, {}, 'expired', retryScope, randomUUID()), code('EVENT_EXPIRED'));
  assert.equal((await f.deliveries.get(row.id, {}, scoped)).data.deliveryId, row.id);
  assert.deepEqual((await f.deliveries.list({ eventId: event.id }, scoped)).data.items.map(item => item.deliveryId), [row.id]);
  assert.equal((await f.deliveryRows.findOneByOrFail({ id: row.id })).expiresAt, row.expiresAt);
  await f.events.delete(event.id);
  assert.equal((await f.deliveries.get(row.id, {}, scoped)).data.deliveryId, row.id);
  await assert.rejects(() => f.deliveries.retry(
    row.id, { reason: 'missing event' }, {}, 'missing-event', retryScope, randomUUID()), code('EVENT_EXPIRED'));
});

test('cancelled delivery requires an explicit enabled current revision', async t => {
  const f = await fixture(t), created = await subscription(f);
  const result = await f.deliveries.testSubscription(created.data.id, {}, {}, undefined, scoped, randomUUID());
  const row = await f.deliveryRows.findOneByOrFail({ id: result.data.deliveryId });
  row.status = 'cancelled';
  await f.deliveryRows.save(row);
  await assert.rejects(() => f.deliveries.retry(
    row.id, { reason: 'no revision' }, {}, 'cancel-1', retryScope, randomUUID()),
  code('DELIVERY_NOT_RETRYABLE'));
  const retried = await f.deliveries.retry(row.id,
    { reason: 'approved', subscriptionRevision: 1 }, {}, 'cancel-2', retryScope, randomUUID());
  assert.equal(retried.data.status, 'pending');
  assert.equal(retried.data.subscriptionRevision, 1);
});

test('hidden deliveries are not disclosed by list, detail, test replay or retry', async t => {
  const f = await fixture(t), created = await subscription(f);
  const result = await f.deliveries.testSubscription(
    created.data.id, {}, {}, 'scoped-test', scoped, randomUUID());
  assert.equal((await f.deliveries.list({}, other)).data.items.length, 0);
  await assert.rejects(() => f.deliveries.get(result.data.deliveryId, {}, other), code('NOT_FOUND'));
  await assert.rejects(() => f.deliveries.testSubscription(
    created.data.id, {}, {}, 'scoped-test', other, randomUUID()), code('FORBIDDEN'));
  const row = await f.deliveryRows.findOneByOrFail({ id: result.data.deliveryId });
  row.status = 'dead';
  await f.deliveryRows.save(row);
  await assert.rejects(() => f.deliveries.retry(row.id, { reason: 'hidden' }, {}, 'hidden',
    { ...other, requiredPermissions: retryScope.requiredPermissions }, randomUUID()), code('NOT_FOUND'));
});
