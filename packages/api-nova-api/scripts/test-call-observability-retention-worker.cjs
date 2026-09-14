'use strict';
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, project: require('path').resolve(__dirname, '../tsconfig.json') });
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DataSource } = require('typeorm');
const base = '../src/modules/call-observability/';
const entities = require('../src/database/entities/runtime-call-observability.entity.ts');
const { RuntimeObservabilityEventEntity } = require('../src/database/entities/runtime-observability-event.entity.ts');
const { CallObservabilityStore } = require(base + 'call-observability.store.ts');
const { CallObservabilityPayloadStore } = require(base + 'call-observability-payload.store.ts');
const { CallObservabilityGarbageService } = require(base + 'call-observability-garbage.service.ts');
const { PAYLOAD_COORDINATION_ID } = require(base + 'call-observability-payload.coordinator.ts');
const root = path.resolve(__dirname, '../../..', 'tmp', 'observability-retention-worker-tests');
const graceMs = 60_000;
const hash = text => createHash('sha256').update(text).digest('hex');
const errorCode = code => error => error?.code === code;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const payloadBody = (data = '{"ok":true}') => ({
  state: 'captured', reason: null, contentType: 'application/json', encoding: 'utf8',
  data, observedBytes: Buffer.byteLength(data), capturedBytes: Buffer.byteLength(data),
  storedBytes: Buffer.byteLength(data), capturedDigest: hash(data), digestScope: 'observed_raw',
  redacted: true, redactionPolicyVersion: 'default-v1',
});
function evidence() {
  const id = randomUUID();
  return {
    schemaVersion: 2, invocationId: id, eventId: randomUUID(), sourceInstanceId: randomUUID(),
    sourceSequence: 1, recordVersion: 1, phase: 'finished', requestId: randomUUID(),
    traceId: id, rootInvocationId: id, runtimeAssetId: randomUUID(), kind: 'admission',
    spanKind: 'gateway_request', serverType: 'gateway', transport: 'gateway', protocolTransport: 'http',
    origin: 'external', identitySource: 'anonymous', outcome: 'success', statusCode: 200,
    startedAt: new Date(Date.now() - 1000).toISOString(), completedAt: new Date().toISOString(),
    request: payloadBody(), response: { state: 'unavailable', reason: 'not_captured' },
  };
}
function makePayloadStore(directory) {
  const old = process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  process.env.API_NOVA_OBSERVABILITY_DATA_DIR = directory;
  const instance = new CallObservabilityPayloadStore();
  if (old === undefined) delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  else process.env.API_NOVA_OBSERVABILITY_DATA_DIR = old;
  return instance;
}
function database() {
  return new DataSource({ type: 'sqljs', synchronize: true, logging: false,
    entities: [...entities.CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity] });
}
async function fixture(t) {
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'run-'));
  const db = database();
  const objects = makePayloadStore(directory);
  const store = new CallObservabilityStore(db, objects);
  const gc = new CallObservabilityGarbageService(store, objects);
  t.after(async () => {
    await objects.closeScanner();
    if (db.isInitialized) await db.destroy();
    const target = path.resolve(directory);
    if (path.dirname(target) !== root || !path.basename(target).startsWith('run-')) throw new Error('Unsafe cleanup target');
    await fs.rm(target, { recursive: true, force: true });
  });
  await db.initialize();
  return {
    directory, db, objects, store, gc,
    repository: entity => db.getRepository(entity),
    file: entity => path.join(directory, 'payloads', entity.fileKey),
    async orphan() {
      await store.ensurePayloadStorage();
      const identity = { sourceInstanceId: randomUUID(), invocationId: randomUUID(), side: 'request' };
      const body = payloadBody();
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 86400000).toISOString();
      const prepared = await store.payloadCoordination.withWriter(lease =>
        objects.prepare(identity, body, createdAt, expiresAt, lease.generation));
      return { ...prepared, identity, originalBody: body, createdAt, expiresAt };
    },
    async age(file) {
      const time = new Date(Date.now() - 120000);
      await fs.utimes(file, time, time);
    },
    async coordination(mutate) {
      await store.transaction(async tx => {
        const repository = tx.manager.getRepository(entities.RuntimePipelineStateEntity);
        const row = await repository.findOneByOrFail({ id: PAYLOAD_COORDINATION_ID });
        mutate(row.value);
        await repository.save(row);
      });
    },
  };
}
async function insertedPayload(f) {
  const row = evidence();
  await f.store.ingest(row);
  const invocation = await f.repository(entities.RuntimeInvocationEntity).findOneByOrFail({ invocationId: row.invocationId });
  return f.repository(entities.RuntimePayloadEntity).findOneByOrFail({ id: invocation.requestPayloadId });
}

