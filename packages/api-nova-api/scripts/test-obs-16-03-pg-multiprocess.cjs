'use strict';
// OBS-16-03 Stage 1: environment-dependent multi-process PostgreSQL execution lane.
//
// Runs the real outbox materializer and the real webhook delivery worker in at least two
// independent Node processes against one PostgreSQL database and a loopback receiver:
//   * shared claim/lease behaviour of the actual PostgreSQL code paths
//     (pessimistic_write + skip_locked; event lease 15 s, delivery lease 30 s),
//   * a worker killed mid-cycle and its lease reclaimed without loss or duplicate delivery,
//   * revision range / revocation / subscription state / event expiry boundaries.
//
// PostgreSQL resolution (no external network, no image pulls):
//   OBS16_PG_MODE=auto (default): isolated local cluster through API_NOVA_TEST_PG_BIN /
//     PATH, else the already-present local postgres:16.14 image with a small named volume.
//   OBS16_PG_MODE=isolated|container|external. external reads OBS16_PG_HOST/PORT/USER/
//     PASSWORD/DATABASE and never starts or removes a cluster.
//
// TAP: node --test --test-reporter=tap scripts/test-obs-16-03-pg-multiprocess.cjs
process.env.DB_TYPE = 'postgres';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn, spawnSync, fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, project: path.resolve(__dirname, '../tsconfig.json') });
const { DataSource } = require('typeorm');
const { Client } = require('pg');
const { ConfigService } = require('@nestjs/config');
const entities = require('../src/database/entities/runtime-call-observability.entity.ts');
const { RuntimeObservabilityEventEntity: Event } =
  require('../src/database/entities/runtime-observability-event.entity.ts');
const { CallObservabilityStore } =
  require('../src/modules/call-observability/call-observability.store.ts');
const { CallObservabilityOutboxService, OUTBOX_WORKER_STATE_ID } =
  require('../src/modules/call-observability/call-observability-outbox.service.ts');
const { CallObservabilityDeliveryWorker } =
  require('../src/modules/call-observability/call-observability-delivery.worker.ts');
const { canonicalJson, contentHash, sequenceKey } =
  require('../src/modules/call-observability/call-observability-storage.ts');

const Subscription = entities.RuntimeEventSubscriptionEntity;
const Revision = entities.RuntimeSubscriptionRevisionEntity;
const Delivery = entities.RuntimeEventDeliveryEntity;
const Attempt = entities.RuntimeEventDeliveryAttemptEntity;
const PipelineState = entities.RuntimePipelineStateEntity;

const SECRET = 'obs16-synthetic-key-'.repeat(4);
const OWNER_ID = 'obs16-owner-' + randomUUID();
const ASSET_A = 'asset-a';
const EVENT_TTL_MS = 14 * 86400000;
const DELIVERY_TTL_MS = 30 * 86400000;
const WORKER_TIMEOUT_MS = 60000;
const TEMP_ROOT = process.env.OBS16_TMP_DIR || path.join(os.tmpdir(), 'obs-16-03-pg-multiprocess');
const pgTool = name => process.env.API_NOVA_TEST_PG_BIN
  ? path.join(process.env.API_NOVA_TEST_PG_BIN, name + (process.platform === 'win32' ? '.exe' : ''))
  : name;
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG|^DATABASE_URL$/i.test(key)));

function connection(config) {
  return {
    type: 'postgres', host: config.host, port: config.port, username: config.user, password: config.password,
    database: config.database, schema: config.schema, ssl: false, synchronize: false,
    entities: [...entities.CALL_OBSERVABILITY_ENTITIES, Event],
    extra: { max: 2, connectionTimeoutMillis: 10000, statement_timeout: 20000 },
  };
}

function fakeUsers(ownerId) {
  const role = {
    enabled: true, type: 'custom', name: 'obs16-worker-fixture',
    permissions: [{ name: 'monitoring:read', enabled: true }, { name: 'monitoring:subscription:manage', enabled: true }],
    metadata: { observabilityScope: { mode: 'assets', runtimeAssetIds: [ASSET_A] } },
  };
  const user = { id: ownerId, isActive: true, isLocked: false, roles: [role] };
  return { async findUserById(id) { if (id !== ownerId) throw new Error('unknown user'); return user; } };
}

