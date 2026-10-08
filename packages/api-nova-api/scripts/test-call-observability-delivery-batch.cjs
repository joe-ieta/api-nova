'use strict';
// Independent PostgreSQL cluster, two independent DataSources. No inherited DB target.
const postgres = process.argv.includes('--postgres');
process.env.DB_TYPE = postgres ? 'postgres' : 'sqlite';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID, createHmac } = require('node:crypto');
const { createServer } = require('node:http');
const { ConfigService } = require('@nestjs/config');
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, project: path.resolve(__dirname, '../tsconfig.json') });
const { DataSource } = require('typeorm');
const { CallObservabilityDeliveryWorker: Worker } = require('../src/modules/call-observability/call-observability-delivery.worker.ts');
const { createApplicationDataSource } = require('../src/database/sqljs-persistence.ts');
const { CALL_OBSERVABILITY_ENTITIES, RuntimeInvocationEntity: Invocation, RuntimeInvocationRevisionEntity: Revision,
  RuntimeEventSubscriptionEntity: Subscription, RuntimeSubscriptionRevisionEntity: SubscriptionRevision, RuntimeEventDeliveryEntity: Delivery, RuntimeEventDeliveryAttemptEntity: Attempt, RuntimePipelineStateEntity: Pipeline } = require('../src/database/entities/runtime-call-observability.entity.ts');