const { CallObservabilityRetentionWorker, RETENTION_WORKER_ID, retentionWorkerConfiguration } = require(base + 'call-observability-retention.worker.ts');
const PREFIX = 'API_NOVA_OBSERVABILITY_RETENTION_';
const configured = (input = {}) => {
  const values = Object.fromEntries(Object.entries(input).map(([key, value]) => [PREFIX + key, value]));
  return { get: key => values[key], values };
};
const enabled = () => configured({ ENABLED: 'true', INTERVAL_MS: '1000', GRACE_MS: '60000' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = (promise, ms) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('worker recovery timed out')), ms); })])
    .finally(() => clearTimeout(timer));
};
async function workerFixture(t, config = enabled()) {
  const f = await fixture(t);
  const worker = new CallObservabilityRetentionWorker(f.gc, f.store, config);
  t.after(() => worker.onModuleDestroy());
  const status = () => f.repository(entities.RuntimePipelineStateEntity).findOneBy({ id: RETENTION_WORKER_ID });
  return { ...f, worker, config, status };
}

test('default-off lifecycle and runOnce neither collect nor create persisted state', async t => {
  const f = await workerFixture(t, configured());
  let calls = 0; f.gc.collect = async () => { calls++; throw new Error('must not collect'); };
  await f.worker.onApplicationBootstrap();
  await assert.rejects(f.worker.runOnce(), errorCode('RETENTION_DISABLED'));
  await f.worker.onModuleDestroy();
  assert.equal(calls, 0); assert.equal(await f.status(), null);
  assert.equal(await f.repository(entities.RuntimePipelineStateEntity).count(), 0);
  assert.equal(await fs.readdir(f.directory).then(items => items.length), 0);
});

test('strict bounded retention configuration rejects coercions and excessive work', () => {
  assert.deepEqual(retentionWorkerConfiguration(configured()), { enabled: false, intervalMs: 60000, scanLimit: 128, deleteLimit: 32, graceMs: 86400000 });
  for (const value of [true, false, 'TRUE', '1', '', null, ' true']) {
    assert.throws(() => retentionWorkerConfiguration(configured({ ENABLED: value })), errorCode('INVALID_RETENTION_CONFIGURATION'));
  }
  for (const key of ['INTERVAL_MS', 'SCAN_LIMIT', 'DELETE_LIMIT', 'GRACE_MS']) {
    for (const value of ['01', '1e3', ' 1000', '1000 ', '1.5', '', null, true, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => retentionWorkerConfiguration(configured({ [key]: value })), errorCode('INVALID_RETENTION_CONFIGURATION'), key + ':' + value);
    }
  }
  for (const input of [{ INTERVAL_MS: '999' }, { INTERVAL_MS: '86400001' }, { SCAN_LIMIT: '1001' },
    { SCAN_LIMIT: '1', DELETE_LIMIT: '2' }, { GRACE_MS: '59999' }, { GRACE_MS: '604800001' }]) {
    assert.throws(() => retentionWorkerConfiguration(configured(input)), errorCode('INVALID_RETENTION_CONFIGURATION'));
  }
  assert.equal(retentionWorkerConfiguration(configured({ SCAN_LIMIT: 1, DELETE_LIMIT: 1 })).scanLimit, 1);
});