// ---------------------------------------------------------------------------
// Worker child process: hosts exactly one real worker against the shared PG.
// ---------------------------------------------------------------------------
async function runWorkerProcess(role, config) {
  const db = await new DataSource(connection(config)).initialize();
  const store = new CallObservabilityStore(db, {});
  const send = message => { if (process.connected) process.send(message); };
  const respond = operation => Promise.resolve()
    .then(operation)
    .then(report => send({ phase: 'result', ok: true, report }))
    .catch(error => send({ phase: 'result', ok: false, code: error?.code ?? null, message: error?.message ?? String(error) }));

  if (role === 'outbox') {
    const outbox = new CallObservabilityOutboxService(store, new ConfigService({}));
    if (config.crashAfterClaim) {
      const transaction = store.transaction.bind(store);
      let first = true;
      store.transaction = async operation => {
        const result = await transaction(operation);
        if (first) {
          first = false;
          send({ phase: 'claimed-before-materialize', leaseHeld: true });
          await new Promise(() => {});
        }
        return result;
      };
    }
    process.on('message', message => {
      if (message?.op === 'run') respond(() => outbox.runOnce(message.limit ?? 8));
    });
  } else if (role === 'delivery') {
    const worker = new CallObservabilityDeliveryWorker(store, new ConfigService({
      API_NOVA_OBSERVABILITY_WEBHOOK_ALLOW_HTTP: 'true',
      API_NOVA_OBSERVABILITY_WEBHOOK_ALLOWED_HOSTS: '127.0.0.1:' + config.receiverPort,
      API_NOVA_OBSERVABILITY_WEBHOOK_ALLOWED_PRIVATE_IPS: '127.0.0.1',
      API_NOVA_OBSERVABILITY_WEBHOOK_SECRET_REFS: 'obs16-key',
      API_NOVA_OBSERVABILITY_WEBHOOK_SECRETS: JSON.stringify({ 'obs16-key': SECRET }),
      API_NOVA_OBSERVABILITY_WEBHOOK_TIMEOUT_MS: '2000',
    }), fakeUsers(config.ownerId));
    process.on('message', message => {
      if (message?.op === 'run') respond(() => worker.runOnce(message.limit ?? 4));
    });
  } else {
    throw new Error('Unknown worker role ' + role);
  }
  process.on('disconnect', () => { db.destroy().catch(() => undefined).finally(() => process.exit(0)); });
  send({ phase: 'ready', pid: process.pid, role });
}

if (process.argv[2] === '--worker') {
  runWorkerProcess(process.argv[3], JSON.parse(process.argv[4])).catch(error => {
    process.send?.({ phase: 'fatal', message: error?.stack || String(error) });
    process.exitCode = 1;
    process.disconnect?.();
  });
} else {
  main();
}

