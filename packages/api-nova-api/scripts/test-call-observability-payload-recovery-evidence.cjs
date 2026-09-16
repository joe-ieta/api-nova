'use strict';
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, project: require('node:path').resolve(__dirname, '../tsconfig.json') });
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const load = name => require('../src/' + name + '.ts');
const entities = load('database/entities/runtime-call-observability.entity');
const { RuntimeObservabilityEventEntity: Event } = load('database/entities/runtime-observability-event.entity');
const { CallObservabilityStore } = load('modules/call-observability/call-observability.store');
const { CallObservabilityPayloadStore } = load('modules/call-observability/call-observability-payload.store');
const { PayloadRecoveryEvidenceService } = load('modules/call-observability/call-observability-payload-recovery-evidence');
const { PayloadQuotaPrimitives } = load('modules/call-observability/call-observability-payload-quota');
const parent = path.resolve(__dirname, '../../../tmp/observability-payload-recovery-evidence-tests');

async function fixture(t) {
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'run-'));
  const previous = process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  process.env.API_NOVA_OBSERVABILITY_DATA_DIR = directory;
  const payloads = new CallObservabilityPayloadStore();
  if (previous === undefined) delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  else process.env.API_NOVA_OBSERVABILITY_DATA_DIR = previous;
  const db = await new DataSource({ type: 'sqljs', synchronize: true,
    entities: [...entities.CALL_OBSERVABILITY_ENTITIES, Event] }).initialize();
  const store = new CallObservabilityStore(db, payloads);
  const ownerId = await store.ensurePayloadStorage();
  const quota = new PayloadQuotaPrimitives();
  const ledger = await store.transaction(tx => quota.initialize(tx,
    { enabled: true, quotaBytes: 1000, maxBodyBytes: 500 }));
  const evidence = new PayloadRecoveryEvidenceService(store, payloads);
  t.after(async () => {
    if (db.isInitialized) await db.destroy();
    await payloads.onModuleDestroy();
    const target = path.resolve(directory);
    if (path.dirname(target) !== parent || !path.basename(target).startsWith('run-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(target, { recursive: true, force: true });
  });
  const object = async (shard, data = 'x', suffix = '') => {
    const label = shard.toString(16).padStart(2, '0');
    const id = label + '0'.repeat(62);
    const folder = path.join(directory, 'payloads', label);
    await fs.mkdir(folder, { recursive: true });
    const file = path.join(folder, id + '.body' + suffix);
    await fs.writeFile(file, data);
    return { id, key: label + '/' + id + '.body' + suffix, file };
  };
  const reserve = async (id, state = 'uncertain', epoch = ledger.epoch) =>
    db.getRepository(entities.RuntimePayloadQuotaReservationEntity).insert({
      id: id.repeat(64), ownerId, operationId: 'publish:' + id.repeat(64),
      epoch, generation: '0', requestHash: 'f'.repeat(64), reservedBytes: '100',
      committedBytes: null, state, settlementHash: null, updatedAt: new Date().toISOString(),
    });
  return { db, store, payloads, ownerId, quota, ledger, evidence, directory, object, reserve };
}

test('known empty managed root yields zero observed bytes without mutating ledger', async t => {
  const f = await fixture(t);
  const before = await f.db.getRepository(entities.RuntimePayloadQuotaLedgerEntity).findOneByOrFail({ ownerId: f.ownerId });
  const result = await f.evidence.inspect();
  assert.equal(result.status, 'observed');
  assert.equal(result.traversal, 'complete');
  assert.equal(result.unknownOccupancy, false);
  assert.equal(result.observedBytes, 0);
  assert.equal(result.measurement, 'observed_paths_only');
  assert.equal(result.totalOccupancyBytes, null);
  assert.equal(result.reservationObjectCorrelation, 'unavailable');
  assert.equal(result.quotaEnforced, false);
  const after = await f.db.getRepository(entities.RuntimePayloadQuotaLedgerEntity).findOneByOrFail({ ownerId: f.ownerId });
  assert.deepEqual(after, before);
});

test('final file with no metadata is only an orphan candidate; a dangling reference makes it unknown', async t => {
  const f = await fixture(t);
  const file = await f.object(0, 'orphan');
  const first = await f.evidence.inspect();
  assert.equal(first.files[0].classification, 'orphan_candidate');
  assert.equal(first.files[0].sizeBytes, 6);
  assert.equal(first.unknownOccupancy, true);
  assert.equal(first.observedBytes, 6);
  assert.equal(first.totalOccupancyBytes, null);
  const now = new Date().toISOString();
  await f.db.getRepository(entities.RuntimeInvocationEntity).insert({
    invocationId: randomUUID(), sourceInstanceId: 'source', sourceRecordVersion: 1, recordVersion: 1,
    recordHash: 'a'.repeat(64), createdSequence: '1', updatedSequence: '1',
    serverType: 'gateway', spanKind: 'http_ingress', origin: 'test', startedAt: now,
    phase: 'complete', requestPayloadId: file.id, responsePayloadId: null, record: {},
    expiresAt: now, ingestedAt: now,
  });
  const protectedEvidence = await f.evidence.inspect();
  assert.equal(protectedEvidence.files[0].classification, 'unknown');
  assert.equal(protectedEvidence.files[0].referencePresent, true);
});

test('metadata path and measured length can match, but damaged metadata remains unknown', async t => {
  const f = await fixture(t);
  const file = await f.object(0, 'abc');
  const repo = f.db.getRepository(entities.RuntimePayloadEntity);
  const now = new Date().toISOString();
  await repo.insert({ id: file.id, invocationId: randomUUID(), side: 'request',
    state: 'captured', reason: null, fileKey: file.key, digest: 'b'.repeat(64),
    metadata: { storedBytes: 3 }, createdAt: now, expiresAt: now });
  const unreferenced = await f.evidence.inspect();
  assert.equal(unreferenced.files[0].classification, 'metadata_orphan_candidate');
  assert.equal(unreferenced.files[0].referencePresent, false);
  assert.equal(unreferenced.unknownOccupancy, true);
  const invocationId = randomUUID();
  await f.db.getRepository(entities.RuntimeInvocationEntity).insert({
    invocationId, sourceInstanceId: 'source', sourceRecordVersion: 1, recordVersion: 1,
    recordHash: 'a'.repeat(64), createdSequence: '1', updatedSequence: '1',
    serverType: 'gateway', spanKind: 'http_ingress', origin: 'test', startedAt: now,
    phase: 'complete', requestPayloadId: file.id, responsePayloadId: null, record: {},
    expiresAt: now, ingestedAt: now,
  });
  assert.equal((await f.evidence.inspect()).files[0].classification, 'metadata_match_unverified');
  await repo.update({ id: file.id }, { metadata: { storedBytes: 2 } });
  const damaged = await f.evidence.inspect();
  assert.equal(damaged.files[0].classification, 'unknown');
  assert.equal(damaged.unknownOccupancy, true);
});

test('actual temporary naming, unexpected file, and unreadable object all preserve unknown occupation', async t => {
  const f = await fixture(t);
  await f.object(0, 'tmp', '.' + randomUUID() + '.tmp');
  await fs.writeFile(path.join(f.directory, 'payloads', '00', 'unexpected.bin'), 'unknown');
  const observed = await f.evidence.inspect();
  assert.ok(observed.files.some(x => x.classification === 'temporary_unknown' && x.sizeBytes === 3));
  assert.ok(observed.files.some(x => x.classification === 'unknown' && x.sizeBytes === null));
  assert.equal(observed.unknownOccupancy, true);
  const original = f.payloads.candidatePath.bind(f.payloads);
  f.payloads.candidatePath = async () => { const error = new Error('denied'); error.code = 'EACCES'; throw error; };
  const denied = await f.evidence.inspect();
  assert.ok(denied.files.every(x => x.classification === 'unknown'));
  assert.equal(denied.unknownOccupancy, true);
  f.payloads.candidatePath = original;
  const originalScan = f.payloads.scanRecoveryPaths.bind(f.payloads);
  f.payloads.scanRecoveryPaths = async () => { const error = new Error('root denied'); error.code = 'EACCES'; throw error; };
  const rootDenied = await f.evidence.inspect();
  assert.equal(rootDenied.traversal, 'unknown');
  assert.equal(rootDenied.observedBytes, null);
  assert.equal(rootDenied.totalOccupancyBytes, null);
  assert.equal(rootDenied.unknownOccupancy, true);
  f.payloads.scanRecoveryPaths = originalScan;
});

test('unsettled reservations remain unknown and cannot be paired with an orphan by hash', async t => {
  const f = await fixture(t);
  await f.object(0, 'four');
  await f.reserve('a');
  const evidence = await f.evidence.inspect();
  assert.equal(evidence.files[0].classification, 'orphan_candidate');
  assert.equal(evidence.reservations[0].occupancy, 'unknown');
  assert.equal(evidence.reservations[0].reservedBytes, '100');
  assert.equal(evidence.reservationObjectCorrelation, 'unavailable');
  assert.equal(evidence.unknownOccupancy, true);
  assert.equal(await f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity).count(), 1);
});

