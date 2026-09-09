'use strict';
process.env.DB_TYPE = 'sqlite';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fork } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
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
const { CallObservabilityWorker } =
  require('../dist/src/modules/call-observability/call-observability.worker.js');
const { CallObservabilitySourceLifecycle, SOURCE_EXIT_PREFIX, SOURCE_FILE_SEAL_PREFIX } =
  require('../dist/src/modules/call-observability/call-observability-source-lifecycle.service.js');
const root = path.resolve(__dirname, '../../../tmp/observability-source-lifecycle-tests');
const fragment = '{"schemaVersion":2,"private":"tail-secret';
const code = expected => error => error?.code === expected;
const encode = row => JSON.stringify(row) + '\n';

function owned(directory) {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith('run-')) {
    throw new Error('Refusing a non-owned lifecycle test directory');
  }
  return resolved;
}
async function producerMain() {
  const directory = owned(process.argv[3]);
  const mode = process.argv[4];
  const source = path.join(directory, 'source');
  process.env.API_NOVA_AUDIT_DIR = source;
  const sourceId = parser.getRuntimeAuditHealth().processId;
  if (mode === 'manifest-failure') {
    process.send({ type: 'prepared', sourceId });
    await new Promise(resolve => process.once('message', resolve));
  }
  let call = null;
  if (mode === 'partial-only') await parser.publishRuntimeAuditSource(source, sourceId);
  else {
    call = parser.beginRuntimeCall({
      transport: 'gateway', protocolTransport: 'http', requestId: randomUUID(),
      identitySource: 'authenticated', callerId: 'source-subject', credentialId: 'credential-ref',
      runtimeAssetId: '00000000-0000-4000-8000-000000000003', peerIp: '127.0.0.1',
    }, 'admission');
    await parser.flushRuntimeAudit();
  }
  const fileName = mode === 'partial-only'
    ? 'calls-v2-' + new Date().toISOString().slice(0, 10) + '-' + sourceId + '.jsonl'
    : (await fs.readdir(source)).find(name => name.startsWith('calls-v2-'));
  const file = path.join(source, fileName);
  const initialSize = mode === 'partial-only' ? 0 : (await fs.stat(file)).size;
  if (mode !== 'clean') await fs.appendFile(file, fragment);
  process.on('message', async message => {
    if (message?.type === 'finish' && call) {
      await call.finish({ outcome: 'success', statusCode: 200 });
      await parser.flushRuntimeAudit();
      process.send({ type: 'finished' });
    }
  });
  process.send({ type: 'ready', sourceId, pid: process.pid, fileName, initialSize,
    record: call?.record || null, health: parser.getRuntimeAuditHealth() });
  setInterval(() => {}, 1000);
}
async function fixture(t) {
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
  await database.initialize();
  const store = new CallObservabilityStore(database, payloads);
  const config = new ConfigService({ API_NOVA_OBSERVABILITY_SOURCE_ID_SECRET: 'lifecycle-fixture-'.repeat(4) });
  const callers = new CallObservabilityCallersProjector(config);
  const instances = [];
  const make = () => {
    const old = process.env.API_NOVA_AUDIT_DIR;
    process.env.API_NOVA_AUDIT_DIR = source;
    try {
      const lifecycle = new CallObservabilitySourceLifecycle(store);
      const collector = new CallObservabilityCollector(store, lifecycle);
      const worker = new CallObservabilityWorker(collector, callers, store, config, lifecycle);
      const instance = { lifecycle, collector, worker };
      instances.push(instance);
      return instance;
    } finally {
      if (old === undefined) delete process.env.API_NOVA_AUDIT_DIR;
      else process.env.API_NOVA_AUDIT_DIR = old;
    }
  };
  const instance = make();
  const children = [];
  const stop = async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise(resolve => child.once('close', resolve));
    child.kill('SIGKILL');
    await closed;
  };
  const producer = mode => new Promise((resolve, reject) => {
    const child = fork(__filename, ['--producer', directory, mode || 'partial'], {
      execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    children.push(child);
    let ready = false, stderr = '';
    const timeout = setTimeout(() => { void stop(child); reject(new Error('Producer startup timed out')); }, 10000);
    child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-4000); });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', exitCode => {
      if (!ready) { clearTimeout(timeout); reject(new Error('Producer failed: ' + exitCode + ' ' + stderr)); }
    });
    child.on('message', message => {
      if (message?.type === 'prepared') {
        if (!parser.isRuntimeAuditSourceId(message.sourceId)) return reject(new Error('Invalid fixture source id'));
        fs.mkdir(path.join(source, 'source-v2-' + message.sourceId + '.json'))
          .then(() => child.send({ type: 'go' })).catch(reject);
      }
      if (message?.type === 'ready') {
        clearTimeout(timeout);
        ready = true;
        resolve({ ...message, child, file: path.join(source, message.fileName),
          manifest: path.join(source, 'source-v2-' + message.sourceId + '.json'),
          stop: () => stop(child) });
      }
    });
  });
  t.after(async () => {
    for (const child of children) await stop(child);
    for (const item of instances) { await item.worker.onModuleDestroy(); item.collector.onModuleDestroy(); }
    await payloads.onModuleDestroy();
    await database.destroy();
    await fs.rm(owned(directory), { recursive: true, force: true });
  });
  return { ...instance, directory, source, database, store, config, callers, make, producer,
    repository: entity => database.getRepository(entity) };
}
async function sweep(worker) {
  for (let i = 0; i < 100; i++) {
    const report = await worker.runOnce();
    if (report.scanComplete) return report;
  }
  assert.fail('Fixture directory scan did not converge');
}

