'use strict';
process.env.DB_TYPE = 'sqlite';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DataSource } = require('typeorm');
const base = '../dist/src/modules/call-observability/';
const entities = require('../dist/src/database/entities/runtime-call-observability.entity.js');
const { RuntimeObservabilityEventEntity } = require('../dist/src/database/entities/runtime-observability-event.entity.js');
const { CallObservabilityStore } = require(base + 'call-observability.store.js');
const { CallObservabilityPayloadStore } = require(base + 'call-observability-payload.store.js');
const { CallObservabilityGarbageService } = require(base + 'call-observability-garbage.service.js');
const { PAYLOAD_COORDINATION_ID } = require(base + 'call-observability-payload.coordinator.js');
const root = path.resolve(__dirname, '../../..', 'tmp', 'observability-gc-tests');
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

test('reclaims aged unreferenced objects without changing the call watermark', async t => {
  const f = await fixture(t);
  const orphan = await f.orphan();
  const file = f.file(orphan.entity);
  await f.age(file);
  const report = await f.gc.collect({ graceMs });
  assert.equal(report.deleted, 1);
  assert.equal(report.status, 'completed');
  assert.equal(await f.store.watermark(), '0');
  await assert.rejects(fs.access(file), { code: 'ENOENT' });
  await fs.access(path.join(f.directory, 'payloads', '.owner.json'));
});

test('retained payload metadata protects old files even when their mtime is aged', async t => {
  const f = await fixture(t);
  const object = await insertedPayload(f);
  await f.age(f.file(object));
  const report = await f.gc.collect({ graceMs });
  assert.equal(report.deleted, 0);
  assert.equal(report.protected, 1);
  assert.equal((await f.objects.read(object)).data, '{"ok":true}');
});

test('expired objects can be removed while preserving invocation and audit metadata', async t => {
  const f = await fixture(t);
  const object = await insertedPayload(f);
  object.expiresAt = new Date(Date.now() - 1).toISOString();
  await f.repository(entities.RuntimePayloadEntity).save(object);
  await f.age(f.file(object));
  const watermark = await f.store.watermark();
  const report = await f.gc.collect({ graceMs });
  assert.equal(report.deleted, 1);
  const stored = await f.repository(entities.RuntimePayloadEntity).findOneByOrFail({ id: object.id });
  assert.equal(stored.state, 'expired');
  assert.equal(stored.fileKey, null);
  await assert.rejects(() => f.objects.read(stored), errorCode('PAYLOAD_EXPIRED'));
  assert.equal(await f.repository(entities.RuntimeInvocationEntity).count(), 1);
  assert.equal(await f.store.watermark(), watermark);
});

test('aged temporary files are reclaimed without deleting their retained final object', async t => {
  const f = await fixture(t);
  const object = await insertedPayload(f);
  const temporary = f.file(object) + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temporary, 'unfinished');
  await f.age(temporary);
  const report = await f.gc.collect({ graceMs });
  assert.equal(report.deleted, 1);
  await assert.rejects(fs.access(temporary), { code: 'ENOENT' });
  await fs.access(f.file(object));
});

test('active writers defer garbage collection', async t => {
  const f = await fixture(t);
  await f.store.ensurePayloadStorage();
  const lease = await f.store.payloadCoordination.acquireWriter();
  try {
    const report = await f.gc.collect({ graceMs });
    assert.equal(report.status, 'busy');
    assert.equal(report.reason, 'writer_active');
  } finally { await f.store.payloadCoordination.releaseWriter(lease); }
});

test('the GC lease is exclusive and temporarily rejects new writers', async t => {
  const f = await fixture(t);
  await f.store.ensurePayloadStorage();
  const { lease } = await f.store.payloadCoordination.acquireGc();
  assert.ok(lease);
  try {
    assert.equal((await f.gc.collect({ graceMs })).reason, 'gc_active');
    await assert.rejects(() => f.store.payloadCoordination.acquireWriter(), errorCode('PAYLOAD_GC_BUSY'));
  } finally { await f.store.payloadCoordination.releaseGc(lease); }
});

test('expired writers lose commit rights and new generations never reuse their object paths', async t => {
  const f = await fixture(t);
  await f.store.ensurePayloadStorage();
  const old = await f.store.payloadCoordination.acquireWriter();
  const identity = { sourceInstanceId: randomUUID(), invocationId: randomUUID(), side: 'request' };
  const body = payloadBody();
  const now = new Date().toISOString();
  const expiry = new Date(Date.now() + 86400000).toISOString();
  const previous = await f.objects.prepare(identity, body, now, expiry, old.generation);
  await f.coordination(value => { value.writers[old.token].expiresAt = 0; });
  const { lease: gc } = await f.store.payloadCoordination.acquireGc();
  assert.ok(gc);
  await f.store.payloadCoordination.releaseGc(gc);
  await assert.rejects(() => f.store.transaction(tx => f.store.payloadCoordination.assertWriter(tx, old)),
    errorCode('PAYLOAD_WRITE_LEASE_LOST'));
  const fresh = await f.store.payloadCoordination.acquireWriter();
  try {
    const next = await f.objects.prepare(identity, body, now, expiry, fresh.generation);
    assert.notEqual(next.entity.id, previous.entity.id);
    assert.notEqual(next.entity.fileKey, previous.entity.fileKey);
    await f.store.payloadCoordination.releaseWriter(old);
    await f.store.transaction(tx => f.store.payloadCoordination.assertWriter(tx, fresh));
    assert.equal((await f.objects.read(next.entity)).data, body.data);
  } finally { await f.store.payloadCoordination.releaseWriter(fresh); }
});