// ---------------------------------------------------------------------------
// Parent: PostgreSQL lifecycle, loopback receiver, fixtures and cases.
// ---------------------------------------------------------------------------
function main() {
  const { test, before, after } = require('node:test');
  let cluster = null;
  let directory = null;
  let containerName = null;
  let volumeName = null;
  let isolatedStarted = false;
  let serverVersion = null;

  const receiver = { server: null, port: 0, requests: [], held: [], waiters: [], holdEnabled: false };

  function notifyReceiverWaiters() {
    for (const waiter of [...receiver.waiters]) {
      if (receiver.requests.filter(waiter.predicate).length >= waiter.count) {
        receiver.waiters.splice(receiver.waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(receiver.requests.filter(waiter.predicate));
      }
    }
  }
  function waitForRequests(predicate, count = 1, timeout = 20000) {
    const matching = receiver.requests.filter(predicate);
    if (matching.length >= count) return Promise.resolve(matching);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, count, resolve, reject, timer: setTimeout(() => {
        receiver.waiters.splice(receiver.waiters.indexOf(waiter), 1);
        reject(new Error(`receiver request timeout (${receiver.requests.length} seen)`));
      }, timeout) };
      receiver.waiters.push(waiter);
    });
  }
  async function startReceiver() {
    receiver.server = http.createServer((request, response) => {
      const chunks = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        const entry = {
          path: request.url, method: request.method,
          deliveryId: request.headers['x-apinova-delivery-id'] || null,
          signed: Boolean(request.headers['x-apinova-signature']),
          body: Buffer.concat(chunks).toString('utf8'), acked: false, held: false,
        };
        receiver.requests.push(entry);
        if (String(request.url).startsWith('/hold') && receiver.holdEnabled) {
          entry.held = true;
          receiver.held.push(response);
          notifyReceiverWaiters();
          return;
        }
        response.statusCode = 202;
        response.end('accepted');
        entry.acked = true;
        notifyReceiverWaiters();
      });
    });
    await new Promise((resolve, reject) => {
      receiver.server.once('error', reject);
      receiver.server.listen(0, '127.0.0.1', resolve);
    });
    receiver.port = receiver.server.address().port;
  }
  async function releaseHeldResponses() {
    receiver.holdEnabled = false;
    for (const response of receiver.held.splice(0)) {
      try { response.destroy(); } catch { /* already closed */ }
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  function docker(args, options = {}) {
    return spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...options });
  }
  function isolatedAvailable() {
    if (process.env.API_NOVA_TEST_PG_BIN) return fsSync.existsSync(pgTool('initdb'));
    const probe = spawnSync('initdb', ['--version'], { encoding: 'utf8', windowsHide: true });
    return probe.status === 0;
  }
  function containerAvailable() {
    const inspect = docker(['image', 'inspect', 'postgres:16.14', '--format', '{{.Id}}']);
    return inspect.status === 0 && String(inspect.stdout || '').trim().length > 0;
  }
  function resolveMode() {
    const requested = String(process.env.OBS16_PG_MODE || 'auto').toLowerCase();
    if (['isolated', 'container', 'external'].includes(requested)) return requested;
    if (requested !== 'auto') throw new Error('Unknown OBS16_PG_MODE: ' + requested);
    if (isolatedAvailable()) return 'isolated';
    if (containerAvailable()) return 'container';
    throw new Error('PostgreSQL unavailable: set API_NOVA_TEST_PG_BIN, install initdb, '
      + 'provide the local postgres:16.14 image, or use OBS16_PG_MODE=external');
  }

  const pgRun = (name, args) => new Promise((resolve, reject) => {
    // PostgreSQL descendants on Windows may inherit pipe handles; await launcher exit with no inherited pipe.
    const child = spawn(pgTool(name), args, { windowsHide: true, env: safeEnv, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${name} timed out`)); }, 45000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(Object.assign(new Error(`${name} exited ${code}`), { code }));
    });
  });
  async function isolatedStart() {
    await pgRun('initdb', ['--version']);
    await fs.mkdir(TEMP_ROOT, { recursive: true });
    directory = await fs.mkdtemp(path.join(TEMP_ROOT, 'run-'));
    const data = path.join(directory, 'pgdata');
    await pgRun('initdb', ['-D', data, '-U', 'obs16_fixture', '--auth=trust', '--no-locale', '--encoding=UTF8']);
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const selected = server.address().port;
        server.close(error => error ? reject(error) : resolve(selected));
      });
    });
    await fs.appendFile(path.join(data, 'postgresql.conf'),
      `\nlisten_addresses = '127.0.0.1'\nport = ${port}\nmax_connections = 16\nfsync = on\nsynchronous_commit = on\n`);
    await fs.writeFile(path.join(data, 'pg_hba.conf'), 'host all obs16_fixture 127.0.0.1/32 trust\nlocal all obs16_fixture trust\n');
    await pgRun('pg_ctl', ['-D', data, '-l', path.join(directory, 'postgres.log'), '-w', '-t', '30', 'start']);
    isolatedStarted = true;
    return { host: '127.0.0.1', port, user: 'obs16_fixture', password: '', adminDatabase: 'postgres', database: 'postgres' };
  }
  async function isolatedStop() {
    if (!directory) return;
    if (!isolatedStarted) {
      try { await pgRun('pg_ctl', ['-D', path.join(directory, 'pgdata'), 'status']); isolatedStarted = true; }
      catch (error) { if (error.code === 3 || error.code === 4) return; throw error; }
    }
    await pgRun('pg_ctl', ['-D', path.join(directory, 'pgdata'), '-w', '-t', '30', '-m', 'fast', 'stop']);
    isolatedStarted = false;
  }
  async function containerStart() {
    containerName = `obs16-pg-${process.pid}`;
    volumeName = `obs16-pg-vol-${process.pid}`;
    docker(['rm', '-f', containerName]);
    const created = docker(['run', '-d', '--name', containerName,
      '-e', 'POSTGRES_USER=obs16', '-e', 'POSTGRES_PASSWORD=obs16-container-fixture',
      '-e', 'POSTGRES_DB=obs16', '-p', '127.0.0.1:0:5432',
      '-v', `${volumeName}:/var/lib/postgresql/data`, 'postgres:16.14']);
    if (created.status !== 0) throw new Error('docker run postgres:16.14 failed: ' + (created.stderr || '').trim());
    const deadline = Date.now() + 90000;
    let ready = false;
    while (Date.now() < deadline) {
      const probe = docker(['exec', containerName, 'pg_isready', '-U', 'obs16', '-d', 'obs16']);
      if (probe.status === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error('postgres:16.14 container did not become ready');
    const published = docker(['port', containerName, '5432']);
    const match = String(published.stdout || '').trim().match(/:(\d+)\s*$/m);
    if (!match) throw new Error('cannot resolve published PostgreSQL port: ' + (published.stdout || ''));
    return { host: '127.0.0.1', port: Number(match[1]), user: 'obs16', password: 'obs16-container-fixture',
      adminDatabase: 'obs16', database: 'obs16' };
  }
  function containerStop() {
    if (containerName) docker(['rm', '-f', containerName]);
    if (volumeName) docker(['volume', 'rm', '-f', volumeName]);
    containerName = null;
    volumeName = null;
  }
  function externalConfig() {
    const host = process.env.OBS16_PG_HOST;
    if (!host) throw new Error('OBS16_PG_MODE=external requires OBS16_PG_HOST');
    return { host, port: Number(process.env.OBS16_PG_PORT || 5432), user: process.env.OBS16_PG_USER || 'postgres',
      password: process.env.OBS16_PG_PASSWORD || '',
      adminDatabase: process.env.OBS16_PG_ADMIN_DATABASE || 'postgres',
      database: process.env.OBS16_PG_DATABASE || process.env.OBS16_PG_ADMIN_DATABASE || 'postgres' };
  }

  function adminClient() {
    // Fixture schemas are created in the same database the workers connect to. The admin
    // database is only the connection fallback when the target database itself is the
    // maintenance database (isolated cluster).
    return new Client({ host: cluster.host, port: cluster.port, user: cluster.user,
      password: cluster.password, database: cluster.database || cluster.adminDatabase,
      connectionTimeoutMillis: 10000 });
  }
  async function adminExec(sql, parameters = []) {
    const client = adminClient();
    try { await client.connect(); return await client.query(sql, parameters); }
    finally { await client.end().catch(() => undefined); }
  }

  async function createFixture(t) {
    const schema = 'obs16_' + randomUUID().replaceAll('-', '');
    await adminExec(`CREATE SCHEMA "${schema}"`);
    const db = await new DataSource(connection({ ...cluster, schema })).initialize();
    await db.synchronize();
    const store = new CallObservabilityStore(db, {});
    const children = [];
    t.after(async () => {
      for (const child of children.splice(0)) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
      if (db.isInitialized) await db.destroy();
      await adminExec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    });
    return { schema, db, store, children, repository: entity => db.getRepository(entity) };
  }

  async function seedSubscription(f, options = {}) {
    const subscriptionId = options.subscriptionId || randomUUID();
    const state = options.state || 'enabled';
    const revoked = options.revoked === true;
    const from = options.from || '1';
    const until = options.until || null;
    const path = options.path || '/events';
    const filter = options.filter || { eventTypes: ['invocation.completed'] };
    const scope = options.scope || { mode: 'assets', runtimeAssetIds: [ASSET_A] };
    const now = new Date().toISOString();
    const destination = { type: 'webhook', url: `http://127.0.0.1:${receiver.port}${path}` };
    await f.repository(Subscription).insert({
      id: subscriptionId, ownerId: options.ownerId || OWNER_ID, name: 'obs16-fixture', version: 1,
      state, destination: JSON.stringify(destination), secretRef: 'obs16-key', filter, scope,
      effectiveFromSequence: sequenceKey(from), createdAt: now, updatedAt: now,
      pausedFromSequence: null, deletedAt: null,
    });
    await f.repository(Revision).insert({
      id: randomUUID(), subscriptionId, version: 1, effectiveFromSequence: sequenceKey(from),
      effectiveUntilSequence: until === null ? null : sequenceKey(until),
      config: { state: options.revisionState || 'enabled', filter, scope, destination, secretRef: 'obs16-key' },
      revoked, createdAt: now,
    });
    return subscriptionId;
  }

  async function seedEvent(f, overrides = {}) {
    return f.store.transaction(async tx => {
      const row = Object.assign(new Event(), {
        id: randomUUID(), sequence: tx.nextSequence(), schemaVersion: '1.0',
        subjectId: randomUUID(), subjectVersion: 1, eventName: 'invocation.completed',
        runtimeAssetId: ASSET_A, eventFamily: 'runtime.request', severity: 'info', status: 'success',
        actorType: 'runtime', retentionClass: 'standard', occurredAt: new Date(tx.now), createdAt: new Date(tx.now),
        expiresAt: new Date(Date.parse(tx.now) + EVENT_TTL_MS), dispatchState: 'pending',
        dimensions: { serverType: 'gateway', callerId: 'caller-a' },
        details: { spanKind: 'gateway_request', outcome: 'success' },
        ...overrides,
      });
      await tx.manager.getRepository(Event).insert(row);
      return row;
    });
  }

  async function seedDelivery(f, event, subscriptionId, overrides = {}) {
    const now = new Date().toISOString();
    const id = overrides.id || contentHash(canonicalJson(['observability.delivery.v1', subscriptionId, event.id]));
    await f.repository(Delivery).insert({
      id, subscriptionId, subscriptionRevision: 1, eventId: event.id, eventSequence: event.sequence,
      status: 'pending', version: 1, attemptCount: 0, replayGeneration: 0,
      nextAttemptAt: now, leaseOwner: null, leaseUntil: null, lastError: {},
      createdAt: now, updatedAt: now,
      expiresAt: new Date(Date.parse(now) + DELIVERY_TTL_MS).toISOString(),
      ...overrides,
    });
    return id;
  }

  function launchWorker(f, role, extra = {}) {
    const config = { mode: cluster.mode, host: cluster.host, port: cluster.port, user: cluster.user,
      password: cluster.password, database: cluster.database, adminDatabase: cluster.adminDatabase,
      schema: f.schema, receiverPort: receiver.port, ownerId: OWNER_ID, ...extra };
    const child = fork(__filename, ['--worker', role, JSON.stringify(config)],
      { windowsHide: true, env: safeEnv, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    f.children.push(child);
    const messages = [];
    const waiters = [];
    let stderr = '';
    child.stderr?.on('data', data => { stderr += String(data); });
    child.on('message', message => {
      const index = waiters.findIndex(waiter => waiter.phase === message.phase || message.phase === 'fatal');
      if (index >= 0) {
        const waiter = waiters.splice(index, 1)[0];
        clearTimeout(waiter.timer);
        message.phase === 'fatal' ? waiter.reject(new Error(message.message)) : waiter.resolve(message);
      } else {
        messages.push(message);
      }
    });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => {
      resolve({ code, signal });
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`worker exited ${code}/${signal}: ${stderr}`));
      }
    }));
    function wait(phase, timeout = WORKER_TIMEOUT_MS) {
      const index = messages.findIndex(message => message.phase === phase || message.phase === 'fatal');
      if (index >= 0) {
        const message = messages.splice(index, 1)[0];
        return message.phase === 'fatal' ? Promise.reject(new Error(message.message)) : Promise.resolve(message);
      }
      return new Promise((resolve, reject) => {
        const waiter = { phase, resolve, reject, timer: setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at >= 0) waiters.splice(at, 1);
          reject(new Error(`worker ${phase} timeout: ${stderr}`));
        }, timeout) };
        waiters.push(waiter);
      });
    }
    return {
      child, wait, exited,
      send: message => child.send(message),
      async kill() { child.kill('SIGKILL'); await exited; },
    };
  }

  async function runOutbox(f, options = {}) {
    const worker = launchWorker(f, 'outbox', options.extra);
    await worker.wait('ready');
    worker.send({ op: 'run', limit: options.limit ?? 8 });
    const result = await worker.wait('result');
    assert.equal(result.ok, true, `outbox worker failed: ${result.code || ''} ${result.message || ''}`);
    return { result: result.report, worker };
  }
  async function runDelivery(f, options = {}) {
    const worker = launchWorker(f, 'delivery', options.extra);
    await worker.wait('ready');
    worker.send({ op: 'run', limit: options.limit ?? 4 });
    const result = await worker.wait('result');
    assert.equal(result.ok, true, `delivery worker failed: ${result.code || ''} ${result.message || ''}`);
    return { result: result.report, worker };
  }

  before(async () => {
    const mode = resolveMode();
    let config;
    if (mode === 'isolated') config = await isolatedStart();
    else if (mode === 'container') config = await containerStart();
    else config = externalConfig();
    cluster = { mode, ...config };
    serverVersion = await adminExec('SHOW server_version')
      .then(result => result.rows[0].server_version, () => null);
    await startReceiver();
    receiver.holdEnabled = true;
  });

  after(async () => {
    await releaseHeldResponses();
    if (receiver.server) await new Promise(resolve => receiver.server.close(resolve));
    if (!cluster) return;
    if (cluster.mode === 'isolated') await isolatedStop().catch(() => undefined);
    if (cluster.mode === 'container') containerStop();
    if (directory) {
      const target = path.resolve(directory);
      assert.equal(path.dirname(target), path.resolve(TEMP_ROOT));
      assert.ok(path.basename(target).startsWith('run-'));
      await fs.rm(target, { recursive: true, force: true });
    }
    console.log('OBS_16_03_STAGE1_ENV ' + JSON.stringify({
      mode: cluster.mode, host: cluster.host, port: cluster.port, user: cluster.user,
      postgresVersion: serverVersion,
    }));
  });

  test('claim mechanism is the actual PostgreSQL skip-locked code path', async () => {
    const source = path.resolve(__dirname, '../src/modules/call-observability');
    const outbox = await fs.readFile(path.join(source, 'call-observability-outbox.service.ts'), 'utf8');
    const delivery = await fs.readFile(path.join(source, 'call-observability-delivery.worker.ts'), 'utf8');
    assert.ok(outbox.includes("setLock('pessimistic_write').setOnLocked('skip_locked')"), 'outbox claim must use skip_locked');
    assert.ok(delivery.includes("setLock('pessimistic_write').setOnLocked('skip_locked')"), 'delivery claim must use skip_locked');
    assert.ok(outbox.includes('const EVENT_LEASE_MS = 15000;'), 'event lease must be 15 s');
    assert.ok(delivery.includes('const LEASE_MS = 30000;'), 'delivery lease must be 30 s');
    assert.ok(outbox.includes("(event.dispatchState = 'pending' OR (event.dispatchState = 'leased' AND event.dispatchLeaseUntil <= :now))"),
      'event claim must include pending and expired leases');
    assert.ok(delivery.includes("delivery.status !== 'in_flight' || delivery.leaseOwner !== claimed.leaseOwner"),
      'delivery completion must be lease-owner guarded');
  });

  test('two outbox processes claim pending events without duplicate deliveries', { timeout: 180000 }, async t => {
    const f = await createFixture(t);
    await seedSubscription(f);
    const events = [];
    for (let index = 0; index < 24; index++) events.push(await seedEvent(f));
    const first = launchWorker(f, 'outbox');
    const second = launchWorker(f, 'outbox');
    await Promise.all([first.wait('ready'), second.wait('ready')]);
    for (const worker of [first, second]) worker.send({ op: 'run', limit: 10 });
    const reports = await Promise.all([first.wait('result'), second.wait('result')]);
    assert.ok(reports.every(report => report.ok), JSON.stringify(reports));
    for (const worker of [first, second]) worker.send({ op: 'run', limit: 10 });
    const again = await Promise.all([first.wait('result'), second.wait('result')]);
    assert.ok(again.every(report => report.ok), JSON.stringify(again));
    const rows = await f.repository(Event).find();
    const deliveries = await f.repository(Delivery).find();
    assert.equal(rows.length, 24);
    assert.equal(deliveries.length, 24);
    assert.equal(new Set(deliveries.map(row => row.id)).size, 24);
    assert.equal(new Set(deliveries.map(row => row.eventId)).size, 24);
    assert.ok(rows.every(row => row.dispatchState === 'materialized'));
    assert.ok(events.every(event => deliveries.some(row => row.eventId === event.id)));
  });

  test('a locked event row is skipped instead of awaited by the PostgreSQL claim', { timeout: 180000 }, async t => {
    const f = await createFixture(t);
    await seedSubscription(f);
    const first = await seedEvent(f);
    const second = await seedEvent(f);
    const locker = adminClient();
    await locker.connect();
    await locker.query('BEGIN');
    try {
      await locker.query(
        `SELECT id FROM "${f.schema}"."runtime_observability_events" WHERE id = $1 FOR UPDATE`, [first.id]);
      const worker = launchWorker(f, 'outbox');
      await worker.wait('ready');
      const started = Date.now();
      worker.send({ op: 'run', limit: 1 });
      const result = await worker.wait('result');
      const elapsed = Date.now() - started;
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.report.claimed, 1);
      assert.ok(elapsed < 10000, `claim waited on the locked row for ${elapsed} ms; skip_locked did not apply`);
    } finally {
      await locker.query('COMMIT').catch(() => undefined);
      await locker.end().catch(() => undefined);
    }
    const rows = await f.repository(Event).find();
    assert.equal(rows.find(row => row.id === first.id).dispatchState, 'pending');
    assert.equal(await f.repository(Delivery).countBy({ eventId: second.id }), 1);
    assert.equal(await f.repository(Delivery).countBy({ eventId: first.id }), 0);
    const { result: followUp } = await runOutbox(f, { limit: 1 });
    assert.equal(followUp.claimed, 1);
    assert.equal(await f.repository(Delivery).countBy({ eventId: first.id }), 1);
    assert.equal(await f.repository(Delivery).count(), 2);
    assert.equal(await f.repository(PipelineState).countBy({ id: OUTBOX_WORKER_STATE_ID }), 1);
  });

  test('two delivery processes deliver every row exactly once', { timeout: 180000 }, async t => {
    const f = await createFixture(t);
    const subscriptionId = await seedSubscription(f);
    for (let index = 0; index < 12; index++) {
      const event = await seedEvent(f);
      await seedDelivery(f, event, subscriptionId);
    }
    const first = launchWorker(f, 'delivery');
    const second = launchWorker(f, 'delivery');
    await Promise.all([first.wait('ready'), second.wait('ready')]);
    const before = receiver.requests.length;
    for (const worker of [first, second]) worker.send({ op: 'run', limit: 6 });
    const reports = await Promise.all([first.wait('result'), second.wait('result')]);
    assert.ok(reports.every(report => report.ok), JSON.stringify(reports));
    const requests = receiver.requests.slice(before);
    assert.equal(requests.length, 12);
    assert.equal(new Set(requests.map(request => request.deliveryId)).size, 12);
    assert.ok(requests.every(request => request.acked && request.signed));
    const rows = await f.repository(Delivery).find();
    assert.equal(rows.length, 12);
    assert.ok(rows.every(row => row.status === 'succeeded' && row.attemptCount === 1));
    const attempts = await f.repository(Attempt).find();
    assert.equal(attempts.length, 12);
    assert.equal(new Set(attempts.map(row => row.deliveryId)).size, 12);
    assert.ok(attempts.every(row => row.result === 'succeeded' && row.httpStatus === 202));
  });

  test('a locked delivery row is skipped by the PostgreSQL claim without blocking', { timeout: 180000 }, async t => {
    const f = await createFixture(t);
    const subscriptionId = await seedSubscription(f);
    const firstEvent = await seedEvent(f);
    const secondEvent = await seedEvent(f);
    const firstId = await seedDelivery(f, firstEvent, subscriptionId,
      { createdAt: new Date(Date.now() - 2000).toISOString(), nextAttemptAt: new Date(Date.now() - 2000).toISOString() });
    await seedDelivery(f, secondEvent, subscriptionId);
    const locker = adminClient();
    await locker.connect();
    await locker.query('BEGIN');
    try {
      await locker.query(`SELECT id FROM "${f.schema}"."runtime_event_deliveries" WHERE id = $1 FOR UPDATE`, [firstId]);
      const worker = launchWorker(f, 'delivery');
      await worker.wait('ready');
      const before = receiver.requests.length;
      const started = Date.now();
      worker.send({ op: 'run', limit: 1 });
      const result = await worker.wait('result');
      const elapsed = Date.now() - started;
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.report.claimed, 1);
      assert.ok(elapsed < 10000, `claim waited on the locked delivery for ${elapsed} ms`);
      const requests = receiver.requests.slice(before);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].deliveryId, contentHash(canonicalJson(
        ['observability.delivery.v1', subscriptionId, secondEvent.id])));
    } finally {
      await locker.query('COMMIT').catch(() => undefined);
      await locker.end().catch(() => undefined);
    }
    assert.equal((await f.repository(Delivery).findOneByOrFail({ id: firstId })).status, 'pending');
    const { result: followUp } = await runDelivery(f, { limit: 1 });
    assert.equal(followUp.claimed, 1);
    assert.equal((await f.repository(Delivery).findOneByOrFail({ id: firstId })).status, 'succeeded');
  });

  test('only expired delivery leases are reclaimed; active leases stay owned', { timeout: 180000 }, async t => {
    const f = await createFixture(t);
    const subscriptionId = await seedSubscription(f);
    const readyEvent = await seedEvent(f);
    const inFlightEvent = await seedEvent(f);
    await seedDelivery(f, readyEvent, subscriptionId);
    const activeId = await seedDelivery(f, inFlightEvent, subscriptionId, {
      status: 'in_flight', leaseOwner: 'active-other-worker',
      leaseUntil: new Date(Date.now() + 300000).toISOString(),
      nextAttemptAt: new Date(Date.now() - 1000).toISOString(),
    });
    const before = receiver.requests.length;
    const { result } = await runDelivery(f, { limit: 4 });
    assert.equal(result.claimed, 1);
    assert.equal(receiver.requests.length - before, 1);
    const active = await f.repository(Delivery).findOneByOrFail({ id: activeId });
    assert.equal(active.status, 'in_flight');
    assert.equal(active.leaseOwner, 'active-other-worker');
    await f.db.query(`UPDATE "${f.schema}"."runtime_event_deliveries" ` +
      `SET "leaseUntil" = now() - interval '1 second' WHERE id = $1`, [activeId]);
    const { result: reclaimed } = await runDelivery(f, { limit: 4 });
    assert.equal(reclaimed.claimed, 1);
    assert.equal(reclaimed.succeeded, 1);
    const row = await f.repository(Delivery).findOneByOrFail({ id: activeId });
    assert.equal(row.status, 'succeeded');
    assert.equal(row.attemptCount, 1);
  });

  test('a killed outbox process keeps its claim and recovers without loss or duplicates', { timeout: 180000 }, async t => {
    const f = await createFixture(t);
    await seedSubscription(f);
    const event = await seedEvent(f);
    const crashed = launchWorker(f, 'outbox', { crashAfterClaim: true });
    await crashed.wait('ready');
    crashed.send({ op: 'run', limit: 4 });
    await crashed.wait('claimed-before-materialize');
    await crashed.kill();
    // Pin a clearly active crashed lease window so the no-steal check does not depend on
    // process startup speed (slow container hosts can take longer than the 15 s event lease).
    await f.db.query(`UPDATE "${f.schema}"."runtime_observability_events" ` +
      `SET "dispatchLeaseUntil" = now() + interval '5 minutes' WHERE id = $1`, [event.id]);
    const held = await f.repository(Event).findOneByOrFail({ id: event.id });
    assert.equal(held.dispatchState, 'leased');
    assert.ok(held.dispatchLeaseUntil.getTime() > Date.now() + 60000,
      'crashed worker lease must remain active for the no-steal check');
    assert.equal(await f.repository(Delivery).count(), 0);
    const { result: blocked } = await runOutbox(f, { limit: 4 });
    assert.equal(blocked.claimed, 0, 'active crashed lease must not be stolen');
    assert.equal(await f.repository(Delivery).count(), 0);
    await f.db.query(`UPDATE "${f.schema}"."runtime_observability_events" ` +
      `SET "dispatchLeaseUntil" = now() - interval '1 second' WHERE id = $1`, [event.id]);
    const { result: recovered } = await runOutbox(f, { limit: 4 });
    assert.equal(recovered.claimed, 1);
    assert.equal(recovered.recoveredLeases, 1);
    assert.equal(recovered.deliveriesCreated, 1);
    const deliveries = await f.repository(Delivery).find();
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].eventId, event.id);
    assert.equal((await f.repository(Event).findOneByOrFail({ id: event.id })).dispatchState, 'materialized');
    const state = await f.repository(PipelineState).findOneByOrFail({ id: OUTBOX_WORKER_STATE_ID });
    assert.equal(state.value.watermark, '1');
  });

  test('a killed delivery process recovers its in-flight lease with one completed attempt', { timeout: 180000 }, async t => {
    const f = await createFixture(t);
    const subscriptionId = await seedSubscription(f, { path: '/hold' });
    const event = await seedEvent(f);
    const deliveryId = await seedDelivery(f, event, subscriptionId);
    const crashed = launchWorker(f, 'delivery');
    await crashed.wait('ready');
    crashed.send({ op: 'run', limit: 1 });
    await waitForRequests(request => request.path === '/hold' && request.deliveryId === deliveryId, 1, 30000);
    await crashed.kill();
    await f.db.query(`UPDATE "${f.schema}"."runtime_event_deliveries" ` +
      `SET "leaseUntil" = now() + interval '5 minutes' WHERE id = $1`, [deliveryId]);
    const inFlight = await f.repository(Delivery).findOneByOrFail({ id: deliveryId });
    assert.equal(inFlight.status, 'in_flight');
    assert.equal(inFlight.attemptCount, 0);
    assert.equal(await f.repository(Attempt).count(), 0);
    assert.ok(inFlight.leaseUntil && Date.parse(inFlight.leaseUntil) > Date.now() + 60000);
    await releaseHeldResponses();
    await f.db.query(`UPDATE "${f.schema}"."runtime_event_deliveries" ` +
      `SET "leaseUntil" = now() - interval '1 second' WHERE id = $1`, [deliveryId]);
    const { result } = await runDelivery(f, { limit: 1 });
    assert.equal(result.claimed, 1);
    assert.equal(result.succeeded, 1);
    const row = await f.repository(Delivery).findOneByOrFail({ id: deliveryId });
    assert.equal(row.status, 'succeeded');
    assert.equal(row.attemptCount, 1);
    assert.equal(row.leaseOwner, null);
    const attempts = await f.repository(Attempt).findBy({ deliveryId });
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].httpStatus, 202);
    const received = receiver.requests.filter(request => request.deliveryId === deliveryId);
    assert.equal(received.length, 2, 'at-least-once: the uncertain first request may be retried');
    assert.equal(received.filter(request => request.acked).length, 1);
  });

  test('outbox enforces revision range, revocation, disabled state and event expiry', { timeout: 180000 }, async t => {
    const f = await createFixture(t);
    await seedSubscription(f, { from: '1', until: '2' });
    await seedSubscription(f, { revoked: true });
    await seedSubscription(f, { revisionState: 'disabled' });
    const first = await seedEvent(f);
    const second = await seedEvent(f);
    const expired = await seedEvent(f, { expiresAt: new Date(Date.now() - 60000) });
    const { result } = await runOutbox(f, { limit: 16 });
    assert.equal(result.claimed, 2);
    const deliveries = await f.repository(Delivery).find();
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].eventId, first.id);
    assert.equal(deliveries[0].eventSequence, first.sequence);
    const rows = await f.repository(Event).find();
    assert.equal(rows.find(row => row.id === second.id).dispatchState, 'materialized');
    assert.equal(rows.find(row => row.id === expired.id).dispatchState, 'pending',
      'expired events must not be claimed or materialized');
  });

  test('delivery worker enforces revocation, pause and event expiry without network sends', { timeout: 180000 }, async t => {
    const f = await createFixture(t);
    const revokedSubscription = await seedSubscription(f, { revoked: true });
    const pausedSubscription = await seedSubscription(f, { state: 'paused' });
    const expiredSubscription = await seedSubscription(f);
    const revokedEvent = await seedEvent(f);
    const pausedEvent = await seedEvent(f);
    const expiredEvent = await seedEvent(f, { expiresAt: new Date(Date.now() - 60000) });
    await seedDelivery(f, revokedEvent, revokedSubscription);
    await seedDelivery(f, pausedEvent, pausedSubscription);
    const expiredId = await seedDelivery(f, expiredEvent, expiredSubscription);
    const before = receiver.requests.length;
    const { result } = await runDelivery(f, { limit: 8 });
    assert.equal(result.claimed, 0);
    assert.equal(receiver.requests.length - before, 0);
    assert.equal(await f.repository(Attempt).count(), 0);
    const revoked = await f.repository(Delivery).findOneByOrFail({ eventId: revokedEvent.id });
    assert.equal(revoked.status, 'cancelled');
    assert.equal(revoked.lastError.category, 'subscription_revision_revoked');
    const paused = await f.repository(Delivery).findOneByOrFail({ eventId: pausedEvent.id });
    assert.equal(paused.status, 'pending');
    const expired = await f.repository(Delivery).findOneByOrFail({ id: expiredId });
    assert.equal(expired.status, 'dead');
    assert.equal(expired.lastError.category, 'event_expired');
  });
}
