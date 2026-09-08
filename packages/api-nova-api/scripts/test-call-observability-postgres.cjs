'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { fork } = require('node:child_process');
const { DataSource } = require('typeorm');
const { Client } = require('pg');

const isWorker = process.argv[2] === 'worker';
const workspace = path.resolve(__dirname, '../../..');
const databaseName = isWorker ? process.env.OBSERVABILITY_TEST_DATABASE :
  'api_nova_obs_verify_' + process.pid + '_' + Date.now();
const directory = isWorker ? process.env.OBSERVABILITY_TEST_DIRECTORY :
  path.join(workspace, 'tmp', databaseName);
if (!/^api_nova_obs_verify_[0-9]+_[0-9]+$/.test(databaseName || '') ||
  path.dirname(path.resolve(directory || '')) !== path.join(workspace, 'tmp') ||
  path.basename(directory) !== databaseName) throw new Error('Unsafe isolated PostgreSQL target');
process.env.DB_TYPE = 'postgres';
process.env.DB_DATABASE = databaseName;
process.env.API_NOVA_OBSERVABILITY_DATA_DIR = directory;
const base = '../dist/src/modules/call-observability/';
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let options, db, objects, store, gc, entities, EventEntity;
let created = false;
const children = [];
const warnings = [];
const quote = value => '"' + String(value).replace(/"/g, '""') + '"';

function safeError(error) {
  let text = String(error?.stack || error);
  for (const [key, value] of Object.entries(process.env)) {
    if (/PASSWORD|SECRET|TOKEN|API_KEY/.test(key) && value) text = text.split(value).join('[REDACTED]');
  }
  return text;
}
async function configure() {
  await require('../dist/src/config/environment.js').applicationConfigModule;
  options = {
    ...require('../dist/src/database/database-options.js').buildDatabaseOptions(),
    type: 'postgres', database: databaseName, synchronize: false, logging: false,
    extra: { connectionTimeoutMillis: 5000, max: 4 },
  };
  entities = require('../dist/src/database/entities/runtime-call-observability.entity.js');
  EventEntity = require('../dist/src/database/entities/runtime-observability-event.entity.js').RuntimeObservabilityEventEntity;
}
async function connect() {
  db = new DataSource(options);
  await db.initialize();
  const { CallObservabilityStore } = require(base + 'call-observability.store.js');
  const { CallObservabilityPayloadStore } = require(base + 'call-observability-payload.store.js');
  const { CallObservabilityGarbageService } = require(base + 'call-observability-garbage.service.js');
  objects = new CallObservabilityPayloadStore();
  store = new CallObservabilityStore(db, objects);
  gc = new CallObservabilityGarbageService(store, objects);
}
async function admin(sql, parameters = []) {
  const client = new Client({
    host: options.host, port: options.port, user: options.username, password: options.password,
    database: process.env.DB_ADMIN_DATABASE || 'postgres', ssl: options.ssl, connectionTimeoutMillis: 5000,
  });
  try { await client.connect(); return await client.query(sql, parameters); }
  finally { await client.end(); }
}
function body(data = '{"ok":true}') {
  return {
    state: 'captured', reason: null, contentType: 'application/json', encoding: 'utf8',
    observedBytes: Buffer.byteLength(data), capturedBytes: Buffer.byteLength(data), storedBytes: Buffer.byteLength(data),
    data, capturedDigest: createHash('sha256').update(data).digest('hex'), digestScope: 'observed_raw',
    redacted: true, redactionPolicyVersion: 'default-v1',
  };
}
function evidence() {
  const id = randomUUID();
  return {
    schemaVersion: 2, invocationId: id, eventId: randomUUID(), sourceInstanceId: randomUUID(),
    sourceSequence: 1, recordVersion: 1, phase: 'finished', kind: 'admission',
    spanKind: 'gateway_request', serverType: 'gateway', transport: 'gateway', protocolTransport: 'http',
    requestId: randomUUID(), traceId: id, rootInvocationId: id, runtimeAssetId: randomUUID(),
    origin: 'external', identitySource: 'anonymous', outcome: 'success', statusCode: 200,
    startedAt: new Date(Date.now() - 1000).toISOString(), completedAt: new Date().toISOString(),
    request: body(), response: { state: 'unavailable', reason: 'not_captured' },
  };
}

async function worker() {
  await configure();
  await connect();
  const gates = new Map();
  const send = message => { if (process.connected) process.send(message); };
  process.on('message', message => {
    if (message.op === 'release') { gates.get(message.id)?.resolve(); return; }
    const signal = (name, value) => send({ kind: 'signal', id: message.id, name, value });
    const run = async () => {
      if (message.op === 'reserve') {
        const gate = deferred();
        gates.set(message.id, gate);
        signal('attempting');
        try {
          return await store.transaction(async tx => {
            const sequence = String(BigInt(tx.nextSequence()));
            signal('reserved', sequence);
            await gate.promise;
            if (message.rollback) throw new Error('fixture-rollback');
            return { sequence };
          });
        } catch (error) {
          if (message.rollback && error.message === 'fixture-rollback') return { rolledBack: true };
          throw error;
        } finally { gates.delete(message.id); }
      }
      if (message.op === 'batch') {
        const results = [];
        for (let i = 0; i < message.count; i++) results.push(await store.ingest(evidence()));
        return results.map(result => ({ sequence: result.snapshotSeq, eventId: result.events[0].eventId }));
      }
      if (message.op === 'paused-body') {
        const gate = deferred();
        gates.set(message.id, gate);
        const publish = objects.publish.bind(objects);
        objects.publish = async (...args) => {
          signal('preparing');
          await gate.promise;
          return publish(...args);
        };
        try { return await store.ingest(evidence()); }
        finally { objects.publish = publish; gates.delete(message.id); }
      }
      if (message.op === 'shutdown') {
        await objects.closeScanner();
        await db.destroy();
        return { stopped: true };
      }
      throw new Error('Unknown test operation');
    };
    run().then(value => {
      if (message.op === 'shutdown') {
        process.send({ kind: 'result', id: message.id, value }, () => process.disconnect());
      } else send({ kind: 'result', id: message.id, value });
    }).catch(error => send({ kind: 'failure', id: message.id, error: safeError(error) }));
  });
  send({ kind: 'ready' });
}

async function startWorker() {
  const ready = deferred();
  const exited = deferred();
  const pending = new Map();
  let output = '';
  const child = fork(__filename, ['worker'], {
    cwd: workspace, windowsHide: true,
    env: { ...process.env, OBSERVABILITY_TEST_DATABASE: databaseName, OBSERVABILITY_TEST_DIRECTORY: directory },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const wrapper = {
    child, exited: exited.promise,
    request(op, fields = {}) {
      const id = randomUUID();
      const result = deferred();
      const signals = new Map();
      const history = new Map();
      let settled = false;
      result.promise.catch(() => undefined);
      const timer = setTimeout(() => result.reject(new Error('Worker operation timeout: ' + op)), 20000);
      const finish = () => { settled = true; clearTimeout(timer); pending.delete(id); };
      const promise = result.promise.finally(finish);
      promise.catch(() => undefined);
      const entry = { result, signals, history };
      pending.set(id, entry);
      child.send({ id, op, ...fields });
      return {
        id, promise, get settled() { return settled; },
        signal(name) {
          if (history.has(name)) return Promise.resolve(history.get(name));
          const signal = signals.get(name) || deferred();
          signals.set(name, signal);
          return Promise.race([signal.promise, promise.then(() => { throw new Error('Missing worker signal: ' + name); })]);
        },
        release() { child.send({ id, op: 'release' }); },
      };
    },
  };
  children.push(wrapper);
  const capture = chunk => { output = (output + chunk.toString()).slice(-10000); };
  child.stdout.on('data', capture);
  child.stderr.on('data', chunk => {
    capture(chunk);
    if (chunk.toString().includes('DeprecationWarning')) warnings.push(chunk.toString().slice(0,500));
  });
  child.on('message', message => {
    if (message.kind === 'ready') { ready.resolve(wrapper); return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    if (message.kind === 'signal') {
      entry.history.set(message.name, message.value);
      entry.signals.get(message.name)?.resolve(message.value);
    } else if (message.kind === 'result') entry.result.resolve(message.value);
    else if (message.kind === 'failure') entry.result.reject(new Error(message.error));
  });
  child.on('error', error => ready.reject(error));
  child.on('exit', code => {
    const error = new Error('Test worker exited: ' + code + ' ' + safeError(output));
    ready.reject(error);
    for (const entry of pending.values()) entry.result.reject(error);
    exited.resolve(code);
  });
  const timeout = setTimeout(() => ready.reject(new Error('Test worker startup timeout: ' + safeError(output))), 20000);
  try { return await ready.promise; } finally { clearTimeout(timeout); }
}

async function main() {
  await fs.mkdir(directory, { recursive: true });
  await configure();
  await admin('CREATE DATABASE ' + quote(databaseName));
  created = true;
  await connect();
  const migrations = await db.runMigrations({ transaction: 'all' });
  assert.equal(migrations.length, 1);
  assert.equal((await db.driver.createSchemaBuilder().log()).upQueries.length, 0);

  const workers = await Promise.all(Array.from({ length: 4 }, startWorker));
  const first = workers[0].request('reserve');
  assert.equal(await first.signal('reserved'), '1');
  assert.equal(await store.watermark(), '0', 'Uncommitted reservation must stay invisible');
  const second = workers[1].request('reserve');
  await second.signal('attempting');
  await wait(100);
  assert.equal(second.settled, false, 'A later writer must wait for the first commit');
  first.release();
  assert.equal((await first.promise).sequence, '1');
  assert.equal(await second.signal('reserved'), '2');
  second.release();
  assert.equal((await second.promise).sequence, '2');

  const rolledBack = workers[0].request('reserve', { rollback: true });
  assert.equal(await rolledBack.signal('reserved'), '3');
  const following = workers[1].request('reserve');
  await following.signal('attempting');
  rolledBack.release();
  assert.equal((await rolledBack.promise).rolledBack, true);
  assert.equal(await following.signal('reserved'), '3', 'Rollback must roll back counter allocation');
  following.release();
  assert.equal((await following.promise).sequence, '3');

  const batches = await Promise.all(workers.map(client => client.request('batch', { count: 5 }).promise));
  const sequences = batches.flat().map(item => Number(item.sequence)).sort((a,b) => a-b);
  assert.deepEqual(sequences, Array.from({ length: 20 }, (_, i) => i + 4));
  assert.equal(await db.getRepository(entities.RuntimeInvocationEntity).count(), 20);
  assert.equal(await db.getRepository(EventEntity).count(), 20);
  const committedEvents = await db.getRepository(EventEntity).find({ order: { sequence: 'ASC' } });
  assert.deepEqual(committedEvents.map(event => Number(event.sequence)), sequences);

  const paused = workers[0].request('paused-body');
  await paused.signal('preparing');
  assert.equal((await gc.collect({ graceMs: 60000 })).reason, 'writer_active');
  paused.release();
  await paused.promise;
  assert.equal(await store.watermark(), '24');

  await store.ensurePayloadStorage();
  const orphan = await store.payloadCoordination.withWriter(lease => objects.prepare({
    sourceInstanceId: randomUUID(), invocationId: randomUUID(), side: 'request',
  }, body('orphan'), new Date().toISOString(), new Date(Date.now()+86400000).toISOString(), lease.generation));
  const file = path.join(directory, 'payloads', orphan.entity.fileKey);
  const oldTime = new Date(Date.now()-120000);
  await fs.utimes(file, oldTime, oldTime);
  const collected = await gc.collect({ graceMs: 60000 });
  assert.equal(collected.deleted, 1);
  await assert.rejects(fs.access(file), { code: 'ENOENT' });
  assert.equal(await db.getRepository(entities.RuntimeInvocationEntity).count(), 21);
  assert.equal(await store.watermark(), '24');
  console.log(JSON.stringify({
    marker: 'OBSERVABILITY_POSTGRES_MULTIPROCESS_OK', processes: 4,
    concurrentInvocations: 20, totalInvocations: 21, commitOrdering: true,
    rollbackSequence: true, uncommittedInvisible: true, crossProcessWriterFence: true,
    orphanCollected: true, schemaDrift: 0, nonFatalWarnings: warnings.length,
  }));
}

async function cleanup() {
  for (const client of children) {
    if (client.child.exitCode === null && client.child.connected) {
      await Promise.race([client.request('shutdown').promise.catch(() => undefined), wait(2000)]);
    }
    if (client.child.exitCode === null) client.child.kill('SIGTERM');
    await Promise.race([client.exited, wait(2000)]);
    if (client.child.exitCode === null) client.child.kill('SIGKILL');
  }
  if (objects) await objects.closeScanner();
  if (db?.isInitialized) await db.destroy();
  if (created) {
    // Only this run-created DB is eligible for connection termination or dropping.
    await admin('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [databaseName]);
    await admin('DROP DATABASE ' + quote(databaseName));
    created = false;
  }
  const target = path.resolve(directory);
  if (path.dirname(target) !== path.join(workspace, 'tmp') || path.basename(target) !== databaseName) {
    throw new Error('Unsafe isolated cleanup target');
  }
  await fs.rm(target, { recursive: true, force: true });
}

if (isWorker) {
  worker().catch(error => { console.error(safeError(error)); process.exitCode = 1; process.disconnect(); });
} else {
  main().catch(error => { console.error(safeError(error)); process.exitCode = 1; })
    .finally(() => cleanup().catch(error => { console.error(safeError(error)); process.exitCode = 1; }));
}
