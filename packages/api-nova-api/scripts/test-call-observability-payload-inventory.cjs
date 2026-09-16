'use strict';
process.env.DB_TYPE = 'sqlite';
require('ts-node').register({ transpileOnly: true, project: require('path').resolve(__dirname, '../tsconfig.json') });
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { CallObservabilityPayloadStore } = require('../src/modules/call-observability/call-observability-payload.store.ts');
const parent = path.resolve(__dirname, '../../../tmp/observability-payload-inventory-tests');
const name = n => n.toString(16).padStart(2, '0');
const key = (shard, digit) => name(shard) + digit.repeat(62) + '.body';

async function fixture(t) {
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'run-'));
  const previous = process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  process.env.API_NOVA_OBSERVABILITY_DATA_DIR = directory;
  const store = new CallObservabilityPayloadStore();
  if (previous === undefined) delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  else process.env.API_NOVA_OBSERVABILITY_DATA_DIR = previous;
  const ownerId = randomUUID();
  await store.ensureOwner(ownerId);
  const root = path.join(directory, 'payloads');
  t.after(async () => {
    await store.onModuleDestroy();
    const target = path.resolve(directory);
    if (path.dirname(target) !== parent || !path.basename(target).startsWith('run-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(target, { recursive: true, force: true });
  });
  async function object(shard, digit, data) {
    const folder = path.join(root, name(shard));
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, key(shard, digit)), data);
  }
  return { root, store, ownerId, object };
}

const incomplete = { code: 'PAYLOAD_INVENTORY_INCOMPLETE' };

test('empty owned root completes all 256 shards without claiming a baseline or writer fence', async t => {
  const f = await fixture(t), session = await f.store.openInventory();
  t.after(() => session.close());
  const result = await session.scanBatch(16);
  assert.equal(result.coverage, 'complete'); assert.equal(result.rangeComplete, true);
  assert.equal(result.nextShard, 256); assert.equal(result.completedShards.length, 256);
  assert.equal(result.checkpointedBytes, 0); assert.equal(result.scannedEntries, 0);
  assert.equal(result.writerFenceRequired, true); assert.equal(result.baselineReady, false);
});

test('partial shard bytes are withheld until checkpoint, and a restarted session rescans it', async t => {
  const f = await fixture(t);
  await f.object(0, 'a', 'abc'); await f.object(0, 'b', '12345');
  const interrupted = await f.store.openInventory();
  const first = await interrupted.scanBatch(1);
  assert.equal(first.coverage, 'incomplete'); assert.equal(first.nextShard, 0);
  assert.equal(first.inProgressShard, 0); assert.equal(first.checkpointedBytes, 0);
  assert.deepEqual(first.completedShards, []);
  await interrupted.close();
  const restarted = await f.store.openInventory();
  t.after(() => restarted.close());
  const result = await restarted.scanBatch(10);
  assert.equal(result.coverage, 'complete'); assert.equal(result.nextShard, 256);
  assert.equal(result.checkpointedBytes, 8); assert.equal(result.checkpointedFiles, 2);
  assert.deepEqual(result.completedShards[0], {
    shard: 0, state: 'present', directoryIdentity: result.completedShards[0].directoryIdentity,
    observedBytes: 8, observedFiles: 2, scannedEntries: 2,
  });
  const suffix = await f.store.openInventory(1);
  t.after(() => suffix.close());
  const range = await suffix.scanBatch(10);
  assert.equal(range.rangeComplete, true); assert.equal(range.coverage, 'incomplete');
  assert.equal(range.startShard, 1); assert.equal(range.nextShard, 256);
});

test('unknown root entries and temporary or unrecognized shard entries fail closed', async t => {
  const rootUnknown = await fixture(t);
  await fs.writeFile(path.join(rootUnknown.root, 'surprise'), 'x');
  await assert.rejects(() => rootUnknown.store.openInventory(), incomplete);
  const temporary = await fixture(t);
  await temporary.object(0, 'a', 'safe');
  await fs.writeFile(path.join(temporary.root, '00', key(0, 'b') + '.' + randomUUID() + '.tmp'), 'pending');
  const session = await temporary.store.openInventory();
  t.after(() => session.close());
  await assert.rejects(() => session.scanBatch(10), incomplete);
  await assert.rejects(() => session.scanBatch(10), incomplete);
  const unknown = await fixture(t);
  await fs.mkdir(path.join(unknown.root, '00'));
  await fs.writeFile(path.join(unknown.root, '00', 'unexpected.txt'), 'x');
  const another = await unknown.store.openInventory();
  t.after(() => another.close());
  await assert.rejects(() => another.scanBatch(10), incomplete);
});

test('owner or shard identity changing during a session invalidates its evidence', async t => {
  const owner = await fixture(t);
  await owner.object(0, 'a', 'x');
  const ownerSession = await owner.store.openInventory();
  t.after(() => ownerSession.close());
  await ownerSession.scanBatch(1);
  await fs.writeFile(path.join(owner.root, '.owner.json'), JSON.stringify({ schemaVersion: 1, ownerId: randomUUID() }));
  await assert.rejects(() => ownerSession.scanBatch(1), incomplete);

  const replacement = await fixture(t);
  await replacement.object(0, 'a', 'x');
  const replaceSession = await replacement.store.openInventory();
  t.after(() => replaceSession.close());
  await replaceSession.scanBatch(1);
  await fs.rename(path.join(replacement.root, '00'), path.join(replacement.root, '00-old'));
  await replacement.object(0, 'a', 'x');
  await assert.rejects(() => replaceSession.scanBatch(1), incomplete);
});

test('a completed shard is revalidated before the next bounded batch', async t => {
  const f = await fixture(t);
  await f.object(0, 'a', 'x'); await f.object(1, 'b', 'y');
  const session = await f.store.openInventory();
  t.after(() => session.close());
  await session.scanBatch(1);
  const second = await session.scanBatch(1);
  assert.equal(second.nextShard, 1); assert.equal(second.completedShards[0].shard, 0);
  await f.object(0, 'c', 'changed');
  await assert.rejects(() => session.scanBatch(1), incomplete);
});
test('persisted completed-shard proof is rechecked before a resumed suffix can claim coverage', async t => {
  const f = await fixture(t);
  await f.object(0, 'a', 'x'); await f.object(1, 'b', 'y');
  const first = await f.store.openInventory();
  await first.scanBatch(1);
  const batch = await first.scanBatch(1);
  assert.equal(batch.nextShard, 1); assert.equal(batch.completedShards.length, 1);
  const proof = { rootIdentity: batch.rootIdentity, completedShards: batch.completedShards };
  await first.close();
  const resumed = await f.store.openInventory(1, proof);
  t.after(() => resumed.close());
  const complete = await resumed.scanBatch(10);
  assert.equal(complete.prefixVerified, true); assert.equal(complete.coverage, 'complete');
  assert.equal(complete.checkpointedBytes, 1); // shard 00 is not counted twice
  await f.object(0, 'c', 'changed');
  await assert.rejects(() => f.store.openInventory(1, proof), incomplete);
});