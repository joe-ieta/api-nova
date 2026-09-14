'use strict';

// Isolated B02 projection recovery tests. Never load configured business DB options.
process.env.DB_TYPE = 'sqlite';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DataSource } = require('typeorm');
const entities = require('../dist/src/database/entities/runtime-call-observability.entity.js');
const { RuntimeObservabilityEventEntity } =
  require('../dist/src/database/entities/runtime-observability-event.entity.js');
const { CallObservabilityStore } =
  require('../dist/src/modules/call-observability/call-observability.store.js');
const { CallObservabilityPayloadStore } =
  require('../dist/src/modules/call-observability/call-observability-payload.store.js');

const workspace = path.resolve(__dirname, '../../..');
const temporaryRoot = path.join(workspace, 'tmp', 'observability-bucket-projection-tests');
const hash = value => createHash('sha256').update(value).digest('hex');

const body = (data = '{"ok":true}') => ({
  state: 'complete', contentType: 'application/json', encoding: 'utf8',
  data, totalBytes: Buffer.byteLength(data), capturedBytes: Buffer.byteLength(data),
  sha256: hash(data), redacted: true,
});
const missingBody = () => ({ state: 'unavailable', reason: 'not_captured' });

function evidence(overrides = {}) {
  const invocationId = randomUUID();
  const startedAt = new Date(Date.now() - 1000).toISOString();
  return {
    schemaVersion: 2, invocationId, eventId: randomUUID(), sourceInstanceId: randomUUID(),
    sourceSequence: 1, recordVersion: 1, phase: 'started',
    requestId: randomUUID(), traceId: invocationId, rootInvocationId: invocationId,
    kind: 'admission', spanKind: 'gateway_request', transport: 'gateway',
    serverType: 'gateway', protocolTransport: 'http', origin: 'external',
    runtimeAssetId: randomUUID(), identitySource: 'authenticated',
    callerId: 'caller-recovery', credentialId: 'credential-recovery',
    startedAt, method: 'GET', path: '/sample',
    byteMeasurement: 'observed_body', measurementStage: 'gateway_ingress',
    request: body(), response: missingBody(),
    ...overrides,
  };
}

function terminal(start, overrides = {}) {
  return {
    ...start, eventId: randomUUID(), sourceSequence: start.sourceSequence + 1,
    recordVersion: start.recordVersion + 1, phase: 'finished',
    completedAt: new Date().toISOString(), durationMs: 25,
    outcome: 'success', statusCode: 200,
    response: body('{"result":"ok"}'),
    ...overrides,
  };
}

function checkpoint(previousOffset = '0', byteOffset = '100', seed = randomUUID()) {
  const fileName = 'calls-v2-2026-09-13-' + seed + '.jsonl';
  return {
    id: hash(fileName),
    fileName,
    fileIdentity: 'fixture:' + seed,
    previousOffset,
    byteOffset,
  };
}

async function fixture(t) {
  await fs.mkdir(temporaryRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'run-'));
  const oldDirectory = process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  process.env.API_NOVA_OBSERVABILITY_DATA_DIR = directory;
  const databasePath = path.join(directory, 'observability.sqlite');
  const payloads = new CallObservabilityPayloadStore();
  if (oldDirectory === undefined) delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  else process.env.API_NOVA_OBSERVABILITY_DATA_DIR = oldDirectory;
  const database = new DataSource({
    type: 'sqljs', location: databasePath, autoSave: true,
    entities: [...entities.CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity],
    synchronize: true, logging: false,
  });
  t.after(async () => {
    if (database.isInitialized) await database.destroy();
    const target = path.resolve(directory);
    if (path.dirname(target) !== temporaryRoot || !path.basename(target).startsWith('run-')) {
      throw new Error('Refusing to delete a non-owned test directory');
    }
    await fs.rm(target, { recursive: true, force: true });
  });
  await database.initialize();
  const store = new CallObservabilityStore(database, payloads);
  return {
    database,
    payloads,
    store,
    repository: entity => database.getRepository(entity),
    directory,
    databasePath,
  };
}

async function reopen(directory) {
  const oldDirectory = process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  process.env.API_NOVA_OBSERVABILITY_DATA_DIR = directory;
  const payloads = new CallObservabilityPayloadStore();
  if (oldDirectory === undefined) delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  else process.env.API_NOVA_OBSERVABILITY_DATA_DIR = oldDirectory;
  const database = new DataSource({
    type: 'sqljs', location: path.join(directory, 'observability.sqlite'), autoSave: true,
    entities: [...entities.CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity],
    synchronize: true, logging: false,
  });
  await database.initialize();
  const store = new CallObservabilityStore(database, payloads);
  return {
    database,
    payloads,
    store,
    repository: entity => database.getRepository(entity),
  };
}

