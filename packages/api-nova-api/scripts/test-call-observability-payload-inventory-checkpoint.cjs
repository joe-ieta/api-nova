'use strict';
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, project: require('node:path').resolve(__dirname, '../tsconfig.json') });
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const source = name => require('../src/' + name + '.ts');
const entities = source('database/entities/runtime-call-observability.entity');
const { RuntimeObservabilityEventEntity: Event } = source('database/entities/runtime-observability-event.entity');
const { CallObservabilityStore } = source('modules/call-observability/call-observability.store');
const { CallObservabilityPayloadStore } = source('modules/call-observability/call-observability-payload.store');
const { PayloadInventoryCheckpointStore } = source('modules/call-observability/call-observability-payload-inventory-checkpoint');
const { PayloadQuotaPrimitives } = source('modules/call-observability/call-observability-payload-quota');
const { PAYLOAD_OWNER_ID, PAYLOAD_COORDINATION_ID } = source('modules/call-observability/call-observability-payload.coordinator');
const parent = path.resolve(__dirname, '../../../tmp/observability-payload-checkpoint-tests');
const code = expected => error => error.code === expected;
const name = n => n.toString(16).padStart(2, '0');

async function fixture(t, enabled = true) {
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'run-'));
  const previous = process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  process.env.API_NOVA_OBSERVABILITY_DATA_DIR = directory;
  const payloadStore = new CallObservabilityPayloadStore();
  if (previous === undefined) delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  else process.env.API_NOVA_OBSERVABILITY_DATA_DIR = previous;
  const db = await new DataSource({ type: 'sqljs', synchronize: true,
    entities: [...entities.CALL_OBSERVABILITY_ENTITIES, Event] }).initialize();
  const store = new CallObservabilityStore(db, payloadStore);
  const checkpoints = new PayloadInventoryCheckpointStore(), quota = new PayloadQuotaPrimitives();
  const ownerId = randomUUID();
  await payloadStore.ensureOwner(ownerId);
  await store.transaction(async tx => {
    const repo = tx.manager.getRepository(entities.RuntimePipelineStateEntity);
    await repo.insert({ id: PAYLOAD_OWNER_ID, value: { ownerId }, updatedAt: tx.now });
    await repo.insert({ id: PAYLOAD_COORDINATION_ID, value: { generation: '0', writers: {}, gc: null }, updatedAt: tx.now });
  });
  const initial = await store.transaction(tx => quota.initialize(tx,
    enabled ? { enabled: true, quotaBytes: 1000, maxBodyBytes: 500 } : {}));
  t.after(async () => {
    if (db.isInitialized) await db.destroy();
    await payloadStore.onModuleDestroy();
    const target = path.resolve(directory);
    if (path.dirname(target) !== parent || !path.basename(target).startsWith('run-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(target, { recursive: true, force: true });
  });
  async function object(shard, digit, data = 'x') {
    const folder = path.join(directory, 'payloads', name(shard));
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, name(shard) + digit.repeat(62) + '.body'), data);
  }
  return { db, store, payloadStore, checkpoints, quota, ownerId, epoch: initial.epoch, directory, object,
    append: (version, batch) => store.transaction(tx => checkpoints.append(tx, initial.epoch, version, batch)),
    load: () => store.readSnapshot(tx => checkpoints.load(tx, initial.epoch)) };
}

async function twoBatches(f, t) {
  for (let shard = 0; shard < 3; shard++) await f.object(shard, String(shard));
  const session = await f.payloadStore.openInventory();
  t.after(() => session.close());
  const partial = await session.scanBatch(1);
  assert.equal(partial.nextShard, 0);
  const first = await session.scanBatch(1);
  const second = await session.scanBatch(1);
  assert.equal(first.nextShard, 1);
  assert.equal(second.nextShard, 2);
  return { first, second };
}

test('complete prefix persists across SQL.js restart but remains unverified and baseline-not-ready', async t => {
  const f = await fixture(t), { first, second } = await twoBatches(f, t);
  const saved = (await f.append(null, first)).checkpoint;
  assert.equal(saved.nextShard, 1); assert.equal(saved.generation, '0');
  assert.equal(saved.unverified, true); assert.equal(saved.writerFenceRequired, true);
  assert.equal(saved.baselineReady, false); assert.equal(saved.observedBytes, 1);
  assert.equal((await f.store.readSnapshot(tx => f.quota.status(tx))).committedBytes, null);
  assert.equal(await f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity).count(), 0);
  const database = f.db.driver.export(); await f.db.destroy();
  const db = await new DataSource({ type: 'sqljs', database, synchronize: false,
    entities: [...entities.CALL_OBSERVABILITY_ENTITIES, Event] }).initialize();
  t.after(() => db.destroy());
  const restartedStore = new CallObservabilityStore(db, f.payloadStore);
  const resumed = await restartedStore.readSnapshot(tx => new PayloadInventoryCheckpointStore().load(tx, f.epoch));
  assert.deepEqual(resumed, saved);
  const verified = await f.payloadStore.openInventory(resumed.nextShard, resumed.resumeEvidence);
  t.after(() => verified.close());
  assert.equal((await verified.scanBatch(1)).prefixVerified, true);
  const advanced = await restartedStore.transaction(tx => new PayloadInventoryCheckpointStore().append(tx, f.epoch, resumed.version, second));
  assert.equal(advanced.checkpoint.nextShard, 2);
  assert.equal(advanced.checkpoint.observedBytes, 2);
  assert.equal(advanced.checkpoint.baselineReady, false);
});

