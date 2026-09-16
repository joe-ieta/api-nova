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
const load = name => require('../src/' + name + '.ts');
const entities = load('database/entities/runtime-call-observability.entity');
const { RuntimeObservabilityEventEntity: Event } = load('database/entities/runtime-observability-event.entity');
const { CallObservabilityStore } = load('modules/call-observability/call-observability.store');
const { CallObservabilityPayloadStore } = load('modules/call-observability/call-observability-payload.store');
const { FencedPayloadBaselineService } = load('modules/call-observability/call-observability-payload-baseline');
const { PayloadInventoryCheckpointStore } = load('modules/call-observability/call-observability-payload-inventory-checkpoint');
const { PayloadQuotaPrimitives } = load('modules/call-observability/call-observability-payload-quota');
const { PAYLOAD_COORDINATION_ID, PAYLOAD_OWNER_ID } = load('modules/call-observability/call-observability-payload.coordinator');
const parent = path.resolve(__dirname, '../../../tmp/observability-payload-baseline-tests');
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
  const initialFence = await store.payloadCoordination.acquireInventoryFence();
  await store.payloadCoordination.releaseInventoryFence(initialFence.lease);
  const quota = new PayloadQuotaPrimitives();
  const initialized = await store.transaction(tx => quota.initialize(tx,
    { enabled: true, quotaBytes: 1000, maxBodyBytes: 500 }));
  const checkpoints = new PayloadInventoryCheckpointStore();
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
  const rawLedger = () => db.getRepository(entities.RuntimePayloadQuotaLedgerEntity).findOneByOrFail({ ownerId });
  return { db, store, payloads, ownerId, quota, initialized, checkpoints, baseline, directory, object, state, rawLedger };
}

test('empty owned root yields atomic complete checkpoint and conservative ready baseline', async t => {
  const f = await fixture(t);
  const result = await f.baseline.advance(f.initialized.epoch);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.observedBytes, 0);
  assert.equal(result.observedFiles, 0);
  assert.equal(result.quota.state, 'ready');
  assert.equal(result.quota.quotaEnforced, false);
  const ledger = await f.rawLedger();
  assert.ok(ledger.baselineKey);
  assert.equal(ledger.committedBytes, '0');
  const checkpoint = await f.db.getRepository(entities.RuntimePayloadInventoryCheckpointEntity).findOneByOrFail({ ownerId: f.ownerId });
  assert.equal(checkpoint.nextShard, 256);
  assert.equal(checkpoint.completedShards.length, 256);
  assert.equal(await f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity).count(), 0);
});

test('preexisting unverified prefix is reopened under the fence and rescanned before baseline', async t => {
  const f = await fixture(t);
  await f.object(0, 'a');
  await f.object(1, 'b');
  const session = await f.payloads.openInventory();
  const partial = await session.scanBatch(1);
  assert.equal(partial.nextShard, 0);
  const first = await session.scanBatch(1);
  await session.close();
  assert.equal(first.nextShard, 1);
  await f.store.transaction(tx => f.checkpoints.append(tx, f.initialized.epoch, null, first));
  const result = await f.baseline.advance(f.initialized.epoch, { maxBatches: 3, maxEntriesPerBatch: 1 });
  assert.equal(result.status, 'confirmed');
  assert.equal(result.observedBytes, 2);
  assert.equal(result.observedFiles, 2);
  assert.equal((await f.rawLedger()).committedBytes, '2');
});

test('partial shard remains incomplete and does not establish a baseline', async t => {
  const f = await fixture(t);
  await f.object(0, 'x');
  const result = await f.baseline.advance(f.initialized.epoch, { maxBatches: 1, maxEntriesPerBatch: 1 });
  assert.deepEqual(result, { status: 'incomplete', reason: 'scan_budget_exhausted', nextShard: 0, checkpointVersion: null });
  assert.equal((await f.rawLedger()).baselineKey, null);
});

