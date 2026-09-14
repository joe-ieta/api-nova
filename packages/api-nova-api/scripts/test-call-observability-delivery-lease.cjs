'use strict';
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const entities = require('../dist/src/database/entities/runtime-call-observability.entity.js');
const { RuntimeObservabilityEventEntity: Event } = require('../dist/src/database/entities/runtime-observability-event.entity.js');
const { CallObservabilityStore } = require('../dist/src/modules/call-observability/call-observability.store.js');
const { CallObservabilityDeliveryLeaseService: LeaseService } = require('../dist/src/modules/call-observability/call-observability-delivery-lease.service.js');
const { sequenceKey } = require('../dist/src/modules/call-observability/call-observability-storage.js');
const { RuntimeEventSubscriptionEntity: Subscription, RuntimeSubscriptionRevisionEntity: Revision,
  RuntimeEventDeliveryEntity: Delivery, RuntimeEventDeliveryAttemptEntity: Attempt } = entities;
const DAY = 86400000;
async function fixture(t) {
  const db = await new DataSource({ type: 'sqljs', entities: [...entities.CALL_OBSERVABILITY_ENTITIES, Event], synchronize: true }).initialize();
  t.after(() => db.destroy());
  const store = new CallObservabilityStore(db, {});
  let clock = Date.now(), allowed = true;
  // Keep the real Store transaction, locking and rollback. Only its clock is deterministic.
  const transaction = store.transaction.bind(store);
  store.transaction = operation => transaction(tx => operation({ ...tx, now: new Date(clock).toISOString() }));
  const authorizer = { resolve: async (ownerId, manager) => {
    assert.equal(manager.queryRunner.isTransactionActive, true);
    return allowed ? { principalId: ownerId, runtimeAssetIds: ['asset-a'], requiredPermissions: ['monitoring:read'] } : null;
  } };
  const service = new LeaseService(store, authorizer);
  const subscriptionId = randomUUID(), revisionId = randomUUID(), now = new Date(clock).toISOString();
  await store.transaction(async tx => {
    await tx.manager.getRepository(Subscription).insert({ id: subscriptionId, ownerId: 'owner', name: 'fixture', version: 1,
      state: 'active', destination: 'https://example.invalid/webhook', secretRef: 'fixture-secret', filter: {},
      scope: { mode: 'assets', runtimeAssetIds: ['asset-a'] }, effectiveFromSequence: sequenceKey('0'),
      createdAt: now, updatedAt: now, pausedFromSequence: null, deletedAt: null });
    await tx.manager.getRepository(Revision).insert({ id: revisionId, subscriptionId, version: 1,
      effectiveFromSequence: sequenceKey('0'), effectiveUntilSequence: null, revoked: false, createdAt: now,
      config: { enabled: true, scope: { mode: 'assets', runtimeAssetIds: ['asset-a'] }, filter: {} } });
  });
  const change = (entity, criteria, patch) => store.transaction(tx => tx.manager.getRepository(entity).update(criteria, patch));
  async function add(extra = {}) {
    return store.transaction(async tx => {
      const eventId = randomUUID(), deliveryId = randomUUID(), sequence = tx.nextSequence();
      await tx.manager.getRepository(Event).insert({ id: eventId, sequence, runtimeAssetId: 'asset-a',
        eventName: 'invocation.completed', eventFamily: 'runtime.request', dispatchState: 'dispatched',
        occurredAt: new Date(tx.now), expiresAt: new Date(clock + 14 * DAY) });
      await tx.manager.getRepository(Delivery).insert({ id: deliveryId, subscriptionId, subscriptionRevision: 1,
        eventId, eventSequence: sequence, status: 'pending', version: 1, attemptCount: 0, replayGeneration: 0,
        nextAttemptAt: tx.now, leaseOwner: null, leaseUntil: null, lastError: {}, createdAt: tx.now,
        updatedAt: tx.now, expiresAt: new Date(clock + 30 * DAY).toISOString(), ...extra });
      return deliveryId;
    });
  }
  return { db, store, service, authorizer, subscriptionId, revisionId, add, change,
    advance: ms => { clock += ms; }, at: value => { clock = Date.parse(value); },
    revoke: () => { allowed = false; }, restore: () => { allowed = true; },
    row: id => db.getRepository(Delivery).findOneByOrFail({ id }),
    attempts: id => db.getRepository(Attempt).find({ where: { deliveryId: id }, order: { attemptNo: 'ASC' } }) };
}

