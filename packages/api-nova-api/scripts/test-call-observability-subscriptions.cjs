'use strict';
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, compilerOptions: {
  module: 'commonjs', experimentalDecorators: true, emitDecoratorMetadata: true,
} });
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ConfigService } = require('@nestjs/config');
const entities = require('../src/database/entities/runtime-call-observability.entity.ts');
const { RuntimeObservabilityEventEntity: Event } = require('../src/database/entities/runtime-observability-event.entity.ts');
const { CallObservabilityStore } = require('../src/modules/call-observability/call-observability.store.ts');
const { ObservabilityCommandStore, observabilityEtag } = require('../src/modules/call-observability/call-observability-command.store.ts');
const { CallObservabilitySubscriptionsService: Subscriptions } = require('../src/modules/call-observability/call-observability-subscriptions.service.ts');
const { CallObservabilitySubscriptionsQueryService: SubscriptionQueries } = require('../src/modules/call-observability/call-observability-subscriptions-query.service.ts');
const { CallObservabilityDeliveriesQueryService: DeliveryQueries } = require('../src/modules/call-observability/call-observability-deliveries-query.service.ts');
const { contentHash } = require('../src/modules/call-observability/call-observability-storage.ts');
const { RuntimeEventSubscriptionEntity: Subscription, RuntimeSubscriptionRevisionEntity: Revision,
  RuntimeEventDeliveryEntity: Delivery, RuntimeEventDeliveryAttemptEntity: Attempt, RuntimePipelineStateEntity: State } = entities;
const READ = 'monitoring:read', MANAGE = 'monitoring:subscription:manage';
function input(patch = {}) { return { name: 'fixture subscription', destination: 'https://receiver.example.invalid/PRIVATE-PATH',
  secretRef: 'private-secret-ref', signingKeyId: 'signing-v1', enabled: true,
  scope: { mode: 'assets', runtimeAssetIds: ['asset-a'] }, filter: { eventTypes: ['invocation.completed'] }, ...patch }; }
const code = expected => error => error.code === expected;
async function fixture(t) {
  const db = await new DataSource({ type: 'sqljs', entities: [...entities.CALL_OBSERVABILITY_ENTITIES, Event], synchronize: true }).initialize();
  t.after(() => db.destroy());
  const store = new CallObservabilityStore(db, {});
  let allowed = true, assets = ['asset-a'];
  const authorization = { principalId: 'owner', runtimeAssetIds: ['asset-a'], requiredPermissions: [READ, MANAGE], fingerprint: contentHash('owner-assets-a') };
  const owners = { resolve: async (principalId, manager) => {
    assert.equal(manager.queryRunner.isTransactionActive, true);
    return allowed ? { ...authorization, principalId, runtimeAssetIds: assets } : null;
  } };
  const configAuth = { authorize: async (ownerId, body, manager) => {
    assert.equal(ownerId, 'owner'); assert.equal(manager.queryRunner.isTransactionActive, true);
    return body.secretRef !== 'denied-ref';
  } };
  // Audit boundary stub deliberately persists through the SAME EntityManager to exercise rollback.
  const audit = { fail: false, log: async (record, manager) => {
    assert.equal(manager.queryRunner.isTransactionActive, true);
    if (audit.fail) throw new Error('fixture-audit-failure');
    const id = 'fixture-audit:' + randomUUID();
    await manager.getRepository(State).insert({ id, value: record, updatedAt: new Date().toISOString() });
    return { id };
  } };
  const commands = new ObservabilityCommandStore(store, new ConfigService({ API_NOVA_OBSERVABILITY_IDEMPOTENCY_SECRET: 'i'.repeat(64) }));
  const service = new Subscriptions(store, commands, audit, owners, configAuth);
  const query = new SubscriptionQueries(store, owners), deliveryQuery = new DeliveryQueries(store, owners);
  const change = (entity, id, patch) => store.transaction(tx => tx.manager.getRepository(entity).update(id, patch));
  const create = (body = input(), key = randomUUID()) => service.create(body, authorization, key);
  const row = id => db.getRepository(Subscription).findOneByOrFail({ id });
  const revisions = id => db.getRepository(Revision).find({ where: { subscriptionId: id }, order: { version: 'ASC' } });
  async function delivery(subscriptionId, status = 'pending') {
    return store.transaction(async tx => {
      const id = randomUUID(), eventId = randomUUID(), sequence = tx.nextSequence();
      await tx.manager.getRepository(Event).insert({ id: eventId, sequence, runtimeAssetId: 'asset-a',
        eventName: 'invocation.completed', eventFamily: 'runtime.request', occurredAt: new Date(tx.now),
        expiresAt: new Date(Date.now() + 86400000), details: { secret: 'EVENT-SECRET' } });
      await tx.manager.getRepository(Delivery).insert({ id, subscriptionId, subscriptionRevision: 1, eventId,
        eventSequence: sequence, status, version: 3, attemptCount: 1, replayGeneration: 0,
        nextAttemptAt: tx.now, leaseOwner: 'PRIVATE-LEASE', leaseUntil: new Date(Date.now() + 60000).toISOString(),
        lastError: { code: 'RAW-ERROR-SECRET', message: 'SECRET-MESSAGE' }, createdAt: tx.now, updatedAt: tx.now,
        expiresAt: new Date(Date.now() + 86400000).toISOString() });
      await tx.manager.getRepository(Attempt).insert({ id: randomUUID(), deliveryId: id, attemptNo: 1,
        startedAt: tx.now, completedAt: tx.now, result: 'failed', durationMs: 10, httpStatus: 503,
        errorCategory: 'PRIVATE-ATTEMPT-ERROR', responseSummary: 'PRIVATE-RESPONSE' });
      return id;
    });
  }
  return { db, store, commands, owners, configAuth, audit, service, query, deliveryQuery, authorization,
    create, row, revisions, change, delivery, revoke: () => { allowed = false; },
    narrow: () => { assets = []; } };
}