test('bounded file and reservation pages return partial/unknown rather than a false zero', async t => {
  const f = await fixture(t);
  await f.object(0, 'a');
  await f.object(1, 'b');
  await f.reserve('a');
  await f.reserve('b');
  const evidence = await f.evidence.inspect({ maxEntriesPerBatch: 1, maxBatches: 1, maxReservations: 1 });
  assert.equal(evidence.traversal, 'partial');
  assert.equal(evidence.unknownOccupancy, true);
  assert.equal(evidence.reservationsHasMore, true);
  assert.equal(evidence.reservations.length, 1);
  assert.ok(evidence.observedBytes >= 0);
  assert.equal(evidence.totalOccupancyBytes, null);
});
test('historical invocation reference prevents a metadata-backed file from being marked orphan', async t => {
  const f = await fixture(t);
  const file = await f.object(0, 'history');
  const now = new Date().toISOString();
  const invocationId = randomUUID();
  await f.db.getRepository(entities.RuntimePayloadEntity).insert({
    id: file.id, invocationId, side: 'response', state: 'captured',
    reason: null, fileKey: file.key, digest: 'b'.repeat(64),
    metadata: { storedBytes: 7 }, createdAt: now, expiresAt: now,
  });
  await f.db.getRepository(entities.RuntimeInvocationRevisionEntity).insert({
    id: randomUUID(), invocationId, sourceInstanceId: 'source', sourceRecordVersion: 1,
    recordVersion: 1, recordHash: 'a'.repeat(64), createdSequence: '1', updatedSequence: '2',
    serverType: 'gateway', spanKind: 'http_ingress', origin: 'test', startedAt: now,
    phase: 'complete', requestPayloadId: null, responsePayloadId: file.id, record: {},
    expiresAt: now, ingestedAt: now, validFromSequence: '1', validUntilSequence: '2',
  });
  const report = await f.evidence.inspect();
  assert.equal(report.files[0].classification, 'metadata_match_unverified');
  assert.equal(report.files[0].referencePresent, true);
  assert.equal(report.totalOccupancyBytes, null);
});

