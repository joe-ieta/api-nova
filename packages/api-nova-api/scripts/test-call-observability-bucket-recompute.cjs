'use strict';
process.env.DB_TYPE = 'sqlite';
require('ts-node').register({ project: require('node:path').resolve(__dirname, '../tsconfig.json'), transpileOnly: true, compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true } });
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DataSource } = require('typeorm');
const { RuntimeMetricBucketEntity: Bucket, RuntimeMetricContributionEntity: Contribution } = require('../src/database/entities/runtime-call-observability.entity.ts');
const { CallObservabilityBucketsProjector: Projector } = require('../src/modules/call-observability/call-observability-buckets.projector.ts');
const { CallObservabilityBucketRecomputeQueue: Queue } = require('../src/modules/call-observability/call-observability-bucket-recompute.queue.ts');
const { CallObservabilityBucketRecomputeService: Service } = require('../src/modules/call-observability/call-observability-bucket-recompute.service.ts');
const BASE = '2026-09-11T01:00:00.000Z';
function row(id = 'a', version = 1, fields = {}) {
 const record = { invocationId: id, runtimeAssetId: 'asset', origin: 'external', spanKind: 'gateway_request', transport: 'http',
 startedAt: '2026-09-11T00:00:01.000Z', completedAt: '2026-09-11T00:00:04.000Z', phase: 'finished', outcome: 'success',
 completionSource: 'observed', durationMs: 3000, identitySource: 'authenticated', authState: 'authenticated', callerId: 'caller',
 byteMeasurement: 'application', measurementStage: 'ingress', request: { state: 'complete', observedBytes: 10 },
 response: { state: 'complete', observedBytes: 20 }, ...fields };
 return { ...record, record, recordVersion: version, sourceId: null, updatedSequence: String(version).padStart(20, '0') };
}
async function fixture(t, options = {}) {
 const db = new DataSource({ type: 'sqljs', entities: [Bucket, Contribution], synchronize: true }); await db.initialize(); t.after(() => db.destroy());
 let now = BASE, lane = Promise.resolve();
 const execute = operation => { const p = lane.then(() => db.transaction(manager => operation({ manager, now, events: [], snapshotSeq: '99' }))); lane = p.catch(() => {}); return p; };
 const store = { transaction: execute, readSnapshot: execute };
 const queue = new Queue(), projector = new Projector(queue);
 const service = new Service(store, queue, { batchSize: 64, ...options });
 return { db, store, queue, projector, service, clock: value => { now = value; },
 project: r => execute(tx => projector.apply(tx, r)), buckets: () => db.getRepository(Bucket).find() };
}
test('full snapshots compute all bases and retain explicit unknown historical coverage', async t => {
 const f = await fixture(t); await f.project(row());
 const id = (await f.buckets())[0].id;
 assert.equal((await f.service.readCompleted(id)).state, 'pending');
 const report = await f.service.runOnce(); assert.equal(report.completed, 16); assert.equal(report.failed, 0);
 const read = await f.service.readCompleted(id); assert.equal(read.state, 'available'); assert.equal(read.bucketVersion, 1);
 assert.equal(read.snapshot.metrics.selectedInvocations, 1); assert.equal(read.snapshot.metrics.requestBytes, 10);
 assert.equal(read.snapshot.coverage.historyCompleteSince, null); assert.equal(read.snapshot.coverage.isPartial, true);
 assert.equal(read.snapshot.coverage.livenessEvaluated, false); assert.equal((await f.service.runOnce()).claimed, 0);
});
test('late revisions retract prior bytes, latency maxima and caller sets without double counting', async t => {
 const f = await fixture(t); await f.project(row('a', 1, { durationMs: 9000, callerId: 'old' })); await f.project(row('b'));
 await f.service.runOnce(); const id = (await f.buckets())[0].id;
 await f.project(row('a', 2, { durationMs: 1000, callerId: 'caller', request: { state: 'complete', observedBytes: 5 } }));
 const stale = await f.service.readCompleted(id); assert.equal(stale.stale, true); assert.equal(stale.snapshot.metrics.latency.maxMs, 9000);
 await f.project(row('a', 2)); await f.service.runOnce(); const read = await f.service.readCompleted(id);
 assert.equal(read.snapshot.metrics.selectedInvocations, 2); assert.equal(read.snapshot.metrics.uniqueCallers, 1);
 assert.equal(read.snapshot.metrics.latency.maxMs, 3000); assert.equal(read.snapshot.metrics.requestBytes, 15);
});
test('removed bucket membership publishes empty complete computation with unknown coverage', async t => {
 const f = await fixture(t); await f.project(row()); const oldIds = (await f.buckets()).map(b => b.id); await f.service.runOnce();
 await f.project(row('a', 2, { runtimeAssetId: 'other' })); await f.service.runOnce();
 for (const id of oldIds) { const r = await f.service.readCompleted(id); assert.equal(r.snapshot.contributionCount, 0); assert.equal(r.snapshot.metrics.selectedInvocations, 0); assert.equal(r.snapshot.coverage.isPartial, true); }
});
test('over-limit bucket fails explicitly and retains previous completed snapshot for recovery', async t => {
 const f = await fixture(t, { maxContributions: 1, retryMs: 1000 }); await f.project(row()); await f.service.runOnce();
 const id = (await f.buckets())[0].id; await f.project(row('b')); const report = await f.service.runOnce();
 assert.equal(report.failed, 16); assert.ok(report.failures.every(e => e.code === 'BUCKET_CONTRIBUTION_LIMIT_EXCEEDED'));
 const read = await f.service.readCompleted(id); assert.equal(read.bucketVersion, 1); assert.equal(read.stale, true); assert.equal(read.snapshot.contributionCount, 1);
 assert.equal((await f.service.runOnce()).claimed, 0); f.clock('2026-09-11T01:00:01.000Z');
 const resumed = new Service(f.store, new Queue(), { batchSize: 64, maxContributions: 2 }); assert.equal((await resumed.runOnce()).completed, 16);
 assert.equal((await resumed.readCompleted(id)).snapshot.contributionCount, 2);
});
test('intervening projection fences computed result; later tick recovers latest generation', async t => {
 const f = await fixture(t); await f.project(row()); const complete = f.queue.complete.bind(f.queue); let injected = false;
 f.queue.complete = async (tx, claim, metrics) => { if (!injected) { injected = true; await f.projector.apply(tx, row('a', 2, { durationMs: 100 })); } return complete(tx, claim, metrics); };
 assert.equal((await f.service.runOnce()).superseded, 16); assert.ok((await f.buckets()).every(b => b.version === 0));
 assert.equal((await f.service.runOnce()).completed, 16);
 assert.ok((await f.buckets()).every(b => b.metrics.metrics.latency.maxMs === 100));
});
test('retention denies expired snapshots and expired jobs are not claimed', async t => {
 const f = await fixture(t); await f.project(row()); await f.service.runOnce(); const id = (await f.buckets())[0].id;
 await f.project(row('a', 2)); f.clock('2027-09-11T01:00:00.000Z');
 assert.equal((await f.service.readCompleted(id)).state, 'expired'); assert.equal((await f.service.runOnce()).claimed, 0);
 assert.equal((await f.service.readCompleted('bkt_' + '0'.repeat(64))).state, 'missing');
});
test('JSON key ordering does not invalidate persisted bucket keys', async t => {
 const f = await fixture(t); await f.project(row());
 for (const b of await f.buckets()) await f.db.getRepository(Bucket).update({ id: b.id }, { dimensions: Object.fromEntries(Object.entries(b.dimensions).reverse()) });
 assert.equal((await f.service.runOnce()).completed, 16);
});
test('corrupt contribution fails closed without publishing a partial snapshot', async t => {
 const f = await fixture(t); await f.project(row()); const c = await f.db.getRepository(Contribution).findOneByOrFail({ invocationId: 'a' });
 c.contribution.observation.revision = 999; await f.db.getRepository(Contribution).save(c);
 const report = await f.service.runOnce(); assert.equal(report.failed, 16); assert.ok(report.failures.every(e => e.code === 'INVALID_BUCKET_CONTRIBUTION'));
 assert.ok((await f.buckets()).every(b => b.version === 0));
});
test('unfinished and cache-unobserved evidence does not invent live counts or misses', async t => {
 const f = await fixture(t); await f.project(row('a', 1, { completedAt: null, phase: 'started', missingFields: ['cacheHit'] }));
 await f.service.runOnce(); const r = await f.service.readCompleted((await f.buckets())[0].id);
 assert.equal(r.snapshot.metrics.inFlight, 0); assert.equal(r.snapshot.metrics.unknownInFlight, 1); assert.equal(r.snapshot.metrics.cacheMisses, 0);
});
