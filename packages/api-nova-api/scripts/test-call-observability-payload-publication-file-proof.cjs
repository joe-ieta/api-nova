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
const { PayloadPublicationFileProofService } = require('../src/modules/call-observability/call-observability-payload-publication-file-proof.ts');
const { PAYLOAD_OWNER_ID } = require('../src/modules/call-observability/call-observability-payload.coordinator.ts');
const { ObservabilityStorageError } = require('../src/modules/call-observability/call-observability-storage.ts');
const parent = path.resolve(__dirname, '../../../tmp/observability-publication-file-proof-tests');

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
    { kind: 'complete_inventory', evidenceId: 'isolated-c2a-baseline', committedBytes: 0 }));
  const source = event();
  await store.ingest(source);
  const intent = await db.getRepository(entities.RuntimePayloadPublicationIntentEntity).findOne({ where: {} });
  assert.ok(intent);
  const proof = new PayloadPublicationFileProofService(store, payloads);
  const final = path.join(directory, 'payloads', intent.fileKey);
  const temporary = path.join(directory, 'payloads', intent.temporaryKey);
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
    // Synthetic unknown row with a real committed receipt/metadata/final object:
    // this isolates read-only proof from the later C2B settlement decision.
    const ledger = await db.getRepository(entities.RuntimePayloadQuotaLedgerEntity).findOne({ where: {} });
    const reservation = await db.getRepository(entities.RuntimePayloadQuotaReservationEntity).findOne({ where: {} });
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
  return { db, store, payloads, source, intent, proof, final, temporary, directory, makeHeld, snapshot };
}
async function assertHeld(f, before) {
  assert.deepEqual(await f.snapshot(), before);
  assert.equal((await f.store.readSnapshot(tx => new PayloadQuotaPrimitives().status(tx))).quotaEnforced, false);
}

test('complete scan and exact digest yield uncommitted proof without releasing a byte', async t => {
  const f = await fixture(t); await f.makeHeld(); const before = await f.snapshot();
  const result = await f.proof.inspect(f.intent.reservationId);
  assert.equal(result.status, 'file_proof_uncommitted', JSON.stringify(result));
  assert.equal(result.fileKey, f.intent.fileKey);
  assert.equal(result.storedBytes, 10);
  assert.equal(result.quotaEnforced, false);
  await assertHeld(f, before);
});

test('missing final or same-length digest corruption remains blocked and held', async t => {
  const f = await fixture(t); await f.makeHeld(); const before = await f.snapshot();
  await fs.writeFile(f.final, 'xxxxxxxxxx');
  assert.equal((await f.proof.inspect(f.intent.reservationId)).reason, 'file_unverified');
  await fs.unlink(f.final);
  assert.equal((await f.proof.inspect(f.intent.reservationId)).reason, 'file_missing_or_invalid');
  await assertHeld(f, before);
});

test('residual temporary path and unknown root entry never become zero occupancy', async t => {
  const f = await fixture(t); await f.makeHeld(); const before = await f.snapshot();
  await fs.writeFile(f.temporary, 'residual');
  assert.equal((await f.proof.inspect(f.intent.reservationId)).reason, 'temporary_present');
  await fs.unlink(f.temporary);
  await fs.writeFile(path.join(f.directory, 'payloads', f.intent.fileKey.slice(0, 2), 'unexpected'), 'x');
  assert.equal((await f.proof.inspect(f.intent.reservationId)).reason, 'scan_unknown');
  await assertHeld(f, before);
});

test('insufficient scan budget reports partial instead of reusable proof', async t => {
  const f = await fixture(t); await f.makeHeld(); const before = await f.snapshot();
  const otherShard = f.intent.fileKey.slice(0, 2) === 'ff' ? 'ee' : 'ff';
  const folder = path.join(f.directory, 'payloads', otherShard);
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, otherShard + '0'.repeat(62) + '.body'), 'x');
  const result = await f.proof.inspect(f.intent.reservationId,
    { maxEntriesPerBatch: 1, maxBatches: 1 });
  assert.equal(result.reason, 'scan_partial');
  await assertHeld(f, before);
});

test('active writer and scanner failure cannot produce proof or change quota', async t => {
  const f = await fixture(t); await f.makeHeld(); const before = await f.snapshot();
  const lease = await f.store.payloadCoordination.acquireWriter();
  try {
    const busy = await f.proof.inspect(f.intent.reservationId);
    assert.equal(busy.status, 'busy'); assert.equal(busy.reason, 'writer_active');
  } finally { await f.store.payloadCoordination.releaseWriter(lease); }
  const scan = f.payloads.scanRecoveryPaths.bind(f.payloads);
  f.payloads.scanRecoveryPaths = async () => { throw new Error('injected-scanner-failure'); };
  try { assert.equal((await f.proof.inspect(f.intent.reservationId)).reason, 'scan_unknown'); }
  finally { f.payloads.scanRecoveryPaths = scan; }
  await assertHeld(f, before);
});

test('lost inventory fence cannot yield a trusted result', async t => {
  const f = await fixture(t); await f.makeHeld(); const before = await f.snapshot();
  const scan = f.payloads.scanRecoveryPaths.bind(f.payloads);
  f.payloads.scanRecoveryPaths = async () => {
    throw new ObservabilityStorageError('PAYLOAD_INVENTORY_FENCE_LOST');
  };
  try { await assert.rejects(f.proof.inspect(f.intent.reservationId),
    error => error.code === 'PAYLOAD_INVENTORY_FENCE_LOST'); }
  finally { f.payloads.scanRecoveryPaths = scan; }
  await assertHeld(f, before);
});

test('missing receipt blocks file proof before scanning and leaves quota held', async t => {
  const f = await fixture(t); await f.makeHeld(); const before = await f.snapshot();
  const receipt = await f.db.getRepository(entities.RuntimeIngestReceiptEntity).findOne({ where: {} });
  await f.db.getRepository(entities.RuntimeIngestReceiptEntity).delete({ id: receipt.id });
  const scan = f.payloads.scanRecoveryPaths.bind(f.payloads); let scans = 0;
  f.payloads.scanRecoveryPaths = async (...args) => { scans++; return scan(...args); };
  try { assert.equal((await f.proof.inspect(f.intent.reservationId)).reason, 'receipt_missing_or_invalid'); }
  finally { f.payloads.scanRecoveryPaths = scan; }
  assert.equal(scans, 0);
  await assertHeld(f, before);
});

test('missing owner binding is unavailable and cannot make a proof', async t => {
  const f = await fixture(t); await f.makeHeld(); const before = await f.snapshot();
  await f.db.getRepository(entities.RuntimePipelineStateEntity).delete({ id: PAYLOAD_OWNER_ID });
  const result = await f.proof.inspect(f.intent.reservationId);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'storage_unavailable');
  assert.equal(result.quotaEnforced, false);
  assert.deepEqual(await f.snapshot(), before);
});
