'use strict';
process.env.DB_TYPE = 'sqlite';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ConfigService } = require('@nestjs/config');
const parser = require('api-nova-parser');
const entities = require('../dist/src/database/entities/runtime-call-observability.entity.js');
const { RuntimeObservabilityEventEntity: Event } =
  require('../dist/src/database/entities/runtime-observability-event.entity.js');
const { CallObservabilityStore } =
  require('../dist/src/modules/call-observability/call-observability.store.js');
const { CallObservabilityPayloadStore } =
  require('../dist/src/modules/call-observability/call-observability-payload.store.js');
const { CallObservabilityCollector } =
  require('../dist/src/modules/call-observability/call-observability.collector.js');
const { CallObservabilityCallersProjector } =
  require('../dist/src/modules/call-observability/call-observability-callers.projector.js');
const { CallObservabilityWorker, COLLECTOR_WORKER_ID } =
  require('../dist/src/modules/call-observability/call-observability.worker.js');
const root = path.resolve(__dirname, '../../../tmp/observability-worker-tests');
const encode = row => JSON.stringify(row) + '\n';
const code = expected => error => error?.code === expected;

test('pipeline state events are durable, change-only and do not claim server health', async t => {
  const f = await fixture(t);
  await sweep(f.worker);
  await sweep(f.worker);
  let events = await f.repository(Event).findBy({ eventName: 'pipeline.state_changed' });
  assert.equal(events.length, 1);
  assert.equal(events[0].subjectVersion, 1);
  assert.equal(events[0].details.serverHealth, 'unknown');
  const original = f.store.recomputePendingBuckets.bind(f.store);
  f.store.recomputePendingBuckets = async () => ({ recomputed: 0, failed: 1 });
  const degraded = await sweep(f.worker);
  assert.equal(degraded.at(-1).state, 'degraded');
  f.store.recomputePendingBuckets = original;
  await sweep(f.makeWorker());
  events = await f.repository(Event).find({ where: { eventName: 'pipeline.state_changed' }, order: { sequence: 'ASC' } });
  assert.deepEqual(events.map(event => event.details.state), ['running', 'degraded', 'running']);
  assert.deepEqual(events.map(event => event.subjectVersion), [1, 2, 3]);
  const state = await f.repository(entities.RuntimePipelineStateEntity).findOneByOrFail({ id: COLLECTOR_WORKER_ID });
  assert.equal(BigInt(state.value.snapshotSeq), BigInt(events[2].sequence));
});

