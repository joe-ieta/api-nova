'use strict';
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, project: require('node:path').resolve(__dirname, '../tsconfig.json') });
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const load = name => require('../src/' + name + '.ts');
const entities = load('database/entities/runtime-call-observability.entity');
const { RuntimeObservabilityEventEntity: Event } = load('database/entities/runtime-observability-event.entity');
const { CallObservabilityStore } = load('modules/call-observability/call-observability.store');
const { PayloadQuotaPrimitives } = load('modules/call-observability/call-observability-payload-quota');
const { PayloadInventoryCheckpointStore } = load('modules/call-observability/call-observability-payload-inventory-checkpoint');
const { PAYLOAD_OWNER_ID, PAYLOAD_COORDINATION_ID } = load('modules/call-observability/call-observability-payload.coordinator');
const code = expected => error => error.code === expected;

async function fixture(t) {
  const db = await new DataSource({ type: 'sqljs', synchronize: true,
    entities: [...entities.CALL_OBSERVABILITY_ENTITIES, Event] }).initialize();
  t.after(async () => { if (db.isInitialized) await db.destroy(); });
  const ownerId = randomUUID();
  const first = new CallObservabilityStore(db, {});
  const second = new CallObservabilityStore(db, {});
  await first.transaction(async tx => {
    await tx.manager.getRepository(entities.RuntimePipelineStateEntity)
      .insert({ id: PAYLOAD_OWNER_ID, value: { ownerId }, updatedAt: tx.now });
  });
  const state = db.getRepository(entities.RuntimePipelineStateEntity);
  return { db, first, second, state, ownerId };
}

async function expire(f) {
  const row = await f.state.findOneByOrFail({ id: PAYLOAD_COORDINATION_ID });
  row.value.inventory.expiresAt = Date.now() - 1;
  await f.state.save(row);
}

test('independent inventory fence blocks writer and GC on another Store without changing generation', async t => {
  const f = await fixture(t);
  const result = await f.first.payloadCoordination.withInventoryFence(async session => {
    assert.equal(session.lease.ownerId, f.ownerId);
    assert.equal(session.lease.generation, '0');
    await session.check();
    await f.first.transaction(tx => session.assertInTransaction(tx));
    await assert.rejects(f.second.payloadCoordination.acquireWriter(), code('PAYLOAD_GC_BUSY'));
    assert.deepEqual(await f.second.payloadCoordination.acquireGc(),
      { lease: null, reason: 'gc_active' });
    const row = await f.state.findOneByOrFail({ id: PAYLOAD_COORDINATION_ID });
    assert.equal(row.value.generation, '0');
    return 'two batches completed';
  });
  assert.deepEqual(result, { status: 'completed', result: 'two batches completed' });
  const writer = await f.second.payloadCoordination.acquireWriter();
  assert.equal(writer.generation, '0');
  await f.second.payloadCoordination.releaseWriter(writer);
  const gc = await f.second.payloadCoordination.acquireGc();
  assert.equal(gc.lease.generation, '1');
  await f.second.payloadCoordination.releaseGc(gc.lease);
});

test('an active writer or GC prevents inventory acquisition across Store instances', async t => {
  const f = await fixture(t);
  const writer = await f.first.payloadCoordination.acquireWriter();
  assert.deepEqual(await f.second.payloadCoordination.acquireInventoryFence(),
    { lease: null, reason: 'writer_active' });
  await f.first.payloadCoordination.releaseWriter(writer);
  const gc = await f.first.payloadCoordination.acquireGc();
  assert.deepEqual(await f.second.payloadCoordination.acquireInventoryFence(),
    { lease: null, reason: 'gc_active' });
  await f.first.payloadCoordination.releaseGc(gc.lease);
});

test('expired inventory fence increments generation and invalidates an old checkpoint', async t => {
  const f = await fixture(t);
  const quota = new PayloadQuotaPrimitives();
  const status = await f.first.transaction(tx => quota.initialize(tx,
    { enabled: true, quotaBytes: 1000, maxBodyBytes: 500 }));
  const acquired = await f.first.payloadCoordination.acquireInventoryFence();
  assert.equal(acquired.lease.generation, '0');
  await f.first.transaction(async tx => tx.manager.getRepository(entities.RuntimePayloadInventoryCheckpointEntity)
    .insert({ ownerId: f.ownerId, epoch: status.epoch, generation: '0', rootIdentity: 'a'.repeat(64),
      version: 0, nextShard: 1, completedShards: [{ shard: 0, state: 'absent',
        directoryIdentity: null, observedBytes: 0, observedFiles: 0, scannedEntries: 0 }], updatedAt: tx.now }));
  const checkpoints = new PayloadInventoryCheckpointStore();
  assert.equal((await f.first.readSnapshot(tx => checkpoints.load(tx, status.epoch))).generation, '0');
  await expire(f);
  const writer = await f.second.payloadCoordination.acquireWriter();
  assert.equal(writer.generation, '1');
  await assert.rejects(f.first.payloadCoordination.checkInventoryFence(acquired.lease),
    code('PAYLOAD_INVENTORY_FENCE_LOST'));
  await assert.rejects(f.first.readSnapshot(tx => checkpoints.load(tx, status.epoch)),
    code('PAYLOAD_INVENTORY_CHECKPOINT_SCOPE_MISMATCH'));
  await f.second.payloadCoordination.releaseWriter(writer);
});

