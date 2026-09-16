'use strict';
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, project: require('path').resolve(__dirname, '../tsconfig.json') });
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const source = name => require('../src/' + name + '.ts');
const entities = source('database/entities/runtime-call-observability.entity');
const { RuntimeObservabilityEventEntity: Event } = source('database/entities/runtime-observability-event.entity');
const { CallObservabilityStore } = source('modules/call-observability/call-observability.store');
const { PayloadQuotaPrimitives, payloadQuotaConfiguration } = source('modules/call-observability/call-observability-payload-quota');
const { PAYLOAD_OWNER_ID, PAYLOAD_COORDINATION_ID } = source('modules/call-observability/call-observability-payload.coordinator');
const options = { enabled: true, quotaBytes: 1000, maxBodyBytes: 500 };
async function fixture(t) {
  const db = await new DataSource({ type: 'sqljs', synchronize: true, entities: [...entities.CALL_OBSERVABILITY_ENTITIES, Event] }).initialize();
  t.after(async () => { if (db.isInitialized) await db.destroy(); });
  const store = new CallObservabilityStore(db, {}), quota = new PayloadQuotaPrimitives(), ownerId = randomUUID();
  await store.transaction(async tx => { await tx.manager.getRepository(entities.RuntimePipelineStateEntity).insert({ id: PAYLOAD_OWNER_ID, value: { ownerId }, updatedAt: tx.now }); });
  const initial = await store.transaction(tx => quota.initialize(tx, options));
  const epoch = initial.epoch;
  return { db, store, quota, ownerId, epoch, initial,
    baseline: (bytes = 0) => store.transaction(tx => quota.confirmBaseline(tx, epoch, { kind: 'complete_inventory', evidenceId: 'fixture-inventory', committedBytes: bytes })),
    reserve: (id, bytes) => store.transaction(tx => quota.reserve(tx, epoch, id, bytes)),
    settle: (id, result) => store.transaction(tx => quota.settle(tx, epoch, id, result)),
    status: () => store.readSnapshot(tx => quota.status(tx)) };
}
const code = expected => error => error.code === expected;

test('strict defaults and safe integer Q/H/L boundaries include overflow-free default percentages', () => {
  assert.equal(payloadQuotaConfiguration().enabled, false);
  assert.equal(payloadQuotaConfiguration().quotaBytes, null);
  const max = payloadQuotaConfiguration({ enabled: true, quotaBytes: Number.MAX_SAFE_INTEGER });
  assert.equal(max.highWatermarkBytes, Number(BigInt(Number.MAX_SAFE_INTEGER) * 90n / 100n));
  for (const raw of [{ enabled: 'true' }, { enabled: true }, { ...options, quotaBytes: 999 },
    { ...options, quotaBytes: Number.MAX_SAFE_INTEGER + 1 }, { ...options, highWatermarkBytes: 1000 },
    { ...options, lowWatermarkBytes: 900 }, { ...options, lowWatermarkBytes: 0 }, { ...options, quotaBytes: '1e3' },
    { ...options, minimumFreeBytes: Number.MAX_SAFE_INTEGER }, { ...options, maxBodyBytes: 67108865 }, { unexpected: true }]) {
    assert.throws(() => payloadQuotaConfiguration(raw), code('INVALID_QUOTA_CONFIGURATION'));
  }
});

test('initializing refuses reservations and baseline is explicit, epoch-bound and idempotent', async t => {
  const f = await fixture(t);
  assert.equal(f.initial.state, 'initializing'); assert.equal(f.initial.committedBytes, null); assert.equal(f.initial.quotaEnforced, false);
  await assert.rejects(f.reserve('first', 1), code('QUOTA_NOT_READY'));
  await assert.rejects(f.store.transaction(tx => f.quota.confirmBaseline(tx, randomUUID(), { kind: 'complete_inventory', evidenceId: 'fixture', committedBytes: 0 })), code('QUOTA_EPOCH_MISMATCH'));
  const ready = await f.baseline(); assert.equal(ready.state, 'ready'); assert.equal(ready.quotaEnforced, false);
  assert.deepEqual(await f.baseline(), ready);
  await assert.rejects(f.baseline(1), code('QUOTA_BASELINE_CONFLICT'));
  await assert.rejects(f.reserve('../bad', 1), code('INVALID_QUOTA_OPERATION'));
  await assert.rejects(f.reserve('a'.repeat(129), 1), code('INVALID_QUOTA_OPERATION'));
});

