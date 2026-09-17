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
const { PayloadPublicationReconcileService } = require('../src/modules/call-observability/call-observability-payload-publication-reconcile.ts');
const parent = path.resolve(__dirname, '../../../tmp/observability-publication-reconcile-tests');

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

function reconcile(f) { return new PayloadPublicationReconcileService(f.store, f.payloads); }

test('complete same-fence evidence settles exact bytes once and keeps enforcement off', async t => {
  const f = await fixture(t); await f.makeHeld();
  const result = await reconcile(f).reconcile(f.intent.reservationId);
  assert.equal(result.status, 'settled', JSON.stringify(result));
  assert.equal(result.committedBytes, 10);
  assert.equal(result.quotaEnforced, false);
  const after = await f.snapshot();
  assert.equal(after.ledger.reservedBytes, '0');
  assert.equal(after.ledger.committedBytes, '10');
  assert.equal(after.reservation.state, 'settled');
  assert.equal(after.reservation.committedBytes, '10');
  assert.match(after.reservation.settlementHash, /^[a-f0-9]{64}$/);
  const retry = await reconcile(f).reconcile(f.intent.reservationId);
  assert.equal(retry.status, 'blocked');
  assert.deepEqual(await f.snapshot(), after);
});

test('missing file, residual temp, unknown path and incomplete scan never release quota', async t => {
  const f = await fixture(t); await f.makeHeld();
  const before = await f.snapshot(); const service = reconcile(f);
  await fs.unlink(f.final);
  assert.equal((await service.reconcile(f.intent.reservationId)).status, 'blocked');
  await fs.writeFile(f.final, '1234567890');
  await fs.writeFile(f.temporary, 'residual');
  assert.equal((await service.reconcile(f.intent.reservationId)).reason, 'temporary_present');
  await fs.unlink(f.temporary);
  await fs.writeFile(path.join(f.directory, 'payloads', f.intent.fileKey.slice(0, 2), 'unexpected'), 'x');
  assert.equal((await service.reconcile(f.intent.reservationId)).reason, 'scan_unknown');
  await fs.unlink(path.join(f.directory, 'payloads', f.intent.fileKey.slice(0, 2), 'unexpected'));
  const otherShard = f.intent.fileKey.slice(0, 2) === 'ff' ? 'ee' : 'ff';
  await fs.mkdir(path.join(f.directory, 'payloads', otherShard));
  await fs.writeFile(path.join(f.directory, 'payloads', otherShard, otherShard + '0'.repeat(62) + '.body'), 'x');
  assert.equal((await service.reconcile(f.intent.reservationId,
    { maxEntriesPerBatch: 1, maxBatches: 1 })).reason, 'scan_partial');
  await assertHeld(f, before);
});

test('active writer is busy and cannot settle or hold bytes', async t => {
  const f = await fixture(t); await f.makeHeld(); const before = await f.snapshot();
  const writer = await f.store.payloadCoordination.acquireWriter();
  try {
    const result = await reconcile(f).reconcile(f.intent.reservationId);
    assert.equal(result.status, 'busy');
    assert.equal(result.reason, 'writer_active');
    assert.equal(result.holdStatus, null);
  } finally { await f.store.payloadCoordination.releaseWriter(writer); }
  await assertHeld(f, before);
});

test('DB version change after file proof blocks the final transaction', async t => {
  const f = await fixture(t); await f.makeHeld();
  const service = reconcile(f);
  const original = service.files.inspectWithinFence.bind(service.files);
  service.files.inspectWithinFence = async (...args) => {
    const proof = await original(...args);
    const ledger = await f.db.getRepository(entities.RuntimePayloadQuotaLedgerEntity).findOne({ where: {} });
    await f.db.getRepository(entities.RuntimePayloadQuotaLedgerEntity)
      .update({ ownerId: ledger.ownerId }, { version: ledger.version + 1 });
    return proof;
  };
  const result = await service.reconcile(f.intent.reservationId);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'PAYLOAD_RECOVERY_EVIDENCE_CHANGED');
  const after = await f.snapshot();
  assert.equal(after.ledger.reservedBytes, '20');
  assert.equal(after.ledger.committedBytes, '0');
  assert.equal(after.reservation.state, 'uncertain');
});

test('same-length file corruption between scans is caught before credit', async t => {
  const f = await fixture(t); await f.makeHeld(); const before = await f.snapshot();
  const scan = f.payloads.scanRecoveryPaths.bind(f.payloads); let calls = 0;
  f.payloads.scanRecoveryPaths = async (...args) => {
    if (++calls === 2) await fs.writeFile(f.final, 'xxxxxxxxxx');
    return scan(...args);
  };
  try {
    const result = await reconcile(f).reconcile(f.intent.reservationId);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'PAYLOAD_INTEGRITY_ERROR');
  } finally { f.payloads.scanRecoveryPaths = scan; }
  assert.equal(calls, 2);
  await assertHeld(f, before);
});