test('damaged ledger returns unknown evidence, never a zero total', async t => {
  const f = await fixture(t);
  await f.db.getRepository(entities.RuntimePayloadQuotaLedgerEntity)
    .update({ ownerId: f.ownerId }, { committedBytes: 'broken' });
  const report = await f.evidence.inspect();
  assert.equal(report.status, 'observed');
  assert.equal(report.traversal, 'unknown');
  assert.equal(report.unknownOccupancy, true);
  assert.equal(report.reservationsHasMore, true);
  assert.equal(report.totalOccupancyBytes, null);
});

test('missing managed root is unavailable and evidence inspection never creates it', async t => {
  const f = await fixture(t);
  const absentBase = path.join(f.directory, 'absent-root');
  const previous = process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  process.env.API_NOVA_OBSERVABILITY_DATA_DIR = absentBase;
  const unboundPayloads = new CallObservabilityPayloadStore();
  if (previous === undefined) delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  else process.env.API_NOVA_OBSERVABILITY_DATA_DIR = previous;
  const report = await new PayloadRecoveryEvidenceService(f.store, unboundPayloads).inspect();
  assert.equal(report.status, 'unavailable');
  assert.equal(report.traversal, 'unknown');
  assert.equal(report.unknownOccupancy, true);
  assert.equal(report.observedBytes, null);
  assert.equal(report.totalOccupancyBytes, null);
  await assert.rejects(fs.stat(path.join(absentBase, 'payloads')), { code: 'ENOENT' });
  await unboundPayloads.onModuleDestroy();
});

