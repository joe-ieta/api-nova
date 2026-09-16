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
const root = path.resolve(__dirname, '../../../tmp/observability-payload-quota-publication-tests');
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



const { PayloadQuotaPrimitives } = source('modules/call-observability/call-observability-payload-quota');
function enabled(t, ...values) {
  const value = values.length ? values[0] : 'true';
  const previous = process.env.API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_ENABLED;
  if (value === undefined) delete process.env.API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_ENABLED;
  else process.env.API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_ENABLED = value;
  t.after(() => { if (previous === undefined) delete process.env.API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_ENABLED; else process.env.API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_ENABLED = previous; });
}
function evidence(data = '1234567890') {
  const invocationId = randomUUID(), bytes = Buffer.byteLength(data);
  return { schemaVersion: 2, invocationId, eventId: randomUUID(), sourceInstanceId: randomUUID(),
    sourceSequence: 1, recordVersion: 1, phase: 'finished', requestId: randomUUID(), traceId: invocationId,
    rootInvocationId: invocationId, runtimeAssetId: randomUUID(), kind: 'admission', spanKind: 'gateway_request',
    serverType: 'gateway', transport: 'gateway', protocolTransport: 'http', origin: 'external', identitySource: 'anonymous',
    outcome: 'success', statusCode: 200, startedAt: new Date(Date.now() - 1000).toISOString(), completedAt: new Date().toISOString(),
    request: { state: 'captured', reason: null, data, contentType: 'text/plain', encoding: 'utf8', observedBytes: bytes,
      capturedBytes: bytes, storedBytes: bytes, capturedDigest: createHash('sha256').update(data).digest('hex'),
      digestScope: 'observed_raw', redacted: true, redactionPolicyVersion: 'default-v1' },
    response: { state: 'unavailable', reason: 'not_captured' } };
}
async function budget(f, { ready = true, bytes = 0, quotaBytes = 1000, maxBodyBytes = 500 } = {}) {
  await f.store.ensurePayloadStorage();
  const quota = new PayloadQuotaPrimitives();
  const initial = await f.store.transaction(tx => quota.initialize(tx, { enabled: true, quotaBytes, maxBodyBytes }));
  if (ready) await f.store.transaction(tx => quota.confirmBaseline(tx, initial.epoch, { kind: 'complete_inventory', evidenceId: 'synthetic-empty-fixture', committedBytes: bytes }));
  return () => f.store.readSnapshot(tx => quota.status(tx));
}
async function request(f, record) {
  const invocation = await f.db.getRepository(entities.RuntimeInvocationEntity).findOneByOrFail({ invocationId: record.invocationId });
  return f.db.getRepository(entities.RuntimePayloadEntity).findOneByOrFail({ id: invocation.requestPayloadId });
}
function watchTemporary(t, observe = async () => {}) {
  const open = fs.open; let writes = 0;
  fs.open = async (...args) => { if (args[1] === 'wx') { writes++; await observe(); } return open(...args); };
  t.after(() => { fs.open = open; });
  return () => writes;
}

test('enabled but missing or initializing budget omits without a temporary write or changing business outcome', async t => {
  const f = await fixture(t); enabled(t);
  await f.store.ensurePayloadStorage(); const writes = watchTemporary(t);
  const missing = evidence(); await f.store.ingest(missing);
  assert.equal((await request(f, missing)).reason, 'quota_unavailable'); assert.equal(writes(), 0);
  const status = await budget(f, { ready: false });
  const initializing = evidence(); await f.store.ingest(initializing);
  assert.equal((await request(f, initializing)).reason, 'quota_unavailable'); assert.equal(writes(), 0);
  assert.equal((await status()).state, 'initializing'); assert.equal((await status()).quotaEnforced, false);
  const row = await f.db.getRepository(entities.RuntimeInvocationEntity).findOneByOrFail({ invocationId: initializing.invocationId });
  assert.equal(row.record.outcome, 'success'); assert.equal(row.record.httpStatus, 200);
});

