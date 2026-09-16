'use strict';
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, project: require('node:path').resolve(__dirname, '../tsconfig.json') });
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DataSource } = require('typeorm');
const entities = require('../src/database/entities/runtime-call-observability.entity.ts');
const { RuntimeObservabilityEventEntity } = require('../src/database/entities/runtime-observability-event.entity.ts');
const { CallObservabilityStore } = require('../src/modules/call-observability/call-observability.store.ts');
const { CallObservabilityPayloadStore } = require('../src/modules/call-observability/call-observability-payload.store.ts');
const { PayloadQuotaPrimitives } = require('../src/modules/call-observability/call-observability-payload-quota.ts');
const { PayloadPublicationIntentStore } = require('../src/modules/call-observability/call-observability-payload-publication-intent.ts');
const { PAYLOAD_OWNER_ID } = require('../src/modules/call-observability/call-observability-payload.coordinator.ts');
const parent = path.resolve(__dirname, '../../../tmp/observability-publication-restart-tests');
const sqlEntities = [...entities.CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity];
const failure = expected => error => error.code === expected;

function withRoot(directory) {
  const previous = process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  process.env.API_NOVA_OBSERVABILITY_DATA_DIR = directory;
  try { return new CallObservabilityPayloadStore(); }
  finally {
    if (previous === undefined) delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
    else process.env.API_NOVA_OBSERVABILITY_DATA_DIR = previous;
  }
}
async function fixture(t) {
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'run-'));
  let db = await new DataSource({ type: 'sqljs', synchronize: true, entities: sqlEntities }).initialize();
  let payloads = withRoot(directory);
  let store = new CallObservabilityStore(db, payloads);
  await store.ensurePayloadStorage();
  const quota = new PayloadQuotaPrimitives();
  const initial = await store.transaction(tx => quota.initialize(tx,
    { enabled: true, quotaBytes: 1000, maxBodyBytes: 500 }));
  await store.transaction(tx => quota.confirmBaseline(tx, initial.epoch,
    { kind: 'complete_inventory', evidenceId: 'isolated-b3-baseline', committedBytes: 0 }));
  const f = {
    directory, quota, epoch: initial.epoch,
    get db() { return db; }, get store() { return store; }, get payloads() { return payloads; },
    async status() { return store.readSnapshot(tx => quota.status(tx)); },
    async intent() { return db.getRepository(entities.RuntimePayloadPublicationIntentEntity).findOne({ where: {} }); },
    async reservation() { return db.getRepository(entities.RuntimePayloadQuotaReservationEntity).findOne({ where: {} }); },
    async restart() {
      const database = db.driver.export();
      await payloads.onModuleDestroy(); await db.destroy();
      db = await new DataSource({ type: 'sqljs', database, synchronize: false, entities: sqlEntities }).initialize();
      payloads = withRoot(directory);
      store = new CallObservabilityStore(db, payloads);
      await store.ensurePayloadStorage();
      assert.equal((await db.driver.createSchemaBuilder().log()).upQueries.length, 0);
    },
  };
  t.after(async () => {
    if (db.isInitialized) await db.destroy();
    await payloads.onModuleDestroy();
    const target = path.resolve(directory);
    if (path.dirname(target) !== parent || !path.basename(target).startsWith('run-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(target, { recursive: true, force: true });
  });
  assert.equal((await f.status()).quotaEnforced, false);
  return f;
}
function record(data = '1234567890') {
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
async function withQuota(t, run) {
  const previous = process.env.API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_ENABLED;
  process.env.API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_ENABLED = 'true';
  t.after(() => {
    if (previous === undefined) delete process.env.API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_ENABLED;
    else process.env.API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_ENABLED = previous;
  });
  return run();
}
async function holdReservedOnFault(f, event, behavior) {
  const transaction = f.store.transaction.bind(f.store), open = fs.open, link = fs.link, unlink = fs.unlink;
  let attempted = null;
  f.store.transaction = callback => transaction(async tx => {
    const result = await callback(tx);
    const row = await tx.manager.getRepository(entities.RuntimePayloadQuotaReservationEntity).findOne({ where: {} });
    if (row?.state === 'uncertain') throw new Error('injected-settlement-rollback');
    return result;
  });
  fs.open = async (...args) => {
    if (args[1] === 'wx') {
      attempted = String(args[0]);
      if (behavior === 'before_open') throw Object.assign(new Error('injected-open-fault'), { code: 'EIO' });
    }
    return open(...args);
  };
  if (behavior === 'residual_temp') {
    fs.link = async () => { throw Object.assign(new Error('injected-link-fault'), { code: 'EIO' }); };
    fs.unlink = async file => {
      if (String(file).endsWith('.tmp')) throw Object.assign(new Error('injected-cleanup-fault'), { code: 'EACCES' });
      return unlink(file);
    };
  }
  try { await f.store.ingest(event); }
  finally { f.store.transaction = transaction; fs.open = open; fs.link = link; fs.unlink = unlink; }
  return attempted;
}
function watchOpens() {
  const open = fs.open, attempted = [];
  fs.open = async (...args) => {
    if (args[1] === 'wx') attempted.push(String(args[0]));
    return open(...args);
  };
  return { attempted, restore: () => { fs.open = open; } };
}

// A process can stop after the reservation+intent commit and before the first file open.
test('export/restart after pre-open crash reuses the committed temp key but never releases its reservation', async t => withQuota(t, async () => {
  const f = await fixture(t), event = record();
  const attempted = await holdReservedOnFault(f, event, 'before_open');
  const intent = await f.intent(), temporary = path.join(f.directory, 'payloads', intent.temporaryKey);
  assert.equal(attempted, temporary);
  assert.equal((await f.reservation()).state, 'reserved');
  assert.equal((await f.status()).reservedBytes, 20);
  await assert.rejects(fs.stat(temporary), error => error.code === 'ENOENT');
  await f.restart();
  const writes = watchOpens();
  try { await f.store.ingest(event); } finally { writes.restore(); }
  assert.deepEqual(writes.attempted, [temporary]);
  assert.equal((await f.intent()).temporaryKey, intent.temporaryKey);
  assert.equal(await f.db.getRepository(entities.RuntimePayloadPublicationIntentEntity).count(), 1);
  assert.equal(await fs.readFile(path.join(f.directory, 'payloads', intent.fileKey), 'utf8'), event.request.data);
  assert.equal((await f.reservation()).state, 'uncertain');
  assert.equal((await f.status()).reservedBytes, 20);
  assert.equal((await f.status()).committedBytes, 0);
  assert.equal((await f.status()).quotaEnforced, false);
}));

test('export/restart with residual temp rejects overwrite and retains unknown occupancy', async t => withQuota(t, async () => {
  const f = await fixture(t), event = record();
  await holdReservedOnFault(f, event, 'residual_temp');
  const intent = await f.intent(), temporary = path.join(f.directory, 'payloads', intent.temporaryKey);
  assert.equal(await fs.readFile(temporary, 'utf8'), event.request.data);
  assert.equal((await f.reservation()).state, 'reserved');
  await f.restart();
  const writes = watchOpens();
  try { await f.store.ingest(event); } finally { writes.restore(); }
  assert.deepEqual(writes.attempted, [temporary]);
  assert.equal(await fs.readFile(temporary, 'utf8'), event.request.data);
  assert.equal((await f.reservation()).state, 'uncertain');
  assert.equal((await f.status()).reservedBytes, 20);
  assert.equal((await f.status()).committedBytes, 0);
}));

test('uncertain intent stays held across export/restart and replay performs no file write', async t => withQuota(t, async () => {
  const f = await fixture(t), event = record(), link = fs.link;
  fs.link = async () => { throw Object.assign(new Error('injected-link-fault'), { code: 'EIO' }); };
  try { await f.store.ingest(event); } finally { fs.link = link; }
  assert.equal((await f.reservation()).state, 'uncertain');
  const intent = await f.intent();
  await f.restart();
  const writes = watchOpens();
  try { await f.store.ingest(event); } finally { writes.restore(); }
  assert.deepEqual(writes.attempted, []);
  assert.equal((await f.intent()).temporaryKey, intent.temporaryKey);
  assert.equal((await f.status()).reservedBytes, 20);
  assert.equal((await f.status()).committedBytes, 0);
}));

test('settled duplicate after export/restart verifies final without new temp or extra charge', async t => withQuota(t, async () => {
  const f = await fixture(t), event = record();
  await f.store.ingest(event);
  const intent = await f.intent();
  assert.equal((await f.reservation()).state, 'settled');
  await f.restart();
  const writes = watchOpens();
  try { await f.store.ingest(event); } finally { writes.restore(); }
  assert.deepEqual(writes.attempted, []);
  assert.equal((await f.intent()).temporaryKey, intent.temporaryKey);
  assert.equal((await f.status()).committedBytes, 10);
  assert.equal((await f.status()).reservedBytes, 0);
  assert.equal((await f.status()).quotaEnforced, false);
}));

test('legacy reservation lacking intent stays unknown after export/restart and is never backfilled', async t => withQuota(t, async () => {
  const f = await fixture(t), event = record();
  await f.store.ingest(event);
  const intent = await f.intent();
  await f.db.getRepository(entities.RuntimePayloadPublicationIntentEntity).delete({ reservationId: intent.reservationId });
  await f.restart();
  const prepare = f.payloads.prepare.bind(f.payloads); let request;
  f.payloads.prepare = async (...args) => {
    const result = await prepare(...args);
    if (args[0].side === 'request') request = result;
    return result;
  };
  const writes = watchOpens();
  try { await f.store.ingest(event); }
  finally { writes.restore(); f.payloads.prepare = prepare; }
  assert.equal(request.entity.reason, 'storage_error');
  assert.deepEqual(writes.attempted, []);
  assert.equal(await f.db.getRepository(entities.RuntimePayloadPublicationIntentEntity).count(), 0);
  assert.equal((await f.status()).committedBytes, 10);
  assert.equal((await f.status()).reservedBytes, 0);
}));

async function bareIntent(f) {
  const input = { sourceInstanceId: 'source', sourceEventId: 'event', payloadId: 'a'.repeat(64),
    generation: '0', fileKey: 'aa/' + 'a'.repeat(64) + '.body', digest: 'b'.repeat(64), storedBytes: 10 };
  const primitive = new PayloadPublicationIntentStore();
  const created = await f.store.transaction(tx => primitive.reserve(tx, f.epoch, input));
  return { input, primitive, created };
}
async function assertHeld(f, ownerId) {
  assert.equal(await f.db.getRepository(entities.RuntimePayloadPublicationIntentEntity).count(), 1);
  assert.equal((await f.reservation()).state, 'reserved');
  const ledger = ownerId
    ? await f.db.getRepository(entities.RuntimePayloadQuotaLedgerEntity).findOneByOrFail({ ownerId })
    : await f.db.getRepository(entities.RuntimePayloadQuotaLedgerEntity).findOne({ where: {} });
  assert.equal(ledger.reservedBytes, '20');
  assert.equal(ledger.committedBytes, '0');
  if (!ownerId) assert.equal((await f.status()).quotaEnforced, false);
}

test('changed owner rejects persisted intent without mutating the old reservation', async t => {
  const f = await fixture(t), { primitive, created } = await bareIntent(f);
  const binding = await f.db.getRepository(entities.RuntimePipelineStateEntity).findOneByOrFail({ id: PAYLOAD_OWNER_ID });
  const oldOwner = binding.value.ownerId;
  binding.value = { ...binding.value, ownerId: randomUUID() };
  await f.db.getRepository(entities.RuntimePipelineStateEntity).save(binding);
  await assert.rejects(f.store.readSnapshot(tx => primitive.load(tx, created.reservationId)),
    failure('INVALID_PAYLOAD_PUBLICATION_INTENT'));
  await assertHeld(f, oldOwner);
});

test('changed epoch rejects replay and leaves the old reservation held', async t => {
  const f = await fixture(t), { input, primitive } = await bareIntent(f);
  const ledger = await f.db.getRepository(entities.RuntimePayloadQuotaLedgerEntity).findOne({ where: {} });
  ledger.epoch = randomUUID();
  await f.db.getRepository(entities.RuntimePayloadQuotaLedgerEntity).save(ledger);
  await assert.rejects(f.store.transaction(tx => primitive.reserve(tx, ledger.epoch, input)),
    failure('QUOTA_OPERATION_CONFLICT'));
  await assertHeld(f);
});

test('GC generation change rejects old intent replay and leaves its reservation held', async t => {
  const f = await fixture(t), { input, primitive } = await bareIntent(f);
  const { lease } = await f.store.payloadCoordination.acquireGc();
  assert.ok(lease); assert.equal(lease.generation, '1');
  await f.store.payloadCoordination.releaseGc(lease);
  await assert.rejects(f.store.transaction(tx => primitive.reserve(tx, f.epoch, input)),
    failure('PAYLOAD_PUBLICATION_INTENT_SCOPE_MISMATCH'));
  await assertHeld(f);
});