test('strict contiguous append, CAS, rollback and exact replay never replace prior proof', async t => {
  const f = await fixture(t), { first, second } = await twoBatches(f, t);
  const start = await f.append(null, first);
  assert.equal(start.replayed, false);
  assert.equal((await f.append(null, first)).replayed, true);
  assert.equal(await f.db.getRepository(entities.RuntimePayloadInventoryCheckpointEntity).count(), 1);
  await assert.rejects(f.append(42, second), code('PAYLOAD_INVENTORY_CHECKPOINT_CONFLICT'));
  assert.equal((await f.load()).version, 0);
  await assert.rejects(f.store.transaction(async tx => {
    await f.checkpoints.append(tx, f.epoch, 0, second);
    throw new Error('rollback');
  }), /rollback/);
  assert.equal((await f.load()).nextShard, 1);
  const advanced = await f.append(0, second);
  assert.equal(advanced.replayed, false); assert.equal(advanced.checkpoint.version, 1);
  assert.equal((await f.append(0, second)).replayed, true);
  assert.equal((await f.load()).nextShard, 2);
  const skip = { ...second, completedShards: [], checkpointedBytes: 0, checkpointedFiles: 0 };
  await assert.rejects(f.append(1, skip), code('INVALID_PAYLOAD_INVENTORY_CHECKPOINT'));
  assert.equal((await f.load()).nextShard, 2);
});

test('owner, epoch, generation and root changes invalidate old proof without touching ledger', async t => {
  const f = await fixture(t), { first } = await twoBatches(f, t);
  const saved = (await f.append(null, first)).checkpoint;
  const state = f.db.getRepository(entities.RuntimePipelineStateEntity);
  await state.update({ id: PAYLOAD_COORDINATION_ID },
    { value: { generation: '1', writers: {}, gc: null } });
  await assert.rejects(f.load(), code('PAYLOAD_INVENTORY_CHECKPOINT_SCOPE_MISMATCH'));
  await assert.rejects(f.append(0, first), code('PAYLOAD_INVENTORY_CHECKPOINT_SCOPE_MISMATCH'));
  await state.update({ id: PAYLOAD_COORDINATION_ID },
    { value: { generation: '0', writers: {}, gc: null } });
  await assert.rejects(f.store.readSnapshot(tx => f.checkpoints.load(tx, randomUUID())),
    code('PAYLOAD_INVENTORY_CHECKPOINT_SCOPE_MISMATCH'));
  await f.object(0, 'a', 'changed');
  await assert.rejects(f.payloadStore.openInventory(saved.nextShard, saved.resumeEvidence),
    code('PAYLOAD_INVENTORY_INCOMPLETE'));
  await state.update({ id: PAYLOAD_OWNER_ID }, { value: { ownerId: randomUUID() } });
  await assert.rejects(f.load(), code('PAYLOAD_INVENTORY_CHECKPOINT_NOT_READY')); // New owner has no enabled ledger.
});

test('disabled or absent ledger and malformed or noncontiguous batches fail closed', async t => {
  const f = await fixture(t, false);
  await f.object(0, 'a');
  const session = await f.payloadStore.openInventory();
  t.after(() => session.close());
  await session.scanBatch(1);
  const batch = await session.scanBatch(1);
  await assert.rejects(f.append(null, batch), code('PAYLOAD_INVENTORY_CHECKPOINT_NOT_READY'));
  await f.db.getRepository(entities.RuntimePayloadQuotaLedgerEntity).delete({ ownerId: f.ownerId });
  await assert.rejects(f.load(), code('PAYLOAD_INVENTORY_CHECKPOINT_NOT_READY'));
  const active = await fixture(t);
  const { first, second } = await twoBatches(active, t);
  await assert.rejects(active.append(null, second), code('PAYLOAD_INVENTORY_CHECKPOINT_CONFLICT'));
  const forged = { ...first, completedShards: [{ ...first.completedShards[0], shard: 1 }] };
  await assert.rejects(active.append(null, forged), code('INVALID_PAYLOAD_INVENTORY_CHECKPOINT'));
  const partial = { ...first, prefixVerified: false };
  await assert.rejects(active.append(null, partial), code('INVALID_PAYLOAD_INVENTORY_CHECKPOINT'));
  assert.equal(await active.load(), null);
});

test('SQLite migration and both schema baselines include the isolated checkpoint table', async t => {
  const db = await new DataSource({ type: 'sqljs', entities: [...entities.CALL_OBSERVABILITY_ENTITIES, Event],
    synchronize: false }).initialize();
  t.after(() => db.destroy());
  const { InitialSqliteSchema1788825600000: Migration } =
    source('database/migrations/1788825600000-InitialSqliteSchema');
  const runner = db.createQueryRunner();
  await new Migration().up(runner);
  assert.equal(await db.getRepository(entities.RuntimePayloadInventoryCheckpointEntity).count(), 0);
  const fsSync = require('node:fs');
  for (const [dialect, name] of [['sqlite', '1788825600000-InitialSqliteSchema'],
    ['postgres', '1788825601000-InitialPostgresSchema']]) {
    const sql = fsSync.readFileSync(path.resolve(__dirname, '../database/' + dialect + '-schema.sql'), 'utf8');
    const ts = fsSync.readFileSync(path.resolve(__dirname, '../src/database/migrations/' + name + '.ts'), 'utf8');
    const statement = sql.split(';').map(part => part.trim()).find(part =>
      part.startsWith('CREATE TABLE "runtime_payload_inventory_checkpoints"'));
    assert.ok(statement);
    // Current snapshots include forward migrations while Initial stays immutable.
    for (const field of ['runtime_payload_inventory_checkpoints', 'completedShards',
      'rootIdentity', 'nextShard']) assert.ok(ts.includes(field), dialect + ': ' + field);
    assert.ok(ts.includes('DROP TABLE \\"runtime_payload_inventory_checkpoints\\"'));
  }
  await new Migration().down(runner);
});