test('publication reserves 2B before opening, settles B and verifies same-intent replay without writes or double charging', async t => {
  const f = await fixture(t); enabled(t); const status = await budget(f);
  const record = evidence();
  const writes = watchTemporary(t, async () => { assert.equal((await status()).reservedBytes, 20); });
  await f.store.ingest(record);
  const first = await request(f, record);
  assert.equal(first.state, 'captured'); assert.equal((await status()).committedBytes, 10); assert.equal((await status()).reservedBytes, 0);
  await f.store.ingest(record);
  assert.equal(writes(), 1); assert.equal(await f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity).count(), 1);
  assert.equal((await f.objects.read(first)).data, '1234567890');
  // Different source event, same immutable object: a distinct publish attempt reuses the final path.
  await f.store.ingest({ ...record, eventId: randomUUID() });
  assert.equal(writes(), 2); assert.equal((await status()).committedBytes, 10);
});

test('quota exhaustion and body limit omit while empty body requires no reservation or file', async t => {
  const f = await fixture(t); enabled(t); const status = await budget(f, { bytes: 900 }); const writes = watchTemporary(t);
  const denied = evidence(); await f.store.ingest(denied);
  assert.equal((await request(f, denied)).reason, 'quota_exhausted'); assert.equal(writes(), 0);
  const empty = evidence(''); await f.store.ingest(empty);
  assert.equal((await request(f, empty)).state, 'captured'); assert.equal((await f.objects.read(await request(f, empty))).data, '');
  assert.equal((await status()).reservedBytes, 0); assert.equal(writes(), 0);
});

test('unknown publication holds its reservation and retry does not write or charge again', async t => {
  const f = await fixture(t); enabled(t); const status = await budget(f); const record = evidence();
  const link = fs.link; let links = 0;
  fs.link = async () => { links++; throw Object.assign(new Error('fixture failure'), { code: 'EIO' }); };
  try { await f.store.ingest(record); } finally { fs.link = link; }
  assert.equal((await request(f, record)).reason, 'storage_error');
  assert.equal((await status()).state, 'degraded'); assert.equal((await status()).reservedBytes, 20);
  await f.store.ingest(record);
  assert.equal(links, 1); assert.equal((await status()).reservedBytes, 20);
  assert.equal(await f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity).count(), 1);
});

test('settlement transaction rollback cannot claim captured or release unknown occupancy', async t => {
  const f = await fixture(t); enabled(t); const status = await budget(f); const record = evidence();
  const transaction = f.store.transaction.bind(f.store); let once = false;
  f.store.transaction = callback => transaction(async tx => {
    const result = await callback(tx);
    if (!once && await tx.manager.getRepository(entities.RuntimePayloadQuotaReservationEntity).findOneBy({ state: 'settled' })) {
      once = true; throw new Error('fixture settlement rollback');
    }
    return result;
  });
  try { await f.store.ingest(record); } finally { f.store.transaction = transaction; }
  assert.equal((await request(f, record)).reason, 'storage_error');
  assert.equal((await status()).reservedBytes, 20); assert.equal((await status()).committedBytes, 0);
  assert.equal((await status()).state, 'degraded');
});

test('default-off and explicit false preserve every prepared payload field', async t => {
  const f = await fixture(t); enabled(t, undefined); await f.store.ensurePayloadStorage();
  const record = evidence(), identity = { sourceInstanceId: record.sourceInstanceId, invocationId: record.invocationId, side: 'request' };
  const now = new Date().toISOString(), expiry = new Date(Date.now() + 60000).toISOString();
  const first = await f.objects.prepare(identity, record.request, now, expiry, '0');
  process.env.API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_ENABLED = 'false';
  const second = await f.objects.prepare(identity, record.request, now, expiry, '0');
  assert.deepEqual(second, first); assert.equal(first.entity.state, 'captured');
  assert.equal(await f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity).count(), 0);
});