test('a callback whose lease expires cannot return a trusted result', async t => {
  const f = await fixture(t);
  await assert.rejects(f.first.payloadCoordination.withInventoryFence(async session => {
    await session.check();
    await expire(f);
    return { baselineReady: true };
  }), code('PAYLOAD_INVENTORY_FENCE_LOST'));
  const writer = await f.second.payloadCoordination.acquireWriter();
  assert.equal(writer.generation, '1');
  await f.second.payloadCoordination.releaseWriter(writer);
});

test('storage owner replacement and malformed binding fail closed', async t => {
  const f = await fixture(t);
  const acquired = await f.first.payloadCoordination.acquireInventoryFence();
  await f.state.update({ id: PAYLOAD_OWNER_ID }, { value: { ownerId: randomUUID() } });
  await assert.rejects(f.first.payloadCoordination.checkInventoryFence(acquired.lease),
    code('PAYLOAD_INVENTORY_FENCE_LOST'));
  await f.first.payloadCoordination.releaseInventoryFence(acquired.lease);
  await f.state.update({ id: PAYLOAD_OWNER_ID }, { value: { ownerId: '' } });
  await assert.rejects(f.first.payloadCoordination.acquireInventoryFence(), code('PAYLOAD_STORAGE_NOT_BOUND'));
});
test('expired release persists generation across SQL.js restart before new inventory acquisition', async t => {
  const f = await fixture(t);
  const quota = new PayloadQuotaPrimitives();
  const status = await f.first.transaction(tx => quota.initialize(tx,
    { enabled: true, quotaBytes: 1000, maxBodyBytes: 500 }));
  const first = await f.first.payloadCoordination.acquireInventoryFence();
  await f.first.transaction(async tx => tx.manager.getRepository(entities.RuntimePayloadInventoryCheckpointEntity)
    .insert({ ownerId: f.ownerId, epoch: status.epoch, generation: first.lease.generation,
      rootIdentity: 'b'.repeat(64), version: 0, nextShard: 1,
      completedShards: [{ shard: 0, state: 'absent', directoryIdentity: null,
        observedBytes: 0, observedFiles: 0, scannedEntries: 0 }], updatedAt: tx.now }));
  await expire(f);
  await f.first.payloadCoordination.releaseInventoryFence(first.lease);
  assert.equal((await f.state.findOneByOrFail({ id: PAYLOAD_COORDINATION_ID })).value.generation, '1');
  const database = f.db.driver.export();
  await f.db.destroy();
  const db = await new DataSource({ type: 'sqljs', database, synchronize: false,
    entities: [...entities.CALL_OBSERVABILITY_ENTITIES, Event] }).initialize();
  t.after(() => db.destroy());
  const restarted = new CallObservabilityStore(db, {});
  await assert.rejects(restarted.readSnapshot(tx =>
    new PayloadInventoryCheckpointStore().load(tx, status.epoch)),
    code('PAYLOAD_INVENTORY_CHECKPOINT_SCOPE_MISMATCH'));
  const next = await restarted.payloadCoordination.acquireInventoryFence();
  assert.equal(next.lease.generation, '1');
  await restarted.payloadCoordination.releaseInventoryFence(next.lease);
});
test('expired inventory does not advance generation while a valid writer still exists', async t => {
  const f = await fixture(t);
  const acquired = await f.first.payloadCoordination.acquireInventoryFence();
  const row = await f.state.findOneByOrFail({ id: PAYLOAD_COORDINATION_ID });
  row.value.inventory.expiresAt = Date.now() - 1;
  row.value.writers.synthetic = { owner: 'other-process', expiresAt: Date.now() + 60_000 };
  await f.state.save(row);
  assert.deepEqual(await f.second.payloadCoordination.acquireInventoryFence(),
    { lease: null, reason: 'gc_active' });
  assert.equal((await f.state.findOneByOrFail({ id: PAYLOAD_COORDINATION_ID })).value.generation, '0');
  const blocked = await f.state.findOneByOrFail({ id: PAYLOAD_COORDINATION_ID });
  delete blocked.value.writers.synthetic;
  await f.state.save(blocked);
  const next = await f.second.payloadCoordination.acquireInventoryFence();
  assert.equal(next.lease.generation, '1');
  await f.second.payloadCoordination.releaseInventoryFence(next.lease);
  await assert.rejects(f.first.payloadCoordination.checkInventoryFence(acquired.lease),
    code('PAYLOAD_INVENTORY_FENCE_LOST'));
});