test('claim atomically reserves an attempt and successful completion clears lease with fixed safe metadata', async t => {
  const f = await fixture(t), id = await f.add();
  const { leases } = await f.service.claim();
  assert.equal(leases.length, 1);
  const lease = leases[0], row = await f.row(id), attempts = await f.attempts(id);
  assert.equal(lease.deliveryId, id); assert.equal(lease.attemptNo, 1); assert.equal(lease.version, 2);
  assert.equal(row.leaseOwner, lease.token); assert.equal(row.attemptCount, 1);
  assert.equal(attempts[0].result, 'in_flight'); assert.equal(attempts[0].startedAt, lease.startedAt);
  assert.equal(await f.service.complete(lease, { kind: 'success', httpStatus: 204, responseBody: 'SECRET' }), true);
  const completed = await f.row(id), [attempt] = await f.attempts(id);
  assert.equal(completed.status, 'succeeded'); assert.equal(completed.version, 3);
  assert.equal(completed.leaseOwner, null); assert.equal(completed.leaseUntil, null);
  assert.equal(attempt.result, 'succeeded'); assert.equal(attempt.httpStatus, 204); assert.equal(attempt.responseSummary, null);
  assert.equal(JSON.stringify({ completed, attempt }).includes('SECRET'), false);
  assert.equal(await f.service.complete(lease, { kind: 'success', httpStatus: 200 }), false);
});

test('bounded and simultaneous claims cannot reserve the same delivery twice', async t => {
  const f = await fixture(t); await f.add(); await f.add(); await f.add();
  const another = new LeaseService(f.store, f.authorizer);
  const results = await Promise.all([f.service.claim({ limit: 1, scanLimit: 1 }), another.claim({ limit: 1, scanLimit: 1 })]);
  assert.equal(results.every(result => result.scanned === 1), true);
  const ids = results.flatMap(result => result.leases.map(lease => lease.deliveryId));
  assert.equal(new Set(ids).size, 2); assert.equal(await f.db.getRepository(Attempt).count(), 2);
  assert.equal((await f.service.claim()).leases.length, 1);
  assert.equal((await f.service.claim()).leases.length, 0);
});

test('token, version and attempt fences reject stale or forged completion without mutation', async t => {
  const f = await fixture(t), id = await f.add(), [lease] = (await f.service.claim()).leases;
  for (const patch of [{ token: randomUUID() }, { version: lease.version + 1 }, { attemptNo: 2 }]) {
    assert.equal(await f.service.complete({ ...lease, ...patch }, { kind: 'success', httpStatus: 200 }), false);
  }
  assert.equal((await f.row(id)).status, 'in_flight'); assert.equal((await f.attempts(id))[0].result, 'in_flight');
});

test('expired lease cannot report success; recovery consumes a new attempt and fences the old claimant', async t => {
  const f = await fixture(t), id = await f.add(), [old] = (await f.service.claim()).leases;
  f.at(old.leaseUntil);
  assert.equal(await f.service.complete(old, { kind: 'success', httpStatus: 200 }), false);
  const [fresh] = (await new LeaseService(f.store, f.authorizer).claim()).leases;
  assert.equal(fresh.attemptNo, 2); assert.equal(fresh.version, old.version + 1); assert.notEqual(fresh.token, old.token);
  assert.deepEqual((await f.attempts(id)).map(attempt => attempt.result), ['lease_expired', 'in_flight']);
  assert.equal(await f.service.complete(old, { kind: 'success', httpStatus: 200 }), false);
  assert.equal(await f.service.complete(fresh, { kind: 'success', httpStatus: 200 }), true);
});

test('pause preserves pending and retry queues, and denies in-flight result until resumed', async t => {
  const f = await fixture(t), id = await f.add();
  await f.change(Subscription, f.subscriptionId, { state: 'paused' });
  assert.equal((await f.service.claim()).leases.length, 0); assert.equal((await f.row(id)).status, 'pending');
  await f.change(Subscription, f.subscriptionId, { state: 'active' });
  const [lease] = (await f.service.claim()).leases;
  await f.change(Subscription, f.subscriptionId, { state: 'paused' });
  assert.equal(await f.service.complete(lease, { kind: 'success', httpStatus: 200 }), false);
  await f.change(Subscription, f.subscriptionId, { state: 'active' });
  assert.equal(await f.service.complete(lease, { kind: 'failure', reason: 'network' }), true);
  const retry = await f.row(id); assert.equal(retry.status, 'retry_wait'); f.at(retry.nextAttemptAt);
  await f.change(Subscription, f.subscriptionId, { state: 'paused' });
  assert.equal((await f.service.claim()).leases.length, 0);
  assert.equal((await f.row(id)).status, 'retry_wait'); assert.equal((await f.row(id)).nextAttemptAt, retry.nextAttemptAt);
});

