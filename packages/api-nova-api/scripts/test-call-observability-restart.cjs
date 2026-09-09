'use strict';
process.env.DB_TYPE = 'sqlite';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ConfigService } = require('@nestjs/config');
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
const temporaryRoot = path.resolve(__dirname, '../../../tmp/observability-restart-tests');
const encode = row => JSON.stringify(row) + '\n';

function ownedDirectory(directory) {
  const target = path.resolve(directory);
  if (path.dirname(target) !== temporaryRoot || !path.basename(target).startsWith('run-')) {
    throw new Error('Refusing a non-owned persistent test directory');
  }
  return target;
}
function startRecord() {
  const invocationId = randomUUID();
  return { schemaVersion: 2, invocationId, eventId: randomUUID(), sourceInstanceId: randomUUID(),
    sourceSequence: 1, recordVersion: 1, phase: 'started', requestId: randomUUID(),
    spanKind: 'gateway_request', serverType: 'gateway', transport: 'gateway',
    protocolTransport: 'http', origin: 'external', identitySource: 'authenticated',
    callerId: 'persistent-subject', credentialId: 'credential-reference',
    peerIp: '127.0.0.1', runtimeAssetId: '00000000-0000-4000-8000-000000000002',
    startedAt: new Date(Date.now() - 120000).toISOString() };
}
function terminal(start) {
  return { ...start, eventId: randomUUID(), sourceSequence: 2, recordVersion: 2, phase: 'finished',
    completedAt: new Date().toISOString(), outcome: 'success', statusCode: 200,
    response: { state: 'complete', encoding: 'utf8', contentType: 'text/plain',
      data: 'persisted-response', totalBytes: 18, capturedBytes: 18, redacted: true } };
}

async function childMain() {
  const directory = ownedDirectory(process.argv[3]);
  const action = process.argv[4];
  if (!['collect', 'age', 'collect-and-wait'].includes(action)) throw new Error('Invalid fixture action');
  process.env.API_NOVA_AUDIT_DIR = path.join(directory, 'source');
  process.env.API_NOVA_OBSERVABILITY_DATA_DIR = path.join(directory, 'data');
  const database = new DataSource({ type: 'sqljs', location: path.join(directory, 'observability.sqlite'),
    autoSave: true, entities: [...entities.CALL_OBSERVABILITY_ENTITIES, Event],
    synchronize: true, logging: false });
  await database.initialize();
  const payloads = new CallObservabilityPayloadStore();
  const store = new CallObservabilityStore(database, payloads);
  const collector = new CallObservabilityCollector(store);
  const config = new ConfigService({ API_NOVA_OBSERVABILITY_SOURCE_ID_SECRET: 'restart-fixture-'.repeat(4),
    API_NOVA_OBSERVABILITY_SOURCE_ID_KEY_ID: 'restart-v1' });
  const callers = new CallObservabilityCallersProjector(config);
  const worker = new CallObservabilityWorker(collector, callers, store, config);
  let report = null;
  if (action === 'age') {
    // A deterministic observation-clock fixture, not a claim that 45 seconds elapsed in real time.
    await store.transaction(tx => tx.manager.getRepository(entities.RuntimeInvocationEntity)
      .createQueryBuilder().update().set({ ingestedAt: new Date(Date.now() - 60000).toISOString() })
      .where('phase <> :phase', { phase: 'finished' }).execute());
  } else {
    for (let i = 0; i < 100; i++) {
      report = await worker.runOnce();
      if (report.scanComplete) break;
    }
    if (!report?.scanComplete) throw new Error('Fixture scan did not converge');
  }
  const calls = await database.getRepository(entities.RuntimeInvocationEntity).find();
  const events = await database.getRepository(Event).find();
  const checkpoints = await database.getRepository(entities.RuntimeIngestCheckpointEntity).find();
  const dataset = await collector.initialize();
  const responseBodies = [];
  for (const call of calls) {
    const body = await database.getRepository(entities.RuntimePayloadEntity).findOneBy({ id: call.responsePayloadId });
    if (body?.state === 'captured') responseBodies.push((await payloads.read(body)).data);
  }
  const summary = { pid: process.pid, dataset, watermark: await store.watermark(), report,
    calls: calls.map(row => ({ id: row.invocationId, phase: row.phase, outcome: row.outcome,
      recordVersion: row.recordVersion, sourceRecordVersion: row.sourceRecordVersion,
      completedAt: row.completedAt, completionSource: row.record.completionSource })),
    callers: await database.getRepository(entities.RuntimeCallerEntity).count(),
    receipts: await database.getRepository(entities.RuntimeIngestReceiptEntity).count(),
    events: events.map(row => ({ id: row.id, subjectId: row.subjectId, state: row.dispatchState })),
    checkpoints: checkpoints.map(row => ({ id: row.id, byteOffset: BigInt(row.byteOffset).toString() })),
    responseBodies };
  // Await SQL.js file publication before the parent is allowed to kill this process.
  await database.driver.save();
  await new Promise((resolve, reject) => process.send({ type: 'result', summary }, error => error ? reject(error) : resolve()));
  if (action === 'collect-and-wait') {
    setInterval(() => {}, 1000);
    return;
  }
  await worker.onModuleDestroy();
  collector.onModuleDestroy();
  await payloads.onModuleDestroy();
  await database.destroy();
  process.disconnect();
}