test('create stores exact immutable config once; identical idempotency replay preserves sequence and audit count', async t => {
  const f = await fixture(t), key = randomUUID(), first = await f.create(input(), key), watermark = await f.store.watermark();
  const replay = await f.create(input(), key);
  assert.equal(first.replayed, false); assert.equal(replay.replayed, true); assert.deepEqual(first.result, replay.result);
  assert.equal(await f.store.watermark(), watermark); assert.equal(await f.db.getRepository(Subscription).count(), 1);
  const [revision] = await f.revisions(first.result.resourceId), row = await f.row(first.result.resourceId);
  assert.equal(revision.effectiveFromSequence, row.effectiveFromSequence);
  assert.deepEqual(revision.config, { destination: input().destination, secretRef: input().secretRef,
    signingKeyId: 'signing-v1', enabled: true, scope: input().scope, filter: input().filter });
  const audits = await f.db.getRepository(State).createQueryBuilder('s').where('s.id LIKE :prefix', { prefix: 'fixture-audit:%' }).getMany();
  assert.equal(audits.length, 1);
  assert.equal(JSON.stringify(audits).includes('private-secret-ref'), false);
  assert.equal(JSON.stringify(audits).includes('PRIVATE-PATH'), false);
  await assert.rejects(f.create(input({ name: 'changed' }), key), code('IDEMPOTENCY_CONFLICT'));
});

test('idempotency replay rechecks current permission and full current scope', async t => {
  const f = await fixture(t), key = randomUUID(); await f.create(input(), key); f.revoke();
  await assert.rejects(f.create(input(), key), code('FORBIDDEN'));
  const g = await fixture(t), other = randomUUID(); await g.create(input(), other); g.narrow();
  await assert.rejects(g.create(input(), other), code('FORBIDDEN'));
});

