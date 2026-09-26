'use strict';
require('ts-node').register({ transpileOnly: true, project: require('path').resolve(__dirname, '../tsconfig.json') });
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ConfigService } = require('@nestjs/config');
const base = '../src/';
const {
  CALL_OBSERVABILITY_ENTITIES,
  RuntimeEventDeletionGapEntity: Gap,
  RuntimeEventDeliveryAttemptEntity: Attempt,
  RuntimeEventDeliveryEntity: Delivery,
  RuntimeObservabilityIdempotencyEntity: Idempotency,
  RuntimePipelineStateEntity: Pipeline,
} = require(base + 'database/entities/runtime-call-observability.entity.ts');
const { RuntimeObservabilityEventEntity: Event } =
  require(base + 'database/entities/runtime-observability-event.entity.ts');
const { CallObservabilityStore } = require(base + 'modules/call-observability/call-observability.store.ts');
const { CallObservabilityLifecycleRetentionService, LIFECYCLE_RETENTION_STATE_ID } =
  require(base + 'modules/call-observability/call-observability-lifecycle-retention.service.ts');
const { lifecycleRetentionWorkerConfiguration } =
  require(base + 'modules/call-observability/call-observability-lifecycle-retention.worker.ts');
const { sequenceKey, publicSequence, DAY_MS } =
  require(base + 'modules/call-observability/call-observability-storage.ts');

const NOW = new Date('2026-09-26T12:00:00.000Z');
const FIXED_NOW = '2026-09-26T12:00:00.000Z';
const at = (days, offset = 0) => new Date(NOW.getTime() - days * DAY_MS + offset).toISOString();

async function seedEvent(repository, store, overrides = {}) {
  return store.transaction(async tx => {
    const row = Object.assign(new Event(), {
      id: randomUUID(), sequence: tx.nextSequence(), schemaVersion: '1.0', eventName: 'invocation.completed',
      runtimeAssetId: 'asset-a', eventFamily: 'runtime.request', severity: 'info', status: 'success',
      actorType: 'runtime', retentionClass: 'standard', subjectId: randomUUID(), subjectVersion: 1,
      occurredAt: new Date(at(60)), createdAt: new Date(at(60)), expiresAt: new Date(at(1)),
      dispatchState: 'pending', details: {}, dimensions: {},
    }, overrides);
    await tx.manager.getRepository(Event).insert(row);
    return row;
  });
}

const options = (overrides = {}) =>
  ({ scanLimit: 100, deleteLimit: 50, now: NOW, events: { enabled: true }, ...overrides });