test('changed unverified prefix is rebuilt under the fence; unknown file still fails closed', async t => {
  const f = await fixture(t);
  await f.object(0, 'a');
  await f.object(1, 'b');
  const session = await f.payloads.openInventory();
  await session.scanBatch(1);
  const first = await session.scanBatch(1);
  await session.close();
  await f.store.transaction(tx => f.checkpoints.append(tx, f.initialized.epoch, null, first));
  await f.object(0, 'changed');
  const rebuilt = await f.baseline.advance(f.initialized.epoch);
  assert.equal(rebuilt.status, 'confirmed');
  assert.equal(rebuilt.observedBytes, 8);
  assert.equal((await f.rawLedger()).committedBytes, '8');
  const unknown = await fixture(t);
  await fs.mkdir(path.join(unknown.directory, 'payloads', '00'), { recursive: true });
  await fs.writeFile(path.join(unknown.directory, 'payloads', '00', 'unknown.tmp'), 'not counted');
  await assert.rejects(unknown.baseline.advance(unknown.initialized.epoch), code('PAYLOAD_INVENTORY_INCOMPLETE'));
  assert.equal((await unknown.rawLedger()).baselineKey, null);
});

test('any reservation row or nonzero reserved ledger prevents confirmation', async t => {
  const f = await fixture(t);
  await f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity).insert({
    id: 'a'.repeat(64), ownerId: f.ownerId, operationId: 'orphan', epoch: randomUUID(),
    generation: '0', requestHash: 'b'.repeat(64), reservedBytes: '1', committedBytes: null,
    state: 'uncertain', settlementHash: null, updatedAt: new Date().toISOString(),
  });
  await assert.rejects(f.baseline.advance(f.initialized.epoch),
    code('PAYLOAD_INVENTORY_BASELINE_RESERVATIONS_PRESENT'));
  assert.equal((await f.rawLedger()).baselineKey, null);
  await f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity).delete({ ownerId: f.ownerId });
  const ledger = await f.rawLedger();
  ledger.reservedBytes = '1';
  await f.db.getRepository(entities.RuntimePayloadQuotaLedgerEntity).save(ledger);
  await assert.rejects(f.baseline.advance(f.initialized.epoch),
    code('PAYLOAD_INVENTORY_BASELINE_NOT_READY'));
  assert.equal((await f.rawLedger()).baselineKey, null);
});

test('ledger failure after confirmBaseline rolls back readiness while checkpoint stays unverified', async t => {
  const f = await fixture(t);
  const original = f.baseline.quota.confirmBaseline.bind(f.baseline.quota);
  f.baseline.quota.confirmBaseline = async (...args) => {
    await original(...args);
    throw new Error('injected-ledger-failure');
  };
  await assert.rejects(f.baseline.advance(f.initialized.epoch), /injected-ledger-failure/);
  assert.equal((await f.rawLedger()).baselineKey, null);
  const checkpoint = await f.db.getRepository(entities.RuntimePayloadInventoryCheckpointEntity).findOneByOrFail({ ownerId: f.ownerId });
  assert.equal(checkpoint.nextShard, 256);
  assert.equal((await f.state()).state, 'initializing');
});

test('managed occupancy above quota is counted and enters limited state without overselling', async t => {
  const f = await fixture(t);
  await f.object(0, 'x'.repeat(1200));
  const result = await f.baseline.advance(f.initialized.epoch, { maxBatches: 3, maxEntriesPerBatch: 1 });
  assert.equal(result.status, 'confirmed');
  assert.equal(result.observedBytes, 1200);
  assert.equal(result.quota.state, 'limited');
  assert.equal(result.quota.quotaEnforced, false);
  await assert.rejects(f.store.transaction(tx => f.quota.reserve(tx, f.initialized.epoch, 'new', 1)),
    code('QUOTA_NOT_READY'));
  assert.equal(await f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity).count(), 0);
});