test('failed B02 projection hook rolls back contribution, dirty buckets and all related writes', async t => {
  const f = await fixture(t);
  const cp = checkpoint();
  const start = evidence();
  await assert.rejects(() => f.store.ingest(terminal(start), { checkpoint: cp }, async () => {
    throw new Error('b02 projection failure');
  }), /b02 projection failure/);
  for (const entity of [
    entities.RuntimeIngestReceiptEntity,
    entities.RuntimeInvocationEntity,
    entities.RuntimeInvocationRevisionEntity,
    entities.RuntimeMetricContributionEntity,
    entities.RuntimeMetricBucketEntity,
    entities.RuntimeCallerBucketEntity,
    entities.RuntimePayloadEntity,
    entities.RuntimeIngestCheckpointEntity,
    RuntimeObservabilityEventEntity,
  ]) {
    assert.equal(await f.repository(entity).count(), 0, entity.name);
  }
  assert.equal(await f.store.watermark(), '0');
});

test('concurrent old-version replay only commits one projection and one dirty-set set', async t => {
  const f = await fixture(t);
  const cp = checkpoint();
  const replay = evidence();
  const finished = terminal(replay);
  const results = await Promise.all(Array.from({ length: 8 }, () => f.store.ingest(finished, { checkpoint: cp })));
  assert.equal(results.filter(result => result.status === 'inserted').length, 1);
  assert.equal(results.filter(result => result.status === 'duplicate').length, 7);
  assert.equal(await f.repository(entities.RuntimeInvocationEntity).count(), 1);
  assert.equal(await f.repository(entities.RuntimeInvocationRevisionEntity).count(), 1);
  assert.equal(await f.repository(entities.RuntimeMetricContributionEntity).count(), 1);
  assert.equal(await f.repository(entities.RuntimeMetricBucketEntity).count(), 16);
  assert.equal(await f.repository(entities.RuntimeCallerBucketEntity).count(), 16);
  const marker = (await f.repository(entities.RuntimeMetricBucketEntity).find({ order: { id: 'ASC' } }))[0];
  assert.equal(marker.metrics.recompute.state, 'pending');
  assert.equal(marker.version, 0);
  assert.equal(await f.repository(RuntimeObservabilityEventEntity).count(), 1);
  assert.equal(await f.store.watermark(), '1');
});

test('stale older versions cannot add projection rows or dirty markers again', async t => {
  const f = await fixture(t);
  const start = evidence();
  await f.store.ingest(start);
  await f.store.ingest(terminal(start));
  const before = {
    invocation: await f.repository(entities.RuntimeInvocationEntity).count(),
    revision: await f.repository(entities.RuntimeInvocationRevisionEntity).count(),
    contribution: await f.repository(entities.RuntimeMetricContributionEntity).count(),
    bucket: await f.repository(entities.RuntimeMetricBucketEntity).count(),
    callerBucket: await f.repository(entities.RuntimeCallerBucketEntity).count(),
    events: await f.repository(RuntimeObservabilityEventEntity).count(),
  };
  const stale = await f.store.ingest({
    ...start, eventId: randomUUID(), sourceSequence: 3, recordVersion: 1, phase: 'progress',
  });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.recordVersion, 2);
  assert.equal(await f.repository(entities.RuntimeInvocationEntity).count(), before.invocation);
  assert.equal(await f.repository(entities.RuntimeInvocationRevisionEntity).count(), before.revision);
  assert.equal(await f.repository(entities.RuntimeMetricContributionEntity).count(), before.contribution);
  assert.equal(await f.repository(entities.RuntimeMetricBucketEntity).count(), before.bucket);
  assert.equal(await f.repository(entities.RuntimeCallerBucketEntity).count(), before.callerBucket);
  assert.equal(await f.repository(RuntimeObservabilityEventEntity).count(), before.events);
});