test('multiple Store instances cannot oversell, unique operation replay never charges twice', async t => {
  const f = await fixture(t); await f.baseline();
  const other = new CallObservabilityStore(f.db, {}), primitives = new PayloadQuotaPrimitives();
  const results = await Promise.allSettled([
    f.reserve('left', 600), other.transaction(tx => primitives.reserve(tx, f.epoch, 'right', 600)) ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'QUOTA_EXHAUSTED').length, 1);
  const winner = results[0].status === 'fulfilled' ? 'left' : 'right';
  assert.equal((await f.reserve(winner, 600)).replayed, true);
  assert.equal((await f.status()).reservedBytes, 600);
  await assert.rejects(f.reserve(winner, 599), code('QUOTA_OPERATION_CONFLICT'));
  assert.equal(await f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity).count(), 1);
});

test('high water stops new work; settlement below low water resumes with exact hard bound', async t => {
  const f = await fixture(t); await f.baseline();
  assert.equal((await f.reserve('high', 900)).status.state, 'limited');
  await assert.rejects(f.reserve('blocked', 1), code('QUOTA_NOT_READY'));
  assert.equal((await f.settle('high', { reason: 'confirmed_occupancy_and_unused_absent', committedBytes: 801 })).status.state, 'limited');
  // A new isolated budget demonstrates the low boundary without inventing deletion of committed bytes.
  const low = await fixture(t); await low.baseline(); await low.reserve('low', 900);
  assert.equal((await low.settle('low', { reason: 'confirmed_occupancy_and_unused_absent', committedBytes: 800 })).status.state, 'ready');
  assert.equal((await low.reserve('hard', 200)).status.budgetedBytes, 1000);
  assert.equal((await low.status()).state, 'limited');
});

test('unknown occupancy remains reserved across generation changes and reconstructed database services', async t => {
  const f = await fixture(t); await f.baseline(); await f.reserve('uncertain', 600);
  assert.equal((await f.settle('uncertain', { reason: 'unknown' })).status.state, 'degraded');
  assert.equal((await f.settle('uncertain', { reason: 'unknown' })).replayed, true);
  await f.store.transaction(tx => tx.manager.getRepository(entities.RuntimePipelineStateEntity).save({ id: PAYLOAD_COORDINATION_ID,
    value: { generation: '999', writers: {}, gc: null }, updatedAt: tx.now }));
  const database = f.db.driver.export(); await f.db.destroy();
  const db = await new DataSource({ type: 'sqljs', database, synchronize: false, entities: [...entities.CALL_OBSERVABILITY_ENTITIES, Event] }).initialize();
  t.after(() => db.destroy());
  const store = new CallObservabilityStore(db, {}), quota = new PayloadQuotaPrimitives();
  assert.equal((await store.readSnapshot(tx => quota.status(tx))).reservedBytes, 600);
  await assert.rejects(store.transaction(tx => quota.reserve(tx, f.epoch, 'later', 1)), code('QUOTA_NOT_READY'));
  const resolved = await store.transaction(tx => quota.settle(tx, f.epoch, 'uncertain', { reason: 'confirmed_absent', committedBytes: 0 }));
  assert.equal(resolved.status.reservedBytes, 0); assert.equal(resolved.status.state, 'ready');
  assert.equal(resolved.status.epoch, f.epoch);
});

test('reservation and settlement roll back atomically, terminal settlement conflicts cannot release twice', async t => {
  const f = await fixture(t); await f.baseline(); const before = await f.status(), watermark = await f.store.watermark();
  await assert.rejects(f.store.transaction(async tx => { await f.quota.reserve(tx, f.epoch, 'rolled-back', 500); throw new Error('rollback'); }), /rollback/);
  assert.deepEqual(await f.status(), before);
  assert.equal(await f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity).count(), 0);
  await f.reserve('settlement', 500);
  await assert.rejects(f.store.transaction(async tx => { await f.quota.settle(tx, f.epoch, 'settlement', { reason: 'confirmed_absent', committedBytes: 0 }); throw new Error('rollback'); }), /rollback/);
  assert.equal((await f.status()).reservedBytes, 500);
  await assert.rejects(f.settle('settlement', { reason: 'lease_expired', committedBytes: 0 }), code('INVALID_QUOTA_SETTLEMENT'));
  await assert.rejects(f.settle('settlement', { reason: 'confirmed_occupancy_and_unused_absent', committedBytes: 501 }), code('INVALID_QUOTA_SETTLEMENT'));
  const settled = await f.settle('settlement', { reason: 'confirmed_occupancy_and_unused_absent', committedBytes: 250 });
  const repeated = await f.settle('settlement', { reason: 'confirmed_occupancy_and_unused_absent', committedBytes: 250 });
  assert.equal(repeated.replayed, true); assert.deepEqual(repeated.status, settled.status);
  assert.equal((await f.reserve('settlement', 500)).reservationState, 'settled');
  assert.deepEqual(await f.baseline(), settled.status);
  await assert.rejects(f.settle('settlement', { reason: 'confirmed_absent', committedBytes: 0 }), code('QUOTA_OPERATION_CONFLICT'));
  assert.equal(await f.store.watermark(), watermark);
});