test('concurrent ingesters share the hard budget and cannot write without a reservation', async t => {
  const f = await fixture(t); enabled(t); const status = await budget(f, { quotaBytes: 20, maxBodyBytes: 10 });
  const secondStore = new CallObservabilityStore(f.db, f.objects), first = evidence(), second = evidence();
  await Promise.all([f.store.ingest(first), secondStore.ingest(second)]);
  const bodies = [await request(f, first), await request(f, second)];
  assert.equal(bodies.filter(body => body.state === 'captured').length, 1);
  assert.equal(bodies.filter(body => body.reason === 'quota_exhausted').length, 1);
  assert.equal((await status()).committedBytes, 10); assert.equal((await status()).reservedBytes, 0);
  assert.equal(await f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity).count(), 1);
});

test('unconfirmed temporary cleanup keeps the full reservation and reports uncertainty', async t => {
  const f = await fixture(t); enabled(t); const status = await budget(f); const record = evidence();
  const unlink = fs.unlink;
  fs.unlink = async file => { if (String(file).endsWith('.tmp')) throw Object.assign(new Error('fixture temporary lock'), { code: 'EACCES' }); return unlink(file); };
  try { await f.store.ingest(record); } finally { fs.unlink = unlink; }
  assert.equal((await request(f, record)).reason, 'quota_publication_uncertain');
  assert.equal((await status()).state, 'degraded'); assert.equal((await status()).reservedBytes, 20);
  assert.equal((await status()).committedBytes, 0);
});

test('existing object digest conflict never overwrites content or releases uncertain budget', async t => {
  const f = await fixture(t); enabled(t); const status = await budget(f);
  const finished = evidence(), { completedAt, ...fields } = finished;
  const started = { ...fields, eventId: randomUUID(), phase: 'started', outcome: 'unknown' };
  await f.store.ingest(started);
  const first = await request(f, started), file = path.join(f.directory, 'payloads', first.fileKey);
  await fs.writeFile(file, 'xxxxxxxxxx');
  await f.store.ingest({ ...finished, recordVersion: 2, sourceSequence: 2 });
  assert.equal((await request(f, finished)).reason, 'storage_error');
  assert.equal(await fs.readFile(file, 'utf8'), 'xxxxxxxxxx');
  assert.equal((await status()).committedBytes, 10); assert.equal((await status()).reservedBytes, 20);
  assert.equal((await status()).state, 'degraded');
});

test('quota body-size bound has a distinct omission and DB reservation failure retains storage_error', async t => {
  const f = await fixture(t); enabled(t); await budget(f, { maxBodyBytes: 5 });
  const tooLarge = evidence(); await f.store.ingest(tooLarge);
  assert.equal((await request(f, tooLarge)).reason, 'quota_body_limit');
  const transaction = f.store.transaction.bind(f.store); let failed = false;
  f.store.transaction = callback => transaction(async tx => {
    const result = await callback(tx);
    if (!failed && await tx.manager.getRepository(entities.RuntimePayloadQuotaReservationEntity).count()) { failed = true; throw new Error('fixture reserve rollback'); }
    return result;
  });
  const record = evidence('tiny');
  try { await f.store.ingest(record); } finally { f.store.transaction = transaction; }
  assert.equal((await request(f, record)).reason, 'storage_error');
  assert.equal(await f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity).count(), 0);
});

test('failed confirmed and unknown settlements keep the full reservation until recovery', async t => {
  const f = await fixture(t); enabled(t); const status = await budget(f); const record = evidence();
  const writes = watchTemporary(t), transaction = f.store.transaction.bind(f.store); let blocked = 0;
  f.store.transaction = callback => transaction(async tx => {
    const result = await callback(tx);
    const reservation = await tx.manager.getRepository(entities.RuntimePayloadQuotaReservationEntity).findOne({ where: {} });
    if (reservation && ['settled', 'uncertain'].includes(reservation.state)) {
      blocked++; throw new Error('fixture cannot persist a settlement');
    }
    return result;
  });
  try { await f.store.ingest(record); } finally { f.store.transaction = transaction; }
  assert.equal(blocked, 2);
  assert.equal((await request(f, record)).reason, 'storage_error');
  assert.equal((await status()).committedBytes, 0); assert.equal((await status()).reservedBytes, 20);
  assert.equal((await f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity).findOne({ where: {} })).state, 'reserved');
  await f.store.ingest(record);
  assert.equal(writes(), 1); assert.equal((await status()).reservedBytes, 20);
});