test('bounded, default-off physical event cleanup end state (OBS-14-03E2B)', async t => {
  const database = new DataSource({ type: 'sqljs', entities: [...CALL_OBSERVABILITY_ENTITIES, Event], synchronize: true });
  await database.initialize();
  t.after(() => database.destroy());
  const store = new CallObservabilityStore(database, {});
  const service = new CallObservabilityLifecycleRetentionService(store);
  const events = database.getRepository(Event);
  const gaps = database.getRepository(Gap);
  const state = async () =>
    (await database.getRepository(Pipeline).findOneBy({ id: LIFECYCLE_RETENTION_STATE_ID }))?.value;
  const detail = { workPackage: 'OBS-14-03E3', database: 'sqljs' };

  // Default off: neither omitting the explicit opt-in nor passing enabled=false writes anything.
  const offRows = [await seedEvent(events, store), await seedEvent(events, store)];
  const watermarkBefore = await store.watermark();
  const omitted = await service.collect({ scanLimit: 100, deleteLimit: 50, now: NOW });
  const refused = await service.collect(options({ events: { enabled: false } }));
  assert.equal('events' in omitted, false);
  assert.equal('events' in refused, false);
  assert.equal(await events.count(), 2);
  assert.equal(await gaps.count(), 0);
  assert.equal((await state())?.events, undefined);
  assert.equal(await store.watermark(), watermarkBefore);
  const defaults = lifecycleRetentionWorkerConfiguration(new ConfigService({}));
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.eventsEnabled, false);
  detail.defaultOff = { runsRefused: 2, survivingEvents: 2, gapRanges: 0,
    cursorAdvanced: false, watermarkUnchanged: true, workerDefaultEventsEnabled: defaults.eventsEnabled };

  // Enabled: the two E2A-eligible rows disappear together with one merged gap and a persisted report.
  const enabledRun = await service.collect(options());
  assert.equal(enabledRun.events.scanned, 2);
  assert.equal(enabledRun.events.deleted, 2);
  assert.equal(enabledRun.events.status, 'completed');
  assert.equal(enabledRun.events.checkpoint, null);
  assert.equal(await events.count(), 0);
  assert.equal(await gaps.count(), 1);
  const [merged] = await gaps.find();
  assert.equal(merged.startSequence, sequenceKey(offRows[0].sequence));
  assert.equal(merged.endSequence, sequenceKey(offRows[1].sequence));
  assert.equal(merged.assetScope, 'asset-a');
  detail.enabled = { scanned: enabledRun.events.scanned, deleted: enabledRun.events.deleted,
    gapRanges: await gaps.count(), checkpointNull: enabledRun.events.checkpoint === null };

  // Atomicity: a blocked delete rolls back the gap and the cursor, and the retry is safe.
  const atomic = await seedEvent(events, store);
  const reportBefore = JSON.stringify((await state())?.events ?? null);
  const gapCountBefore = await gaps.count();
  const watermarkAtAttempt = await store.watermark();
  await database.query('CREATE TRIGGER "block_events_delete" BEFORE DELETE ON "runtime_observability_events" '
    + "BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
  try {
    await assert.rejects(service.collect(options()));
  } finally {
    await database.query('DROP TRIGGER "block_events_delete"');
  }
  assert.equal(await events.count(), 1);
  assert.equal(await gaps.count(), gapCountBefore);
  assert.equal(JSON.stringify((await state())?.events ?? null), reportBefore);
  assert.equal(await store.watermark(), watermarkAtAttempt);
  const retried = await service.collect(options());
  assert.equal(retried.events.deleted, 1);
  assert.equal(await events.count(), 0);
  detail.atomicity = { rolledBack: true, gapRangesAfterFailure: gapCountBefore,
    cursorUnchangedOnFailure: true, retriedDeleted: retried.events.deleted };

  // Protections, asset scope, bounded batches and restart/resume over one fixture.
  const bounded = [];
  for (let index = 0; index < 5; index += 1) bounded.push(await seedEvent(events, store));
  const leased = await seedEvent(events, store, {
    dispatchState: 'leased', dispatchLeaseOwner: 'worker-1', dispatchLeaseUntil: new Date(at(0, 60000)),
  });
  const openEvent = await seedEvent(events, store);
  const openDelivery = randomUUID();
  await database.getRepository(Delivery).insert({
    id: openDelivery, subscriptionId: randomUUID(), subscriptionRevision: 1, eventId: openEvent.id,
    eventSequence: openEvent.sequence, status: 'pending', version: 1, attemptCount: 0, replayGeneration: 0,
    nextAttemptAt: at(31), leaseOwner: null, leaseUntil: null, lastError: {},
    createdAt: at(31), updatedAt: at(31), expiresAt: at(0),
  });
  await database.getRepository(Attempt).insert({
    id: randomUUID(), deliveryId: openDelivery, attemptNo: 1, startedAt: at(31), completedAt: null,
    result: 'permanent_failure', durationMs: 1, httpStatus: null, errorCategory: null, responseSummary: null,
  });
  const backedEvent = await seedEvent(events, store);
  const backedDelivery = randomUUID();
  await database.getRepository(Delivery).insert({
    id: backedDelivery, subscriptionId: randomUUID(), subscriptionRevision: 1, eventId: backedEvent.id,
    eventSequence: backedEvent.sequence, status: 'succeeded', version: 1, attemptCount: 0, replayGeneration: 0,
    nextAttemptAt: at(31), leaseOwner: null, leaseUntil: null, lastError: {},
    createdAt: at(31), updatedAt: at(31), expiresAt: at(0),
  });
  const idempotencyId = randomUUID();
  await database.getRepository(Idempotency).insert({
    id: idempotencyId, ownerId: randomUUID(), requestHash: 'r'.repeat(64),
    response: { scopeFingerprint: 'f'.repeat(64), result: { statusCode: 202, resourceId: backedDelivery, version: 1 } },
    expiresAt: at(0, 60000),
  });
  const hidden = await seedEvent(events, store, { runtimeAssetId: 'hidden-asset' });

  const scopedBounded = { scanLimit: 4, deleteLimit: 2, now: NOW,
    events: { enabled: true, runtimeAssetIds: ['asset-a'] } };
  const firstBatch = await service.collect(scopedBounded);
  assert.equal(firstBatch.events.deleted, 2);
  assert.equal(firstBatch.events.status, 'waiting');
  assert.deepEqual(firstBatch.events.checkpoint, { sequence: publicSequence(bounded[1].sequence) });
  const restarted = new CallObservabilityLifecycleRetentionService(store);
  const secondBatch = await restarted.collect(scopedBounded);
  assert.equal(secondBatch.events.deleted, 2);
  const thirdBatch = await restarted.collect(scopedBounded);
  assert.equal(thirdBatch.events.deleted, 1);
  assert.equal(thirdBatch.events.retainedReasons.lease_active, 1);
  assert.equal(thirdBatch.events.retainedReasons.protected_by_delivery, 2);
  const scopedTail = await restarted.collect(scopedBounded);
  assert.equal(scopedTail.events.deleted, 0);
  assert.equal(scopedTail.events.status, 'completed');
  assert.equal(scopedTail.events.checkpoint, null);
  assert.equal(await events.findOneBy({ id: hidden.id }) !== null, true);
  assert.equal(await events.findOneBy({ id: leased.id }) !== null, true);
  assert.equal(await events.findOneBy({ id: openEvent.id }) !== null, true);
  assert.equal(await events.findOneBy({ id: backedEvent.id }) !== null, true);
  assert.equal(await events.findOneBy({ id: bounded[4].id }), null);
  detail.bounded = { batches: [firstBatch.events.deleted, secondBatch.events.deleted, thirdBatch.events.deleted,
    scopedTail.events.deleted], scanLimit: scopedBounded.scanLimit, deleteLimit: scopedBounded.deleteLimit,
    resumedAcrossInstances: true, tailReset: scopedTail.events.checkpoint === null,
    scopedOutHiddenRows: 1 };

  // Release protections and the hidden scope, then the remaining rows are deleted exactly once.
  await database.getRepository(Attempt).update({ deliveryId: openDelivery }, { completedAt: at(1) });
  await database.getRepository(Idempotency).update({ id: idempotencyId }, { expiresAt: at(1) });
  await database.getRepository(Delivery).update({ id: openDelivery }, { leaseOwner: null, leaseUntil: null });
  await database.getRepository(Event).update({ id: leased.id }, { dispatchLeaseUntil: new Date(at(1)) });
  const released = await service.collect({ scanLimit: 100, deleteLimit: 50, now: NOW,
    events: { enabled: true, runtimeAssetIds: ['asset-a', 'hidden-asset'] } });
  assert.equal(released.events.deleted, 4);
  assert.equal(released.events.retainedReasons.protected_by_delivery, undefined);
  assert.equal(await events.count(), 0);
  const gapRangesAfterRelease = await gaps.count();
  const rerun = await service.collect({ scanLimit: 100, deleteLimit: 50, now: NOW,
    events: { enabled: true, runtimeAssetIds: null } });
  assert.equal(rerun.events.deleted, 0);
  assert.equal(await gaps.count(), gapRangesAfterRelease);
  detail.protections = { leaseProtectedThenDeleted: true, openAttemptProtectedThenDeleted: true,
    validIdempotencyProtectedThenDeleted: true, releasedDeleted: released.events.deleted };
  detail.idempotentRerun = { deleted: rerun.events.deleted, gapRangesUnchanged: true,
    gapRanges: gapRangesAfterRelease };

  process.stdout.write('OBS_14_03E3_DETAIL ' + JSON.stringify(detail) + '\n');
});
