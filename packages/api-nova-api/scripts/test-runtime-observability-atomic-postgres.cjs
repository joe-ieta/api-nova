'use strict';
// Independent PostgreSQL cluster, two independent DataSources. No inherited DB target.
process.env.DB_TYPE = 'postgres';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, project: path.resolve(__dirname, '../tsconfig.json') });
const { DataSource } = require('typeorm');
const { RuntimeObservabilityService: Service } = require('../src/modules/runtime-observability/services/runtime-observability.service.ts');
const { RuntimeAssetEntity: Asset } = require('../src/database/entities/runtime-asset.entity.ts');
const { RuntimeAssetEndpointBindingEntity: Binding } = require('../src/database/entities/runtime-asset-endpoint-binding.entity.ts');
const { EndpointDefinitionEntity: Endpoint } = require('../src/database/entities/endpoint-definition.entity.ts');
const { RuntimeMetricSeriesEntity: Metric } = require('../src/database/entities/runtime-metric-series.entity.ts');
const { RuntimeObservabilityEventEntity: Event } = require('../src/database/entities/runtime-observability-event.entity.ts');
const { RuntimeObservabilityStateEntity: State } = require('../src/database/entities/runtime-observability-state.entity.ts');
const entities = [Metric, Event, State];
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG|^DATABASE_URL$/i.test(key)));
const run = (name, args) => new Promise((resolve, reject) => {
  const executable = process.env.API_NOVA_TEST_PG_BIN ? path.join(process.env.API_NOVA_TEST_PG_BIN, name + (process.platform === 'win32' ? '.exe' : '')) : name;
  const child = spawn(executable, args, { env: safeEnv, windowsHide: true, stdio: 'ignore' });
  const timer = setTimeout(() => { child.kill(); reject(new Error(name + ' timed out')); }, 45000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(name + ' exited ' + code)); });
});
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const makeService = manager => new Service(manager.getRepository(Asset), manager.getRepository(Binding), manager.getRepository(Endpoint),
  manager.getRepository(Event), manager.getRepository(Metric), manager.getRepository(State));
