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
const { PayloadPublicationCorrelationService } = require('../src/modules/call-observability/call-observability-payload-publication-correlation.ts');
const parent = path.resolve(__dirname, '../../../tmp/observability-publication-correlation-tests');

function event(data = '1234567890') {
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
async function fixture(t) {
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'run-'));
  const priorRoot = process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  const priorQuota = process.env.API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_ENABLED;
  process.env.API_NOVA_OBSERVABILITY_DATA_DIR = directory;
  process.env.API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_ENABLED = 'true';
  const payloads = new CallObservabilityPayloadStore();
  if (priorRoot === undefined) delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  else process.env.API_NOVA_OBSERVABILITY_DATA_DIR = priorRoot;
  const db = await new DataSource({ type: 'sqljs', synchronize: true,
    entities: [...entities.CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity] }).initialize();
  const store = new CallObservabilityStore(db, payloads);
  await store.ensurePayloadStorage();
  const quota = new PayloadQuotaPrimitives();
  const initial = await store.transaction(tx => quota.initialize(tx,
    { enabled: true, quotaBytes: 1000, maxBodyBytes: 500 }));
  await store.transaction(tx => quota.confirmBaseline(tx, initial.epoch,
    { kind: 'complete_inventory', evidenceId: 'isolated-c1-baseline', committedBytes: 0 }));
  const source = event();
  await store.ingest(source);
  const intent = await db.getRepository(entities.RuntimePayloadPublicationIntentEntity).findOne({ where: {} });
  assert.ok(intent);
  const correlation = new PayloadPublicationCorrelationService(store, payloads);
  t.after(async () => {
    if (priorQuota === undefined) delete process.env.API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_ENABLED;
    else process.env.API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_ENABLED = priorQuota;
    if (db.isInitialized) await db.destroy();
    await payloads.onModuleDestroy();
    const target = path.resolve(directory);
    if (path.dirname(target) !== parent || !path.basename(target).startsWith('run-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(target, { recursive: true, force: true });
  });
  async function makeHeld() {
    // A synthetic unknown state with complete historical DB evidence isolates
    // correlation from the later filesystem/settlement stage.
    const ledger = await db.getRepository(entities.RuntimePayloadQuotaLedgerEntity).findOne({ where: {} });
    const reservation = await db.getRepository(entities.RuntimePayloadQuotaReservationEntity).findOne({ where: {} });
    assert.equal(reservation.state, 'settled');
    ledger.state = 'degraded'; ledger.committedBytes = '0'; ledger.reservedBytes = reservation.reservedBytes;
    ledger.version += 1;
    reservation.state = 'uncertain'; reservation.committedBytes = null; reservation.settlementHash = null;
    await db.getRepository(entities.RuntimePayloadQuotaLedgerEntity).save(ledger);
    await db.getRepository(entities.RuntimePayloadQuotaReservationEntity).save(reservation);
  }
  async function snapshot() {
    const ledger = await db.getRepository(entities.RuntimePayloadQuotaLedgerEntity).findOne({ where: {} });
    const reservation = await db.getRepository(entities.RuntimePayloadQuotaReservationEntity).findOne({ where: {} });
    return { ledger: { version: ledger.version, state: ledger.state, committedBytes: ledger.committedBytes,
      reservedBytes: ledger.reservedBytes }, reservation: { state: reservation.state,
      committedBytes: reservation.committedBytes, settlementHash: reservation.settlementHash } };
  }
  return { db, store, payloads, quota, source, intent, correlation, makeHeld, snapshot, directory };
}

test('complete DB link is explicitly unverified and leaves quota unchanged', async t => {
  const f = await fixture(t); await f.makeHeld();
  const before = await f.snapshot();
  const result = await f.correlation.inspect(f.intent.reservationId);
  assert.equal(result.status, 'linked_unverified', JSON.stringify(result));
  assert.equal(result.payloadId, f.intent.payloadId);
  assert.equal(result.fileKey, f.intent.fileKey);
  assert.equal(result.temporaryKey, f.intent.temporaryKey);
  assert.equal(result.storedBytes, 10);
  assert.equal(result.quotaEnforced, false);
  assert.deepEqual(await f.snapshot(), before);
});

test('missing receipt or legacy missing intent blocks correlation without releasing bytes', async t => {
  const f = await fixture(t); await f.makeHeld();
  const before = await f.snapshot();
  const receipt = await f.db.getRepository(entities.RuntimeIngestReceiptEntity).findOne({ where: {} });
  await f.db.getRepository(entities.RuntimeIngestReceiptEntity).delete({ id: receipt.id });
  assert.equal((await f.correlation.inspect(f.intent.reservationId)).reason, 'receipt_missing_or_invalid');
  await f.db.getRepository(entities.RuntimePayloadPublicationIntentEntity)
    .delete({ reservationId: f.intent.reservationId });
  assert.equal((await f.correlation.inspect(f.intent.reservationId)).reason, 'intent_missing_or_invalid');
  assert.deepEqual(await f.snapshot(), before);
});

test('corrupt metadata, receipt hash, or revision reference never becomes a trusted link', async t => {
  const f = await fixture(t); await f.makeHeld();
  const before = await f.snapshot();
  const payloads = f.db.getRepository(entities.RuntimePayloadEntity);
  const payload = await payloads.findOneByOrFail({ id: f.intent.payloadId });
  const original = structuredClone(payload.metadata);
  payload.metadata = { ...original, storedBytes: 0 };
  await payloads.save(payload);
  assert.equal((await f.correlation.inspect(f.intent.reservationId)).reason, 'payload_metadata_missing_or_invalid');
  payload.metadata = original; await payloads.save(payload);
  const receipts = f.db.getRepository(entities.RuntimeIngestReceiptEntity);
  const receipt = await receipts.findOne({ where: {} }), hash = receipt.recordHash;
  receipt.recordHash = 'f'.repeat(64); await receipts.save(receipt);
  assert.equal((await f.correlation.inspect(f.intent.reservationId)).reason, 'revision_missing_or_conflict');
  receipt.recordHash = hash; await receipts.save(receipt);
  const invocations = f.db.getRepository(entities.RuntimeInvocationEntity);
  const invocation = await invocations.findOneByOrFail({ invocationId: f.source.invocationId });
  invocation.requestPayloadId = 'e'.repeat(64); await invocations.save(invocation);
  assert.equal((await f.correlation.inspect(f.intent.reservationId)).reason, 'revision_missing_or_conflict');
  invocation.requestPayloadId = f.intent.payloadId; await invocations.save(invocation);
  const revisions = f.db.getRepository(entities.RuntimeInvocationRevisionEntity);
  const history = await revisions.find({ where: { invocationId: f.source.invocationId } });
  for (const row of history) { row.requestPayloadId = 'e'.repeat(64); await revisions.save(row); }
  assert.equal((await f.correlation.inspect(f.intent.reservationId)).reason, 'revision_missing_or_conflict');
  assert.deepEqual(await f.snapshot(), before);
});

test('active writer blocks read-only correlation; no ledger transaction is performed', async t => {
  const f = await fixture(t); await f.makeHeld();
  const before = await f.snapshot();
  const lease = await f.store.payloadCoordination.acquireWriter();
  try {
    const result = await f.correlation.inspect(f.intent.reservationId);
    assert.equal(result.status, 'busy'); assert.equal(result.reason, 'writer_active');
  } finally { await f.store.payloadCoordination.releaseWriter(lease); }
  assert.deepEqual(await f.snapshot(), before);
});

test('epoch and GC generation drift both block old intent while preserving held bytes', async t => {
  const f = await fixture(t); await f.makeHeld();
  const before = await f.snapshot();
  const gc = await f.store.payloadCoordination.acquireGc();
  assert.ok(gc.lease); await f.store.payloadCoordination.releaseGc(gc.lease);
  assert.equal((await f.correlation.inspect(f.intent.reservationId)).reason, 'scope_mismatch');
  const ledger = await f.db.getRepository(entities.RuntimePayloadQuotaLedgerEntity).findOne({ where: {} });
  ledger.epoch = randomUUID();
  await f.db.getRepository(entities.RuntimePayloadQuotaLedgerEntity).save(ledger);
  assert.equal((await f.correlation.inspect(f.intent.reservationId)).reason, 'scope_mismatch');
  assert.deepEqual(await f.snapshot(), before);
});