test('current authorization revocation prevents claim and completion', async t => {
  const f = await fixture(t), id = await f.add(); f.revoke();
  assert.equal((await f.service.claim()).leases.length, 0); assert.equal((await f.row(id)).attemptCount, 0);
  f.restore(); const [lease] = (await f.service.claim()).leases; f.revoke();
  assert.equal(await f.service.complete(lease, { kind: 'success', httpStatus: 200 }), false);
  assert.equal((await f.row(id)).status, 'in_flight');
});

test('revoked revision, expired event and nonzero replay generation fail closed', async t => {
  const f = await fixture(t), id = await f.add(), original = await f.row(id);
  await f.change(Revision, f.revisionId, { revoked: true });
  assert.equal((await f.service.claim()).leases.length, 0);
  await f.change(Revision, f.revisionId, { revoked: false });
  await f.change(Delivery, id, { replayGeneration: 1 });
  assert.equal((await f.service.claim()).leases.length, 0);
  await f.change(Delivery, id, { replayGeneration: 0 });
  await f.change(Event, original.eventId, { expiresAt: new Date(0) });
  assert.equal((await f.service.claim()).leases.length, 0); assert.equal((await f.attempts(id)).length, 0);
});

test('six failed sends exhaust the lifetime attempt budget with no seventh claim', async t => {
  const f = await fixture(t), id = await f.add();
  for (let number = 1; number <= 6; number++) {
    const [lease] = (await f.service.claim()).leases; assert.ok(lease); assert.equal(lease.attemptNo, number);
    assert.equal(await f.service.complete(lease, { kind: 'failure', reason: 'timeout' }), true);
    const row = await f.row(id);
    assert.equal(row.status, number < 6 ? 'retry_wait' : 'dead');
    if (number < 6) f.at(row.nextAttemptAt);
  }
  f.advance(DAY);
  assert.equal((await f.service.claim()).leases.length, 0);
  assert.deepEqual((await f.attempts(id)).map(attempt => attempt.attemptNo), [1, 2, 3, 4, 5, 6]);
});

test('six process crashes consume all attempts even without sending or completing', async t => {
  const f = await fixture(t), id = await f.add();
  for (let number = 1; number <= 6; number++) {
    const [lease] = (await f.service.claim()).leases; assert.ok(lease); assert.equal(lease.attemptNo, number);
    f.at(lease.leaseUntil);
  }
  assert.equal((await f.service.claim()).leases.length, 0);
  assert.equal((await f.row(id)).status, 'dead'); assert.equal((await f.attempts(id)).length, 6);
  assert.equal((await f.attempts(id)).every(attempt => attempt.result === 'lease_expired'), true);
});

test('24-hour window starts with first attempt instead of delivery creation', async t => {
  const f = await fixture(t), id = await f.add();
  f.advance(2 * DAY); const [lease] = (await f.service.claim()).leases; assert.ok(lease);
  assert.equal(await f.service.complete(lease, { kind: 'failure', reason: 'network' }), true);
  f.at(lease.startedAt); f.advance(DAY);
  assert.equal((await f.service.claim()).leases.length, 0);
  assert.equal((await f.row(id)).status, 'dead'); assert.equal((await f.attempts(id)).length, 1);
});

test('retryAfter postpones eligible HTTP retry and permanent HTTP failure becomes dead', async t => {
  const f = await fixture(t), id = await f.add(), [lease] = (await f.service.claim()).leases;
  assert.equal(await f.service.complete(lease, { kind: 'failure', reason: 'http', httpStatus: 429, retryAfter: '120' }), true);
  const retry = await f.row(id); assert.equal(retry.status, 'retry_wait');
  assert.ok(Date.parse(retry.nextAttemptAt) >= Date.parse(lease.startedAt) + 120000);
  assert.equal((await f.service.claim()).leases.length, 0);
  f.at(retry.nextAttemptAt); const [next] = (await f.service.claim()).leases;
  assert.equal(await f.service.complete(next, { kind: 'failure', reason: 'http', httpStatus: 400 }), true);
  assert.equal((await f.row(id)).status, 'dead');
});

test('attempt insertion failure rolls back delivery lease and counter reservation', async t => {
  const f = await fixture(t), id = await f.add();
  await f.db.query("CREATE TRIGGER reject_lease_attempt BEFORE INSERT ON runtime_event_delivery_attempts BEGIN SELECT RAISE(ABORT, 'fixture_attempt_failure'); END");
  await assert.rejects(f.service.claim(), /fixture_attempt_failure/);
  const row = await f.row(id); assert.equal(row.status, 'pending'); assert.equal(row.version, 1);
  assert.equal(row.leaseOwner, null); assert.equal(row.attemptCount, 0); assert.equal((await f.attempts(id)).length, 0);
});