function evidence(overrides = {}) {
  const invocationId = randomUUID();
  return { schemaVersion: 2, invocationId, eventId: randomUUID(), sourceInstanceId: randomUUID(),
    sourceSequence: 1, recordVersion: 1, phase: 'started', requestId: randomUUID(),
    traceId: invocationId, rootInvocationId: invocationId, spanKind: 'gateway_request',
    serverType: 'gateway', transport: 'gateway', protocolTransport: 'http', origin: 'external',
    runtimeAssetId: '00000000-0000-4000-8000-000000000001', identitySource: 'authenticated',
    callerId: 'stable-subject', credentialId: 'credential-1', peerIp: '127.0.0.1',
    clientIp: '127.0.0.1', ipSource: 'peer', startedAt: new Date(Date.now() - 120000).toISOString(),
    ...overrides };
}
function terminal(start, overrides = {}) {
  return { ...start, eventId: randomUUID(), sourceSequence: 2, recordVersion: 2,
    phase: 'finished', completedAt: new Date().toISOString(), outcome: 'success', statusCode: 200,
    ...overrides };
}
async function fixture(t, settings = {}) {
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'run-'));
  const source = path.join(directory, 'source');
  await fs.mkdir(source);
  const oldData = process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  process.env.API_NOVA_OBSERVABILITY_DATA_DIR = path.join(directory, 'data');
  const payloads = new CallObservabilityPayloadStore();
  if (oldData === undefined) delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  else process.env.API_NOVA_OBSERVABILITY_DATA_DIR = oldData;
  const database = new DataSource({ type: 'sqljs',
    entities: [...entities.CALL_OBSERVABILITY_ENTITIES, Event], synchronize: true, logging: false });
  const store = new CallObservabilityStore(database, payloads);
  const config = new ConfigService({ API_NOVA_OBSERVABILITY_SOURCE_ID_SECRET: 'fixture-key-'.repeat(5),
    API_NOVA_OBSERVABILITY_SOURCE_ID_KEY_ID: 'fixture-v1',
    API_NOVA_OBSERVABILITY_SOURCES_PER_DAY: 100, ...settings });
  const callers = new CallObservabilityCallersProjector(config);
  const workers = [];
  const makeWorker = () => {
    const old = process.env.API_NOVA_AUDIT_DIR;
    process.env.API_NOVA_AUDIT_DIR = source;
    let collector;
    try { collector = new CallObservabilityCollector(store); }
    finally {
      if (old === undefined) delete process.env.API_NOVA_AUDIT_DIR;
      else process.env.API_NOVA_AUDIT_DIR = old;
    }
    const worker = new CallObservabilityWorker(collector, callers, store, config);
    workers.push({ worker, collector });
    return worker;
  };
  const worker = makeWorker();
  t.after(async () => {
    for (const entry of workers) { await entry.worker.onModuleDestroy(); entry.collector.onModuleDestroy(); }
    await payloads.onModuleDestroy();
    if (database.isInitialized) await database.destroy();
    const target = path.resolve(directory);
    if (path.dirname(target) !== root || !path.basename(target).startsWith('run-')) {
      throw new Error('Refusing non-owned cleanup');
    }
    await fs.rm(target, { recursive: true, force: true });
  });
  await database.initialize();
  const fileName = 'calls-v2-' + randomUUID() + '.jsonl';
  return { directory, source, fileName, file: path.join(source, fileName), store, worker,
    makeWorker, config, callers, database, repository: entity => database.getRepository(entity) };
}
async function sweep(worker, options) {
  const reports = [];
  for (let i = 0; i < 100; i++) {
    const report = await worker.runOnce(options);
    reports.push(report);
    if (report.scanComplete || report.state === 'waiting_for_source') return reports;
  }
  assert.fail('bounded fixture sweep did not complete');
}
async function age(f, invocationId) {
  await f.store.transaction(tx => tx.manager.getRepository(entities.RuntimeInvocationEntity)
    .update({ invocationId }, { ingestedAt: new Date(Date.now() - 60000).toISOString() }));
}

test('merges trusted subjects across credential rotation and changing IP without double-counting phases', async t => {
  const f = await fixture(t);
  const start = evidence();
  const second = evidence({ credentialId: 'credential-2', peerIp: '192.0.2.2' });
  await fs.writeFile(f.file, encode(start) + encode(terminal(start)) + encode(second));
  await sweep(f.worker);
  assert.equal(await f.repository(entities.RuntimeCallerEntity).count(), 1);
  assert.equal(await f.repository(entities.RuntimeCallerCredentialEntity).count(), 2);
  assert.equal(await f.repository(entities.RuntimeAccessSourceEntity).count(), 2);
  assert.equal(await f.repository(entities.RuntimeInvocationEntity).count(), 2);
  const observations = await f.repository(entities.RuntimeCallerObservationEntity).find();
  assert.equal(observations.length, 2);
  const before = await f.repository(entities.RuntimeCallerEntity).find();
  await sweep(f.makeWorker());
  assert.deepEqual(await f.repository(entities.RuntimeCallerEntity).find(), before);
});

test('same IP does not merge different authenticated subjects', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, encode(evidence({ callerId: 'subject-a' })) +
    encode(evidence({ callerId: 'subject-b' })));
  await sweep(f.worker);
  assert.equal(await f.repository(entities.RuntimeCallerEntity).count(), 2);
  assert.equal(await f.repository(entities.RuntimeAccessSourceEntity).count(), 1);
  assert.equal(await f.repository(entities.RuntimeCallerObservationEntity).count(), 2);
});