test('update enforces If-Match and full replacement while closing the old revision at the new boundary', async t => {
  const f = await fixture(t), created = await f.create(), id = created.result.resourceId;
  await assert.rejects(f.service.update(id, input(), undefined, 'owner'), code('PRECONDITION_REQUIRED'));
  await assert.rejects(f.service.update(id, { name: 'partial' }, created.etag, 'owner'), code('INVALID_QUERY'));
  const updated = await f.service.update(id, input({ name: 'new', signingKeyId: 'signing-v2' }), created.etag, 'owner');
  assert.equal(updated.version, 2);
  const revisions = await f.revisions(id);
  assert.equal(revisions[0].effectiveUntilSequence, revisions[1].effectiveFromSequence);
  assert.equal(revisions[0].config.signingKeyId, 'signing-v1'); assert.equal(revisions[1].config.signingKeyId, 'signing-v2');
  await assert.rejects(f.service.update(id, input(), created.etag, 'owner'), code('PRECONDITION_FAILED'));
});

test('pause and resume persist disabled revision and return the paused sequence gap', async t => {
  const f = await fixture(t), created = await f.create(), id = created.result.resourceId;
  const paused = await f.service.update(id, input({ enabled: false }), created.etag, 'owner');
  assert.equal((await f.row(id)).state, 'paused'); assert.equal(paused.pausedGapRange, null);
  await f.store.transaction(async tx => { tx.nextSequence(); });
  const resumed = await f.service.update(id, input(), paused.etag, 'owner');
  assert.deepEqual(resumed.pausedGapRange, { from: paused.effectiveFromSequence, to: resumed.effectiveFromSequence });
  assert.equal((await f.row(id)).pausedFromSequence, null);
  assert.deepEqual((await f.revisions(id)).map(revision => revision.config.enabled), [true, false, true]);
});

test('remove cancels all queued and in-flight deliveries with version fences but preserves completed deliveries', async t => {
  const f = await fixture(t), created = await f.create(), id = created.result.resourceId;
  const ids = [];
  for (const state of ['pending', 'retry_wait', 'in_flight', 'succeeded']) ids.push(await f.delivery(id, state));
  // Deletion must not depend on a still-available destination/secret authorizer.
  const withoutConfig = new Subscriptions(f.store, f.commands, f.audit, f.owners);
  await withoutConfig.remove(id, created.etag, 'owner');
  for (const deliveryId of ids.slice(0, 3)) {
    const delivery = await f.db.getRepository(Delivery).findOneByOrFail({ id: deliveryId });
    assert.equal(delivery.status, 'cancelled'); assert.equal(delivery.version, 4);
    assert.equal(delivery.leaseOwner, null); assert.equal(delivery.leaseUntil, null);
  }
  assert.equal((await f.db.getRepository(Delivery).findOneByOrFail({ id: ids[3] })).status, 'succeeded');
  assert.equal((await f.revisions(id)).every(revision => revision.revoked), true);
  assert.equal(await f.db.getRepository(Attempt).count(), 4);
});

test('missing or denying configuration authorization fails create/update closed', async t => {
  const f = await fixture(t), missing = new Subscriptions(f.store, f.commands, f.audit, f.owners);
  await assert.rejects(missing.create(input(), f.authorization, randomUUID()), code('OBSERVABILITY_UNAVAILABLE'));
  assert.equal(await f.db.getRepository(Subscription).count(), 0);
  await assert.rejects(f.create(input({ secretRef: 'denied-ref' })), code('FORBIDDEN'));
  const created = await f.create();
  await assert.rejects(missing.update(created.result.resourceId, input(), created.etag, 'owner'), code('OBSERVABILITY_UNAVAILABLE'));
  assert.equal((await f.row(created.result.resourceId)).version, 1);
});

test('foreign owners and partially covered scopes cannot modify subscriptions', async t => {
  const f = await fixture(t), created = await f.create(), id = created.result.resourceId;
  await assert.rejects(f.service.update(id, input(), created.etag, 'stranger'), code('NOT_FOUND'));
  await assert.rejects(f.service.remove(id, created.etag, 'stranger'), code('NOT_FOUND'));
  await assert.rejects(f.create(input({ scope: { mode: 'assets', runtimeAssetIds: ['asset-a', 'asset-b'] } })), code('FORBIDDEN'));
  f.narrow(); await assert.rejects(f.service.remove(id, created.etag, 'owner'), code('FORBIDDEN'));
});

