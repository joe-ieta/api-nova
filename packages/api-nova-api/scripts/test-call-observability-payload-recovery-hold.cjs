'use strict';
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, project: require('node:path').resolve(__dirname, '../tsconfig.json') });
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { DataSource } = require('typeorm');
const load = name => require('../src/' + name + '.ts');
const entities = load('database/entities/runtime-call-observability.entity');
const { RuntimeObservabilityEventEntity: Event } = load('database/entities/runtime-observability-event.entity');
const { CallObservabilityStore } = load('modules/call-observability/call-observability.store');
const { CallObservabilityPayloadStore } = load('modules/call-observability/call-observability-payload.store');
const { PayloadQuotaPrimitives } = load('modules/call-observability/call-observability-payload-quota');
const { PayloadRecoveryHoldService } = load('modules/call-observability/call-observability-payload-recovery-hold');
const parent = path.resolve(__dirname, '../../../tmp/observability-payload-recovery-hold-tests');

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
  const initial = await store.transaction(tx => quota.initialize(tx,
    { enabled: true, quotaBytes: 1000, maxBodyBytes: 500 }));
  await store.transaction(tx => quota.confirmBaseline(tx, initial.epoch,
    { kind: 'complete_inventory', evidenceId: 'isolated-test-baseline', committedBytes: 0 }));
  const operationId = 'publish:' + 'a'.repeat(64);
  await store.transaction(tx => quota.reserve(tx, initial.epoch, operationId, 100));
  const reservation = await db.getRepository(entities.RuntimePayloadQuotaReservationEntity)
    .findOneByOrFail({ operationId });
  const service = new PayloadRecoveryHoldService(store, payloads);
  const ledgerRow = () => db.getRepository(entities.RuntimePayloadQuotaLedgerEntity)
    .findOneByOrFail({ ownerId });
  const reservationRow = () => db.getRepository(entities.RuntimePayloadQuotaReservationEntity)
    .findOneByOrFail({ id: reservation.id });
  t.after(async () => {
    if (db.isInitialized) await db.destroy();
    await payloads.onModuleDestroy();
    const target = path.resolve(directory);
    if (path.dirname(target) !== parent || !path.basename(target).startsWith('run-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(target, { recursive: true, force: true });
  });
  return { db, store, payloads, service, ownerId, epoch: initial.epoch, reservation,
    operationId, ledgerRow, reservationRow, directory };
}

test('verified reservation becomes uncertain and ledger degraded without releasing any byte', async t => {
  const f = await fixture(t);
  const before = await f.ledgerRow();
  const result = await f.service.hold(f.reservation.id);
  assert.equal(result.status, 'held');
  assert.equal(result.reservedBytes, '100');
  assert.equal(result.quotaEnforced, false);
  const after = await f.ledgerRow();
  assert.equal(after.reservedBytes, before.reservedBytes);
  assert.equal(after.committedBytes, before.committedBytes);
  assert.equal(after.state, 'degraded');
  const reservation = await f.reservationRow();
  assert.equal(reservation.state, 'uncertain');
  assert.equal(reservation.committedBytes, null);
  assert.equal(reservation.settlementHash, null);
});

test('repeated hold is idempotent and does not alter ledger version or held bytes', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.hold(f.reservation.id)).status, 'held');
  const before = await f.ledgerRow();
  const reservationBefore = await f.reservationRow();
  const replay = await f.service.hold(f.reservation.id);
  assert.equal(replay.status, 'already_held');
  assert.deepEqual(await f.ledgerRow(), before);
  assert.deepEqual(await f.reservationRow(), reservationBefore);
});

test('an orphan candidate cannot release or credit an unrelated reservation', async t => {
  const f = await fixture(t);
  const shard = path.join(f.directory, 'payloads', '00');
  await fs.mkdir(shard, { recursive: true });
  await fs.writeFile(path.join(shard, '0'.repeat(64) + '.body'), 'orphan');
  const result = await f.service.hold(f.reservation.id);
  assert.equal(result.status, 'held');
  assert.equal((await f.ledgerRow()).reservedBytes, '100');
  assert.equal((await f.ledgerRow()).committedBytes, '0');
  assert.equal((await f.reservationRow()).state, 'uncertain');
});