test('authentication failure and anonymous traffic never promote supplied caller/key fields', async t => {
  const f = await fixture(t);
  const invalid = { identitySource: 'anonymous', callerId: 'forged-subject',
    credentialId: 'forged-credential', callerIssuer: 'untrusted', callerSubject: 'admin' };
  await fs.writeFile(f.file, encode(evidence({ ...invalid, authState: 'authentication_failed' })) +
    encode(evidence({ ...invalid, authState: 'anonymous' })));
  await sweep(f.worker);
  assert.equal(await f.repository(entities.RuntimeCallerEntity).count(), 0);
  assert.equal(await f.repository(entities.RuntimeCallerCredentialEntity).count(), 0);
  assert.equal(await f.repository(entities.RuntimeAccessSourceEntity).count(), 2);
  const calls = await f.repository(entities.RuntimeInvocationEntity).find();
  assert.ok(calls.every(row => row.callerId === null && row.record.credentialId === null));
});

test('forged forwarded headers and untrusted client IP cannot replace the socket peer', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, encode(evidence({ clientIp: '203.0.113.99',
    ipSource: 'forwarded', proxyTrusted: false,
    requestHeaders: { 'x-forwarded-for': '203.0.113.99' } })));
  await sweep(f.worker);
  const source = (await f.repository(entities.RuntimeAccessSourceEntity).find())[0];
  assert.equal(source.clientIp, '127.0.0.1');
  assert.equal(source.ipSource, 'peer');
  const call = (await f.repository(entities.RuntimeInvocationEntity).find())[0];
  assert.equal(call.record.clientIp, '127.0.0.1');
  assert.equal(call.record.proxyTrusted, false);
  assert.match(source.sourceId, /^src-fixture-v1-[a-f0-9]{64}$/);
  assert.equal(source.sourceId.includes('127.0.0.1'), false);
});

test('source cardinality is capped per asset/day/auth state with a stable overflow bucket', async t => {
  const f = await fixture(t, { API_NOVA_OBSERVABILITY_SOURCES_PER_DAY: 2 });
  const rows = Array.from({ length: 5 }, (_, n) => evidence({
    identitySource: 'anonymous', authState: 'authentication_failed',
    callerId: 'forged-' + n, credentialId: 'fake-' + n, peerIp: '192.0.2.' + (n + 1),
  }));
  await fs.writeFile(f.file, rows.map(encode).join(''));
  await sweep(f.worker);
  const sources = await f.repository(entities.RuntimeAccessSourceEntity).find();
  assert.equal(sources.length, 3);
  const overflow = sources.find(row => row.ipSource === 'overflow');
  assert.equal(overflow.clientIp, null);
  const calls = await f.repository(entities.RuntimeInvocationEntity).find();
  assert.equal(calls.filter(row => row.sourceId === overflow.sourceId).length, 3);
  const diagnostics = await f.repository(entities.RuntimePipelineStateEntity)
    .findOneByOrFail({ id: 'call-observability:caller-diagnostics' });
  assert.equal(diagnostics.value.sourceOverflowInvocations, 3);
  await fs.appendFile(f.file, encode(terminal(rows[4])));
  await sweep(f.worker);
  assert.equal((await f.repository(entities.RuntimePipelineStateEntity)
    .findOneByOrFail({ id: diagnostics.id })).value.sourceOverflowInvocations, 3);
  assert.equal(await f.repository(entities.RuntimeCallerEntity).count(), 0);
});

test('test/probe/internal and upstream records do not manufacture external caller observations', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, [
    evidence({ origin: 'test' }), evidence({ origin: 'probe' }), evidence({ origin: 'internal' }),
    evidence({ spanKind: 'upstream_api' }),
  ].map(encode).join(''));
  await sweep(f.worker);
  assert.equal(await f.repository(entities.RuntimeInvocationEntity).count(), 4);
  assert.equal(await f.repository(entities.RuntimeCallerEntity).count(), 0);
  assert.equal(await f.repository(entities.RuntimeCallerObservationEntity).count(), 0);
});