test('reopened process replays duplicate evidence as no-op and preserves dirty markers', async t => {
  const f = await fixture(t);
  const cp = checkpoint();
  const row = terminal(evidence());
  const first = await f.store.ingest(row, { checkpoint: cp });
  assert.equal(first.status, 'inserted');
  const beforeContribution = await f.repository(entities.RuntimeMetricContributionEntity)
    .findOneByOrFail({ invocationId: row.invocationId });
  const beforeBuckets = await f.repository(entities.RuntimeMetricBucketEntity).find({ order: { id: 'ASC' } });
  const beforeCallerBuckets = await f.repository(entities.RuntimeCallerBucketEntity).find({ order: { id: 'ASC' } });
  const beforeSignatures = {
    metricBuckets: beforeBuckets.map(item => item.id),
    callerBuckets: beforeCallerBuckets.map(item => item.id),
    markerDigest: beforeBuckets.map(item => JSON.stringify(item.metrics)).join('|'),
    callerDigest: beforeCallerBuckets.map(item => JSON.stringify(item.metrics)).join('|'),
  };
  await f.database.destroy();
  const reopened = await reopen(f.directory);
  try {
    const replay = await reopened.store.ingest(row, { checkpoint: cp });
    assert.equal(replay.status, 'duplicate');
    const afterBuckets = await reopened.repository(entities.RuntimeMetricBucketEntity).find({ order: { id: 'ASC' } });
    const afterCallerBuckets = await reopened.repository(entities.RuntimeCallerBucketEntity).find({ order: { id: 'ASC' } });
    const afterContribution = await reopened.repository(entities.RuntimeMetricContributionEntity)
      .findOneByOrFail({ invocationId: row.invocationId });
    assert.equal(await reopened.repository(entities.RuntimeInvocationEntity).count(), 1);
    assert.equal(await reopened.repository(entities.RuntimeInvocationRevisionEntity).count(), 1);
    assert.equal(await reopened.repository(entities.RuntimeMetricContributionEntity).count(), 1);
    assert.equal(afterContribution.recordVersion, beforeContribution.recordVersion);
    assert.equal(afterBuckets.map(item => item.id).join('|'), beforeSignatures.metricBuckets.join('|'));
    assert.equal(afterCallerBuckets.map(item => item.id).join('|'), beforeSignatures.callerBuckets.join('|'));
    assert.equal(afterBuckets.map(item => JSON.stringify(item.metrics)).join('|'), beforeSignatures.markerDigest);
    assert.equal(afterCallerBuckets.map(item => JSON.stringify(item.metrics)).join('|'), beforeSignatures.callerDigest);
    assert.equal(await reopened.repository(entities.RuntimeMetricBucketEntity).count(), beforeBuckets.length);
    assert.equal(await reopened.repository(entities.RuntimeCallerBucketEntity).count(), beforeCallerBuckets.length);
  } finally {
    await reopened.database.destroy();
  }
});

test('recomputePendingBuckets materializes pending metric/caller buckets and bumps versions', async t => {
  const f = await fixture(t);
  const row = terminal(evidence());
  await f.store.ingest(row);
  const metricRepository = f.repository(entities.RuntimeMetricBucketEntity);
  const callerRepository = f.repository(entities.RuntimeCallerBucketEntity);
  const metricBuckets = await metricRepository.find({ order: { id: 'ASC' } });
  const callerBuckets = await callerRepository.find({ order: { id: 'ASC' } });
  assert.equal(metricBuckets.length > 0, true);
  assert.equal(callerBuckets.length > 0, true);
  const metricBefore = metricBuckets[0];
  const callerBefore = callerBuckets[0];
  assert.equal(typeof metricBefore.dataWatermark, 'string');
  const summary = await f.store.recomputePendingBuckets();
  assert.equal(summary.recomputed >= 2, true);
  const metricAfter = await metricRepository.findOneByOrFail({ id: metricBefore.id });
  const callerAfter = await callerRepository.findOneByOrFail({ id: callerBefore.id });
  assert.equal(metricAfter.version, metricBefore.version + 1);
  assert.equal(callerAfter.version, callerBefore.version + 1);
  assert.equal(metricAfter.metrics?.recompute, undefined);
  assert.equal(callerAfter.metrics?.recompute, undefined);
  assert.equal(metricAfter.metrics?.metrics && typeof metricAfter.metrics.metrics === 'object', true);
  assert.equal(metricAfter.metrics?.coverage && typeof metricAfter.metrics.coverage === 'object', true);
  assert.equal(callerAfter.metrics?.metrics && typeof callerAfter.metrics.metrics === 'object', true);
  assert.equal(callerAfter.metrics?.coverage && typeof callerAfter.metrics.coverage === 'object', true);
  assert.equal(BigInt(metricAfter.dataWatermark), BigInt(metricBefore.dataWatermark) + BigInt(1));
  assert.equal(summary.failed, 0);
});