test('version exhaustion and audit failure roll back the mutation transaction', async t => {
  const f = await fixture(t); f.audit.fail = true;
  await assert.rejects(f.create(), /fixture-audit-failure/); assert.equal(await f.db.getRepository(Subscription).count(), 0);
  f.audit.fail = false; const created = await f.create(), id = created.result.resourceId;
  await f.change(Subscription, id, { version: 2147483647 });
  await assert.rejects(f.service.update(id, input(), observabilityEtag('subscription:' + id, 2147483647), 'owner'), code('OBSERVABILITY_UNAVAILABLE'));
});

test('subscription detail exposes only a safe origin, current signing key and reference-only secret flag', async t => {
  const f = await fixture(t), created = await f.create(), id = created.result.resourceId;
  const { data } = await f.query.detail(id, 'owner');
  assert.deepEqual(Object.keys(data).sort(), ['id', 'name', 'version', 'etag', 'state', 'destination', 'signingKeyId',
    'secretConfigured', 'secretConfigurationMeaning', 'scope', 'filter', 'effectiveFromSequence', 'createdAt', 'updatedAt', 'pausedFromSequence'].sort());
  assert.deepEqual(data.destination, { type: 'webhook', origin: 'https://receiver.example.invalid' });
  assert.equal(data.signingKeyId, 'signing-v1'); assert.equal(data.secretConfigured, true);
  assert.equal(data.secretConfigurationMeaning, 'reference_only');
  assert.equal(JSON.stringify(data).includes('PRIVATE-PATH'), false); assert.equal(JSON.stringify(data).includes('private-secret-ref'), false);
  await f.service.update(id, input({ signingKeyId: 'signing-v2' }), created.etag, 'owner');
  assert.equal((await f.query.detail(id, 'owner')).data.signingKeyId, 'signing-v2');
  await assert.rejects(f.query.detail(id, 'stranger'), code('NOT_FOUND'));
  f.narrow(); await assert.rejects(f.query.detail(id, 'owner'), code('NOT_FOUND'));
});

test('delivery detail whitelist omits lease, event payload, response summaries and raw errors', async t => {
  const f = await fixture(t), created = await f.create(), id = await f.delivery(created.result.resourceId);
  const detail = await f.deliveryQuery.detail(id, { take: 1 }, 'owner');
  assert.deepEqual(Object.keys(detail).sort(), ['id', 'subscriptionId', 'subscriptionRevision', 'eventId', 'status', 'version',
    'attemptCount', 'replayGeneration', 'nextAttemptAt', 'createdAt', 'updatedAt', 'expiresAt', 'errorCode',
    'suspendedBySubscription', 'attempts', 'hasMoreAttempts', 'nextAfterAttemptNo'].sort());
  assert.deepEqual(Object.keys(detail.attempts[0]).sort(), ['attemptNo', 'startedAt', 'completedAt', 'result', 'durationMs', 'httpStatus', 'errorCode'].sort());
  assert.equal(detail.errorCode, 'DELIVERY_ERROR'); assert.equal(detail.attempts[0].errorCode, 'DELIVERY_ERROR');
  for (const secret of ['PRIVATE-LEASE', 'EVENT-SECRET', 'PRIVATE-RESPONSE', 'RAW-ERROR-SECRET', 'SECRET-MESSAGE', 'private-secret-ref']) {
    assert.equal(JSON.stringify(detail).includes(secret), false);
  }
  await assert.rejects(f.deliveryQuery.detail(id, {}, 'stranger'), code('NOT_FOUND'));
  await f.change(Subscription, created.result.resourceId, { state: 'paused' });
  assert.equal((await f.deliveryQuery.detail(id, {}, 'owner')).suspendedBySubscription, true);
  assert.equal((await f.db.getRepository(Delivery).findOneByOrFail({ id })).status, 'pending');
});