test('caller/source associations roll back together with the invocation and checkpoint', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.ingest(evidence(), {}, async (...args) => {
    await f.callers.project(...args);
    throw new Error('injected rollback after associations');
  }), /injected rollback/);
  for (const entity of [entities.RuntimeCallerEntity, entities.RuntimeCallerCredentialEntity,
    entities.RuntimeAccessSourceEntity, entities.RuntimeCallerObservationEntity,
    entities.RuntimeInvocationEntity, entities.RuntimeIngestReceiptEntity]) {
    assert.equal(await f.repository(entity).count(), 0);
  }
});

test('missing identity key retains pending file and checkpoint for retry, not quarantine', async t => {
  const f = await fixture(t, { API_NOVA_OBSERVABILITY_SOURCE_ID_SECRET: '' });
  await fs.writeFile(f.file, encode(evidence()));
  await assert.rejects(f.worker.runOnce(), code('SOURCE_ID_CONFIGURATION_REQUIRED'));
  assert.equal(await f.repository(entities.RuntimeIngestCheckpointEntity).count(), 0);
  assert.equal(await f.repository(entities.RuntimeIngestQuarantineEntity).count(), 0);
  f.config.set('API_NOVA_OBSERVABILITY_SOURCE_ID_SECRET', 'restored-fixture-key-'.repeat(3));
  await sweep(f.worker);
  assert.equal(await f.repository(entities.RuntimeCallerEntity).count(), 1);
});

test('bounded directory sweeps ignore unrelated/old caller files and preserve progress', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 6; i++) {
    await fs.writeFile(path.join(f.source, 'calls-v2-source-' + i + '.jsonl'), encode(evidence()));
  }
  await fs.writeFile(path.join(f.source, 'callers-old.jsonl'), 'private legacy content');
  await fs.writeFile(path.join(f.source, 'calls-old.jsonl'), 'private legacy content');
  const reports = await sweep(f.worker, { maxEntries: 2, maxReadBytes: 2048, maxRecords: 2 });
  assert.ok(reports.length > 1);
  assert.ok(reports.every(row => row.bytesRead <= 2048 && row.processedRecords <= 2));
  assert.equal(await f.repository(entities.RuntimeInvocationEntity).count(), 6);
  assert.equal(await f.repository(entities.RuntimeIngestQuarantineEntity).count(), 0);
  const state = await f.repository(entities.RuntimePipelineStateEntity).findOneByOrFail({ id: COLLECTOR_WORKER_ID });
  assert.equal(state.value.backlogScope, 'completed_directory_scan');
  assert.equal(state.value.scan.visitedFiles, 6);
});

test('independent stale-progress recovery infers unknown and a late real terminal corrects it once', async t => {
  const f = await fixture(t);
  const start = evidence();
  await fs.writeFile(f.file, encode(start));
  await sweep(f.worker);
  await age(f, start.invocationId);
  const recovered = await sweep(f.worker);
  assert.equal(recovered.at(-1).reconciledInvocations, 1);
  let call = await f.repository(entities.RuntimeInvocationEntity).findOneByOrFail({ invocationId: start.invocationId });
  assert.equal(call.outcome, 'unknown');
  assert.equal(call.completedAt, null);
  assert.equal(call.record.durationMs, null);
  assert.equal(call.record.completionSource, 'reconciled');
  assert.equal(call.sourceRecordVersion, 1);
  assert.equal((await f.repository(Event).findBy({ eventName: 'invocation.reconciled' }))[0].dispatchState, 'suppressed');
  const end = terminal(start);
  await fs.appendFile(f.file, encode(end) + encode(end));
  await sweep(f.makeWorker());
  call = await f.repository(entities.RuntimeInvocationEntity).findOneByOrFail({ invocationId: start.invocationId });
  assert.equal(call.recordVersion, 3);
  assert.equal(call.sourceRecordVersion, 2);
  assert.equal(call.outcome, 'success');
  assert.equal(call.record.completionSource, 'observed');
  assert.equal(await f.repository(entities.RuntimeInvocationEntity).count(), 1);
  assert.equal(await f.repository(entities.RuntimeCallerEntity).count(), 1);
  assert.equal(await f.repository(Event).countBy({ eventName: 'invocation.reconciled' }), 2);
});

