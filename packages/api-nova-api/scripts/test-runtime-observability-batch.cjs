'use strict';
// Bounded integration scenarios only; no load generator or application database target.
const postgres = process.argv.includes('--postgres');
process.env.DB_TYPE = postgres ? 'postgres' : 'sqlite';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, project: path.resolve(__dirname, '../tsconfig.json') });
const { DataSource } = require('typeorm');
const { PlatformTools } = require('typeorm/platform/PlatformTools');
const { createApplicationDataSource, isCurrentSqljsWriteOwner } = require('../src/database/sqljs-persistence.ts');
const { RuntimeObservabilityService: Service } = require('../src/modules/runtime-observability/services/runtime-observability.service.ts');
const { RuntimeAssetEntity: Asset } = require('../src/database/entities/runtime-asset.entity.ts');
const { RuntimeAssetEndpointBindingEntity: Binding } = require('../src/database/entities/runtime-asset-endpoint-binding.entity.ts');
const { EndpointDefinitionEntity: Endpoint } = require('../src/database/entities/endpoint-definition.entity.ts');
const { RuntimeMetricSeriesEntity: Metric } = require('../src/database/entities/runtime-metric-series.entity.ts');
const { RuntimeObservabilityEventEntity: Event } = require('../src/database/entities/runtime-observability-event.entity.ts');
const { RuntimeObservabilityStateEntity: State } = require('../src/database/entities/runtime-observability-state.entity.ts');
const entities = [Metric, Event, State, Binding, Endpoint];
const makeService = manager => new Service(manager.getRepository(Asset), manager.getRepository(Binding), manager.getRepository(Endpoint),
  manager.getRepository(Event), manager.getRepository(Metric), manager.getRepository(State));
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG|^DATABASE_URL$/i.test(key)));
const run = (name, args) => new Promise((resolve, reject) => {
  const executable = process.env.API_NOVA_TEST_PG_BIN ? path.join(process.env.API_NOVA_TEST_PG_BIN, name + (process.platform === 'win32' ? '.exe' : '')) : name;
  const child = spawn(executable, args, { env: safeEnv, windowsHide: true, stdio: 'ignore' });
  const timer = setTimeout(() => { child.kill(); reject(new Error(name + ' timed out')); }, 45000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(name + ' exited ' + code)); });
});
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const timeout = async (promise, message = 'fixture operation timed out') => {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 10000); })]); }
  finally { clearTimeout(timer); }
};
function interceptQueries(db, intercept) {
  const create = db.createQueryRunner, installed = new Map();
  db.createQueryRunner = function (...args) {
    const runner = create.apply(this, args);
    if (!installed.has(runner)) {
      const query = runner.query; installed.set(runner, query);
      runner.query = async function (sql, ...parameters) { await intercept(sql, parameters); return query.call(this, sql, ...parameters); };
    }
    return runner;
  };
  return () => { db.createQueryRunner = create; for (const [runner, query] of installed) runner.query = query; };
}
(async () => {
  const root = path.resolve(__dirname, '../../../.tmp'); await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'runtime-batch-' + (postgres ? 'pg-' : 'sqlite-')));
  const evidence = { directory, backend: postgres ? 'postgres' : 'sqljs', tests: [], stopped: false };
  const databases = []; let started = false;
  const oldWindow = Service.prototype.toMinuteWindow;
  const windowAt = index => ({ startedAt: new Date(`2026-10-08T12:${String(index).padStart(2, '0')}:00Z`),
    endedAt: new Date(`2026-10-08T12:${String(index + 1).padStart(2, '0')}:00Z`) });
  Service.prototype.toMinuteWindow = () => windowAt(0);
  try {
    let options;
    if (postgres) {
      const data = path.join(directory, 'pgdata');
      await run('initdb', ['-D', data, '-U', 'batch_fixture', '--auth=trust', '--no-locale', '--encoding=UTF8']);
      const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); }); });
      evidence.port = port;
      await fs.appendFile(path.join(data, 'postgresql.conf'), `\nlisten_addresses='127.0.0.1'\nport=${port}\nfsync=on\nsynchronous_commit=on\nmax_connections=16\n`);
      await fs.writeFile(path.join(data, 'pg_hba.conf'), 'host all batch_fixture 127.0.0.1/32 trust\nlocal all batch_fixture trust\n');
      await run('pg_ctl', ['-D', data, '-l', path.join(directory, 'postgres.log'), '-w', '-t', '30', 'start']); started = true;
      options = { type: 'postgres', host: '127.0.0.1', port, username: 'batch_fixture', password: '', database: 'postgres', ssl: false,
        entities, extra: { max: 2, connectionTimeoutMillis: 10000, statement_timeout: 10000 } };
    } else options = { type: 'sqljs', location: path.join(directory, 'database.sqlite'), autoSave: true, entities };
    const db = await createApplicationDataSource({ ...options, synchronize: true }).initialize(); databases.push(db);
    const service = makeService(db.manager), asset = randomUUID(), firstMembership = randomUUID(), secondMembership = randomUUID();
    const source = randomUUID(), endpoints = [randomUUID(), randomUUID()];
    await db.getRepository(Endpoint).save(endpoints.map((id, index) => ({ id, sourceServiceAssetId: source, method: 'GET', path: '/endpoint-' + index })));
    await db.getRepository(Binding).save([firstMembership, secondMembership].map((id, index) => ({ id, runtimeAssetId: asset, endpointDefinitionId: endpoints[index] })));
    const input = (extra = {}) => ({ runtimeAssetId: asset, runtimeMembershipId: firstMembership, routePath: '/sample', routeMethod: 'GET',
      latencyMs: 10, statusCode: 200, success: true, requestId: randomUUID(), ...extra });
    const reset = async () => { for (const entity of [Metric, Event, State]) await db.getRepository(entity).clear(); };
    const total = (targetAsset = asset) => db.getRepository(Metric).findOneByOrFail({ runtimeAssetId: targetAsset, metricScope: 'runtime_asset', metricName: 'gateway.requests.total' });
    const snapshot = async () => {
      const result = {};
      for (const entity of [Metric, Event, State]) result[entity.name] = (await db.getRepository(entity).find()).map(row => {
        for (const key of ['id', 'createdAt', 'updatedAt', 'occurredAt', 'lastEventAt', 'lastSuccessAt', 'lastFailureAt']) delete row[key];
        return row;
      }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return result;
    };
    let queryCount = 0, exportCount = 0, commits = 0;
    const logQuery = db.logger.logQuery.bind(db.logger);
    db.logger.logQuery = (sql, ...args) => { queryCount++; if (/^COMMIT\b/.test(sql)) commits++; logQuery(sql, ...args); };
    if (!postgres) {
      const connection = db.driver.databaseConnection, originalExport = connection.export.bind(connection);
      connection.export = (...args) => { exportCount++; return originalExport(...args); };
    }
    const records = Array.from({ length: 16 }, (_, index) => input({ latencyMs: (index + 1) * 10,
      success: index % 2 === 0, statusCode: index % 2 === 0 ? 200 : 500, errorMessage: index % 2 ? 'failure-' + index : undefined }));
    queryCount = 0; exportCount = 0; commits = 0;
    for (const value of records) await db.transaction(manager => makeService(manager).recordGatewayRequestResult(value));
    const baseline = { queries: queryCount, exports: exportCount, commits };
    const expected = await snapshot(); await reset(); queryCount = 0; exportCount = 0; commits = 0;
    await timeout(Promise.all(records.map(value => service.recordGatewayRequestResult(value))));
    const actual = { queries: queryCount, exports: exportCount, commits };
    assert.deepEqual(await snapshot(), expected);
    assert.equal((await total()).value, 16); assert.equal(await db.getRepository(Event).count(), 8);
    const average = await db.getRepository(Metric).findOneByOrFail({ metricScope: 'runtime_asset', metricName: 'gateway.latency.avg_ms' });
    assert.equal(average.value, 85); assert.equal(average.sampleCount, 16);
    assert.equal(average.endpointDefinitionId, endpoints[0]); assert.equal(average.sourceServiceAssetId, source);
    assert.ok(actual.queries < baseline.queries * 0.5, `Expected real SQL coalescing: ${actual.queries}/${baseline.queries}`);
    assert.equal(actual.commits, 1);
    if (!postgres) { assert.equal(baseline.exports, 16); assert.equal(actual.exports, 1); assert.equal(db.options.autoSave, true); }
    evidence.coalescing = { records: 16, baseline, actual };
    evidence.tests.push('16 neighboring calls match immediate bound-manager oracle, with one durable transaction, fewer actual SQL statements and preserved real membership refs');

    // Existing timestamps must survive coalesced conflict updates with normal ORM semantics.
    const oldCreatedAt = new Date('2026-10-01T00:00:00.000Z'), oldUpdatedAt = new Date('2026-10-02T00:00:00.000Z');
    await db.getRepository(Metric).createQueryBuilder().update().set({ createdAt: oldCreatedAt }).execute();
    await db.getRepository(State).createQueryBuilder().update().set({ createdAt: oldCreatedAt, updatedAt: oldUpdatedAt }).execute();
    await service.recordGatewayRequestResult(input());
    for (const row of await db.getRepository(Metric).find()) assert.equal(row.createdAt.toISOString(), oldCreatedAt.toISOString());
    for (const row of await db.getRepository(State).find()) {
      assert.equal(row.createdAt.toISOString(), oldCreatedAt.toISOString());
      assert.ok(row.updatedAt.getTime() > oldUpdatedAt.getTime(), 'updatedAt must advance on a changed state');
    }
    evidence.tests.push('existing rows preserve createdAt and advance state updatedAt during conflict updates');

    await reset(); let windowIndex = 0;
    Service.prototype.toMinuteWindow = () => windowAt(Math.floor(windowIndex++ / 8));
    const mixed = records.map((row, index) => ({ ...row, runtimeMembershipId: index % 2 ? secondMembership : firstMembership }));
    for (const value of mixed) await db.transaction(manager => makeService(manager).recordGatewayRequestResult(value));
    const mixedExpected = await snapshot(); await reset(); windowIndex = 0;
    await timeout(Promise.all(mixed.map(value => service.recordGatewayRequestResult(value))));
    assert.deepEqual(await snapshot(), mixedExpected);
    const metricRows = await db.getRepository(Metric).find();
    assert.equal(new Set(metricRows.map(row => row.windowStartedAt.toISOString())).size, 2);
    assert.equal(new Set(metricRows.map(row => row.runtimeAssetEndpointBindingId)).size, 2);
    const assetState = await db.getRepository(State).findOneByOrFail({ runtimeAssetId: asset, scopeType: 'runtime_asset' });
    assert.equal(assetState.runtimeAssetEndpointBindingId, firstMembership); assert.equal(assetState.counters.requestCount, 16);
    assert.equal(assetState.gauges.lastLatencyMs, 160); assert.equal(assetState.currentStatus, 'degraded');
    Service.prototype.toMinuteWindow = () => windowAt(0);
    evidence.tests.push('two minute windows, multiple memberships, legacy NULL lookup aliases and success/error ordering match the original row semantics');

    await reset(); const eventOrder = [], originalEvent = Service.prototype.writeEvent;
    Service.prototype.writeEvent = async function (value) { eventOrder.push([value.eventName, value.details?.requestId]); return originalEvent.call(this, value); };
    try {
      await timeout(Promise.all([
        service.recordGatewayRequestResult(input({ success: false, requestId: 'first-error', errorMessage: 'first', statusCode: 500 })),
        service.recordRuntimeControlEvent({ runtimeAssetId: asset, eventFamily: 'runtime.policy', eventName: 'policy.changed', status: 'success', currentStatus: 'offline' }),
        service.recordGatewayRequestResult(input({ latencyMs: 20 })),
        service.recordGatewayCacheResult({ ...input(), cacheStatus: 'hit', requestId: 'cache' }),
        service.recordGatewayRequestResult(input({ success: false, latencyMs: 30, requestId: 'last-error', errorMessage: 'last', statusCode: 503 })),
      ]));
    } finally { Service.prototype.writeEvent = originalEvent; }
    assert.deepEqual(eventOrder, [['gateway.request_failed', 'first-error'], ['policy.changed', undefined], ['gateway.cache_hit', 'cache'], ['gateway.request_failed', 'last-error']]);
    const finalState = await db.getRepository(State).findOneByOrFail({ runtimeAssetId: asset, scopeType: 'runtime_asset' });
    assert.deepEqual(finalState.counters, { requestCount: 3, successCount: 1, errorCount: 2, 'policy.changed': 1, 'gateway.cache.hit': 1 });
    assert.equal(finalState.currentStatus, 'degraded'); assert.equal(finalState.gauges.lastLatencyMs, 30); assert.equal(finalState.lastErrorMessage, 'last');
    evidence.tests.push('cache/control are FIFO barriers; no request batch crosses them or loses per-call failure events and last state');

    for (const stage of ['late-state-sql', 'commit-before-execute']) {
      await reset(); let injected = false;
      const restore = interceptQueries(db, async sql => {
        if (!injected && (stage === 'commit-before-execute' ? /^COMMIT\b/.test(sql) : /^(?:INSERT INTO|UPDATE) "runtime_observability_states"/.test(sql))) {
          injected = true; throw new Error(stage);
        }
      });
      let outcomes; try { outcomes = await timeout(Promise.allSettled(records.map(value => service.recordGatewayRequestResult(value)))); }
      finally { restore(); }
      assert.equal(injected, true); assert.ok(outcomes.every(row => row.status === 'rejected' && String(row.reason).includes(stage)));
      for (const entity of [Metric, Event, State]) assert.equal(await db.getRepository(entity).count(), 0);
      await timeout(Promise.all(records.map(value => service.recordGatewayRequestResult(value))));
      assert.equal((await total()).value, 16);
      evidence.tests.push(stage + ': all 16 reject, full rollback, no automatic retry, and an explicit fresh batch succeeds');
    }

    await reset(); let firstBatchFailed = false;
    const restoreFirstFailure = interceptQueries(db, async sql => {
      if (!firstBatchFailed && /^COMMIT\b/.test(sql)) { firstBatchFailed = true; throw new Error('first batch only'); }
    });
    let continued;
    try { continued = await timeout(Promise.allSettled(Array.from({ length: 32 }, () => service.recordGatewayRequestResult(input())))); }
    finally { restoreFirstFailure(); }
    assert.ok(continued.slice(0, 16).every(row => row.status === 'rejected'));
    assert.ok(continued.slice(16).every(row => row.status === 'fulfilled'));
    assert.equal((await total()).value, 16);
    evidence.tests.push('a failed first 16-call batch rejects only its own cohort and the already waiting successor batch still commits');

    await reset();
    await assert.rejects(timeout(db.transaction(async manager => {
      const scoped = makeService(manager); await scoped.recordGatewayRequestResult(input());
      await scoped.recordGatewayRequestResult(input({ success: false, statusCode: 500 }));
      throw new Error('outer rollback');
    })), /outer rollback/);
    for (const entity of [Metric, Event, State]) assert.equal(await db.getRepository(entity).count(), 0);
    evidence.tests.push('bound manager bypasses batching, preserves legitimate nesting and leaves no projections after outer rollback');

    await reset(); queryCount = 0; exportCount = 0; commits = 0;
    const sameSourceService = makeService(db.manager);
    const batchSizes = [], executeBatch = Service.prototype.executeRuntimeWriteBatch;
    Service.prototype.executeRuntimeWriteBatch = function (assetId, jobs, batch) {
      if (assetId === asset && batch) batchSizes.push(jobs.length);
      return executeBatch.call(this, assetId, jobs, batch);
    };
    try { await timeout(Promise.all(Array.from({ length: 33 }, (_, index) => (index % 2 ? sameSourceService : service).recordGatewayRequestResult(input({ latencyMs: index + 1 }))))); }
    finally { Service.prototype.executeRuntimeWriteBatch = executeBatch; }
    assert.deepEqual(batchSizes, [16, 16, 1]);
    assert.equal((await total()).value, 33); assert.equal(commits, 3);
    if (!postgres) assert.equal(exportCount, 3);
    evidence.tests.push('two service instances on the same DataSource share one FIFO: 33 calls split into 16/16/1 durable batches without starving the tail');

    if (!postgres) {
      await reset(); const entered = deferred(), release = deferred(); const originalWrite = PlatformTools.writeFile;
      let resolved = 0;
      PlatformTools.writeFile = async function (...args) { entered.resolve(); await release.promise; return originalWrite.apply(this, args); };
      const pending = records.map(value => service.recordGatewayRequestResult(value).then(() => { resolved++; }));
      try { await timeout(entered.promise); assert.equal(resolved, 0); }
      finally { release.resolve(); await timeout(Promise.all(pending)); PlatformTools.writeFile = originalWrite; }
      assert.equal(resolved, 16);
      const reader = await new DataSource({ ...options, autoSave: false }).initialize();
      try { assert.equal((await reader.getRepository(Metric).findOneByOrFail({ metricScope: 'runtime_asset', metricName: 'gateway.requests.total' })).value, 16); }
      finally { await reader.destroy(); }
      evidence.tests.push('all 16 promises await the real snapshot write; an independent reopened SQLite file contains the entire committed batch');

      // Root repositories intentionally support same-owner SQL.js transaction
      // reentry. A batching timer must not merge an independent caller into it.
      await reset(); const submittedInside = deferred(), letOuterProceed = deferred();
      const outerRootCall = db.transaction(async () => {
        const inside = service.recordGatewayRequestResult(input({ latencyMs: 10 }));
        submittedInside.resolve(); await letOuterProceed.promise;
        await inside; throw new Error('outer root call rollback');
      });
      // Attach the rejection observer immediately; the independent call belongs to
      // this outside async context, not the callback that currently owns SQL.js.
      const outerResult = assert.rejects(outerRootCall, /outer root call rollback/);
      await timeout(submittedInside.promise);
      const outsideRootCall = service.recordGatewayRequestResult(input({ latencyMs: 30 }));
      letOuterProceed.resolve();
      await timeout(Promise.all([outerResult, outsideRootCall]), 'root ALS ownership mixed or deadlocked');
      assert.equal((await total()).value, 1);
      assert.equal((await db.getRepository(Metric).findOneByOrFail({ metricScope: 'runtime_asset', metricName: 'gateway.latency.avg_ms' })).value, 30);
      evidence.tests.push("an independent SQL.js root caller never joins another root caller's ambient transaction or disappears when that owner rolls back");

      await reset(); const triggerDetached = deferred(), detachedEntered = deferred(); let detached;
      await db.transaction(async () => {
        assert.equal(isCurrentSqljsWriteOwner(db), true);
        detached = triggerDetached.promise.then(async () => {
          assert.equal(isCurrentSqljsWriteOwner(db), false, 'expired context cannot own a later transaction');
          detachedEntered.resolve();
          await service.recordGatewayRequestResult(input({ latencyMs: 40 }));
        });
      });
      const nextOwnerEntered = deferred(), releaseNextOwner = deferred(); let detachedFinished = false;
      const nextOwner = db.transaction(async () => {
        assert.equal(isCurrentSqljsWriteOwner(db), true);
        nextOwnerEntered.resolve(); await releaseNextOwner.promise;
        throw new Error('new owner rollback');
      });
      const nextOwnerResult = assert.rejects(nextOwner, /new owner rollback/);
      await timeout(nextOwnerEntered.promise);
      detached.then(() => { detachedFinished = true; }, () => {});
      triggerDetached.resolve();
      try {
        await timeout(detachedEntered.promise);
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(detachedFinished, false, 'stale token must wait outside the current owner');
      } finally { releaseNextOwner.resolve(); }
      await timeout(Promise.all([nextOwnerResult, detached]));
      assert.equal((await total()).value, 1);
      evidence.tests.push('a detached callback with an expired ALS token cannot bypass a later owner or be erased by its rollback');

      // A filesystem error after SQL COMMIT is a different boundary from a rejected
      // COMMIT statement. Observe it explicitly instead of claiming it rolled back.
      await reset();
      PlatformTools.writeFile = async function () { throw new Error('post-commit snapshot unavailable'); };
      let unavailable, memoryTotal, diskTotal;
      try {
        unavailable = await timeout(Promise.allSettled(records.map(value => service.recordGatewayRequestResult(value))));
        assert.ok(unavailable.every(row => row.status === 'rejected'));
        const native = db.driver.databaseConnection.exec("SELECT value FROM runtime_metric_series WHERE metricScope = 'runtime_asset' AND metricName = 'gateway.requests.total'");
        memoryTotal = native[0]?.values[0][0] ?? 0;
        const oldReader = await new DataSource({ ...options, autoSave: false }).initialize();
        try { diskTotal = (await oldReader.getRepository(Metric).findOneBy({ metricScope: 'runtime_asset', metricName: 'gateway.requests.total' }))?.value ?? 0; }
        finally { await oldReader.destroy(); }
      } finally { PlatformTools.writeFile = originalWrite; }
      assert.ok([0, 16].includes(memoryTotal)); assert.ok([0, 16].includes(diskTotal));
      evidence.postCommitPersistenceFailure = { rejected: unavailable.length, memoryTotal, diskTotal,
        boundary: 'Post-COMMIT save failure is not evidence of rollback; callers are rejected and the scheduler must not replay the batch.' };
      evidence.tests.push('post-COMMIT filesystem failure rejects the whole cohort and records the actual memory/disk outcome without asserting a safe retry');

    } else {
      await reset(); const other = await new DataSource({ ...options, synchronize: false }).initialize(); databases.push(other);
      const secondService = makeService(other.manager);
      await timeout(Promise.all(Array.from({ length: 32 }, (_, index) => (index % 2 ? secondService : service).recordGatewayRequestResult(input({
        latencyMs: index + 1, success: index % 2 === 0, statusCode: index % 2 === 0 ? 200 : 500,
      })))));
      assert.equal((await total()).value, 32);
      const avg = await db.getRepository(Metric).findOneByOrFail({ metricScope: 'runtime_asset', metricName: 'gateway.latency.avg_ms' });
      assert.equal(avg.sampleCount, 32); assert.ok(Math.abs(avg.value - 16.5) < 1e-10);
      assert.equal(await db.getRepository(Metric).count(), 6); assert.equal(await db.getRepository(State).count(), 2); assert.equal(await db.getRepository(Event).count(), 16);
      for (const state of await db.getRepository(State).find()) assert.deepEqual(state.counters, { requestCount: 32, successCount: 16, errorCount: 16 });
      evidence.tests.push('two independent PostgreSQL DataSources preserve first-insert uniqueness, exact counts, means, refs and all failure events');

      await reset(); let contender;
      await assert.rejects(timeout(db.transaction(async manager => {
        await makeService(manager).recordGatewayRequestResult(input());
        contender = Promise.all(records.map(row => service.recordGatewayRequestResult(row)));
        await new Promise(resolve => setTimeout(resolve, 10));
        await makeService(manager).recordGatewayRequestResult(input());
        throw new Error('outer owner rollback');
      }), 'bound manager deadlocked behind its own root lane'), /outer owner rollback/);
      await timeout(contender); assert.equal((await total()).value, 16);
      evidence.tests.push('bound owner reenters while a root batch waits on its advisory lock; rollback cannot erase the subsequent independent batch');
    }
    evidence.passed = true;
  } catch (error) { evidence.error = String(error?.stack || error); process.exitCode = 1; }
  finally {
    Service.prototype.toMinuteWindow = oldWindow;
    for (const db of databases) if (db.isInitialized) await db.destroy();
    if (started) { await run('pg_ctl', ['-D', path.join(directory, 'pgdata'), '-w', '-t', '30', '-m', 'fast', 'stop']); evidence.stopped = true; }
    else evidence.stopped = !postgres;
    await fs.writeFile(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ directory, tests: evidence.tests.length, stopped: evidence.stopped, coalescing: evidence.coalescing, error: evidence.error }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