if (process.argv[2] === '--producer') {
  producerMain().catch(error => { process.stderr.write(String(error.stack || error)); process.exit(1); });
} else {
  test('source manifests validate current schema, real PID shape and bounded UUID identifiers', () => {
    const valid = { schemaVersion: 2, kind: 'runtime_audit_source', sourceInstanceId: randomUUID(),
      pid: process.pid, startedAt: new Date().toISOString() };
    assert.deepEqual(parser.normalizeRuntimeAuditSourceManifest(valid), valid);
    for (const invalid of [null, [], { ...valid, schemaVersion: 1 }, { ...valid, pid: 0 },
      { ...valid, pid: 1.5 }, { ...valid, sourceInstanceId: '../escape' }, { ...valid, startedAt: 'invalid' }]) {
      assert.throws(() => parser.normalizeRuntimeAuditSourceManifest(invalid), /INVALID_RUNTIME_AUDIT_SOURCE/);
    }
  });

  test('real producer publishes its own UUID/PID and live EOF never consumes a fragment', async t => {
    const f = await fixture(t);
    const producer = await f.producer();
    const manifest = JSON.parse(await fs.readFile(producer.manifest, 'utf8'));
    assert.equal(manifest.sourceInstanceId, producer.sourceId);
    assert.equal(manifest.pid, producer.pid);
    assert.equal(manifest.kind, 'runtime_audit_source');
    const result = await f.collector.collectFile(producer.fileName, {}, f.callers.project);
    assert.equal(result.sourceState, 'active');
    assert.equal(result.byteOffset, String(producer.initialSize));
    assert.equal(result.partialBytes, Buffer.byteLength(fragment));
    assert.equal(await f.repository(entities.RuntimeIngestQuarantineEntity).count(), 0);
    assert.equal(await f.lifecycle.persistedProofId(producer.sourceId), undefined);
  });

  test('real producer kill quarantines the closed fragment once and immediately reconciles the unfinished call', async t => {
    const f = await fixture(t);
    const producer = await f.producer();
    await sweep(f.worker);
    await producer.stop();
    const closed = await sweep(f.worker);
    assert.equal(closed.quarantinedRecords, 1);
    assert.equal(closed.scan.partialBytes, 0);
    const recovered = await sweep(f.worker);
    assert.equal(recovered.reconciledInvocations, 1);
    const call = await f.repository(entities.RuntimeInvocationEntity).findOneByOrFail({ invocationId: producer.record.invocationId });
    assert.equal(call.outcome, 'unknown');
    assert.equal(call.completedAt, null);
    assert.equal(call.record.durationMs, null);
    assert.equal(call.record.reconciliationReason, 'process_exit');
    assert.ok(call.record.sourceExitedAt);
    assert.equal(call.sourceRecordVersion, 1);
    const rows = await f.repository(entities.RuntimeIngestQuarantineEntity).find();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, 'SOURCE_CLOSED_PARTIAL_LINE');
    assert.equal(rows[0].recordHash, createHash('sha256').update(fragment).digest('hex'));
    assert.equal(JSON.stringify(rows).includes('tail-secret'), false);
    const diagnostics = await f.repository(entities.RuntimePipelineStateEntity)
      .findOneByOrFail({ id: 'call-observability:storage-diagnostics' });
    assert.equal(diagnostics.value.closedSourcePartialRecords, 1);
    assert.equal(diagnostics.value.closedSourcePartialBytes, Buffer.byteLength(fragment));
    await sweep(f.make().worker);
    assert.equal(await f.repository(entities.RuntimeIngestQuarantineEntity).count(), 1);
    assert.equal(await f.repository(Event).count(), 1);
  });

  test('a closed first-line fragment advances evidence without inventing an invocation or caller', async t => {
    const f = await fixture(t);
    const producer = await f.producer('partial-only');
    await producer.stop();
    const result = await f.collector.collectFile(producer.fileName, { maxReadBytes: 4096 });
    assert.equal(result.closedPartialRecords, 1);
    assert.equal(result.closedPartialBytes, Buffer.byteLength(fragment));
    assert.equal(result.byteOffset, String(Buffer.byteLength(fragment)));
    assert.equal(await f.repository(entities.RuntimeInvocationEntity).count(), 0);
    assert.equal(await f.repository(entities.RuntimeCallerEntity).count(), 0);
  });

  test('renaming a previously observed file keeps its bound source proof', async t => {
    const f = await fixture(t);
    const producer = await f.producer();
    const before = await f.collector.collectFile(producer.fileName, {}, f.callers.project);
    const renamed = 'calls-v2-renamed.jsonl';
    await fs.rename(producer.file, path.join(f.source, renamed));
    await producer.stop();
    const after = await f.make().collector.collectFile(renamed, {}, f.callers.project);
    assert.equal(after.checkpointId, before.checkpointId);
    assert.equal(after.sourceState, 'closed');
    assert.equal(after.closedPartialRecords, 1);
  });

  test('missing manifests do not convert EOF or an absent producer into unproven closure', async t => {
    const f = await fixture(t);
    const producer = await f.producer();
    await fs.unlink(producer.manifest);
    await producer.stop();
    const result = await f.collector.collectFile(producer.fileName, {}, f.callers.project);
    assert.equal(result.sourceState, 'unknown');
    assert.equal(result.sourceStateReason, 'source_manifest_missing');
    assert.equal(result.byteOffset, String(producer.initialSize));
    assert.equal(result.closedPartialRecords, 0);
  });

  test('invalid manifest and inconclusive process probes retain the partial evidence', async t => {
    const f = await fixture(t);
    const producer = await f.producer();
    f.lifecycle.probeProcess = () => 'unknown'; // Inject the conservative EPERM/unsupported outcome.
    let result = await f.collector.collectFile(producer.fileName, {}, f.callers.project);
    assert.equal(result.sourceStateReason, 'process_probe_inconclusive');
    assert.equal(result.closedPartialRecords, 0);
    await fs.writeFile(producer.manifest, '{"schemaVersion":1,"pid":0}');
    await producer.stop();
    result = await f.make().collector.collectFile(producer.fileName, {}, f.callers.project);
    assert.equal(result.sourceState, 'unknown');
    assert.equal(result.closedPartialRecords, 0);
  });

  test('manifest publication failure remains observable without preventing source call logging', async t => {
    const f = await fixture(t);
    const producer = await f.producer('manifest-failure');
    assert.ok(producer.health.sourceManifestFailures > 0);
    assert.ok(producer.health.writtenRecords > 0);
    await producer.stop();
    const result = await f.collector.collectFile(producer.fileName, {}, f.callers.project);
    assert.equal(result.sourceState, 'unknown');
    assert.equal(result.processedRecords, 1);
    assert.equal(result.closedPartialRecords, 0);
    assert.equal(await f.repository(entities.RuntimeInvocationEntity).count(), 1);
  });

  test('quarantine failure preserves checkpoint and retries safely against the durable file seal', async t => {
    const f = await fixture(t);
    const producer = await f.producer();
    await f.collector.collectFile(producer.fileName, {}, f.callers.project);
    await producer.stop();
    const original = f.store.rejectRecord.bind(f.store);
    f.store.rejectRecord = async () => { const error = new Error('injected busy'); error.code = 'STORAGE_BUSY'; throw error; };
    await assert.rejects(f.collector.collectFile(producer.fileName), code('STORAGE_BUSY'));
    const checkpoint = (await f.repository(entities.RuntimeIngestCheckpointEntity).find())[0];
    assert.equal(BigInt(checkpoint.byteOffset).toString(), String(producer.initialSize));
    assert.equal(await f.repository(entities.RuntimeIngestQuarantineEntity).count(), 0);
    assert.ok(await f.repository(entities.RuntimePipelineStateEntity).findOneBy({ id: SOURCE_FILE_SEAL_PREFIX + checkpoint.id }));
    f.store.rejectRecord = original;
    assert.equal((await f.make().collector.collectFile(producer.fileName)).closedPartialRecords, 1);
  });

  test('sealed files reject later appends rather than silently accepting a changed source', async t => {
    const f = await fixture(t);
    const producer = await f.producer();
    await producer.stop();
    const before = await f.collector.collectFile(producer.fileName, {}, f.callers.project);
    await fs.appendFile(producer.file, '\nextra');
    await assert.rejects(f.collector.collectFile(producer.fileName), code('SOURCE_SEALED_FILE_CHANGED'));
    const checkpoint = (await f.repository(entities.RuntimeIngestCheckpointEntity).find())[0];
    assert.equal(BigInt(checkpoint.byteOffset).toString(), before.byteOffset);
  });

  test('mixed source identities prevent one producer manifest from closing the whole file', async t => {
    const f = await fixture(t);
    const producer = await f.producer('clean');
    const other = { ...producer.record, invocationId: randomUUID(), eventId: randomUUID(), sourceInstanceId: randomUUID(),
      traceId: randomUUID(), rootInvocationId: randomUUID() };
    await fs.appendFile(producer.file, encode(other) + fragment);
    await producer.stop();
    const result = await f.collector.collectFile(producer.fileName, {}, f.callers.project);
    assert.equal(result.sourceState, 'unknown');
    assert.equal(result.sourceStateReason, 'mixed_source_file');
    assert.equal(result.closedPartialRecords, 0);
    assert.equal(await f.repository(entities.RuntimeInvocationEntity).count(), 2);
  });

  test('persisted UUID-bound exit proofs survive observer restart without confusing PID reuse', async t => {
    const f = await fixture(t);
    const producer = await f.producer();
    await producer.stop();
    const first = await f.lifecycle.observe(producer.sourceId);
    const restarted = f.make().lifecycle;
    restarted.probeProcess = () => { throw new Error('A closed UUID must not be reclassified using a reused PID'); };
    const second = await restarted.observe(producer.sourceId);
    assert.equal(second.state, 'closed');
    assert.equal(second.proofId, SOURCE_EXIT_PREFIX + producer.sourceId);
    assert.deepEqual(second, first);
  });

  test('a live producer can still correct timeout-inferred unknown with its real terminal record', async t => {
    const f = await fixture(t);
    const producer = await f.producer('clean');
    await sweep(f.worker);
    await f.store.transaction(tx => tx.manager.getRepository(entities.RuntimeInvocationEntity)
      .update({ invocationId: producer.record.invocationId }, { ingestedAt: new Date(Date.now() - 60000).toISOString() }));
    await sweep(f.worker);
    let current = (await f.repository(entities.RuntimeInvocationEntity).find())[0];
    assert.equal(current.outcome, 'unknown');
    assert.equal(current.record.reconciliationReason, 'progress_timeout');
    const finished = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Producer terminal timed out')), 5000);
      producer.child.on('message', message => { if (message?.type === 'finished') { clearTimeout(timer); resolve(); } });
    });
    producer.child.send({ type: 'finish' });
    await finished;
    await sweep(f.worker);
    current = (await f.repository(entities.RuntimeInvocationEntity).find())[0];
    assert.equal(current.outcome, 'success');
    assert.equal(current.recordVersion, 3);
    assert.equal(current.sourceRecordVersion, 2);
    assert.equal(await f.repository(entities.RuntimeInvocationEntity).count(), 1);
  });
}