test('partial terminal evidence prevents inference until its remainder arrives', async t => {
  const f = await fixture(t);
  const start = evidence();
  await fs.writeFile(f.file, encode(start));
  await sweep(f.worker);
  await age(f, start.invocationId);
  const end = encode(terminal(start));
  await fs.appendFile(f.file, end.slice(0, 83));
  const incomplete = await sweep(f.worker);
  assert.equal(incomplete.at(-1).scan.partialBytes, 83);
  assert.equal(incomplete.at(-1).reconciledInvocations, 0);
  assert.equal((await f.repository(entities.RuntimeInvocationEntity).find())[0].phase, 'started');
  await fs.appendFile(f.file, end.slice(83));
  await sweep(f.worker);
  assert.equal((await f.repository(entities.RuntimeInvocationEntity).find())[0].outcome, 'success');
});

test('a source truncation degrades the sweep without starving another valid source', async t => {
  const f = await fixture(t);
  const start = evidence();
  await fs.writeFile(f.file, encode(start));
  await sweep(f.worker);
  await age(f, start.invocationId);
  await fs.truncate(f.file, 0);
  await fs.writeFile(path.join(f.source, 'calls-v2-healthy.jsonl'), encode(evidence()));
  const reports = await sweep(f.worker);
  assert.equal(reports.at(-1).state, 'degraded');
  assert.equal(reports.at(-1).scan.errors.SOURCE_FILE_TRUNCATED, 1);
  assert.equal(reports.at(-1).reconciledInvocations, 0);
  assert.equal(await f.repository(entities.RuntimeInvocationEntity).count(), 2);
});

test('missing source directory reports waiting, not a fabricated successful empty scan', async t => {
  const f = await fixture(t);
  await fs.rmdir(f.source);
  const result = await f.worker.runOnce();
  assert.equal(result.state, 'waiting_for_source');
  assert.equal(result.scanComplete, false);
  const state = await f.repository(entities.RuntimePipelineStateEntity).findOneByOrFail({ id: COLLECTOR_WORKER_ID });
  assert.equal(state.value.lastSuccessfulScanAt, null);
});

test('real shared producer logs reach durable calls and caller projection through discovery', async t => {
  const f = await fixture(t);
  const old = process.env.API_NOVA_AUDIT_DIR;
  process.env.API_NOVA_AUDIT_DIR = f.source;
  try {
    const call = parser.beginRuntimeCall({
      transport: 'gateway', protocolTransport: 'http', origin: 'external', requestId: randomUUID(),
      identitySource: 'authenticated', callerId: 'real-producer-subject', credentialId: 'safe-reference',
      peerIp: '127.0.0.1', runtimeAssetId: randomUUID(),
    }, 'admission');
    await call.finish({ outcome: 'success', statusCode: 200,
      request: parser.captureAuditBody('request'), response: parser.captureAuditBody('response') });
    await parser.flushRuntimeAudit();
    await sweep(f.worker);
    const current = await f.repository(entities.RuntimeInvocationEntity).findOneByOrFail({ invocationId: call.record.invocationId });
    assert.equal(current.phase, 'finished');
    assert.equal(current.outcome, 'success');
    assert.equal(current.recordVersion, 2);
    assert.ok(current.sourceId);
    assert.equal(await f.repository(entities.RuntimeCallerEntity).count(), 1);
  } finally {
    if (old === undefined) delete process.env.API_NOVA_AUDIT_DIR;
    else process.env.API_NOVA_AUDIT_DIR = old;
  }
});

test('opt-in background lifecycle collects and waits for its active batch on shutdown', async t => {
  const f = await fixture(t, { API_NOVA_OBSERVABILITY_COLLECTOR_ENABLED: 'true' });
  await fs.writeFile(f.file, encode(evidence()));
  f.worker.onApplicationBootstrap();
  const deadline = Date.now() + 3000;
  let count = 0;
  while (!count && Date.now() < deadline) {
    count = await f.store.transaction(tx => tx.manager.getRepository(entities.RuntimeCallerEntity).count());
    if (!count) await new Promise(resolve => setTimeout(resolve, 10));
  }
  await f.worker.onModuleDestroy();
  assert.equal(count, 1);
  await assert.rejects(f.worker.runOnce(), code('COLLECTOR_STOPPED'));
});

