'use strict';
process.env.DB_TYPE = 'sqlite';
require('ts-node').register({ project: require('node:path').resolve(__dirname, '../tsconfig.json'), transpileOnly: true, compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true } });
require('reflect-metadata');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { DataSource } = require('typeorm');
const { RuntimeMetricBucketEntity: Bucket, RuntimeMetricContributionEntity: Contribution,
 RuntimeInvocationEntity: Invocation, RuntimePipelineStateEntity: State } = require('../src/database/entities/runtime-call-observability.entity.ts');
const { CallObservabilityBucketsProjector: Projector } = require('../src/modules/call-observability/call-observability-buckets.projector.ts');
const { CallObservabilityBucketRecomputeQueue: Queue } = require('../src/modules/call-observability/call-observability-bucket-recompute.queue.ts');
const BASE = '2026-09-11T01:00:00.000Z';
const sequence = n => String(n).padStart(20, '0');
function row(version = 1, fields = {}) {
 const record = { invocationId: 'call-a', runtimeAssetId: 'asset-a', origin: 'external', spanKind: 'gateway_request',
 transport: 'http', startedAt: '2026-09-11T00:00:01.000Z', completedAt: '2026-09-11T00:00:04.000Z',
 serverType: 'gateway', phase: 'finished', outcome: 'success', completionSource: 'observed', durationMs: 3000,
 authState: 'authenticated', identitySource: 'authenticated', callerId: 'caller-a', cacheHit: true,
 byteMeasurement: 'application', measurementStage: 'ingress', request: { state: 'complete', observedBytes: 12, data: 'secret-body' },
 response: { state: 'complete', observedBytes: 15 }, clientIp: 'secret-ip', payloadRef: 'secret-path', ...fields };
 return { ...record, record, recordVersion: version, sourceInstanceId: 'source-a', sourceRecordVersion: version,
 recordHash: 'a'.repeat(64), createdSequence: sequence(1), updatedSequence: sequence(version), sourceId: 'source-safe',
 expiresAt: fields.expiresAt || '2027-01-01T00:00:00.000Z', ingestedAt: BASE, traceId: null, parentInvocationId: null,
 endpointDefinitionId: null, sourceServiceInstanceId: null, toolName: null, requestPayloadId: null, responsePayloadId: null };
}
async function database(location) {
 const db = new DataSource({ type: 'sqljs', ...(location ? { location, autoSave: true } : {}),
 entities: [Bucket, Contribution, Invocation, State], synchronize: true, logging: false });
 await db.initialize(); return db;
}
function transactions(db) {
 // SQLite intentionally shares the single-management-writer policy of the store.
 let tail = Promise.resolve();
 return (operation, now = BASE) => {
 const work = tail.then(() => db.transaction(manager => operation({ manager, now,
 events: [], currentSequence: () => sequence(99), nextSequence: () => sequence(100) })));
 tail = work.catch(() => {}); return work;
 };
}
async function fixture(t) {
 const db = await database(); t.after(() => db.destroy());
 return { db, tx: transactions(db), projector: new Projector(), queue: new Queue() };
}
if (process.argv[2] === '--recover-child') {
 (async () => {
 const db = await database(process.argv[3]);
 const claims = await transactions(db)(tx => new Queue().claim(tx, 256), '2026-09-11T01:01:00.000Z');
 process.stdout.write(JSON.stringify({ count: claims.length, attempts: claims.map(c => c.bucket.recomputeAttempts) }));
 await db.destroy();
 })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
 test('persists 16 memberships and sanitized metric evidence before invocation save', async t => {
 const { db, tx, projector } = await fixture(t);
 assert.equal(await tx(tx => projector.apply(tx, row())), 'apply');
 const contribution = await db.getRepository(Contribution).findOneByOrFail({ invocationId: 'call-a' });
 assert.equal(contribution.contribution.bucketIds.length, 16);
 assert.equal(contribution.contribution.observation.invocation.cacheHit, true);
 assert.doesNotMatch(JSON.stringify(contribution), /secret-body|secret-ip|secret-path/);
 const buckets = await db.getRepository(Bucket).find(); assert.equal(buckets.length, 16);
 for (const b of buckets) { assert.equal(b.version, 0); assert.equal(b.dirtyVersion, 1);
 assert.equal(b.dataWatermark, sequence(0)); assert.equal(b.pendingWatermark, sequence(1)); assert.equal(b.recomputeState, 'pending'); }
 assert.equal(await db.getRepository(Invocation).count(), 0);
 });
 test('duplicate and stale versions do not invalidate again', async t => {
 const { db, tx, projector } = await fixture(t);
 await tx(tx => projector.apply(tx, row(2)));
 assert.equal(await tx(tx => projector.apply(tx, row(2))), 'duplicate');
 assert.equal(await tx(tx => projector.apply(tx, row(1))), 'stale');
 assert.ok((await db.getRepository(Bucket).find()).every(b => b.dirtyVersion === 1));
 });
 test('late completion adds completed basis and increments existing start basis once', async t => {
 const { db, tx, projector } = await fixture(t);
 await tx(tx => projector.apply(tx, row(1, { completedAt: null, phase: 'started' })));
 assert.equal(await db.getRepository(Bucket).count(), 8);
 await tx(tx => projector.apply(tx, row(2)));
 const buckets = await db.getRepository(Bucket).find(); assert.equal(buckets.length, 16);
 for (const b of buckets) assert.equal(b.dirtyVersion, b.dimensions.timeBasis === 'startedAt' ? 2 : 1);
 });
 test('accepted membership correction invalidates old and new buckets', async t => {
 const { db, tx, projector } = await fixture(t);
 await tx(tx => projector.apply(tx, row())); await tx(tx => projector.apply(tx, row(2, { runtimeAssetId: 'asset-b' })));
 const c = await db.getRepository(Contribution).findOneByOrFail({ invocationId: 'call-a' });
 const buckets = await db.getRepository(Bucket).find(); assert.equal(buckets.length, 32);
 assert.equal(c.contribution.bucketIds.length, 16);
 assert.ok(buckets.filter(b => c.contribution.bucketIds.includes(b.id)).every(b => b.dimensions.runtimeAssetId === 'asset-b'));
 });
 test('mid-invalidation error rolls back contribution, buckets and checkpoint', async t => {
 const { db, tx } = await fixture(t); const queue = new Queue(); const original = queue.invalidate.bind(queue); let count = 0;
 queue.invalidate = async (...args) => { await original(...args); if (++count === 3) throw Error('injected'); };
 await assert.rejects(tx(async tx => {
 await tx.manager.getRepository(State).save({ id: 'outer', value: {}, updatedAt: BASE });
 await new Projector(queue).apply(tx, row()); }), /injected/);
 for (const entity of [Contribution, Bucket, State]) assert.equal(await db.getRepository(entity).count(), 0);
 });
 test('SQL expected-version condition detects a changed projection and rolls back', async t => {
 const { db, tx, projector } = await fixture(t); await tx(tx => projector.apply(tx, row()));
 await assert.rejects(tx(async tx => {
 const repository = tx.manager.getRepository(Contribution), update = repository.update.bind(repository);
 repository.update = async (criteria, partial) => { await update({ invocationId: 'call-a' }, { recordVersion: 3 }); return update(criteria, partial); };
 try { await projector.apply(tx, row(2)); } finally { repository.update = update; }
 }), /BUCKET_PROJECTION_CONFLICT/);
 assert.equal((await db.getRepository(Contribution).findOneByOrFail({ invocationId: 'call-a' })).recordVersion, 1);
 assert.ok((await db.getRepository(Bucket).find()).every(b => b.dirtyVersion === 1));
 });
 test('parallel SQLite writer-lane submissions apply once and claims are disjoint', async t => {
 const { tx, projector, queue } = await fixture(t);
 const states = await Promise.all(Array.from({ length: 8 }, () => tx(tx => projector.apply(tx, row()))));
 assert.equal(states.filter(s => s === 'apply').length, 1);
 const batches = await Promise.all([tx(tx => queue.claim(tx, 8)), tx(tx => queue.claim(tx, 8))]);
 const ids = batches.flat().map(c => c.bucket.id); assert.equal(ids.length, 16); assert.equal(new Set(ids).size, 16);
 assert.deepEqual(await tx(tx => queue.claim(tx)), []);
 });
 test('new invalidation fences stale completion and failure without clearing readable metrics', async t => {
 const { db, tx, projector, queue } = await fixture(t); await tx(tx => projector.apply(tx, row()));
 const [first] = await tx(tx => queue.claim(tx, 1)); assert.equal(await tx(tx => queue.complete(tx, first, { count: 1 })), true);
 await tx(tx => projector.apply(tx, row(2)));
 const old = (await tx(tx => queue.claim(tx, 256))).find(c => c.bucket.id === first.bucket.id);
 await tx(tx => projector.apply(tx, row(3)));
 assert.equal(await tx(tx => queue.complete(tx, old, { count: 999 })), false); assert.equal(await tx(tx => queue.fail(tx, old)), false);
 const b = await db.getRepository(Bucket).findOneByOrFail({ id: first.bucket.id });
 assert.deepEqual(b.metrics, { count: 1 }); assert.equal(b.version, 1); assert.equal(b.dirtyVersion, 3); assert.equal(b.dataWatermark, sequence(1));
 });
 test('retry backoff and lease expiry preserve token fencing', async t => {
 const { tx, projector, queue } = await fixture(t); await tx(tx => projector.apply(tx, row()));
 const all = await tx(tx => queue.claim(tx, 256, 1000)); assert.equal(await tx(tx => queue.fail(tx, all[0], 500)), true);
 assert.equal((await tx(tx => queue.claim(tx, 256))).length, 0);
 const retry = await tx(tx => queue.claim(tx, 256, 1000), '2026-09-11T01:00:00.500Z');
 assert.equal(retry.length, 1); assert.notEqual(retry[0].token, all[0].token);
 assert.equal(await tx(tx => queue.complete(tx, all[1], {}), '2026-09-11T01:00:01.000Z'), false);
 assert.equal((await tx(tx => queue.claim(tx, 256), '2026-09-11T01:00:01.000Z')).length, 15);
 });
 test('result publication and acknowledgement roll back together', async t => {
 const { db, tx, projector, queue } = await fixture(t); await tx(tx => projector.apply(tx, row()));
 const [claim] = await tx(tx => queue.claim(tx, 1));
 await assert.rejects(tx(async tx => { await queue.complete(tx, claim, { count: 1 }); throw Error('abort'); }), /abort/);
 const b = await db.getRepository(Bucket).findOneByOrFail({ id: claim.bucket.id }); assert.equal(b.version, 0); assert.equal(b.recomputeState, 'leased');
 assert.equal(await tx(tx => queue.complete(tx, claim, { count: 1 })), true); assert.equal(await tx(tx => queue.complete(tx, claim, { count: 99 })), false);
 });
 test('generation overflow cannot commit contribution revision', async t => {
 const { db, tx, projector } = await fixture(t); await tx(tx => projector.apply(tx, row()));
 const b = (await db.getRepository(Bucket).find())[0]; await db.getRepository(Bucket).update({ id: b.id }, { dirtyVersion: 2147483647 });
 await assert.rejects(tx(tx => projector.apply(tx, row(2))), /BUCKET_VERSION_EXHAUSTED/);
 assert.equal((await db.getRepository(Contribution).findOneByOrFail({ invocationId: 'call-a' })).recordVersion, 1);
 });
 test('backfill excludes expired details, resumes persisted cursor and rescans idempotently', async t => {
 const { db, tx, projector } = await fixture(t);
 await db.getRepository(Invocation).save([row(1, { invocationId: 'a' }), row(1, { invocationId: 'b' }), row(1, { invocationId: 'c', expiresAt: BASE })]);
 assert.deepEqual(await tx(tx => projector.backfill(tx, 1)), { processed: 1, cursor: 'a', complete: false });
 await assert.rejects(tx(async tx => { await projector.backfill(tx, 1); throw Error('abort'); }), /abort/);
 assert.equal(await db.getRepository(Contribution).count(), 1);
 assert.deepEqual(await tx(tx => new Projector().backfill(tx, 1)), { processed: 1, cursor: 'b', complete: false });
 assert.equal((await tx(tx => projector.backfill(tx, 1))).complete, true);
 const generations = (await db.getRepository(Bucket).find()).map(b => [b.id, b.dirtyVersion]).sort();
 await tx(tx => projector.restartBackfill(tx)); assert.equal((await tx(tx => projector.backfill(tx))).processed, 2);
 assert.deepEqual((await db.getRepository(Bucket).find()).map(b => [b.id, b.dirtyVersion]).sort(), generations);
 });
 test('missing cacheHit evidence survives contribution projection as unknown', async t => {
 const { db, tx, projector } = await fixture(t);
 await tx(tx => projector.apply(tx, row(1, { cacheHit: undefined, missingFields: ['cacheHit'] })));
 const c = await db.getRepository(Contribution).findOneByOrFail({ invocationId: 'call-a' });
 assert.equal(c.contribution.observation.invocation.cacheHit, undefined); assert.deepEqual(c.contribution.observation.invocation.missingFields, ['cacheHit']);
 });
 test('fresh process recovers persisted expired leases from SQL.js file', async () => {
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'api-nova-b02-')), filename = path.join(directory, 'queue.sqlite');
 const db = await database(filename);
 try {
 const tx = transactions(db); await tx(tx => new Projector().apply(tx, row()));
 assert.equal((await tx(tx => new Queue().claim(tx, 256, 1000))).length, 16); await db.driver.save(); await db.destroy();
 const output = execFileSync(process.execPath, [__filename, '--recover-child', filename], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 30000, windowsHide: true });
 const result = JSON.parse(output); assert.equal(result.count, 16); assert.ok(result.attempts.every(n => n === 2));
 } finally { if (db.isInitialized) await db.destroy(); await fs.unlink(filename).catch(e => { if (e.code !== 'ENOENT') throw e; }); await fs.rmdir(directory); }
 });
 test('requires transaction, bounded claims and supported database revisions', async t => {
 const { db, tx, projector, queue } = await fixture(t);
 await assert.rejects(projector.apply({ manager: db.manager, now: BASE }, row()), /BUCKET_TRANSACTION_REQUIRED/);
 await assert.rejects(tx(tx => projector.apply(tx, row(2147483648))), /INVALID_BUCKET_DATABASE_VERSION/);
 await assert.rejects(tx(tx => queue.claim(tx, 0)), /INVALID_BUCKET_LEASE/); assert.equal(await db.getRepository(Contribution).count(), 0);
 });
}