test('fault after quota mutation rolls back reserved and committed counters', async t => {
  const f = await fixture(t); await f.makeHeld(); const before = await f.snapshot();
  const original = PayloadQuotaPrimitives.prototype.settle;
  PayloadQuotaPrimitives.prototype.settle = async function (...args) {
    const result = await original.apply(this, args);
    if (args[3].reason === 'confirmed_occupancy_and_unused_absent') {
      throw new Error('injected-after-settle');
    }
    return result;
  };
  try {
    const result = await reconcile(f).reconcile(f.intent.reservationId);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'transaction_failed');
  } finally { PayloadQuotaPrimitives.prototype.settle = original; }
  await assertHeld(f, before);
});

test('export/restart after settlement cannot credit the same reservation again', async t => {
  const f = await fixture(t); await f.makeHeld();
  assert.equal((await reconcile(f).reconcile(f.intent.reservationId)).status, 'settled');
  const before = await f.snapshot();
  const bytes = f.db.driver.export();
  const restartedDb = await new DataSource({ type: 'sqljs', database: bytes, synchronize: false,
    entities: [...entities.CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity] }).initialize();
  const prior = process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  process.env.API_NOVA_OBSERVABILITY_DATA_DIR = f.directory;
  const restartedPayloads = new CallObservabilityPayloadStore();
  if (prior === undefined) delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  else process.env.API_NOVA_OBSERVABILITY_DATA_DIR = prior;
  t.after(async () => { await restartedDb.destroy(); await restartedPayloads.onModuleDestroy(); });
  const restartedStore = new CallObservabilityStore(restartedDb, restartedPayloads);
  const retry = await new PayloadPublicationReconcileService(restartedStore, restartedPayloads)
    .reconcile(f.intent.reservationId);
  assert.equal(retry.status, 'blocked');
  assert.deepEqual(await f.snapshot(), before);
  const row = await restartedDb.getRepository(entities.RuntimePayloadQuotaLedgerEntity).findOne({ where: {} });
  assert.equal(row.reservedBytes, '0');
  assert.equal(row.committedBytes, '10');
});
test('legacy missing intent and changed generation cannot infer settlement', async t => {
  const f = await fixture(t); await f.makeHeld(); const before = await f.snapshot();
  await f.db.getRepository(entities.RuntimePayloadPublicationIntentEntity)
    .delete({ reservationId: f.intent.reservationId });
  let result = await reconcile(f).reconcile(f.intent.reservationId);
  assert.equal(result.reason, 'intent_missing_or_invalid');
  await assertHeld(f, before);
  const coordination = await f.db.getRepository(entities.RuntimePipelineStateEntity)
    .findOneBy({ id: 'call-observability:payload-coordination' });
  coordination.value.generation = String(BigInt(coordination.value.generation) + 1n);
  await f.db.getRepository(entities.RuntimePipelineStateEntity).save(coordination);
  result = await reconcile(f).reconcile(f.intent.reservationId);
  assert.equal(result.reason, 'scope_mismatch');
  await assertHeld(f, before);
});

test('lost lease during final scan cannot release reserved bytes', async t => {
  const f = await fixture(t); await f.makeHeld(); const before = await f.snapshot();
  const scan = f.payloads.scanRecoveryPaths.bind(f.payloads); let calls = 0;
  f.payloads.scanRecoveryPaths = async (...args) => {
    if (++calls === 2) throw new ObservabilityStorageError('PAYLOAD_INVENTORY_FENCE_LOST');
    return scan(...args);
  };
  try {
    const result = await reconcile(f).reconcile(f.intent.reservationId);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'PAYLOAD_INVENTORY_FENCE_LOST');
  } finally { f.payloads.scanRecoveryPaths = scan; }
  await assertHeld(f, before);
});

test('metadata conflict leaves the exact reservation uncertain', async t => {
  const f = await fixture(t); await f.makeHeld(); const before = await f.snapshot();
  const metadata = await f.db.getRepository(entities.RuntimePayloadEntity).findOne({ where: {} });
  metadata.digest = 'f'.repeat(64);
  await f.db.getRepository(entities.RuntimePayloadEntity).save(metadata);
  const result = await reconcile(f).reconcile(f.intent.reservationId);
  assert.equal(result.reason, 'payload_metadata_missing_or_invalid');
  await assertHeld(f, before);
});