async function fixture(t) {
  await fs.mkdir(temporaryRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'run-'));
  const source = path.join(directory, 'source');
  await fs.mkdir(source);
  const children = new Set();
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('close', resolve));
        child.kill('SIGKILL');
        await exited;
      }
    }
    await fs.rm(ownedDirectory(directory), { recursive: true, force: true });
  });
  const run = action => new Promise((resolve, reject) => {
    const child = fork(__filename, ['--collector-child', directory, action], {
      execArgv: [], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    let summary = null, forced = false, stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Persistent collector child timed out'));
    }, 20000);
    child.stdout.on('data', () => {});
    child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-8000); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.on('message', message => {
      if (message?.type !== 'result') return;
      summary = message.summary;
      if (action === 'collect-and-wait') {
        forced = child.kill('SIGKILL');
        if (!forced) reject(new Error('Could not terminate the owned collector child'));
      }
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout);
      children.delete(child);
      if (!summary || !forced && exitCode !== 0) {
        reject(new Error('Persistent collector failed: ' + exitCode + ' ' + signal + ' ' + stderr));
      } else resolve({ ...summary, forced, signal, exitCode });
    });
  });
  return { directory, source, file: path.join(source, 'calls-v2-persistent.jsonl'), run };
}

if (process.argv[2] === '--collector-child') {
  childMain().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exit(1); });
} else {
  test('independent collector processes reopen durable checkpoints, payloads and dataset boundaries', async t => {
    const f = await fixture(t);
    const start = startRecord();
    const end = encode(terminal(start));
    const initial = encode(start);
    await fs.writeFile(f.file, initial + end.slice(0, 91));
    const first = await f.run('collect');
    assert.equal(first.calls.length, 1);
    assert.equal(first.calls[0].phase, 'started');
    assert.equal(first.checkpoints[0].byteOffset, String(Buffer.byteLength(initial)));
    assert.equal(first.events.length, 0);
    await fs.appendFile(f.file, end.slice(91));
    const second = await f.run('collect');
    assert.notEqual(second.pid, first.pid);
    assert.deepEqual(second.dataset, first.dataset);
    assert.equal(second.calls[0].phase, 'finished');
    assert.equal(second.calls[0].recordVersion, 2);
    assert.deepEqual(second.responseBodies, ['persisted-response']);
    assert.equal(second.callers, 1);
    assert.equal(second.receipts, 2);
    await fs.appendFile(f.file, end);
    const replay = await f.run('collect');
    assert.equal(replay.watermark, second.watermark);
    assert.equal(replay.receipts, 2);
    assert.deepEqual(replay.events, second.events);
    assert.equal(replay.checkpoints[0].byteOffset, String(Buffer.byteLength(initial + end + end)));
  });

  test('forced collector termination preserves committed evidence and late terminal correction across restarts', async t => {
    const f = await fixture(t);
    const start = startRecord();
    await fs.writeFile(f.file, encode(start));
    const killed = await f.run('collect-and-wait');
    assert.equal(killed.forced, true);
    assert.equal(killed.calls[0].recordVersion, 1);
    const aged = await f.run('age');
    assert.deepEqual(aged.dataset, killed.dataset);
    const recovered = await f.run('collect');
    assert.equal(recovered.report.reconciledInvocations, 1);
    assert.equal(recovered.calls[0].outcome, 'unknown');
    assert.equal(recovered.calls[0].completedAt, null);
    assert.equal(recovered.calls[0].recordVersion, 2);
    assert.equal(recovered.calls[0].sourceRecordVersion, 1);
    const end = encode(terminal(start));
    await fs.appendFile(f.file, end + end);
    const corrected = await f.run('collect');
    assert.equal(corrected.calls.length, 1);
    assert.equal(corrected.calls[0].outcome, 'success');
    assert.equal(corrected.calls[0].completionSource, 'observed');
    assert.equal(corrected.calls[0].recordVersion, 3);
    assert.equal(corrected.callers, 1);
    assert.equal(corrected.receipts, 2);
    assert.equal(corrected.events.length, 2);
  });

  test('renamed source and replacement source recover independently after a process restart', async t => {
    const f = await fixture(t);
    const original = terminal(startRecord());
    await fs.writeFile(f.file, encode(original));
    const first = await f.run('collect');
    await fs.rename(f.file, path.join(f.source, 'calls-v2-rotated.jsonl'));
    const next = terminal(startRecord());
    await fs.writeFile(f.file, encode(original) + encode(next));
    const restarted = await f.run('collect');
    assert.equal(restarted.calls.length, 2);
    assert.equal(restarted.receipts, 2);
    assert.equal(restarted.events.length, 2);
    assert.equal(restarted.checkpoints.length, 2);
    assert.ok(restarted.checkpoints.some(row => row.id === first.checkpoints[0].id));
    assert.deepEqual(restarted.dataset, first.dataset);
  });
}
