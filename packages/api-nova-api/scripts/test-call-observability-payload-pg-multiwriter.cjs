'use strict';
// OBS-14-05C3: real independent Node writers against a newly initialized local
// PostgreSQL cluster. Never reads DATABASE_URL/PGHOST or connects to an existing DB.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { fork, spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
process.env.DB_TYPE = 'postgres';
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, project: path.resolve(__dirname, '../tsconfig.json') });
const { DataSource } = require('typeorm');
const entities = require('../src/database/entities/runtime-call-observability.entity.ts');
const { RuntimeObservabilityEventEntity } = require('../src/database/entities/runtime-observability-event.entity.ts');
const { CallObservabilityStore } = require('../src/modules/call-observability/call-observability.store.ts');
const { PayloadQuotaPrimitives } = require('../src/modules/call-observability/call-observability-payload-quota.ts');
const { PAYLOAD_OWNER_ID } = require('../src/modules/call-observability/call-observability-payload.coordinator.ts');
const { CallObservabilityPayloadStore } = require('../src/modules/call-observability/call-observability-payload.store.ts');
const sqlEntities = [...entities.CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity];
const connection = (port, schema) => ({ type: 'postgres', host: '127.0.0.1', port,
  username: 'quota_fixture', password: '', database: 'postgres', schema,
  entities: sqlEntities, synchronize: false, ssl: false,
  extra: { max: 1, connectionTimeoutMillis: 10000, statement_timeout: 20000 } });

async function worker(config) {
  const db = await new DataSource(connection(config.port, config.schema)).initialize();
  if (config.directory) {
    process.env.API_NOVA_OBSERVABILITY_DATA_DIR = config.directory;
    process.env.API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_ENABLED = 'true';
  }
  const objects = config.directory ? new CallObservabilityPayloadStore() : null;
  const store = new CallObservabilityStore(db, objects || {}), quota = new PayloadQuotaPrimitives();
  process.send({ phase: 'ready', pid: process.pid });
  await new Promise(resolve => process.once('message', resolve));
  try {
    if (config.directory) {
      const suspend = async phase => { process.send({ phase, pid: process.pid }); await new Promise(() => {}); };
      if (config.mode === 'kill_published') {
        const link = fs.link;
        fs.link = async (...args) => {
          const result = await link(...args);
          assert.ok(path.resolve(args[1]).startsWith(path.resolve(config.directory) + path.sep));
          await suspend('published'); return result;
        };
      } else if (config.mode === 'kill_writing') {
        const open = fs.open;
        fs.open = async (...args) => {
          const handle = await open(...args);
          if (String(args[0]).endsWith('.tmp') && args[1] === 'wx') {
            handle.writeFile = async value => {
              await handle.write(Buffer.from(value).subarray(0, 5)); await handle.sync(); await suspend('writing');
            };
          }
          return handle;
        };
      } else if (config.mode === 'kill_cleaned') {
        const unlink = fs.unlink;
        fs.unlink = async target => {
          const result = await unlink(target);
          if (String(target).endsWith('.tmp')) await suspend('cleaned');
          return result;
        };
      }
      // Projection hook runs inside the real metadata transaction, after receipt
      // and payload inserts but before commit. Killing here tests PG rollback.
      const result = await store.ingest(config.record, {}, config.mode === 'kill_metadata'
        ? async () => suspend('metadata') : undefined);
      if (config.mode !== 'ingest') throw new Error('Expected interruption window was not reached');
      process.send({ phase: 'result', ok: true, result, pid: process.pid });
      return;
    }
    const result = await store.transaction(async tx => {
      const reserved = await quota.reserve(tx, config.epoch, config.operation, config.bytes);
      if (config.mode === 'kill_uncommitted') {
        process.send({ phase: 'uncommitted', pid: process.pid });
        await new Promise(() => {});
      }
      return reserved;
    });
    process.send({ phase: 'result', ok: true, result, pid: process.pid });
    if (config.mode === 'kill_committed') await new Promise(() => {});
  } catch (error) {
    process.send({ phase: 'result', ok: false, code: error.code, message: error.message, pid: process.pid });
  } finally { if (objects) await objects.onModuleDestroy(); await db.destroy(); if (process.connected) process.disconnect(); }
  if (process.connected) process.disconnect();
}