test('expired fence during scanning cannot return a confirmed baseline', async t => {
  const f = await fixture(t);
  const original = f.payloads.openInventory.bind(f.payloads);
  f.payloads.openInventory = async (...args) => {
    const session = await original(...args);
    const scan = session.scanBatch.bind(session);
    session.scanBatch = async (...scanArgs) => {
      const result = await scan(...scanArgs);
      const repo = f.db.getRepository(entities.RuntimePipelineStateEntity);
      const row = await repo.findOneByOrFail({ id: PAYLOAD_COORDINATION_ID });
      row.value.inventory.expiresAt = Date.now() - 1;
      await repo.save(row);
      return result;
    };
    return session;
  };
  await assert.rejects(f.baseline.advance(f.initialized.epoch),
    code('PAYLOAD_INVENTORY_FENCE_LOST'));
  assert.equal((await f.rawLedger()).baselineKey, null);
});
test('a live writer blocks baseline and an old checkpoint generation is rebuilt', async t => {
  const f = await fixture(t);
  const other = new CallObservabilityStore(f.db, f.payloads);
  const writer = await other.payloadCoordination.acquireWriter();
  assert.deepEqual(await f.baseline.advance(f.initialized.epoch),
    { status: 'busy', reason: 'writer_active' });
  assert.equal((await f.rawLedger()).baselineKey, null);
  await other.payloadCoordination.releaseWriter(writer);
  await f.object(0, 'x');
  await f.object(1, 'y');
  const session = await f.payloads.openInventory();
  await session.scanBatch(1);
  const prefix = await session.scanBatch(1);
  await session.close();
  await f.store.transaction(tx => f.checkpoints.append(tx, f.initialized.epoch, null, prefix));
  const gc = await other.payloadCoordination.acquireGc();
  await other.payloadCoordination.releaseGc(gc.lease);
  const rebuilt = await f.baseline.advance(f.initialized.epoch);
  assert.equal(rebuilt.status, 'confirmed');
  assert.equal(rebuilt.generation, gc.lease.generation);
  assert.equal(rebuilt.observedBytes, 2);
  assert.equal((await f.rawLedger()).committedBytes, '2');
});

test('explicit scan budget allows more than 32 batches but still rejects invalid bounds', async t => {
  const f = await fixture(t);
  await assert.rejects(f.baseline.advance(f.initialized.epoch, { maxBatches: 10001 }),
    code('INVALID_PAYLOAD_INVENTORY_BASELINE_REQUEST'));
  const result = await f.baseline.advance(f.initialized.epoch, { maxBatches: 10000 });
  assert.equal(result.status, 'confirmed');
  assert.equal(result.quota.quotaEnforced, false);
});
test('unknown reservation blocks stale-prefix discard and leaves the old proof untouched', async t => {
  const f = await fixture(t);
  await f.object(0, 'a');
  await f.object(1, 'b');
  const session = await f.payloads.openInventory();
  await session.scanBatch(1);
  const first = await session.scanBatch(1);
  await session.close();
  await f.store.transaction(tx => f.checkpoints.append(tx, f.initialized.epoch, null, first));
  const original = await f.db.getRepository(entities.RuntimePayloadInventoryCheckpointEntity)
    .findOneByOrFail({ ownerId: f.ownerId });
  await f.object(0, 'changed');
  await f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity).insert({
    id: 'c'.repeat(64), ownerId: f.ownerId, operationId: 'unknown', epoch: randomUUID(),
    generation: '0', requestHash: 'd'.repeat(64), reservedBytes: '1', committedBytes: null,
    state: 'uncertain', settlementHash: null, updatedAt: new Date().toISOString(),
  });
  await assert.rejects(f.baseline.advance(f.initialized.epoch),
    code('PAYLOAD_INVENTORY_CHECKPOINT_NOT_READY'));
  const after = await f.db.getRepository(entities.RuntimePayloadInventoryCheckpointEntity)
    .findOneByOrFail({ ownerId: f.ownerId });
  assert.deepEqual(after, original);
  assert.equal((await f.rawLedger()).baselineKey, null);
});