test('invalid enabled configuration reports sanitized degraded evidence without cleanup', async t => {
  const f = await workerFixture(t, configured({ ENABLED: 'true', SCAN_LIMIT: 'password=private-path' }));
  let calls = 0; f.gc.collect = async () => { calls++; };
  await f.worker.onApplicationBootstrap();
  assert.equal(calls, 0);
  const row = await f.status(); assert.equal(row.value.state, 'degraded');
  assert.equal(row.value.errorCode, 'INVALID_RETENTION_CONFIGURATION');
  assert.equal(JSON.stringify(row).includes('private-path'), false);
});

test('bounded real payload collection preserves invocation, receipts, events and durable completion report', async t => {
  const f = await workerFixture(t);
  const object = await insertedPayload(f);
  object.expiresAt = new Date(Date.now() - 1).toISOString();
  await f.repository(entities.RuntimePayloadEntity).save(object);
  await f.age(f.file(object));
  const counts = await Promise.all([entities.RuntimeInvocationEntity, entities.RuntimeInvocationRevisionEntity,
    entities.RuntimeIngestReceiptEntity, RuntimeObservabilityEventEntity].map(entity => f.repository(entity).count()));
  const before = await f.store.watermark();
  const report = await f.worker.runOnce();
  assert.equal(report.state, 'idle'); assert.equal(report.lastReport.deleted, 1);
  assert.equal(report.currentAttemptComplete, true); assert.ok(report.lastSuccessAt);
  assert.equal(report.snapshotSeq, before); assert.equal(await f.store.watermark(), before);
  await assert.rejects(fs.access(f.file(object)), { code: 'ENOENT' });
  const after = await Promise.all([entities.RuntimeInvocationEntity, entities.RuntimeInvocationRevisionEntity,
    entities.RuntimeIngestReceiptEntity, RuntimeObservabilityEventEntity].map(entity => f.repository(entity).count()));
  assert.deepEqual(after, counts);
  const saved = (await f.status()).value;
  assert.equal(saved.lastReport.deleted, 1); assert.equal(saved.evidenceScope, 'payload_retention');
});

test('fenced busy writer produces waiting evidence and later retries safely', async t => {
  const f = await workerFixture(t);
  const orphan = await f.orphan(); await f.age(f.file(orphan.entity));
  const hold = deferred(), entered = deferred();
  const writer = f.store.payloadCoordination.withWriter(async () => { entered.resolve(); await hold.promise; });
  await entered.promise;
  try {
    const report = await f.worker.runOnce();
    assert.equal(report.state, 'waiting'); assert.equal(report.lastReport.reason, 'writer_active');
    assert.equal(report.lastSuccessAt, null); await fs.access(f.file(orphan.entity));
  } finally { hold.resolve(); await writer; }
  assert.equal((await f.worker.runOnce()).lastReport.deleted, 1);
});

test('real scan failure persists safe evidence, releases GC fence and recovers on next attempt', async t => {
  const f = await workerFixture(t);
  const orphan = await f.orphan(); await f.age(f.file(orphan.entity));
  const scan = f.objects.scanGarbage.bind(f.objects);
  f.objects.scanGarbage = async () => { throw new Error('password=secret E:/private/path'); };
  await assert.rejects(f.worker.runOnce(), /private\/path/);
  const failure = (await f.status()).value;
  assert.equal(failure.state, 'degraded'); assert.equal(failure.errorCode, 'RETENTION_COLLECTION_FAILED');
  assert.equal(failure.currentAttemptComplete, false); assert.ok(failure.lastFailureAt);
  assert.equal(JSON.stringify(failure).includes('private'), false); assert.equal(failure.lastSuccessAt, null);
  const coordination = await f.repository(entities.RuntimePipelineStateEntity).findOneBy({ id: PAYLOAD_COORDINATION_ID });
  assert.equal(coordination.value.gc, null);
  await fs.access(f.file(orphan.entity));
  f.objects.scanGarbage = scan;
  const recovered = await f.worker.runOnce();
  assert.equal(recovered.state, 'idle'); assert.equal(recovered.errorCode, null);
  assert.equal(recovered.lastReport.deleted, 1); assert.equal(recovered.lastFailureAt, failure.lastFailureAt);
  assert.ok(recovered.lastSuccessAt); assert.ok(recovered.stateVersion > failure.stateVersion);
});