test('shard directory read failure marks the full evidence unknown', async t => {
  const f = await fixture(t);
  await f.object(0, 'payload');
  const nodeFs = require('node:fs').promises;
  const original = nodeFs.opendir;
  const deniedShard = path.join(f.directory, 'payloads', '00');
  nodeFs.opendir = async function (target, ...args) {
    if (String(target) === deniedShard) {
      const error = new Error('shard denied');
      error.code = 'EACCES';
      throw error;
    }
    return original.call(this, target, ...args);
  };
  try {
    const report = await f.evidence.inspect();
    assert.equal(report.traversal, 'unknown');
    assert.equal(report.unknownOccupancy, true);
    assert.ok(report.files.some(row => row.reason === 'shard_unreadable'));
    assert.equal(report.totalOccupancyBytes, null);
  } finally {
    nodeFs.opendir = original;
  }
});

test('missing database owner remains uninitialized during evidence inspection', async t => {
  const f = await fixture(t);
  const pipeline = f.db.getRepository(entities.RuntimePipelineStateEntity);
  const ownerKey = 'call-observability:payload-owner';
  await pipeline.delete({ id: ownerKey });
  const report = await f.evidence.inspect();
  assert.equal(report.status, 'unavailable');
  assert.equal(report.traversal, 'unknown');
  assert.equal(report.totalOccupancyBytes, null);
  assert.equal(await pipeline.countBy({ id: ownerKey }), 0);
});

test('more than 400 historical references remains bounded and marks metadata evidence unknown', async t => {
  const f = await fixture(t);
  const file = await f.object(0, 'overflow');
  const now = new Date().toISOString();
  await f.db.getRepository(entities.RuntimePayloadEntity).insert({
    id: file.id, invocationId: randomUUID(), side: 'response', state: 'captured',
    reason: null, fileKey: file.key, digest: 'b'.repeat(64),
    metadata: { storedBytes: 8 }, createdAt: now, expiresAt: now,
  });
  const revisions = Array.from({ length: 401 }, () => ({
    id: randomUUID(), invocationId: randomUUID(), sourceInstanceId: 'source',
    sourceRecordVersion: 1, recordVersion: 1, recordHash: 'a'.repeat(64),
    createdSequence: '1', updatedSequence: '2', serverType: 'gateway',
    spanKind: 'http_ingress', origin: 'test', startedAt: now, phase: 'complete',
    requestPayloadId: null, responsePayloadId: file.id, record: {}, expiresAt: now,
    ingestedAt: now, validFromSequence: '1', validUntilSequence: '2',
  }));
  await f.db.getRepository(entities.RuntimeInvocationRevisionEntity).insert(revisions);
  const report = await f.evidence.inspect();
  assert.equal(report.files[0].classification, 'unknown');
  assert.equal(report.traversal, 'unknown');
  assert.equal(report.unknownOccupancy, true);
  assert.equal(report.totalOccupancyBytes, null);
});

test('active writer yields busy evidence without scanning or claiming occupancy', async t => {
  const f = await fixture(t);
  const writer = await f.store.payloadCoordination.acquireWriter();
  try {
    const report = await f.evidence.inspect();
    assert.equal(report.status, 'busy');
    assert.equal(report.reason, 'writer_active');
    assert.equal(report.traversal, 'unknown');
    assert.equal(report.observedBytes, null);
    assert.equal(report.totalOccupancyBytes, null);
    assert.equal(report.files.length, 0);
  } finally {
    await f.store.payloadCoordination.releaseWriter(writer);
  }
});