test('bucket events advance versions, survive restart and are idempotent', async t => {
  const f = await fixture(t);
  const start = evidence();
  await f.store.ingest(start, { suppressEvent: true });
  const first = await f.store.recomputePendingBuckets();
  const repo = f.repository(RuntimeObservabilityEventEntity);
  const events = await repo.findBy({ eventName: 'metrics.bucket_updated' });
  assert.equal(events.length, first.recomputed);
  assert.equal(new Set(events.map(event => event.sequence)).size, events.length);
  assert.ok(events.every(event => event.subjectVersion === 1 && event.dispatchState === 'suppressed'));
  await f.store.ingest(terminal(start));
  await f.store.ingest(evidence({ startedAt: start.startedAt, runtimeAssetId: start.runtimeAssetId }), { suppressEvent: true });
  await f.store.recomputePendingBuckets();
  for (const event of events) {
    const revisions = await repo.find({ where: { subjectId: event.subjectId }, order: { sequence: 'ASC' } });
    assert.deepEqual(revisions.map(item => item.subjectVersion), [1, 2]);
    assert.equal(revisions[1].dispatchState, 'pending');
    assert.equal(revisions[1].details.bucketVersion, 2);
    assert.equal(revisions[1].details.request, undefined);
  }
  const count = await repo.count();
  const watermark = await f.store.watermark();
  assert.deepEqual(await f.store.recomputePendingBuckets(), { recomputed: 0, failed: 0 });
  assert.equal(await f.store.watermark(), watermark);
  await f.database.destroy();
  const restarted = await reopen(f.directory);
  try {
    await restarted.store.recomputePendingBuckets();
    assert.equal(await restarted.repository(RuntimeObservabilityEventEntity).count(), count);
  } finally { await restarted.database.destroy(); }
});

test('event insert failure rolls back buckets and sequence for retry', async t => {
  const f = await fixture(t);
  await f.store.ingest(terminal(evidence()));
  const watermark = await f.store.watermark();
  await f.database.query("CREATE TRIGGER reject_bucket_event BEFORE INSERT ON runtime_observability_events WHEN NEW.eventName = 'metrics.bucket_updated' BEGIN SELECT RAISE(ABORT, 'fixture event failure'); END");
  await assert.rejects(() => f.store.recomputePendingBuckets(), /fixture event failure/);
  assert.equal(await f.store.watermark(), watermark);
  const buckets = await f.repository(entities.RuntimeMetricBucketEntity).find();
  assert.ok(buckets.every(row => row.version === 0 && row.metrics.recompute.state === 'pending'));
  assert.equal(await f.repository(RuntimeObservabilityEventEntity).countBy({ eventName: 'metrics.bucket_updated' }), 0);
  await f.database.query('DROP TRIGGER reject_bucket_event');
  assert.equal((await f.store.recomputePendingBuckets()).failed, 0);
});

test('recomputePendingBuckets skips malformed markers and keeps invalid rows in pending state', async t => {
  const f = await fixture(t);
  const row = terminal(evidence());
  await f.store.ingest(row);
  const metricRepository = f.repository(entities.RuntimeMetricBucketEntity);
  const callerRepository = f.repository(entities.RuntimeCallerBucketEntity);
  const metricBuckets = await metricRepository.find({ order: { id: 'ASC' } });
  const callerBuckets = await callerRepository.find({ order: { id: 'ASC' } });
  const [firstMetric, secondMetric, firstCaller] = [metricBuckets[0], metricBuckets[1], callerBuckets[0]];
  assert.equal(typeof secondMetric.dataWatermark, 'string');
  await metricRepository.save({
    ...firstMetric,
    version: firstMetric.version,
    metrics: { recompute: { state: 'pending', action: 'replace' }, bad: true },
  });
  const metricBefore = secondMetric;
  const callerBefore = firstCaller;
  assert.equal(typeof callerBefore.version, 'number');
  const summary = await f.store.recomputePendingBuckets();
  assert.equal(summary.failed >= 1, true);
  assert.equal(summary.recomputed >= 1, true);
  const metricInvalid = await metricRepository.findOneByOrFail({ id: firstMetric.id });
  const metricRecovered = await metricRepository.findOneByOrFail({ id: secondMetric.id });
  const callerRecovered = await callerRepository.findOneByOrFail({ id: firstCaller.id });
  assert.equal(metricInvalid.metrics?.recompute?.state, 'pending');
  assert.equal(metricInvalid.metrics?.recompute?.action, 'replace');
  assert.equal(metricRecovered.version, metricBefore.version + 1);
  assert.equal(metricRecovered.metrics?.recompute, undefined);
  assert.equal(callerRecovered.version, callerBefore.version + 1);
  assert.equal(callerRecovered.metrics?.recompute, undefined);
});
