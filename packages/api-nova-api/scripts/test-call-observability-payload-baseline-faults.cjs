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
const { FencedPayloadBaselineService } = load('modules/call-observability/call-observability-payload-baseline');
const { PayloadInventoryCheckpointStore } = load('modules/call-observability/call-observability-payload-inventory-checkpoint');
const { PayloadQuotaPrimitives } = load('modules/call-observability/call-observability-payload-quota');
const { PAYLOAD_COORDINATION_ID } = load('modules/call-observability/call-observability-payload.coordinator');
const parent = path.resolve(__dirname, '../../../tmp/observability-payload-baseline-fault-tests');
const code = expected => error => error.code === expected;

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
  const initial = await store.payloadCoordination.acquireInventoryFence();
  await store.payloadCoordination.releaseInventoryFence(initial.lease);
  const quota = new PayloadQuotaPrimitives();
  const ledger = await store.transaction(tx => quota.initialize(tx,
    { enabled: true, quotaBytes: 1000, maxBodyBytes: 500 }));
  const baseline = new FencedPayloadBaselineService(store, payloads);
  t.after(async () => {
    if (db.isInitialized) await db.destroy();
    await payloads.onModuleDestroy();
    const target = path.resolve(directory);
    if (path.dirname(target) !== parent || !path.basename(target).startsWith('run-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(target, { recursive: true, force: true });
  });
  const object = async (shard, data = 'x') => {
    const label = shard.toString(16).padStart(2, '0');
    const folder = path.join(directory, 'payloads', label);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, label + '0'.repeat(62) + '.body'), data);
  };
  const state = () => store.readSnapshot(tx => quota.status(tx));
  const checkpoint = () => db.getRepository(entities.RuntimePayloadInventoryCheckpointEntity)
    .findOneBy({ ownerId });
  return { db, store, payloads, ownerId, quota, ledger, baseline, directory, object, state, checkpoint };
}

test('second Store writer and GC are excluded for the full B2 scan, then resume after release', async t => {
  const f = await fixture(t);
  let enter, proceed;
  const entered = new Promise(resolve => { enter = resolve; });
  const released = new Promise(resolve => { proceed = resolve; });
  const originalOpen = f.payloads.openInventory.bind(f.payloads);
  let paused = false;
  f.payloads.openInventory = async (...args) => {
    const session = await originalOpen(...args);
    const scan = session.scanBatch.bind(session);
    session.scanBatch = async (...scanArgs) => {
      if (!paused) { paused = true; enter(); await released; }
      return scan(...scanArgs);
    };
    return session;
  };
  const advancing = f.baseline.advance(f.ledger.epoch);
  await entered;
  const other = new CallObservabilityStore(f.db, f.payloads);
  try {
    await assert.rejects(other.payloadCoordination.acquireWriter(), code('PAYLOAD_GC_BUSY'));
    assert.deepEqual(await other.payloadCoordination.acquireGc(), { lease: null, reason: 'gc_active' });
    assert.equal((await f.state()).state, 'initializing');
  } finally {
    proceed();
  }
  const result = await advancing;
  assert.equal(result.status, 'confirmed');
  assert.equal(result.quota.quotaEnforced, false);
  const writer = await other.payloadCoordination.acquireWriter();
  await other.payloadCoordination.releaseWriter(writer);
});

test('exported SQL.js crash image with in-flight inventory lease rebuilds old generation on restart', async t => {
  const f = await fixture(t);
  await f.object(0, 'a');
  await f.object(1, 'b');
  const session = await f.payloads.openInventory();
  await session.scanBatch(1);
  const first = await session.scanBatch(1);
  await session.close();
  await f.store.transaction(tx => new PayloadInventoryCheckpointStore().append(tx, f.ledger.epoch, null, first));
  const abandoned = await f.store.payloadCoordination.acquireInventoryFence();
  assert.equal(abandoned.lease.generation, '0');
  const database = f.db.driver.export();
  await f.db.destroy();
  const db = await new DataSource({ type: 'sqljs', database, synchronize: false,
    entities: [...entities.CALL_OBSERVABILITY_ENTITIES, Event] }).initialize();
  t.after(() => db.destroy());
  const coordination = db.getRepository(entities.RuntimePipelineStateEntity);
  const row = await coordination.findOneByOrFail({ id: PAYLOAD_COORDINATION_ID });
  row.value.inventory.expiresAt = Date.now() - 1;
  await coordination.save(row);
  const restarted = new CallObservabilityStore(db, f.payloads);
  const result = await new FencedPayloadBaselineService(restarted, f.payloads).advance(f.ledger.epoch);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.generation, '1');
  assert.equal(result.observedBytes, 2);
  assert.equal((await db.getRepository(entities.RuntimePayloadQuotaLedgerEntity)
    .findOneByOrFail({ ownerId: f.ownerId })).committedBytes, '2');
});