test('worker drains complete-line backlog without sixteen-record directory rescans and advances buckets before source EOF', async t => {
  const f = await fixture(t);
  const rows = Array.from({ length: 160 }, () => evidence({ origin: 'internal' }));
  await fs.writeFile(f.file, rows.map(encode).join(''));
  const calls = []; const collect = f.worker.collector.collectFile.bind(f.worker.collector);
  f.worker.collector.collectFile = async (...args) => { calls.push(args[1]); return collect(...args); };
  const first = await f.worker.runOnce();
  assert.equal(first.processedRecords, 128);
  assert.equal(first.scanComplete, false);
  assert.equal(first.reconciledInvocations, 0);
  assert.ok(first.recomputedBuckets > 0 && first.recomputedBuckets <= 1);
  assert.deepEqual(calls.map(item => item.maxRecords), [64, 64]);
  assert.ok(calls.every(item => item.batchFacts === true));
  await sweep(f.worker);
  await sweep(f.worker);
  assert.equal(await f.repository(entities.RuntimeInvocationEntity).count(), 160);
  const receipts = await f.repository(entities.RuntimeIngestReceiptEntity).count();
  assert.equal(receipts, 160);
});

test('one-bucket maintenance alternates metric and caller work across busy turns', async t => {
  const f = await fixture(t);
  await f.store.ingest(evidence(), {}, f.callers.project);
  const metrics = f.repository(entities.RuntimeMetricBucketEntity);
  const callers = f.repository(entities.RuntimeCallerBucketEntity);
  const complete = async repository => (await repository.find()).filter(row => !row.metrics.recompute).length;
  assert.equal(await complete(metrics), 0); assert.equal(await complete(callers), 0);
  assert.deepEqual(await f.store.recomputePendingBuckets(1), { recomputed: 1, failed: 0 });
  assert.equal(await complete(metrics), 1); assert.equal(await complete(callers), 0);
  assert.deepEqual(await f.store.recomputePendingBuckets(1), { recomputed: 1, failed: 0 });
  assert.equal(await complete(metrics), 1); assert.equal(await complete(callers), 1);
});

test('bounded recompute shares work between metric/caller markers and backs off malformed rows without losing them', async t => {
  const f = await fixture(t);
  const start = evidence(); await f.store.ingest(start, {}, f.callers.project);
  const metrics = f.repository(entities.RuntimeMetricBucketEntity);
  const callers = f.repository(entities.RuntimeCallerBucketEntity);
  const metric = (await metrics.find())[0], caller = (await callers.find())[0];
  assert.ok(metric && caller);
  await metrics.save({ ...metric, id: '0'.repeat(64), metrics: { recompute: { state: 'pending', action: 'invalid' } } });
  await callers.save({ ...caller, id: '0'.repeat(64), metrics: { recompute: { state: 'pending', action: 'invalid' } } });
  const first = await f.store.recomputePendingBuckets(2);
  assert.deepEqual(first, { recomputed: 0, failed: 2 });
  const second = await f.store.recomputePendingBuckets(2);
  assert.deepEqual(second, { recomputed: 2, failed: 0 });
  assert.ok((await metrics.find()).some(row => row.id !== '0'.repeat(64) && !row.metrics.recompute));
  assert.ok((await callers.find()).some(row => row.id !== '0'.repeat(64) && !row.metrics.recompute));
  assert.equal((await metrics.findOneByOrFail({ id: '0'.repeat(64) })).metrics.recompute.state, 'pending');
  assert.equal((await callers.findOneByOrFail({ id: '0'.repeat(64) })).metrics.recompute.state, 'pending');
  const full = await f.store.recomputePendingBuckets();
  assert.equal(full.failed, 2); // The existing explicit full repair still sees deferred failures.
  await assert.rejects(f.store.recomputePendingBuckets(0), code('INVALID_RECOMPUTE_LIMIT'));
  await assert.rejects(f.store.recomputePendingBuckets(129), code('INVALID_RECOMPUTE_LIMIT'));
});