test('owner binding, CAS conflict, unsafe persisted counters and action types fail closed', async t => {
  const f = await fixture(t); await f.baseline();
  await assert.rejects(f.reserve('string-bytes', '1'), code('INVALID_QUOTA_RESERVATION'));
  await assert.rejects(f.store.transaction(async tx => {
    const repository = tx.manager.getRepository(entities.RuntimePayloadQuotaLedgerEntity);
    const get = tx.manager.getRepository.bind(tx.manager);
    tx.manager.getRepository = target => target === entities.RuntimePayloadQuotaLedgerEntity
      ? new Proxy(repository, { get(repo, key) { if (key === 'update') return async () => ({ affected: 0 }); const value = repo[key]; return typeof value === 'function' ? value.bind(repo) : value; } }) : get(target);
    try { await f.quota.reserve(tx, f.epoch, 'cas-conflict', 100); }
    finally { tx.manager.getRepository = get; }
  }), code('QUOTA_VERSION_CONFLICT'));
  assert.equal((await f.status()).reservedBytes, 0);
  assert.equal(await f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity).count(), 0);
  await f.db.getRepository(entities.RuntimePayloadQuotaLedgerEntity).update({ ownerId: f.ownerId }, { reservedBytes: String(BigInt(Number.MAX_SAFE_INTEGER) + 1n) });
  await assert.rejects(f.status(), code('INVALID_QUOTA_LEDGER'));
  await f.db.getRepository(entities.RuntimePipelineStateEntity).update({ id: PAYLOAD_OWNER_ID }, { value: { ownerId: 'different-owner' } });
  assert.equal(await f.status(), null);
  await assert.rejects(f.reserve('wrong-domain', 1), code('QUOTA_NOT_INITIALIZED'));
});

test('SQLite initial migration creates budget primitives and both schema baselines match the migrations', async t => {
  const db = await new DataSource({ type: 'sqljs', entities: [...entities.CALL_OBSERVABILITY_ENTITIES, Event], synchronize: false }).initialize();
  t.after(() => db.destroy());
  const { InitialSqliteSchema1788825600000 } = source('database/migrations/1788825600000-InitialSqliteSchema');
  const migration = new InitialSqliteSchema1788825600000(), runner = db.createQueryRunner();
  await migration.up(runner);
  assert.equal(await db.getRepository(entities.RuntimePayloadQuotaLedgerEntity).count(), 0);
  assert.equal(await db.getRepository(entities.RuntimePayloadQuotaReservationEntity).count(), 0);
  const indexes = await db.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='runtime_payload_quota_reservations'");
  assert.ok(indexes.some(index => index.name === 'IDX_obs_quota_reservation_owner_operation'));
  const fs = require('node:fs'), path = require('node:path');
  for (const [dialect, name] of [['sqlite', '1788825600000-InitialSqliteSchema'], ['postgres', '1788825601000-InitialPostgresSchema']]) {
    const sql = fs.readFileSync(path.resolve(__dirname, '../database/' + dialect + '-schema.sql'), 'utf8');
    const ts = fs.readFileSync(path.resolve(__dirname, '../src/database/migrations/' + name + '.ts'), 'utf8');
    // Current snapshots include forward migrations while Initial stays immutable.
    for (const object of ['runtime_payload_quota_ledgers', 'runtime_payload_quota_reservations',
      'IDX_obs_quota_reservation_owner_operation', 'IDX_obs_quota_reservation_owner_state']) {
      assert.ok(sql.includes(object), dialect + ': current snapshot lacks ' + object);
      assert.ok(ts.includes(object), dialect + ': historical Initial lacks ' + object);
    }
  }
  await migration.down(runner);
});