test('scan fault closes fence and keeps ledger initializing', async t => {
  const f = await fixture(t);
  await f.object(0, 'x');
  const originalOpen = f.payloads.openInventory.bind(f.payloads);
  f.payloads.openInventory = async (...args) => {
    const session = await originalOpen(...args);
    session.scanBatch = async () => { throw new Error('injected-scan-failure'); };
    return session;
  };
  await assert.rejects(f.baseline.advance(f.ledger.epoch), /injected-scan-failure/);
  assert.equal((await f.state()).state, 'initializing');
  assert.equal((await f.state()).committedBytes, null);
  const other = new CallObservabilityStore(f.db, f.payloads);
  const writer = await other.payloadCoordination.acquireWriter();
  await other.payloadCoordination.releaseWriter(writer);
});

test('checkpoint append transaction fault rolls back progress and releases fence', async t => {
  const f = await fixture(t);
  f.baseline.checkpoints.append = async (tx, ...args) => {
    const saved = await new PayloadInventoryCheckpointStore().append(tx, ...args);
    assert.equal(saved.checkpoint.nextShard, 256);
    throw new Error('injected-checkpoint-commit-failure');
  };
  await assert.rejects(f.baseline.advance(f.ledger.epoch), /injected-checkpoint-commit-failure/);
  assert.equal(await f.checkpoint(), null);
  assert.equal((await f.state()).state, 'initializing');
  const other = new CallObservabilityStore(f.db, f.payloads);
  const writer = await other.payloadCoordination.acquireWriter();
  await other.payloadCoordination.releaseWriter(writer);
});

test('lease timeout after provisional baseline write rolls back ready state', async t => {
  const f = await fixture(t);
  const original = f.baseline.quota.confirmBaseline.bind(f.baseline.quota);
  f.baseline.quota.confirmBaseline = async (tx, ...args) => {
    const status = await original(tx, ...args);
    const repo = tx.manager.getRepository(entities.RuntimePipelineStateEntity);
    const row = await repo.findOneByOrFail({ id: PAYLOAD_COORDINATION_ID });
    row.value.inventory.expiresAt = Date.now() - 1;
    await repo.save(row);
    return status;
  };
  await assert.rejects(f.baseline.advance(f.ledger.epoch), code('PAYLOAD_INVENTORY_FENCE_LOST'));
  assert.equal((await f.state()).state, 'initializing');
  assert.equal((await f.state()).committedBytes, null);
  assert.equal((await f.db.getRepository(entities.RuntimePayloadQuotaLedgerEntity)
    .findOneByOrFail({ ownerId: f.ownerId })).baselineKey, null);
  f.baseline.quota.confirmBaseline = original;
  const retry = await f.baseline.advance(f.ledger.epoch);
  assert.equal(retry.status, 'confirmed');
});

test('confirmed B2 baseline preserves the hard quota bound across two Stores', async t => {
  const f = await fixture(t);
  const confirmed = await f.baseline.advance(f.ledger.epoch);
  assert.equal(confirmed.status, 'confirmed');
  const other = new CallObservabilityStore(f.db, f.payloads);
  const quota = new PayloadQuotaPrimitives();
  const results = await Promise.allSettled([
    f.store.transaction(tx => quota.reserve(tx, f.ledger.epoch, 'left', 600)),
    other.transaction(tx => quota.reserve(tx, f.ledger.epoch, 'right', 600)),
  ]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.filter(x => x.status === 'rejected' && x.reason.code === 'QUOTA_EXHAUSTED').length, 1);
  const status = await f.state();
  assert.equal(status.reservedBytes, 600);
  assert.equal(status.budgetedBytes, 600);
  assert.equal(status.quotaEnforced, false);
  assert.equal(await f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity).count(), 1);
});
test('ledger transaction failure after provisional confirmation never commits ready', async t => {
  const f = await fixture(t);
  const original = f.baseline.quota.confirmBaseline.bind(f.baseline.quota);
  f.baseline.quota.confirmBaseline = async (...args) => {
    await original(...args);
    throw new Error('injected-ledger-transaction-failure');
  };
  await assert.rejects(f.baseline.advance(f.ledger.epoch), /injected-ledger-transaction-failure/);
  assert.equal((await f.state()).state, 'initializing');
  assert.equal((await f.state()).committedBytes, null);
  assert.equal((await f.db.getRepository(entities.RuntimePayloadQuotaLedgerEntity)
    .findOneByOrFail({ ownerId: f.ownerId })).baselineKey, null);
  assert.equal(await f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity).count(), 0);
});