async function senderFixture(t) {
  const f = await fixture(t);
  const config = { enabled: true, scope: { mode: 'assets', runtimeAssetIds: ['asset-a'] }, filter: {},
    destination: 'https://old.example.invalid/events', secretRef: 'old-secret-ref', signingKeyId: 'old-key-id' };
  await f.change(Revision, f.revisionId, { config });
  const id = await f.add(), [lease] = (await f.service.claim()).leases;
  return { ...f, config, id, lease };
}

test('readForSend returns the bound old revision and event despite newer subscription configuration', async t => {
  const f = await senderFixture(t), row = await f.row(f.id);
  await f.change(Subscription, f.subscriptionId, { version: 2,
    destination: 'https://new.example.invalid/events', secretRef: 'new-secret-ref' });
  await f.change(Revision, f.revisionId, { effectiveUntilSequence: row.eventSequence });
  await f.store.transaction(tx => tx.manager.getRepository(Revision).insert({ id: randomUUID(),
    subscriptionId: f.subscriptionId, version: 2, effectiveFromSequence: row.eventSequence,
    effectiveUntilSequence: null, revoked: false, createdAt: tx.now,
    config: { ...f.config, destination: 'https://new.example.invalid/events', secretRef: 'new-secret-ref', signingKeyId: 'new-key-id' } }));
  const value = await f.service.readForSend(f.lease);
  assert.ok(value); assert.equal(value.event.id, row.eventId); assert.equal(value.ownerId, 'owner');
  assert.equal(value.destination, f.config.destination);
  assert.equal(value.secretRef, f.config.secretRef); assert.equal(value.signingKeyId, f.config.signingKeyId);
  assert.equal((await f.row(f.id)).version, f.lease.version);
  assert.equal((await f.attempts(f.id)).length, 1);
});

test('readForSend refuses missing immutable sender fields instead of falling back to current subscription', async t => {
  const f = await senderFixture(t);
  for (const field of ['destination', 'secretRef', 'signingKeyId']) {
    const config = { ...f.config }; delete config[field];
    await f.change(Revision, f.revisionId, { config });
    await assert.rejects(f.service.readForSend(f.lease), error => error.code === 'DELIVERY_CONFIGURATION_UNAVAILABLE');
  }
});

test('readForSend denies pause and current authorization revocation and recovers only when restored', async t => {
  const f = await senderFixture(t);
  await f.change(Subscription, f.subscriptionId, { state: 'paused' });
  assert.equal(await f.service.readForSend(f.lease), null);
  await f.change(Subscription, f.subscriptionId, { state: 'active' }); f.revoke();
  assert.equal(await f.service.readForSend(f.lease), null);
  f.restore(); assert.ok(await f.service.readForSend(f.lease));
  assert.equal((await f.row(f.id)).status, 'in_flight');
});

test('readForSend rejects stale token, version, attempt and expired lease even before recovery', async t => {
  const f = await senderFixture(t);
  for (const patch of [{ token: randomUUID() }, { version: f.lease.version + 1 }, { attemptNo: 2 }]) {
    assert.equal(await f.service.readForSend({ ...f.lease, ...patch }), null);
  }
  f.at(f.lease.leaseUntil);
  assert.equal(await f.service.readForSend(f.lease), null);
  const [replacement] = (await f.service.claim()).leases;
  assert.ok(replacement);
  assert.equal(await f.service.readForSend(f.lease), null);
  assert.ok(await f.service.readForSend(replacement));
});

test('readForSend rejects event expiry, revoked bound revision and expired delivery', async t => {
  const f = await senderFixture(t), row = await f.row(f.id);
  await f.change(Revision, f.revisionId, { revoked: true });
  assert.equal(await f.service.readForSend(f.lease), null);
  await f.change(Revision, f.revisionId, { revoked: false });
  const event = await f.db.getRepository(Event).findOneByOrFail({ id: row.eventId });
  await f.change(Event, row.eventId, { expiresAt: new Date(0) });
  assert.equal(await f.service.readForSend(f.lease), null);
  await f.change(Event, row.eventId, { expiresAt: event.expiresAt });
  await f.change(Delivery, f.id, { expiresAt: new Date(0).toISOString() });
  assert.equal(await f.service.readForSend(f.lease), null);
});

test('readForSend rejects a completed lease without exposing sender configuration again', async t => {
  const f = await senderFixture(t);
  assert.equal(await f.service.complete(f.lease, { kind: 'success', httpStatus: 200 }), true);
  assert.equal(await f.service.readForSend(f.lease), null);
});