test('corrupt reservation scope and ledger state block mutation', async t => {
  for (const mutate of [
    async f => f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity)
      .update({ id: f.reservation.id }, { requestHash: 'f'.repeat(64) }),
    async f => f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity)
      .update({ id: f.reservation.id }, { generation: '7' }),
    async f => f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity)
      .update({ id: f.reservation.id }, { epoch: 'f'.repeat(36) }),
    async f => f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity)
      .update({ id: f.reservation.id }, { ownerId: 'f'.repeat(36) }),
    async f => f.db.getRepository(entities.RuntimePayloadQuotaLedgerEntity)
      .update({ ownerId: f.ownerId }, { reservedBytes: '50' }),
    async f => f.db.getRepository(entities.RuntimePayloadQuotaLedgerEntity)
      .update({ ownerId: f.ownerId }, { state: 'initializing', baselineKey: null }),
  ]) {
    await t.test('invalid scope or ledger remains held', async sub => {
      const f = await fixture(sub);
      await mutate(f);
      const before = await f.ledgerRow();
      const reservationBefore = await f.reservationRow();
      const result = await f.service.hold(f.reservation.id);
      assert.equal(result.status, 'blocked');
      assert.deepEqual(await f.ledgerRow(), before);
      assert.deepEqual(await f.reservationRow(), reservationBefore);
    });
  }
});

test('writer-held fence reports busy and leaves reservation unchanged', async t => {
  const f = await fixture(t);
  const writer = await f.store.payloadCoordination.acquireWriter();
  const before = await f.ledgerRow();
  try {
    const result = await f.service.hold(f.reservation.id);
    assert.equal(result.status, 'busy');
    assert.equal(result.reason, 'writer_active');
    assert.deepEqual(await f.ledgerRow(), before);
    assert.equal((await f.reservationRow()).state, 'reserved');
  } finally {
    await f.store.payloadCoordination.releaseWriter(writer);
  }
});

test('transaction fault after provisional settlement rolls back row and ledger', async t => {
  const f = await fixture(t);
  const original = f.store.payloadCoordination.assertInventoryFence.bind(f.store.payloadCoordination);
  let assertions = 0;
  f.store.payloadCoordination.assertInventoryFence = async (...args) => {
    if (++assertions === 2) throw new Error('injected-fence-transaction-fault');
    return original(...args);
  };
  const before = await f.ledgerRow();
  try {
    await assert.rejects(f.service.hold(f.reservation.id), /injected-fence-transaction-fault/);
  } finally {
    f.store.payloadCoordination.assertInventoryFence = original;
  }
  assert.deepEqual(await f.ledgerRow(), before);
  assert.equal((await f.reservationRow()).state, 'reserved');
  const retry = await f.service.hold(f.reservation.id);
  assert.equal(retry.status, 'held');
  assert.equal((await f.ledgerRow()).reservedBytes, '100');
});

test('SQL.js export and restart preserve uncertain hold and replay without releasing bytes', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.hold(f.reservation.id)).status, 'held');
  const database = f.db.driver.export();
  await f.db.destroy();
  const restartedDb = await new DataSource({ type: 'sqljs', database, synchronize: false,
    entities: [...entities.CALL_OBSERVABILITY_ENTITIES, Event] }).initialize();
  t.after(() => restartedDb.destroy());
  const restartedStore = new CallObservabilityStore(restartedDb, f.payloads);
  const replay = await new PayloadRecoveryHoldService(restartedStore, f.payloads).hold(f.reservation.id);
  assert.equal(replay.status, 'already_held');
  const ledger = await restartedDb.getRepository(entities.RuntimePayloadQuotaLedgerEntity)
    .findOneByOrFail({ ownerId: f.ownerId });
  assert.equal(ledger.reservedBytes, '100');
  assert.equal(ledger.committedBytes, '0');
  assert.equal(ledger.state, 'degraded');
});
test('missing root blocks recovery without creating files or changing held bytes', async t => {
  const f = await fixture(t);
  const absentBase = path.join(f.directory, 'absent');
  const previous = process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  process.env.API_NOVA_OBSERVABILITY_DATA_DIR = absentBase;
  const unboundPayloads = new CallObservabilityPayloadStore();
  if (previous === undefined) delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  else process.env.API_NOVA_OBSERVABILITY_DATA_DIR = previous;
  const before = await f.ledgerRow();
  const result = await new PayloadRecoveryHoldService(f.store, unboundPayloads).hold(f.reservation.id);
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(await f.ledgerRow(), before);
  assert.equal((await f.reservationRow()).state, 'reserved');
  await assert.rejects(fs.stat(path.join(absentBase, 'payloads')), { code: 'ENOENT' });
  await unboundPayloads.onModuleDestroy();
});
