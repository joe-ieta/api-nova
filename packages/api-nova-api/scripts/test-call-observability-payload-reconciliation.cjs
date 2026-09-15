'use strict';
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, project: require('path').resolve(__dirname, '../tsconfig.json') });
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ConfigService } = require('@nestjs/config');
const source = file => require('../src/' + file + '.ts');
const entities = source('database/entities/runtime-call-observability.entity');
const { RuntimeObservabilityEventEntity: Event } = source('database/entities/runtime-observability-event.entity');
const { CallObservabilityStore } = source('modules/call-observability/call-observability.store');
const { CallObservabilityPayloadStore } = source('modules/call-observability/call-observability-payload.store');
const { CallObservabilityGarbageService, PAYLOAD_METADATA_RECONCILIATION_ID } = source('modules/call-observability/call-observability-garbage.service');
const { CallObservabilityRetentionWorker, RETENTION_WORKER_ID } = source('modules/call-observability/call-observability-retention.worker');
const { payloadCapacityView } = source('modules/call-observability/call-observability-payload-capacity.dto');
const root = path.resolve(__dirname, '../../../tmp/observability-payload-reconciliation-tests');
async function fixture(t) {
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'run-'));
  const old = process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  process.env.API_NOVA_OBSERVABILITY_DATA_DIR = directory;
  const objects = new CallObservabilityPayloadStore();
  if (old === undefined) delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR; else process.env.API_NOVA_OBSERVABILITY_DATA_DIR = old;
  const db = new DataSource({ type: 'sqljs', synchronize: true, logging: false, entities: [...entities.CALL_OBSERVABILITY_ENTITIES, Event] });
  await db.initialize();
  const store = new CallObservabilityStore(db, objects), gc = new CallObservabilityGarbageService(store, objects);
  const worker = new CallObservabilityRetentionWorker(gc, store, new ConfigService({ API_NOVA_OBSERVABILITY_RETENTION_ENABLED: 'true',
    API_NOVA_OBSERVABILITY_RETENTION_INTERVAL_MS: '1000', API_NOVA_OBSERVABILITY_RETENTION_GRACE_MS: '60000' }));
  t.after(async () => {
    await worker.onModuleDestroy(); await objects.onModuleDestroy(); if (db.isInitialized) await db.destroy();
    const target = path.resolve(directory);
    if (path.dirname(target) !== root || !path.basename(target).startsWith('run-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(target, { recursive: true, force: true });
  });
  async function file(data = '123456', persist = true) {
    await store.ensurePayloadStorage();
    const bytes = Buffer.byteLength(data);
    const body = { state: 'captured', reason: null, data, contentType: 'text/plain', encoding: 'utf8',
      observedBytes: bytes, capturedBytes: bytes, storedBytes: bytes, capturedDigest: createHash('sha256').update(data).digest('hex'),
      digestScope: 'observed_raw', redacted: true, redactionPolicyVersion: 'default-v1' };
    const prepared = await store.payloadCoordination.withWriter(lease => objects.prepare({ sourceInstanceId: randomUUID(),
      invocationId: randomUUID(), side: 'request' }, body, new Date().toISOString(), new Date(Date.now() + 86400000).toISOString(), lease.generation));
    if (persist) await db.getRepository(entities.RuntimePayloadEntity).save(prepared.entity);
    return prepared.entity;
  }
  async function allShards() {
    await store.ensurePayloadStorage();
    await Promise.all(Array.from({ length: 256 }, (_, n) => fs.mkdir(path.join(directory, 'payloads', n.toString(16).padStart(2, '0')), { recursive: true })));
  }
  return { db, directory, store, objects, gc, worker, file, allShards,
    row: () => db.getRepository(entities.RuntimePipelineStateEntity).findOneBy({ id: RETENTION_WORKER_ID }) };
}


const expire = async (f, object) => {
  object.expiresAt = new Date(Date.now() - 1000).toISOString();
  await f.db.getRepository(entities.RuntimePayloadEntity).save(object);
};
const objectPath = (f, object) => path.join(f.directory, 'payloads', object.fileKey);
const stored = (f, object) => f.db.getRepository(entities.RuntimePayloadEntity).findOneByOrFail({ id: object.id });
const options = { scanLimit: 1, deleteLimit: 1, graceMs: 60000 };

test('unlink followed by transaction rollback recovers through a reconstructed worker without replay or watermark changes', async t => {
  const f = await fixture(t), object = await f.file('rollback-body');
  const file = objectPath(f, object), aged = new Date(Date.now() - 120000);
  await expire(f, object); await fs.utimes(file, aged, aged);
  const transaction = f.store.transaction.bind(f.store);
  let removed = false;
  const remove = f.objects.deleteGarbage.bind(f.objects);
  f.objects.deleteGarbage = async (...args) => { const result = await remove(...args); removed = result === 'deleted'; return result; };
  f.store.transaction = callback => transaction(async tx => {
    const result = await callback(tx);
    if (removed) { removed = false; throw new Error('synthetic post-unlink rollback'); }
    return result;
  });
  const watermark = await f.store.watermark();
  await assert.rejects(f.worker.runOnce(), /synthetic post-unlink rollback/);
  assert.equal((await stored(f, object)).state, 'captured');
  await assert.rejects(fs.access(file), { code: 'ENOENT' });
  await assert.rejects(f.objects.read(await stored(f, object)), error => error.code === 'PAYLOAD_EXPIRED');
  assert.equal(payloadCapacityView(await f.row(), Date.now()).scanCoverage, 'unknown');
  f.store.transaction = transaction;
  await f.worker.onModuleDestroy(); await f.objects.onModuleDestroy();
  const persistedDatabase = f.db.driver.export();
  await f.db.destroy();
  const restartedDb = new DataSource({ type: 'sqljs', database: persistedDatabase, synchronize: false, logging: false,
    entities: [...entities.CALL_OBSERVABILITY_ENTITIES, Event] });
  await restartedDb.initialize();
  const old = process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  process.env.API_NOVA_OBSERVABILITY_DATA_DIR = f.directory;
  const objects = new CallObservabilityPayloadStore();
  if (old === undefined) delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR; else process.env.API_NOVA_OBSERVABILITY_DATA_DIR = old;
  const store = new CallObservabilityStore(restartedDb, objects), gc = new CallObservabilityGarbageService(store, objects);
  const worker = new CallObservabilityRetentionWorker(gc, store, new ConfigService({ API_NOVA_OBSERVABILITY_RETENTION_ENABLED: 'true' }));
  try {
    const recovered = await worker.runOnce();
    assert.equal(recovered.lastReport.metadataReconciliation.reconciled, 1);
    const repaired = await restartedDb.getRepository(entities.RuntimePayloadEntity).findOneByOrFail({ id: object.id });
    assert.equal(repaired.state, 'expired'); assert.equal(repaired.fileKey, null); assert.equal(repaired.metadata.storedBytes, 0);
    assert.equal((await worker.runOnce()).lastReport.metadataReconciliation.reconciled, 0);
    assert.equal(await store.watermark(), watermark);
  } finally { await worker.onModuleDestroy(); await objects.onModuleDestroy(); await restartedDb.destroy(); }
});

test('keyset progress is durable and bounded while present and unexpired objects remain unchanged', async t => {
  const f = await fixture(t);
  const objects = await Promise.all([f.file('one'), f.file('two'), f.file('three')]);
  for (const object of objects) { await expire(f, object); await fs.unlink(objectPath(f, object)); }
  const present = await f.file('present'), future = await f.file('future');
  await expire(f, present); await fs.unlink(objectPath(f, future));
  const presentBefore = await stored(f, present), futureBefore = await stored(f, future);
  let repaired = 0;
  for (let n = 0; n < 4; n++) {
    const gc = new CallObservabilityGarbageService(f.store, f.objects);
    const report = await gc.collect(options);
    assert.equal(report.metadataReconciliation.checked, 1);
    repaired += report.metadataReconciliation.reconciled;
    const cursor = await f.db.getRepository(entities.RuntimePipelineStateEntity).findOneByOrFail({ id: PAYLOAD_METADATA_RECONCILIATION_ID });
    assert.equal(typeof cursor.value.afterId, 'string');
  }
  assert.equal(repaired, 3);
  assert.deepEqual(await stored(f, present), presentBefore);
  assert.deepEqual(await stored(f, future), futureBefore);
  const tail = await f.gc.collect(options);
  assert.equal(tail.metadataReconciliation.checked, 0);
  assert.equal((await f.db.getRepository(entities.RuntimePipelineStateEntity).findOneByOrFail({ id: PAYLOAD_METADATA_RECONCILIATION_ID })).value.afterId, null);
  await fs.access(objectPath(f, present));
});

test('metadata repair rolls back its cursor with the row and retries after storage errors', async t => {
  const f = await fixture(t), object = await f.file('repair-transaction');
  await expire(f, object); await fs.unlink(objectPath(f, object));
  const transaction = f.store.transaction.bind(f.store);
  let injected = false;
  f.store.transaction = callback => transaction(async tx => {
    const result = await callback(tx);
    const row = await tx.manager.getRepository(entities.RuntimePayloadEntity).findOneByOrFail({ id: object.id });
    if (!injected && row.state === 'expired') { injected = true; throw new Error('synthetic repair rollback'); }
    return result;
  });
  await assert.rejects(f.gc.collect(options), /synthetic repair rollback/);
  assert.equal((await stored(f, object)).state, 'captured');
  assert.equal(await f.db.getRepository(entities.RuntimePipelineStateEntity).findOneBy({ id: PAYLOAD_METADATA_RECONCILIATION_ID }), null);
  f.store.transaction = transaction;
  const inspect = f.objects.isStoredObjectMissing.bind(f.objects);
  f.objects.isStoredObjectMissing = async () => { throw new Error('synthetic disk unavailable'); };
  await assert.rejects(f.gc.collect(options), /synthetic disk unavailable/);
  assert.equal((await stored(f, object)).state, 'captured');
  f.objects.isStoredObjectMissing = inspect;
  assert.equal((await f.gc.collect(options)).metadataReconciliation.reconciled, 1);
});


test('expired referenced payload is repaired without deleting or rewriting invocation history', async t => {
  const f = await fixture(t), invocationId = randomUUID(), data = 'referenced';
  await f.store.ingest({ schemaVersion: 2, invocationId, eventId: randomUUID(), sourceInstanceId: randomUUID(),
    sourceSequence: 1, recordVersion: 1, phase: 'finished', requestId: randomUUID(), traceId: invocationId,
    rootInvocationId: invocationId, runtimeAssetId: randomUUID(), kind: 'admission', spanKind: 'gateway_request',
    serverType: 'gateway', transport: 'gateway', protocolTransport: 'http', origin: 'external',
    identitySource: 'anonymous', outcome: 'success', statusCode: 200,
    startedAt: new Date(Date.now() - 1000).toISOString(), completedAt: new Date().toISOString(),
    request: { state: 'captured', reason: null, contentType: 'text/plain', encoding: 'utf8', data,
      observedBytes: 10, capturedBytes: 10, storedBytes: 10, capturedDigest: createHash('sha256').update(data).digest('hex'),
      digestScope: 'observed_raw', redacted: true, redactionPolicyVersion: 'default-v1' },
    response: { state: 'unavailable', reason: 'not_captured' } });
  const calls = f.db.getRepository(entities.RuntimeInvocationEntity), revisions = f.db.getRepository(entities.RuntimeInvocationRevisionEntity);
  const before = await calls.findOneByOrFail({ invocationId }), history = await revisions.find();
  const object = await f.db.getRepository(entities.RuntimePayloadEntity).findOneByOrFail({ id: before.requestPayloadId });
  await expire(f, object); await fs.unlink(objectPath(f, object));
  const watermark = await f.store.watermark();
  assert.equal((await f.gc.collect(options)).metadataReconciliation.reconciled, 1);
  assert.deepEqual(await calls.findOneByOrFail({ invocationId }), before);
  assert.deepEqual(await revisions.find(), history);
  assert.equal(await f.store.watermark(), watermark);
  await assert.rejects(f.objects.read(await stored(f, object)), error => error.code === 'PAYLOAD_EXPIRED');
});

test('repair shares the writer exclusion and rechecks the GC fence after filesystem observation', async t => {
  const f = await fixture(t), object = await f.file('fenced');
  await expire(f, object); await fs.unlink(objectPath(f, object));
  await f.store.payloadCoordination.withWriter(async () => {
    const report = await f.gc.collect(options);
    assert.equal(report.status, 'busy'); assert.equal(report.metadataReconciliation, undefined);
  });
  const inspect = f.objects.isStoredObjectMissing.bind(f.objects);
  const assertGc = f.store.payloadCoordination.assertGc.bind(f.store.payloadCoordination);
  let observed = false;
  f.objects.isStoredObjectMissing = async (...args) => { const result = await inspect(...args); observed = true; return result; };
  f.store.payloadCoordination.assertGc = async (...args) => { await assertGc(...args); if (observed) throw new Error('synthetic lease lost'); };
  try { await assert.rejects(f.gc.collect(options), /synthetic lease lost/); }
  finally { f.objects.isStoredObjectMissing = inspect; f.store.payloadCoordination.assertGc = assertGc; }
  assert.equal((await stored(f, object)).state, 'captured');
  assert.equal(await f.db.getRepository(entities.RuntimePipelineStateEntity).findOneBy({ id: PAYLOAD_METADATA_RECONCILIATION_ID }), null);
  assert.equal((await f.gc.collect(options)).metadataReconciliation.reconciled, 1);
});


test('public retention report whitelists bounded repair counts without exposing the durable cursor', () => {
  const { retentionPipelineView } = source('modules/call-observability/call-observability-pipeline-retention');
  const now = new Date().toISOString();
  const row = { updatedAt: now, value: { state: 'idle', lastReportAt: now, currentAttemptComplete: true,
    lastReport: { status: 'completed', metadataReconciliation: { checked: 3, reconciled: 2, retained: 1, hasMore: true, afterId: 'PRIVATE_CURSOR' } } } };
  const view = retentionPipelineView(row, Date.now(), []);
  assert.deepEqual(view.lastReport.metadataReconciliation, { checked: 3, reconciled: 2, retained: 1, hasMore: true });
  assert.equal(JSON.stringify(view).includes('PRIVATE'), false);
  row.value.lastReport.metadataReconciliation.checked = 1001;
  assert.equal(retentionPipelineView(row, Date.now(), []).lastReport.metadataReconciliation, null);
});


test('missing-file evidence is rejected if ownership changes during the controlled stat', async t => {
  const f = await fixture(t), object = await f.file('owner-guard');
  await expire(f, object); await fs.unlink(objectPath(f, object));
  const owned = f.objects.assertOwnedRoot.bind(f.objects);
  let checks = 0;
  f.objects.assertOwnedRoot = async () => { await owned(); if (++checks === 2) throw new Error('synthetic owner changed'); };
  try { await assert.rejects(f.objects.isStoredObjectMissing(object.id, object.fileKey), /synthetic owner changed/); }
  finally { f.objects.assertOwnedRoot = owned; }
  assert.equal((await stored(f, object)).state, 'captured');
  assert.equal((await f.gc.collect(options)).metadataReconciliation.reconciled, 1);
});