Service.prototype.resolveRuntimeRefs = async (runtimeAssetId, runtimeAssetEndpointBindingId) => ({ runtimeAssetId, runtimeAssetEndpointBindingId });
Service.prototype.toMinuteWindow = () => ({ startedAt: new Date('2026-10-08T12:00:00Z'), endedAt: new Date('2026-10-08T12:01:00Z') });
(async () => {
  const root = path.resolve(__dirname, '../../../.tmp'); await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'legacy-runtime-pg-')); const data = path.join(directory, 'pgdata');
  const evidence = { directory, tests: [], stopped: false }; let started = false; const databases = [];
  try {
    await run('initdb', ['-D', data, '-U', 'runtime_fixture', '--auth=trust', '--no-locale', '--encoding=UTF8']);
    const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); }); });
    evidence.port = port;
    await fs.appendFile(path.join(data, 'postgresql.conf'), `\nlisten_addresses='127.0.0.1'\nport=${port}\nfsync=on\nsynchronous_commit=on\nmax_connections=16\n`);
    await fs.writeFile(path.join(data, 'pg_hba.conf'), 'host all runtime_fixture 127.0.0.1/32 trust\nlocal all runtime_fixture trust\n');
    await run('pg_ctl', ['-D', data, '-l', path.join(directory, 'postgres.log'), '-w', '-t', '30', 'start']); started = true;
    const options = { type: 'postgres', host: '127.0.0.1', port, username: 'runtime_fixture', password: '', database: 'postgres', ssl: false,
      entities, extra: { max: 2, connectionTimeoutMillis: 10000, statement_timeout: 20000 } };
    const first = await new DataSource({ ...options, synchronize: true }).initialize(); databases.push(first);
    const second = await new DataSource({ ...options, synchronize: false }).initialize(); databases.push(second);
    const services = databases.map(db => makeService(db.manager)); const asset = randomUUID(), membership = randomUUID();
    const input = extra => ({ runtimeAssetId: asset, runtimeMembershipId: membership, routePath: '/sample', routeMethod: 'GET',
      latencyMs: 10, statusCode: 200, success: true, ...extra });
    await Promise.all(Array.from({ length: 20 }, (_, index) => services[index % 2].recordGatewayRequestResult(input({
      latencyMs: (index + 1) * 10, success: index % 2 === 0, statusCode: index % 2 === 0 ? 200 : 500,
    }))));
    const metric = name => first.getRepository(Metric).findOneByOrFail({ metricScope: 'runtime_asset', metricName: name });
    assert.equal((await metric('gateway.requests.total')).value, 20);
    assert.equal((await metric('gateway.requests.success')).value, 10); assert.equal((await metric('gateway.requests.error')).value, 10);
    assert.equal((await metric('gateway.latency.avg_ms')).sampleCount, 20); assert.ok(Math.abs((await metric('gateway.latency.avg_ms')).value - 105) < 1e-9);
    assert.equal(await first.getRepository(Metric).count(), 6); assert.equal(await first.getRepository(State).count(), 2);
    for (const state of await first.getRepository(State).find()) assert.deepEqual(state.counters, { requestCount: 20, successCount: 10, errorCount: 10 });
    assert.equal(await first.getRepository(Event).count(), 10); evidence.tests.push('two independent DataSources preserve first-insert uniqueness, exact counts and weighted mean');
    await Promise.all([
      ...Array.from({ length: 4 }, (_, i) => services[i % 2].recordGatewayCacheResult({ ...input(), cacheStatus: 'hit' })),
      ...Array.from({ length: 4 }, (_, i) => services[i % 2].recordRuntimeControlEvent({ runtimeAssetId: asset, eventFamily: 'runtime.policy',
        eventName: 'policy.changed', status: 'success' })),
    ]);
    const state = await first.getRepository(State).findOneByOrFail({ scopeType: 'runtime_asset', runtimeAssetId: asset });
    assert.equal(state.counters.requestCount, 20); assert.equal(state.counters['gateway.cache.hit'], 4); assert.equal(state.counters['policy.changed'], 4);
    evidence.tests.push('request/cache/control operations share the same cross-connection asset lock');
    const originalEvent = Service.prototype.writeEvent;
    Service.prototype.writeEvent = async function (event) { if (event.details?.requestId === 'inject-final-event') throw new Error('injected final event'); return originalEvent.call(this, event); };
    const retry = input({ success: false, statusCode: 500, requestId: 'inject-final-event', latencyMs: 210 });
    await assert.rejects(services[1].recordGatewayRequestResult(retry), /injected final event/);
    assert.equal((await metric('gateway.requests.total')).value, 20); assert.equal((await metric('gateway.latency.avg_ms')).sampleCount, 20);
    Service.prototype.writeEvent = originalEvent; await services[0].recordGatewayRequestResult(retry);
    assert.equal((await metric('gateway.requests.total')).value, 21); assert.equal((await metric('gateway.requests.error')).value, 11);
    assert.equal((await metric('gateway.latency.avg_ms')).sampleCount, 21); assert.ok(Math.abs((await metric('gateway.latency.avg_ms')).value - 110) < 1e-9);
    evidence.tests.push('late failure rolls back all projections, releases lock and retry applies exactly once');
    await assert.rejects(first.transaction(async manager => {
      await makeService(manager).recordGatewayRequestResult(input()); throw new Error('outer rollback');
    }), /outer rollback/);
    assert.equal((await metric('gateway.requests.total')).value, 21);
    evidence.tests.push('bound transaction manager preserves nested savepoint and outer rollback');
    const gatedAsset = randomUUID(), entered = deferred(), release = deferred();
    const originalRefs = Service.prototype.resolveRuntimeRefs; let firstEntry = true;
    Service.prototype.resolveRuntimeRefs = async function (assetId, bindingId) {
      if (assetId === gatedAsset && firstEntry) { firstEntry = false; entered.resolve(); await release.promise; }
      return originalRefs.call(this, assetId, bindingId);
    };
    const queued = Array.from({ length: 20 }, () => services[0].recordGatewayRequestResult(input({ runtimeAssetId: gatedAsset })));
    try {
      await entered.promise; await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(first.driver.master.options.max, 2);
      assert.equal(first.driver.master.waitingCount, 0, 'same-asset waiters must not occupy or queue for a PostgreSQL connection');
      let timeout;
      const result = await Promise.race([
        first.query('SELECT 1 AS value'),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('unrelated SELECT starved behind advisory waiters')), 1500); }),
      ]).finally(() => clearTimeout(timeout));
      assert.equal(result[0].value, 1);
    } finally {
      release.resolve(); await Promise.all(queued); Service.prototype.resolveRuntimeRefs = originalRefs;
    }
    assert.equal((await first.getRepository(Metric).findOneByOrFail({ runtimeAssetId: gatedAsset, metricScope: 'runtime_asset', metricName: 'gateway.requests.total' })).value, 20);
    evidence.tests.push('max=2 pool retains an unrelated SELECT connection while 20 same-asset operations await local admission');
    const nestedAsset = randomUUID(); let contender;
    await assert.rejects(first.transaction(async manager => {
      await makeService(manager).recordGatewayRequestResult(input({ runtimeAssetId: nestedAsset }));
      contender = services[0].recordGatewayRequestResult(input({ runtimeAssetId: nestedAsset }))
        .then(() => null, error => error);
      await new Promise(resolve => setTimeout(resolve, 20));
      let timeout;
      await Promise.race([
        makeService(manager).recordGatewayRequestResult(input({ runtimeAssetId: nestedAsset })),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('bound manager queued behind its own PostgreSQL lock')), 1500); }),
      ]).finally(() => clearTimeout(timeout));
      throw new Error('outer protected rollback');
    }), /outer protected rollback/);
    assert.equal(await contender, null);
    assert.equal((await first.getRepository(Metric).findOneByOrFail({ runtimeAssetId: nestedAsset, metricScope: 'runtime_asset', metricName: 'gateway.requests.total' })).value, 1);
    evidence.tests.push('bound manager bypasses local admission while a root caller waits on its outer PostgreSQL lock; outer rollback does not erase the independent caller');


  } catch (error) { evidence.error = String(error?.stack || error); process.exitCode = 1; }
  finally {
    for (const db of databases) if (db.isInitialized) await db.destroy();
    if (started) { await run('pg_ctl', ['-D', data, '-w', '-t', '30', '-m', 'fast', 'stop']); evidence.stopped = true; }
    await fs.writeFile(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ directory, passed: evidence.tests.length, stopped: evidence.stopped, error: evidence.error }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