test('a writer expiring during file preparation cannot commit a receipt or call', async t => {
  const f = await fixture(t);
  const reached = deferred();
  const resume = deferred();
  const publish = f.objects.publish.bind(f.objects);
  f.objects.publish = async (...args) => {
    reached.resolve();
    await resume.promise;
    return publish(...args);
  };
  const writing = f.store.ingest(evidence());
  const rejected = assert.rejects(writing, errorCode('PAYLOAD_WRITE_LEASE_LOST'));
  await reached.promise;
  await f.coordination(value => {
    for (const writer of Object.values(value.writers)) writer.expiresAt = 0;
  });
  const { lease } = await f.store.payloadCoordination.acquireGc();
  assert.ok(lease);
  await f.store.payloadCoordination.releaseGc(lease);
  resume.resolve();
  await rejected;
  assert.equal(await f.repository(entities.RuntimeInvocationEntity).count(), 0);
  assert.equal(await f.repository(entities.RuntimeIngestReceiptEntity).count(), 0);
  assert.equal(await f.store.watermark(), '0');
});

test('a collector losing its lease before deletion leaves the candidate intact', async t => {
  const f = await fixture(t);
  const orphan = await f.orphan();
  await f.age(f.file(orphan.entity));
  const scan = f.objects.scanGarbage.bind(f.objects);
  f.objects.scanGarbage = async (...args) => {
    const result = await scan(...args);
    await f.coordination(value => { value.gc.expiresAt = 0; });
    return result;
  };
  await assert.rejects(() => f.gc.collect({ graceMs }), errorCode('PAYLOAD_GC_LEASE_LOST'));
  await fs.access(f.file(orphan.entity));
});

test('an object changed after scanning is not deleted', async t => {
  const f = await fixture(t);
  const orphan = await f.orphan();
  const file = f.file(orphan.entity);
  await f.age(file);
  const scan = f.objects.scanGarbage.bind(f.objects);
  f.objects.scanGarbage = async (...args) => {
    const result = await scan(...args);
    await fs.writeFile(file, 'newer-content-with-different-size');
    return result;
  };
  const report = await f.gc.collect({ graceMs });
  assert.equal(report.changed, 1);
  assert.equal(report.deleted, 0);
  assert.equal(await fs.readFile(file, 'utf8'), 'newer-content-with-different-size');
});

test('populated unowned roots are never automatically adopted or cleared', async t => {
  const f = await fixture(t);
  const directory = path.join(f.directory, 'payloads');
  await fs.mkdir(directory);
  const foreign = path.join(directory, 'existing-evidence.txt');
  await fs.writeFile(foreign, 'preserve-me');
  await assert.rejects(() => f.store.ensurePayloadStorage(), errorCode('PAYLOAD_ROOT_NOT_EMPTY'));
  assert.equal(await fs.readFile(foreign, 'utf8'), 'preserve-me');
});

test('two independent databases cannot claim the same payload root', async t => {
  const f = await fixture(t);
  await f.store.ensurePayloadStorage();
  const other = database();
  const otherObjects = makePayloadStore(f.directory);
  await other.initialize();
  try {
    const otherStore = new CallObservabilityStore(other, otherObjects);
    await assert.rejects(() => otherStore.ensurePayloadStorage(), errorCode('PAYLOAD_ROOT_OWNER_MISMATCH'));
    await f.store.ingest(evidence());
  } finally { await otherObjects.closeScanner(); await other.destroy(); }
});

test('bounded scans resume rather than deleting an unbounded batch', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) {
    const orphan = await f.orphan();
    await f.age(f.file(orphan.entity));
  }
  let deleted = 0;
  for (let i = 0; i < 3; i++) {
    const report = await f.gc.collect({ graceMs, scanLimit: 1, deleteLimit: 1 });
    assert.ok(report.scanned <= 1);
    assert.ok(report.deleted <= 1);
    deleted += report.deleted;
  }
  assert.equal(deleted, 3);
});

test('failed ingestion releases its writer lease', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.store.ingest(evidence(), {}, async () => { throw new Error('fixture rollback'); }),
    /fixture rollback/);
  const state = await f.repository(entities.RuntimePipelineStateEntity).findOneByOrFail({ id: PAYLOAD_COORDINATION_ID });
  assert.deepEqual(state.value.writers, {});
  assert.equal((await f.gc.collect({ graceMs })).status, 'completed');
});

test('unknown files and young orphan objects are preserved', async t => {
  const f = await fixture(t);
  const orphan = await f.orphan();
  const notes = path.join(f.directory, 'payloads', 'operator-notes.txt');
  await fs.writeFile(notes, 'not a payload');
  const report = await f.gc.collect({ graceMs });
  assert.equal(report.deleted, 0);
  await fs.access(f.file(orphan.entity));
  assert.equal(await fs.readFile(notes, 'utf8'), 'not a payload');
});

test('missing payload metadata never causes deletion of an object still referenced by a call', async t => {
  const f = await fixture(t);
  const object = await insertedPayload(f);
  await f.age(f.file(object));
  await f.repository(entities.RuntimePayloadEntity).delete({ id: object.id });
  const report = await f.gc.collect({ graceMs });
  assert.equal(report.danglingReferences, 1);
  assert.equal(report.deleted, 0);
  await fs.access(f.file(object));
});