const { RuntimeObservabilityEventEntity: Event } = require('../src/database/entities/runtime-observability-event.entity.ts');
const { CallObservabilityStore: Store } = require('../src/modules/call-observability/call-observability.store.ts');
const entities = [...CALL_OBSERVABILITY_ENTITIES, Event];
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG|^DATABASE_URL$/i.test(key)));
const run = (name, args) => new Promise((resolve, reject) => {
  const executable = process.env.API_NOVA_TEST_PG_BIN ? path.join(process.env.API_NOVA_TEST_PG_BIN, name + (process.platform === 'win32' ? '.exe' : '')) : name;
  const child = spawn(executable, args, { env: safeEnv, windowsHide: true, stdio: 'ignore' });
  const timer = setTimeout(() => { child.kill(); reject(new Error(name + ' timed out')); }, 45000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(name + ' exited ' + code)); });
});
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
(async () => {
  const root = path.resolve(__dirname, '../../../.tmp'); await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'delivery-batch-' + (postgres ? 'pg-' : 'sqlite-'))); const data = path.join(directory, 'pgdata');
  const evidence = { directory, tests: [], stopped: false }; let started = false; const databases = []; let server; const workers = [];
  try {
    let options;
    if (postgres) {
    await run('initdb', ['-D', data, '-U', 'runtime_fixture', '--auth=trust', '--no-locale', '--encoding=UTF8']);
    const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); }); });
    evidence.port = port;
    await fs.appendFile(path.join(data, 'postgresql.conf'), `\nlisten_addresses='127.0.0.1'\nport=${port}\nfsync=on\nsynchronous_commit=on\nmax_connections=16\n`);
    await fs.writeFile(path.join(data, 'pg_hba.conf'), 'host all runtime_fixture 127.0.0.1/32 trust\nlocal all runtime_fixture trust\n');
    await run('pg_ctl', ['-D', data, '-l', path.join(directory, 'postgres.log'), '-w', '-t', '30', 'start']); started = true;
    options = { type: 'postgres', host: '127.0.0.1', port, username: 'runtime_fixture', password: '', database: 'postgres', ssl: false,
      entities, extra: { max: 2, connectionTimeoutMillis: 10000, statement_timeout: 20000 } };
    } else options = { type: 'sqljs', location: path.join(directory, 'database.sqlite'), autoSave: true, entities };
    const first = await createApplicationDataSource({ ...options, synchronize: true }).initialize(); databases.push(first);
    const second = postgres ? await new DataSource({ ...options, synchronize: false }).initialize() : first;
    if (postgres) databases.push(second);
    const stores = [first, second].map(db => new Store(db, {}));
    let transactionDepth = 0;
    for (const store of stores) {
      const transaction = store.transaction.bind(store);
      store.transaction = callback => transaction(async tx => { transactionDepth++; try { return await callback(tx); } finally { transactionDepth--; } });
    }
    const calls = []; let activeHttp = 0, peakHttp = 0, responder = () => 202;
    server = createServer((request, response) => {
      const chunks = []; request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8'), parsed = JSON.parse(body);
        calls.push({ headers: request.headers, body, parsed, transactionDepth });
        activeHttp++; peakHttp = Math.max(peakHttp, activeHttp);
        const responsePlan = responder(parsed, calls.length);
        const status = typeof responsePlan === 'object' ? responsePlan.status : responsePlan;
        const delayMs = typeof responsePlan === 'object' ? responsePlan.delayMs : 5;
        setTimeout(() => { activeHttp--; if (status === 'disconnect') request.socket.destroy(); else { response.statusCode = status; response.end('fixture response'); } }, delayMs);
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port, secret = 'fixture-only-secret'.repeat(3), asset = randomUUID(), owner = randomUUID();
    const config = new ConfigService({ API_NOVA_OBSERVABILITY_WEBHOOK_ALLOW_HTTP: 'true',
      API_NOVA_OBSERVABILITY_WEBHOOK_ALLOWED_HOSTS: '127.0.0.1:' + port, API_NOVA_OBSERVABILITY_WEBHOOK_ALLOWED_PRIVATE_IPS: '127.0.0.1',
      API_NOVA_OBSERVABILITY_WEBHOOK_SECRET_REFS: 'fixture-key', API_NOVA_OBSERVABILITY_WEBHOOK_SECRETS: JSON.stringify({ 'fixture-key': secret }),
      API_NOVA_OBSERVABILITY_WEBHOOK_TIMEOUT_MS: '1000' });
    const users = { async findUserById(id) { assert.equal(id, owner); return { id, isActive: true, isLocked: false, roles: [{
      enabled: true, type: 'custom', name: 'fixture', permissions: ['monitoring:read', 'monitoring:subscription:manage'].map(name => ({ name, enabled: true })),
      metadata: { observabilityScope: { mode: 'assets', runtimeAssetIds: [asset] } } }] }; } };
    const makeWorker = store => { const worker = new Worker(store, config, users); workers.push(worker); return worker; };
    const worker = makeWorker(stores[0]), competingWorker = makeWorker(stores[1]);
    const subscriptionId = randomUUID(), now = new Date().toISOString(), scope = { mode: 'assets', runtimeAssetIds: [asset] };
    const destination = { type: 'webhook', url: 'http://127.0.0.1:' + port + '/events' };
    await first.getRepository(Subscription).save({ id: subscriptionId, ownerId: owner, name: 'batch fixture', version: 1, state: 'enabled',
      destination: destination.url, secretRef: 'fixture-key', filter: {}, scope, effectiveFromSequence: '00000000000000000000', createdAt: now, updatedAt: now });
    await first.getRepository(SubscriptionRevision).save({ id: randomUUID(), subscriptionId, version: 1, effectiveFromSequence: '00000000000000000000',
      effectiveUntilSequence: null, config: { scope, destination, secretRef: 'fixture-key' }, revoked: false, createdAt: now });
    const seed = async count => {
      await stores[0].transaction(async tx => {
        await tx.manager.getRepository(Attempt).clear(); await tx.manager.getRepository(Delivery).clear(); await tx.manager.getRepository(Event).clear();
        await tx.manager.getRepository(SubscriptionRevision).update({ subscriptionId }, { revoked: false });
        for (let index = 0; index < count; index++) {
          const eventId = randomUUID(), id = randomUUID(), sequence = tx.nextSequence();
          await tx.manager.getRepository(Event).save({ id: eventId, runtimeAssetId: asset, eventFamily: 'runtime.request', eventName: 'invocation.finished',
            severity: 'info', status: 'success', occurredAt: new Date(tx.now), details: { index, text: '署名正文' }, dimensions: { runtimeAssetId: asset },
            sequence, schemaVersion: '1.0', subjectId: randomUUID(), subjectVersion: 1, dispatchState: 'materialized', expiresAt: new Date(Date.now() + 3600000) });
          await tx.manager.getRepository(Delivery).save({ id, subscriptionId, subscriptionRevision: 1, eventId, eventSequence: sequence,
            status: 'pending', version: 1, attemptCount: 0, replayGeneration: 0, nextAttemptAt: tx.now, leaseOwner: null, leaseUntil: null,
            lastError: {}, createdAt: tx.now, updatedAt: tx.now, expiresAt: new Date(Date.now() + 86400000).toISOString() });
        }
      });
      calls.length = 0; peakHttp = 0;
    };
    let queries = 0, commits = 0, exports = 0;
    const originalLog = first.logger.logQuery.bind(first.logger);
    first.logger.logQuery = (sql, ...args) => { queries++; if (/^COMMIT\b/.test(sql)) commits++; originalLog(sql, ...args); };
    if (!postgres) {
      const native = first.driver.databaseConnection, originalExport = native.export.bind(native);
      native.export = (...args) => { exports++; return originalExport(...args); };
    }
    const resetCounts = () => { queries = commits = exports = 0; };
    const counts = () => ({ queries, commits, exports });
    await seed(8); resetCounts();
    for (let index = 0; index < 8; index++) await worker.runOnce(1);
    const scalar = counts(); await seed(8); resetCounts();
    const batchReport = await worker.runOnce(8), batch = counts();
    assert.equal(batchReport.succeeded, 8); assert.equal(calls.length, 8); assert.ok(peakHttp > 1 && peakHttp <= 4);
    assert.ok(batch.commits < scalar.commits); assert.ok(batch.queries < scalar.queries);
    if (!postgres) assert.ok(batch.exports < scalar.exports);
    for (const call of calls) {
      assert.equal(call.transactionDepth, 0);
      const expected = 'sha256=' + createHmac('sha256', secret).update(call.headers['x-apinova-timestamp'] + '.' + call.body).digest('hex');
      assert.equal(call.headers['x-apinova-signature'], expected); assert.equal(call.parsed.delivery.attemptNo, 1);
    }
    assert.equal(await first.getRepository(Attempt).count(), 8);
    evidence.coalescing = { scalar, batch, peakHttp, records: 8 };
    evidence.tests.push('bounded real HTTP waves preserve signed bodies and per-call attempts outside transactions with fewer SQL/commits/exports');

    await seed(8); await Promise.all([worker.runOnce(4), competingWorker.runOnce(4)]);
    assert.equal(calls.length, 8); assert.equal(new Set(calls.map(call => call.headers['x-apinova-delivery-id'])).size, 8);
    assert.equal(await first.getRepository(Attempt).count(), 8);
    assert.equal(await first.getRepository(Delivery).countBy({ status: 'succeeded' }), 8);
    evidence.tests.push('two workers on independent PostgreSQL connections or the shared SQLite writer claim distinct jobs without duplicate attempts');

    await seed(4); responder = parsed => [202, 503, 400, 'disconnect'][parsed.data.index];
    const mixed = await worker.runOnce(4); responder = () => 202;
    assert.equal(mixed.succeeded, 1); assert.equal(mixed.retrying, 2); assert.equal(mixed.dead, 1);
    assert.equal(await first.getRepository(Attempt).count(), 4);
    const statuses = (await first.getRepository(Delivery).find()).map(row => row.status).sort();
    assert.deepEqual(statuses, ['dead', 'retry_wait', 'retry_wait', 'succeeded']);
    evidence.tests.push('one wave with success, retryable HTTP, permanent HTTP and disconnected socket persists four independent outcomes');

    for (const boundary of ['revoke', 'event-expiry']) {
      await seed(4); const addresses = worker.addresses.bind(worker); let changed = false;
      worker.addresses = async (...args) => {
        if (!changed) {
          changed = true;
          await stores[1].transaction(async tx => {
            if (boundary === 'revoke') await tx.manager.getRepository(SubscriptionRevision).update({ subscriptionId }, { revoked: true });
            else await tx.manager.getRepository(Event).createQueryBuilder().update().set({ expiresAt: new Date(0) }).execute();
          });
        }
        return addresses(...args);
      };
      try { await worker.runOnce(4); } finally { worker.addresses = addresses; }
      assert.equal(changed, true); assert.equal(calls.length, 0, boundary + ' must be checked after DNS before sending');
      assert.equal(await first.getRepository(Delivery).countBy({ status: 'in_flight' }), 0);
      evidence.tests.push(boundary + ' committed during DNS preparation prevents every send in the pending wave');
    }
    for (const boundary of ['paused', 'stopping', 'lease-budget']) {
      await seed(4); const deferredWorker = makeWorker(stores[0]);
      if (boundary === 'paused') {
        const addresses = deferredWorker.addresses.bind(deferredWorker); let changed = false;
        deferredWorker.addresses = async (...args) => {
          if (!changed) { changed = true; await stores[1].transaction(tx => tx.manager.getRepository(Subscription).update(subscriptionId, { state: 'paused' })); }
          return addresses(...args);
        };
      } else if (boundary === 'stopping') {
        const preflight = deferredWorker.preflightBatch.bind(deferredWorker);
        deferredWorker.preflightBatch = async (...args) => { const result = await preflight(...args); deferredWorker.stopping = true; return result; };
      } else {
        const claim = deferredWorker.claimBatch.bind(deferredWorker);
        deferredWorker.claimBatch = async (...args) => {
          const rows = await claim(...args), expired = new Date(Date.now() - 1000).toISOString();
          await stores[0].transaction(async tx => {
            for (const row of rows) { row.leaseUntil = expired; await tx.manager.getRepository(Delivery).update(row.id, { leaseUntil: expired }); }
          });
          return rows;
        };
      }
      await deferredWorker.runOnce(4);
      assert.equal(calls.length, 0); assert.equal(await first.getRepository(Attempt).count(), 0);
      for (const row of await first.getRepository(Delivery).find()) {
        assert.equal(row.status, 'pending'); assert.equal(row.attemptCount, 0); assert.equal(row.leaseOwner, null);
        assert.deepEqual(row.lastError, {});
      }
      await stores[0].transaction(tx => tx.manager.getRepository(Subscription).update(subscriptionId, { state: 'enabled' }));
      assert.equal((await worker.runOnce(4)).succeeded, 4);
      evidence.tests.push(boundary + ': unsent wave restores ready state without consuming an attempt and a later worker sends normally');
    }

    await seed(4); responder = parsed => ({ status: 202, delayMs: parsed.data.index === 0 ? 180 : 5 });
    await worker.runOnce(4); responder = () => 202;
    const audited = await first.getRepository(Attempt).find();
    const slowDelivery = calls.find(call => call.parsed.data.index === 0).parsed.delivery.id;
    const slowAttempt = audited.find(row => row.deliveryId === slowDelivery);
    const fastAttempts = audited.filter(row => row.deliveryId !== slowDelivery);
    assert.ok(fastAttempts.every(row => Date.parse(row.completedAt) < Date.parse(slowAttempt.completedAt)),
      'fast response completion timestamps cannot be shifted to the end of the whole wave');
    for (const row of audited) assert.equal(Date.parse(row.completedAt) - Date.parse(row.startedAt), row.durationMs);
    evidence.tests.push('attempt audit preserves each actual response time while a slower sibling delays the shared commit');

    for (const boundary of ['expired-lease', 'replay']) {
      await seed(1); const [oldClaim] = await worker.claimBatch(1);
      await stores[1].transaction(async tx => {
        const row = await tx.manager.getRepository(Delivery).findOneByOrFail({ id: oldClaim.id });
        if (boundary === 'replay') Object.assign(row, { replayGeneration: row.replayGeneration + 1, version: row.version + 1,
          status: 'pending', leaseOwner: null, leaseUntil: null });
        else row.leaseUntil = new Date(0).toISOString();
        await tx.manager.getRepository(Delivery).save(row);
      });
      const [newClaim] = await worker.claimBatch(1);
      assert.notEqual(newClaim.leaseOwner, oldClaim.leaseOwner);
      const outcome = worker.outcome('succeeded', null, 1, 202, 'fixture');
      assert.deepEqual(await worker.completeBatch([{ claimed: oldClaim, outcome }]), [null]);
      assert.equal(await first.getRepository(Attempt).count(), 0);
      assert.equal((await first.getRepository(Delivery).findOneByOrFail({ id: oldClaim.id })).leaseOwner, newClaim.leaseOwner);
      assert.deepEqual(await worker.completeBatch([{ claimed: newClaim, outcome }]), ['succeeded']);
      assert.equal(await first.getRepository(Attempt).count(), 1);
      evidence.tests.push(boundary + ': stale completion from the same worker cannot modify a replacement claim or append its attempt');
    }

    await seed(4);
    const complete = worker.completeBatch.bind(worker), originalTransaction = stores[0].transaction;
    worker.completeBatch = async results => {
      stores[0].transaction = callback => originalTransaction(async tx => {
        await callback(tx); throw new Error('completion transaction unavailable');
      });
      try { return await complete(results); } finally { stores[0].transaction = originalTransaction; }
    };
    try { await assert.rejects(worker.runOnce(4), /completion transaction unavailable/); }
    finally { worker.completeBatch = complete; }
    assert.equal(calls.length, 4); assert.equal(await first.getRepository(Attempt).count(), 0);
    assert.equal(await first.getRepository(Delivery).countBy({ status: 'in_flight' }), 4);
    await stores[0].transaction(tx => tx.manager.getRepository(Delivery).createQueryBuilder().update().set({ leaseUntil: new Date(0).toISOString() }).execute());
    if (!postgres) await first.destroy();
    const restarted = await createApplicationDataSource({ ...options, synchronize: false }).initialize(); databases.push(restarted);
    const recovered = makeWorker(new Store(restarted, {}));
    assert.equal(await restarted.getRepository(Attempt).count(), 0);
    const recovery = await recovered.runOnce(4);
    assert.equal(recovery.succeeded, 4); assert.equal(calls.length, 8);
    assert.equal(await restarted.getRepository(Attempt).count(), 4);
    assert.equal(await restarted.getRepository(Delivery).countBy({ status: 'succeeded' }), 4);
    evidence.tests.push('late completion transaction failure rolls back all attempts/statuses; reopened storage recovers expired claims with explicit at-least-once network delivery');
    evidence.passed = true;
  } catch (error) { evidence.error = String(error?.stack || error); process.exitCode = 1; }
  finally {
    for (const worker of workers) await worker.onModuleDestroy();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (const db of databases) if (db.isInitialized) await db.destroy();
    if (started) { await run('pg_ctl', ['-D', data, '-w', '-t', '30', '-m', 'fast', 'stop']); evidence.stopped = true; }
    else evidence.stopped = !postgres;
    await fs.writeFile(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ directory, tests: evidence.tests.length, stopped: evidence.stopped, coalescing: evidence.coalescing, error: evidence.error }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