test('stale-prefix discard and append share one rollback boundary', async t => {
  const f = await fixture(t);
  await f.object(0, 'a');
  await f.object(1, 'b');
  const session = await f.payloads.openInventory();
  await session.scanBatch(1);
  const first = await session.scanBatch(1);
  await session.close();
  await f.store.transaction(tx => f.checkpoints.append(tx, f.initialized.epoch, null, first));
  const original = await f.db.getRepository(entities.RuntimePayloadInventoryCheckpointEntity)
    .findOneByOrFail({ ownerId: f.ownerId });
  await f.object(0, 'changed');
  f.baseline.checkpoints.append = async () => { throw new Error('injected-rebuild-write-failure'); };
  await assert.rejects(f.baseline.advance(f.initialized.epoch), /injected-rebuild-write-failure/);
  const after = await f.db.getRepository(entities.RuntimePayloadInventoryCheckpointEntity)
    .findOneByOrFail({ ownerId: f.ownerId });
  assert.deepEqual(after, original);
  assert.equal((await f.rawLedger()).baselineKey, null);
});

test('expired B1 inventory generation is rebuilt from shard 0', async t => {
  const f = await fixture(t);
  await f.object(0, 'a');
  await f.object(1, 'b');
  const session = await f.payloads.openInventory();
  await session.scanBatch(1);
  const first = await session.scanBatch(1);
  await session.close();
  await f.store.transaction(tx => f.checkpoints.append(tx, f.initialized.epoch, null, first));
  const fence = await f.store.payloadCoordination.acquireInventoryFence();
  const repo = f.db.getRepository(entities.RuntimePipelineStateEntity);
  const row = await repo.findOneByOrFail({ id: PAYLOAD_COORDINATION_ID });
  row.value.inventory.expiresAt = Date.now() - 1;
  await repo.save(row);
  await f.store.payloadCoordination.releaseInventoryFence(fence.lease);
  const result = await f.baseline.advance(f.initialized.epoch);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.generation, '1');
  assert.equal(result.observedBytes, 2);
  assert.equal(result.quota.quotaEnforced, false);
});
test('cached physical-root owner cannot be substituted by a changed DB owner', async t => {
  const f = await fixture(t);
  await f.db.getRepository(entities.RuntimePipelineStateEntity)
    .update({ id: PAYLOAD_OWNER_ID }, { value: { ownerId: randomUUID() } });
  await assert.rejects(f.baseline.advance(f.initialized.epoch),
    code('PAYLOAD_INVENTORY_BASELINE_SCOPE_MISMATCH'));
  assert.equal((await f.rawLedger()).baselineKey, null);
});
test('non-initializing ledger cannot discard an old unverified checkpoint', async t => {
  const f = await fixture(t);
  await f.object(0, 'a');
  await f.object(1, 'b');
  const session = await f.payloads.openInventory();
  await session.scanBatch(1);
  const first = await session.scanBatch(1);
  await session.close();
  await f.store.transaction(tx => f.checkpoints.append(tx, f.initialized.epoch, null, first));
  const original = await f.db.getRepository(entities.RuntimePayloadInventoryCheckpointEntity)
    .findOneByOrFail({ ownerId: f.ownerId });
  await f.object(0, 'changed');
  const ledger = await f.rawLedger();
  ledger.state = 'degraded';
  await f.db.getRepository(entities.RuntimePayloadQuotaLedgerEntity).save(ledger);
  await assert.rejects(f.baseline.advance(f.initialized.epoch),
    code('PAYLOAD_INVENTORY_CHECKPOINT_NOT_READY'));
  const after = await f.db.getRepository(entities.RuntimePayloadInventoryCheckpointEntity)
    .findOneByOrFail({ ownerId: f.ownerId });
  assert.deepEqual(after, original);
  assert.equal((await f.rawLedger()).baselineKey, null);
});