test('single flight and shutdown await active collection, persist stopped, reject later starts', async t => {
  const f = await workerFixture(t), started = deferred(), finish = deferred();
  const collect = f.gc.collect.bind(f.gc);
  f.gc.collect = async options => { started.resolve(); await finish.promise; return collect(options); };
  const active = f.worker.runOnce(); await started.promise;
  await assert.rejects(f.worker.runOnce(), errorCode('STORAGE_BUSY'));
  let stopped = false;
  const shutdown = f.worker.onModuleDestroy().then(() => { stopped = true; });
  await pause(20); assert.equal(stopped, false);
  await assert.rejects(f.worker.runOnce(), errorCode('RETENTION_WORKER_STOPPED'));
  finish.resolve(); await active; await shutdown;
  assert.equal(stopped, true); assert.equal((await f.status()).value.state, 'stopped');
  assert.equal((await f.status()).value.nextRunAt, null);
});

test('enabled scheduler delays first run, bootstraps once, retries failure and cancels timer on stop', async t => {
  const f = await workerFixture(t), recovered = deferred();
  let calls = 0; const collect = f.gc.collect.bind(f.gc);
  f.gc.collect = async options => {
    calls++;
    if (calls === 1) throw new Error('fixture temporary failure');
    const report = await collect(options); recovered.resolve(); return report;
  };
  await f.worker.onApplicationBootstrap(); await f.worker.onApplicationBootstrap();
  await pause(100); assert.equal(calls, 0); assert.equal((await f.status()).value.state, 'idle');
  await deadline(recovered.promise, 5000);
  await f.worker.onModuleDestroy();
  assert.equal(calls, 2);
  await pause(1100); assert.equal(calls, 2); assert.equal((await f.status()).value.state, 'stopped');
});

test('bootstrap database failure stays nonblocking, skips collection and recovers on scheduled retry', async t => {
  const f = await workerFixture(t), recovered = deferred();
  const transaction = f.store.transaction.bind(f.store), collect = f.gc.collect.bind(f.gc);
  let databaseFailed = true, calls = 0;
  f.store.transaction = operation => databaseFailed ? Promise.reject(new Error('private database fault')) : transaction(operation);
  f.gc.collect = async options => { calls++; const report = await collect(options); recovered.resolve(); return report; };
  await f.worker.onApplicationBootstrap(); assert.equal(calls, 0);
  await assert.rejects(f.worker.runOnce(), /private database fault/); assert.equal(calls, 0);
  databaseFailed = false;
  await deadline(recovered.promise, 4000);
  await f.worker.onModuleDestroy(); assert.equal(calls, 1);
  assert.equal((await f.status()).value.state, 'stopped');
});

test('invalid bootstrap configuration plus unavailable status storage never blocks startup or runs GC', async t => {
  const f = await workerFixture(t, configured({ ENABLED: 'true', DELETE_LIMIT: 'invalid' }));
  let calls = 0;
  f.store.transaction = () => Promise.reject(new Error('private status store failure'));
  f.gc.collect = async () => { calls++; };
  await f.worker.onApplicationBootstrap(); await f.worker.onModuleDestroy(); assert.equal(calls, 0);
});
