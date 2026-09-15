'use strict';
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, project: require('path').resolve(__dirname, '../tsconfig.json') });
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ConfigService } = require('@nestjs/config');
const source = file => require('../src/' + file + '.ts');
const entities = source('database/entities/runtime-call-observability.entity');
const { RuntimeObservabilityEventEntity: Event } = source('database/entities/runtime-observability-event.entity');
const { CallObservabilityStore } = source('modules/call-observability/call-observability.store');
const { CallObservabilityPayloadStore } = source('modules/call-observability/call-observability-payload.store');
const { CallObservabilityGarbageService } = source('modules/call-observability/call-observability-garbage.service');
const { CallObservabilityRetentionWorker, RETENTION_WORKER_ID } = source('modules/call-observability/call-observability-retention.worker');
const { payloadCapacityView } = source('modules/call-observability/call-observability-payload-capacity.dto');
const root = path.resolve(__dirname, '../../../tmp/observability-payload-capacity-tests');
async function fixture(t) {
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'run-'));
  const old = process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  process.env.API_NOVA_OBSERVABILITY_DATA_DIR = directory;
  const objects = new CallObservabilityPayloadStore();
  if (old === undefined) delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR; else process.env.API_NOVA_OBSERVABILITY_DATA_DIR = old;
  const db = new DataSource({ type: 'sqljs', synchronize: true, logging: false, entities: [...entities.CALL_OBSERVABILITY_ENTITIES, Event] });
  await db.initialize();
  const store = new CallObservabilityStore(db, objects), gc = new CallObservabilityGarbageService(store, objects);
  const worker = new CallObservabilityRetentionWorker(gc, store, new ConfigService({ API_NOVA_OBSERVABILITY_RETENTION_ENABLED: 'true',
    API_NOVA_OBSERVABILITY_RETENTION_INTERVAL_MS: '1000', API_NOVA_OBSERVABILITY_RETENTION_GRACE_MS: '60000' }));
  t.after(async () => {
    await worker.onModuleDestroy(); await objects.onModuleDestroy(); await db.destroy();
    const target = path.resolve(directory);
    if (path.dirname(target) !== root || !path.basename(target).startsWith('run-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(target, { recursive: true, force: true });
  });
  async function file(data = '123456') {
    await store.ensurePayloadStorage();
    const bytes = Buffer.byteLength(data);
    const body = { state: 'captured', reason: null, data, contentType: 'text/plain', encoding: 'utf8',
      observedBytes: bytes, capturedBytes: bytes, storedBytes: bytes, capturedDigest: createHash('sha256').update(data).digest('hex'),
      digestScope: 'observed_raw', redacted: true, redactionPolicyVersion: 'default-v1' };
    const prepared = await store.payloadCoordination.withWriter(lease => objects.prepare({ sourceInstanceId: randomUUID(),
      invocationId: randomUUID(), side: 'request' }, body, new Date().toISOString(), new Date(Date.now() + 86400000).toISOString(), lease.generation));
    return path.join(directory, 'payloads', prepared.entity.fileKey);
  }
  async function allShards() {
    await store.ensurePayloadStorage();
    await Promise.all(Array.from({ length: 256 }, (_, n) => fs.mkdir(path.join(directory, 'payloads', n.toString(16).padStart(2, '0')), { recursive: true })));
  }
  return { db, directory, store, objects, gc, worker, file, allShards,
    row: () => db.getRepository(entities.RuntimePipelineStateEntity).findOneBy({ id: RETENTION_WORKER_ID }) };
}

test('single GC scan measures young files and temporary objects with complete namespace scan but never reports a current total', async t => {
  const f = await fixture(t); await f.allShards();
  const first = await f.file('123456'), second = await f.file('abcdefghijk');
  await fs.writeFile(first + '.' + randomUUID() + '.tmp', '12345');
  const report = await f.worker.runOnce();
  assert.equal(report.lastReport.deleted, 0); assert.equal(report.lastReport.scanUsage.observedBytes, 22);
  assert.equal(report.lastReport.scanUsage.observedFiles, 3); assert.equal(report.lastReport.scanUsage.scanCoverage, 'complete');
  const view = payloadCapacityView(await f.row(), Date.now());
  assert.equal(view.scanCoverage, 'complete'); assert.equal(view.observedBytes, 22); assert.equal(view.freshnessStatus, 'recent');
  assert.equal(view.currentTotalBytes, null); assert.equal(view.filesystemAvailableBytes, null); assert.equal(view.quotaEnforced, false);
  assert.equal(JSON.stringify(view).includes(f.directory), false);
  await fs.access(first); await fs.access(second);
});

test('usage records measured bytes before cleanup rather than pretending deleted bytes are still current disk usage', async t => {
  const f = await fixture(t), old = await f.file('123456789');
  const aged = new Date(Date.now() - 120000); await fs.utimes(old, aged, aged);
  const report = await f.worker.runOnce();
  assert.equal(report.lastReport.deleted, 1); assert.equal(report.lastReport.scanUsage.observedBytes, 9);
  await assert.rejects(fs.access(old), { code: 'ENOENT' });
  const view = payloadCapacityView(await f.row(), Date.now());
  assert.equal(view.observedBytes, 9); assert.equal(view.measurement, 'logical_file_length_before_cleanup'); assert.equal(view.currentTotalBytes, null);
});

test('missing shards and unrecognized entries prevent full scan coverage despite hasMore false', async t => {
  const f = await fixture(t), file = await f.file('123');
  await fs.writeFile(path.join(path.dirname(file), 'PRIVATE_UNRECOGNIZED_FILE'), 'hidden');
  const report = await f.worker.runOnce(), usage = report.lastReport.scanUsage;
  assert.equal(report.lastReport.hasMore, false); assert.equal(usage.scanCoverage, 'partial');
  assert.ok(usage.missingShards > 0); assert.equal(usage.unmeasuredEntries, 1); assert.equal(usage.observedBytes, 3);
  assert.equal(JSON.stringify(payloadCapacityView(await f.row(), Date.now())).includes('PRIVATE_UNRECOGNIZED_FILE'), false);
});

test('bounded scan batches remain separate samples and continuation cannot become a full total', async t => {
  const f = await fixture(t); await f.file('abcd'); await f.file('efghijkl');
  const first = await f.objects.scanGarbage(1, 1, Date.now() - 60000);
  assert.equal(first.scanUsage.truncated, true); assert.equal(first.scanUsage.scanCoverage, 'partial');
  const next = await f.objects.scanGarbage(1000, 1000, Date.now() - 60000);
  assert.equal(next.scanUsage.startedAtShardBoundary, false); assert.equal(next.scanUsage.scanCoverage, 'partial');
  assert.equal(first.scanUsage.observedBytes + next.scanUsage.observedBytes, 12);
});

test('measurement freshness uses scan completion, while failed or busy attempts and legacy reports are unknown', async t => {
  const f = await fixture(t); await f.file(); await f.worker.runOnce();
  const row = await f.row(), at = Date.parse(row.value.lastReport.scanUsage.scanCompletedAt);
  const stopped = { ...row, updatedAt: new Date(at + 30000).toISOString(), value: { ...row.value, state: 'stopped' } };
  assert.equal(payloadCapacityView(stopped, at + 30000).freshnessStatus, 'stale');
  for (const change of [value => { value.currentAttemptComplete = false; },
    value => { value.lastReport.status = 'busy'; }, value => { delete value.lastReport.scanUsage; }]) {
    const invalid = JSON.parse(JSON.stringify(row)); change(invalid.value);
    assert.equal(payloadCapacityView(invalid, Date.now()).observedBytes, null);
  }
  assert.equal(payloadCapacityView(null, Date.now()).scanCoverage, 'unknown');
});

test('unsafe file-length addition fails without publishing new capacity evidence', async t => {
  const f = await fixture(t), first = await f.file('a'), second = await f.file('b');
  const lstat = fs.lstat;
  fs.lstat = async (...args) => { const stat = await lstat(...args); if (args[0] === first || args[0] === second) stat.size = Number.MAX_SAFE_INTEGER; return stat; };
  try { await assert.rejects(f.worker.runOnce(), error => error.code === 'INVALID_PAYLOAD_SIZE'); }
  finally { fs.lstat = lstat; }
  const row = await f.row();
  assert.equal(row.value.currentAttemptComplete, false); assert.equal(payloadCapacityView(row, Date.now()).scanCoverage, 'unknown');
  await fs.access(first); await fs.access(second);
});

test('capacity view rejects future measurements, impossible counters and injected unknown data', async t => {
  const f = await fixture(t); await f.file(); await f.worker.runOnce(); const row = await f.row();
  for (const change of [scan => { scan.observedBytes = Number.MAX_SAFE_INTEGER + 1; }, scan => { scan.observedFiles = 999; },
    scan => { scan.scanCompletedAt = new Date(Date.now() + 60000).toISOString(); }, scan => { scan.scanCoverage = 'complete'; }]) {
    const invalid = JSON.parse(JSON.stringify(row)); change(invalid.value.lastReport.scanUsage);
    assert.equal(payloadCapacityView(invalid, Date.now()).observedBytes, null);
  }
  row.value.lastReport.scanUsage.path = 'PRIVATE_PATH'; row.value.lastReport.scanUsage.secret = 'PRIVATE_SECRET';
  const view = payloadCapacityView(row, Date.now());
  assert.equal(JSON.stringify(view).includes('PRIVATE'), false);
});


test('closed directory failure discards its cursor and the next worker attempt safely reopens the failed shard', async t => {
  const f = await fixture(t), file = await f.file('recoverable');
  const opendir = fs.opendir;
  let invalidated = false;
  fs.opendir = async (...args) => {
    const directory = await opendir(...args);
    if (!invalidated) { invalidated = true; await directory.close(); }
    return directory;
  };
  try { await assert.rejects(f.worker.runOnce(), { code: 'ERR_DIR_CLOSED' }); }
  finally { fs.opendir = opendir; }
  const failed = await f.row();
  assert.equal(failed.value.currentAttemptComplete, false);
  assert.equal(payloadCapacityView(failed, Date.now()).scanCoverage, 'unknown');
  const recovered = await f.worker.runOnce();
  assert.equal(recovered.lastReport.scanUsage.startedAtShardBoundary, true);
  assert.equal(recovered.lastReport.scanUsage.observedBytes, 11);
  assert.equal(recovered.lastReport.scanUsage.observedFiles, 1);
  assert.equal(recovered.lastReport.deleted, 0);
  assert.equal(payloadCapacityView(await f.row(), Date.now()).observedBytes, 11);
  await fs.access(file);
});

test('stat failure preserves the original error and retries its consumed entry from the shard boundary', async t => {
  const f = await fixture(t), file = await f.file('retry-stat');
  const lstat = fs.lstat, opendir = fs.opendir;
  const failure = Object.assign(new Error('synthetic stat failure'), { code: 'EIO' });
  fs.opendir = async (...args) => {
    const directory = await opendir(...args), close = directory.close.bind(directory);
    directory.close = async () => { await close(); throw new Error('synthetic close failure'); };
    return directory;
  };
  fs.lstat = async (...args) => { if (args[0] === file) throw failure; return lstat(...args); };
  try { await assert.rejects(f.worker.runOnce(), error => error === failure); }
  finally { fs.lstat = lstat; fs.opendir = opendir; }
  assert.equal(payloadCapacityView(await f.row(), Date.now()).observedBytes, null);
  const recovered = await f.worker.runOnce();
  assert.equal(recovered.lastReport.scanUsage.startedAtShardBoundary, true);
  assert.equal(recovered.lastReport.scanUsage.observedBytes, 10);
  assert.equal(recovered.lastReport.scanUsage.observedFiles, 1);
  assert.equal(recovered.lastReport.deleted, 0);
  await fs.access(file);
});


test('payload shutdown drains an in-flight directory open, closes it and rejects future scans', async t => {
  const f = await fixture(t); await f.file('shutdown');
  const opendir = fs.opendir;
  let opened, release;
  const opening = new Promise(resolve => { opened = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  let directory;
  fs.opendir = async (...args) => {
    directory = await opendir(...args); opened(); await resume; return directory;
  };
  const scan = f.objects.scanGarbage(1, 1, Date.now() - 60000);
  await opening;
  await assert.rejects(f.objects.scanGarbage(1, 1, Date.now()), error => error.code === 'STORAGE_BUSY');
  let stopped = false;
  const destroy = f.objects.onModuleDestroy().then(() => { stopped = true; });
  const repeatedDestroy = f.objects.onModuleDestroy();
  await assert.rejects(f.objects.scanGarbage(1, 1, Date.now()), error => error.code === 'PAYLOAD_SCANNER_STOPPED');
  await new Promise(resolve => setImmediate(resolve));
  const stoppedBeforeScan = stopped;
  release();
  try { await scan; await destroy; await repeatedDestroy; }
  finally { fs.opendir = opendir; }
  assert.equal(stoppedBeforeScan, false);
  await assert.rejects(directory.read(), { code: 'ERR_DIR_CLOSED' });
  await assert.rejects(f.objects.scanGarbage(1, 1, Date.now()), error => error.code === 'PAYLOAD_SCANNER_STOPPED');
  await f.objects.onModuleDestroy();
});


test('failed unlink retries its consumed candidate on the next bounded GC attempt', async t => {
  const f = await fixture(t), file = await f.file('unlink-retry');
  const aged = new Date(Date.now() - 120000); await fs.utimes(file, aged, aged);
  const unlink = fs.unlink;
  fs.unlink = async (...args) => { if (args[0] === file) throw Object.assign(new Error('synthetic denial'), { code: 'EACCES' }); return unlink(...args); };
  try { await assert.rejects(f.gc.collect({ scanLimit: 1, deleteLimit: 1, graceMs: 60000 }), error => error.code === 'PAYLOAD_DELETE_FAILED'); }
  finally { fs.unlink = unlink; }
  await fs.access(file);
  const recovered = await f.gc.collect({ scanLimit: 1, deleteLimit: 1, graceMs: 60000 });
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.deleted, 1);
  await assert.rejects(fs.access(file), { code: 'ENOENT' });
});