if (process.argv[2] === '--worker') {
  worker(JSON.parse(process.argv[3])).catch(error => {
    process.send?.({ phase: 'fatal', message: error.stack }); process.exitCode = 1; process.disconnect?.();
  });
} else {
  const { test, before, after } = require('node:test');
  const root = path.resolve(__dirname, '../../../tmp/observability-pg-multiwriter-tests');
  let directory, data, port, started = false;
  const live = new Set();
  const pgTool = name => process.env.API_NOVA_TEST_PG_BIN
    ? path.join(process.env.API_NOVA_TEST_PG_BIN, name + (process.platform === 'win32' ? '.exe' : '')) : name;
  const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG|^DATABASE_URL$/i.test(key)));
  const run = (name, args) => new Promise((resolve, reject) => {
    // PostgreSQL descendants on Windows may inherit pipe handles. Await the
    // launcher exit, with no inherited pipe to keep execFile's close pending.
    const child = spawn(pgTool(name), args, { windowsHide: true, env: safeEnv, stdio: 'ignore' });
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`${name} timed out`)); }, 45000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(Object.assign(new Error(`${name} exited ${code}`), { code })); });
  });
  async function start() {
    await run('pg_ctl', ['-D', data, '-l', path.join(directory, 'postgres.log'), '-w', '-t', '30', 'start']); started = true;
  }
  async function stop() {
    if (!data) return;
    if (!started) {
      try { await run('pg_ctl', ['-D', data, 'status']); started = true; }
      catch (error) { if (error.code === 3 || error.code === 4) return; throw error; }
    }
    await run('pg_ctl', ['-D', data, '-w', '-t', '30', '-m', 'fast', 'stop']); started = false;
  }
  before(async () => {
    await run('initdb', ['--version']);
    await fs.mkdir(root, { recursive: true }); directory = await fs.mkdtemp(path.join(root, 'run-')); data = path.join(directory, 'pgdata');
    await run('initdb', ['-D', data, '-U', 'quota_fixture', '--auth=trust', '--no-locale', '--encoding=UTF8']);
    port = await new Promise((resolve, reject) => {
      const server = net.createServer(); server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { const selected = server.address().port; server.close(error => error ? reject(error) : resolve(selected)); });
    });
    await fs.appendFile(path.join(data, 'postgresql.conf'), `\nlisten_addresses = '127.0.0.1'\nport = ${port}\nmax_connections = 16\nfsync = on\nsynchronous_commit = on\n`);
    // Replace initdb's permissive defaults: only this newly created fixture user
    // may connect on IPv4 loopback. No external hosts or inherited credentials.
    await fs.writeFile(path.join(data, 'pg_hba.conf'), 'host all quota_fixture 127.0.0.1/32 trust\nlocal all quota_fixture trust\n');
    await start();
  });
  after(async () => {
    for (const child of live) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
    await stop();
    if (directory) {
      const target = path.resolve(directory);
      assert.equal(path.dirname(target), root); assert.ok(path.basename(target).startsWith('run-'));
      await fs.rm(target, { recursive: true, force: true });
    }
  });
  async function fixture(t) {
    const schema = 'quota_' + randomUUID().replaceAll('-', '');
    const admin = await new DataSource(connection(port, 'public')).initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`); await admin.destroy();
    let db = await new DataSource(connection(port, schema)).initialize(); await db.synchronize();
    let store = new CallObservabilityStore(db, {}); const quota = new PayloadQuotaPrimitives();
    await store.transaction(tx => tx.manager.getRepository(entities.RuntimePipelineStateEntity)
      .insert({ id: PAYLOAD_OWNER_ID, value: { ownerId: randomUUID() }, updatedAt: tx.now }));
    const initial = await store.transaction(tx => quota.initialize(tx, { enabled: true, quotaBytes: 1000, maxBodyBytes: 500 }));
    await store.transaction(tx => quota.confirmBaseline(tx, initial.epoch,
      { kind: 'complete_inventory', evidenceId: 'empty-isolated-pg-fixture', committedBytes: 0 }));
    t.after(async () => { if (db.isInitialized) await db.destroy(); });
    return { schema, epoch: initial.epoch, get db() { return db; },
      status: () => store.readSnapshot(tx => quota.status(tx)),
      reserve: (operation, bytes) => store.transaction(tx => quota.reserve(tx, initial.epoch, operation, bytes)),
      async restart() {
        await db.destroy(); await stop(); await start();
        db = await new DataSource(connection(port, schema)).initialize(); store = new CallObservabilityStore(db, {});
      },
    };
  }
  function launch(f, operation, bytes, mode = 'reserve', extra = {}) {
    const child = fork(__filename, ['--worker', JSON.stringify({ port, schema: f.schema, epoch: f.epoch, operation, bytes, mode, ...extra })],
      { windowsHide: true, env: safeEnv, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    live.add(child); let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    const messages = [], waiting = [];
    child.on('message', message => {
      messages.push(message);
      for (const pending of [...waiting]) if (pending.phase === message.phase || message.phase === 'fatal') {
        waiting.splice(waiting.indexOf(pending), 1); clearTimeout(pending.timer);
        message.phase === 'fatal' ? pending.reject(new Error(message.message)) : pending.resolve(message);
      }
    });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => {
      live.delete(child); resolve({ code, signal });
      for (const pending of waiting.splice(0)) { clearTimeout(pending.timer); pending.reject(new Error(`Worker exited ${code}/${signal}: ${stderr}`)); }
    }));
    function wait(phase) {
      const previous = messages.find(message => message.phase === phase); if (previous) return Promise.resolve(previous);
      return new Promise((resolve, reject) => {
        const pending = { phase, resolve, reject, timer: setTimeout(() => reject(new Error(`Worker ${phase} timeout: ${stderr}`)), 30000) }; waiting.push(pending);
      });
    }
    return { child, wait, exited, async kill() { child.kill('SIGKILL'); await exited; } };
  }
  async function race(f, operations, bytes) {
    const workers = operations.map(operation => launch(f, operation, bytes));
    const ready = await Promise.all(workers.map(worker => worker.wait('ready')));
    assert.equal(new Set(ready.map(message => message.pid)).size, workers.length);
    workers.forEach(worker => worker.child.send('go'));
    const results = await Promise.all(workers.map(worker => worker.wait('result')));
    for (const worker of workers) assert.equal((await worker.exited).code, 0);
    return results;
  }
  test('four independent PostgreSQL writers cannot oversell the shared hard budget', { timeout: 90000 }, async t => {
    const f = await fixture(t), results = await race(f, ['one', 'two', 'three', 'four'], 600);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.ok(results.filter(result => !result.ok).every(result => result.code === 'QUOTA_EXHAUSTED'));
    const before = await f.status(); assert.equal(before.reservedBytes, 600); assert.equal(before.committedBytes, 0);
    assert.equal(before.quotaEnforced, false);
    assert.equal(await f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity).count(), 1);
    await f.restart(); assert.deepEqual(await f.status(), before);
  });
  test('same operation races across processes charge exactly once, including after PostgreSQL restart', { timeout: 90000 }, async t => {
    const f = await fixture(t), results = await race(f, ['same', 'same', 'same', 'same'], 600);
    assert.ok(results.every(result => result.ok)); assert.equal(results.filter(result => !result.result.replayed).length, 1);
    assert.equal(await f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity).count(), 1);
    await f.restart(); assert.equal((await f.reserve('same', 600)).replayed, true); assert.equal((await f.status()).reservedBytes, 600);
  });
  test('killing a writer after durable reservation preserves the hold across PostgreSQL restart', { timeout: 90000 }, async t => {
    const f = await fixture(t), writer = launch(f, 'killed-committed', 600, 'kill_committed');
    await writer.wait('ready'); writer.child.send('go'); assert.equal((await writer.wait('result')).ok, true); await writer.kill();
    await f.restart(); assert.equal((await f.status()).reservedBytes, 600);
    assert.equal((await f.reserve('killed-committed', 600)).replayed, true);
    await assert.rejects(f.reserve('new-writer', 600), error => error.code === 'QUOTA_EXHAUSTED');
  });
  test('killing a writer inside the reservation transaction rolls back ledger and reservation together', { timeout: 90000 }, async t => {
    const f = await fixture(t), writer = launch(f, 'killed-uncommitted', 600, 'kill_uncommitted');
    await writer.wait('ready'); writer.child.send('go'); await writer.wait('uncommitted'); await writer.kill();
    await f.restart(); assert.equal((await f.status()).reservedBytes, 0);
    assert.equal(await f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity).count(), 0);
    assert.equal((await f.reserve('replacement', 600)).replayed, false); assert.equal((await f.status()).reservedBytes, 600);
  });
  async function payloadFixture(t) {
    const f = await fixture(t), payloadRoot = path.join(directory, 'payload-' + randomUUID());
    const previous = process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
    process.env.API_NOVA_OBSERVABILITY_DATA_DIR = payloadRoot;
    let objects;
    try { objects = new CallObservabilityPayloadStore(); }
    finally {
      if (previous === undefined) delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
      else process.env.API_NOVA_OBSERVABILITY_DATA_DIR = previous;
    }
    t.after(() => objects.onModuleDestroy());
    await new CallObservabilityStore(f.db, objects).ensurePayloadStorage();
    return { f, payloadRoot };
  }
  function evidence(data = '1234567890') {
    const invocationId = randomUUID(), bytes = Buffer.byteLength(data);
    return { schemaVersion: 2, invocationId, eventId: randomUUID(), sourceInstanceId: randomUUID(),
      sourceSequence: 1, recordVersion: 1, phase: 'finished', requestId: randomUUID(), traceId: invocationId,
      rootInvocationId: invocationId, runtimeAssetId: randomUUID(), kind: 'admission', spanKind: 'gateway_request',
      serverType: 'gateway', transport: 'gateway', protocolTransport: 'http', origin: 'external', identitySource: 'anonymous',
      outcome: 'success', statusCode: 200, startedAt: new Date(Date.now() - 1000).toISOString(), completedAt: new Date().toISOString(),
      request: { state: 'captured', reason: null, data, contentType: 'text/plain', encoding: 'utf8', observedBytes: bytes,
        capturedBytes: bytes, storedBytes: bytes, capturedDigest: createHash('sha256').update(data).digest('hex'),
        digestScope: 'observed_raw', redacted: true, redactionPolicyVersion: 'default-v1' },
      response: { state: 'unavailable', reason: 'not_captured' } };
  }
  for (const [phase, temporaryBytes, finalBytes, reserved, committed] of [
    ['published', 10, 10, 20, 0], ['writing', 5, null, 20, 0],
    ['cleaned', null, 10, 20, 0], ['metadata', null, 10, 0, 10],
  ]) {
    test(`real ingest killed during ${phase} conserves file occupancy and rolls back incomplete metadata after PG restart`, { timeout: 90000 }, async t => {
      const { f, payloadRoot } = await payloadFixture(t), record = evidence();
      const writer = launch(f, 'ingest', 20, 'kill_' + phase, { directory: payloadRoot, record });
      await writer.wait('ready'); writer.child.send('go'); await writer.wait(phase); await writer.kill();
      await f.restart();
      const status = await f.status(); assert.equal(status.reservedBytes, reserved); assert.equal(status.committedBytes, committed);
      assert.equal(status.quotaEnforced, false);
      const intents = await f.db.getRepository(entities.RuntimePayloadPublicationIntentEntity).find();
      assert.equal(intents.length, 1); const intent = intents[0]; assert.equal(intent.sourceEventId, record.eventId);
      for (const [key, expectedBytes] of [[intent.temporaryKey, temporaryBytes], [intent.fileKey, finalBytes]]) {
        const target = path.join(payloadRoot, 'payloads', key);
        if (expectedBytes === null) { await assert.rejects(fs.stat(target), error => error.code === 'ENOENT'); continue; }
        const bytes = await fs.readFile(target); assert.equal(bytes.length, expectedBytes);
        assert.equal(bytes.toString(), record.request.data.slice(0, expectedBytes));
        if (expectedBytes === 10) assert.equal(createHash('sha256').update(bytes).digest('hex'), record.request.capturedDigest);
      }
      assert.equal(await f.db.getRepository(entities.RuntimeInvocationEntity).count(), 0);
      assert.equal(await f.db.getRepository(entities.RuntimeIngestReceiptEntity).count(), 0);
      assert.equal(await f.db.getRepository(entities.RuntimePayloadEntity).count(), 0);
      const reservations = await f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity).find();
      assert.equal(reservations.length, 1); assert.equal(reservations[0].state, committed ? 'settled' : 'reserved');
      await assert.rejects(f.reserve('oversell-residue', 1000), error => error.code === 'QUOTA_EXHAUSTED');
    });
  }
  test('four actual ingest processes share files and PostgreSQL budget without overselling or losing business metadata', { timeout: 90000 }, async t => {
    const { f, payloadRoot } = await payloadFixture(t);
    const records = Array.from({ length: 4 }, (_, index) => evidence(String(index).repeat(300)));
    const writers = records.map(record => launch(f, 'ingest', 600, 'ingest', { directory: payloadRoot, record }));
    const ready = await Promise.all(writers.map(writer => writer.wait('ready')));
    assert.equal(new Set(ready.map(message => message.pid)).size, 4);
    writers.forEach(writer => writer.child.send('go'));
    const results = await Promise.all(writers.map(writer => writer.wait('result')));
    assert.ok(results.every(result => result.ok), JSON.stringify(results));
    for (const writer of writers) assert.equal((await writer.exited).code, 0);
    await f.restart();
    assert.equal(await f.db.getRepository(entities.RuntimeIngestReceiptEntity).count(), 4);
    const invocations = await f.db.getRepository(entities.RuntimeInvocationEntity).find(); assert.equal(invocations.length, 4);
    const accepted = [];
    for (const invocation of invocations) {
      assert.equal(invocation.record.outcome, 'success'); assert.equal(invocation.record.httpStatus, 200);
      const payload = await f.db.getRepository(entities.RuntimePayloadEntity).findOneByOrFail({ id: invocation.requestPayloadId });
      if (payload.state === 'captured') {
        accepted.push(invocation.invocationId);
        const bytes = await fs.readFile(path.join(payloadRoot, 'payloads', payload.fileKey)); assert.equal(bytes.length, 300);
        const record = records.find(record => record.invocationId === invocation.invocationId);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), record.request.capturedDigest);
      } else assert.equal(payload.reason, 'quota_exhausted');
    }
    assert.ok(accepted.length >= 1 && accepted.length <= 2);
    const before = await f.status(); assert.equal(before.reservedBytes, 0); assert.equal(before.committedBytes, accepted.length * 300);
    assert.ok(before.budgetedBytes <= 1000);
    const intents = await f.db.getRepository(entities.RuntimePayloadPublicationIntentEntity).find(); assert.equal(intents.length, accepted.length);
    for (const intent of intents) await assert.rejects(fs.stat(path.join(payloadRoot, 'payloads', intent.temporaryKey)), error => error.code === 'ENOENT');
    // Reconstruct independent writers after restart and replay successful events:
    // exact existing objects and receipts must prevent a second charge.
    const retries = records.filter(record => accepted.includes(record.invocationId)).map(record =>
      launch(f, 'retry', 600, 'ingest', { directory: payloadRoot, record }));
    await Promise.all(retries.map(writer => writer.wait('ready'))); retries.forEach(writer => writer.child.send('go'));
    assert.ok((await Promise.all(retries.map(writer => writer.wait('result')))).every(result => result.ok));
    for (const writer of retries) assert.equal((await writer.exited).code, 0);
    assert.deepEqual(await f.status(), before);
    assert.equal(await f.db.getRepository(entities.RuntimeIngestReceiptEntity).count(), 4);
  });
}