if (process.argv[2] !== '--recover-child') {
 test('initial SQL and migration baselines agree for both dialects; SQLite queue schema has no drift', async () => {
  const pairs = [
   ['sqlite', '../src/database/migrations/1788825600000-InitialSqliteSchema.ts', 'InitialSqliteSchema1788825600000'],
   ['postgres', '../src/database/migrations/1788825601000-InitialPostgresSchema.ts', 'InitialPostgresSchema1788825601000'],
  ];
  let sqliteQueries;
  for (const [dialect, filename, name] of pairs) {
   const queries = [];
   await new (require(filename)[name])().up({ query: async sql => { queries.push(sql); } });
   const schema = await fs.readFile(path.resolve(__dirname, '../database/' + dialect + '-schema.sql'), 'utf8');
   const bucketQueries = queries.filter(q => q.startsWith('CREATE') && q.includes('"runtime_metric_buckets"'));
   const bucketSql = schema.split(/\r?\n/).filter(q => q.startsWith('CREATE') && q.includes('"runtime_metric_buckets"')).map(q => q.replace(/;$/, ''));
   assert.deepEqual(bucketQueries, bucketSql);
   assert.equal(bucketQueries.length, 4);
   if (dialect === 'sqlite') sqliteQueries = queries;
  }
  const db = new DataSource({ type: 'sqljs', entities: [Bucket, Contribution, Invocation, State], synchronize: false });
  await db.initialize();
  try {
   for (const sql of sqliteQueries) await db.query(sql);
   const changes = await db.driver.createSchemaBuilder().log();
   assert.deepEqual(changes.upQueries, [], 'Initial SQLite baseline must match current entity metadata');
  } finally { await db.destroy(); }
 });
}
