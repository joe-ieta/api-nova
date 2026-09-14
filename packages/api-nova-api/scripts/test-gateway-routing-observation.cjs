'use strict';
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, project: require('path').resolve(__dirname, '../tsconfig.json') });
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ConfigService } = require('@nestjs/config');
const source = file => require('../src/' + file + '.ts');
const entities = source('database/entities/runtime-call-observability.entity');
const { RuntimeObservabilityEventEntity: Event } = source('database/entities/runtime-observability-event.entity');
const { RuntimeAssetEntity: Asset, RuntimeAssetType: AssetType } = source('database/entities/runtime-asset.entity');
const { RuntimeObservabilityStateEntity } = source('database/entities/runtime-observability-state.entity');
const { CallObservabilityStore } = source('modules/call-observability/call-observability.store');
const { GatewayRouteSnapshotService } = source('modules/gateway-runtime/services/gateway-route-snapshot.service');
const { GatewayRoutingObservationWorker, gatewayRoutingObservationConfiguration } = source('modules/gateway-runtime/services/gateway-routing-observation.worker');
const { GATEWAY_ROUTING_OBSERVER_ID: LEASE_ID, GATEWAY_ROUTING_OBSERVATION_PREFIX: PREFIX, gatewayRoutingView } = source('modules/call-observability/call-observability-gateway-routing.dto');
const { CallObservabilityServerStatusService } = source('modules/call-observability/call-observability-server-status.service');
const enabled = { API_NOVA_OBSERVABILITY_GATEWAY_ROUTING_OBSERVER_ENABLED: 'true', API_NOVA_OBSERVABILITY_GATEWAY_ROUTING_OBSERVER_INTERVAL_MS: '1000' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t) {
  const db = new DataSource({ type: 'sqljs', synchronize: true, logging: false,
    entities: [...entities.CALL_OBSERVABILITY_ENTITIES, Event, Asset, RuntimeObservabilityStateEntity] });
  await db.initialize();
  const store = new CallObservabilityStore(db, {}), workers = [];
  const persisted = { find: async () => [], create: row => row, save: async row => row };
  const registry = new GatewayRouteSnapshotService({}, {}, persisted, {}, {}, {}, {}, {}, {});
  await registry.onModuleInit();
  const makeWorker = (options = enabled, target = registry) => {
    const worker = new GatewayRoutingObservationWorker(target, store, new ConfigService(options)); workers.push(worker); return worker;
  };
  t.after(async () => { for (const worker of workers) await worker.onModuleDestroy(); await db.destroy(); });
  async function asset(type = AssetType.GATEWAY_SERVICE) {
    const id = randomUUID(); await db.getRepository(Asset).insert({ id, name: id, type }); return id;
  }
  function candidate(assetId, count = 1) {
    const revision = randomUUID();
    const entries = Array.from({ length: count }, () => ({ runtimeAsset: { id: assetId, type: AssetType.GATEWAY_SERVICE },
      membership: { id: randomUUID() }, priorityScore: 1, routeBinding: { updatedAt: new Date(), privateSecret: 'PRIVATE_INTERNAL_UPSTREAM' },
      upstreamBaseUrl: 'https://PRIVATE_INTERNAL_UPSTREAM/path', policies: { secret: 'PRIVATE_INTERNAL_UPSTREAM' } }));
    registry.candidateSnapshots.set(revision, { runtimeAssetId: assetId, entries, snapshotFingerprint: 'fixture', preparedAt: new Date() });
    return revision;
  }
  const activate = async (id, count = 1) => registry.activateCandidate(candidate(id, count));
  return { db, store, registry, makeWorker, asset, candidate, activate,
    row: id => db.getRepository(entities.RuntimePipelineStateEntity).findOneBy({ id: PREFIX + id }),
    lease: () => db.getRepository(entities.RuntimePipelineStateEntity).findOneBy({ id: LEASE_ID }),
    states: db.getRepository(entities.RuntimePipelineStateEntity), events: db.getRepository(Event) };
}

test('default disabled observer does not read registry or mutate state', async t => {
  const f = await fixture(t), worker = f.makeWorker({}, { observeRoutingAssets() { throw new Error('must not read'); } });
  worker.onApplicationBootstrap();
  await assert.rejects(worker.runOnce(), error => error.code === 'GATEWAY_ROUTING_OBSERVER_DISABLED');
  await worker.onModuleDestroy();
  assert.equal(await f.states.count(), 0); assert.equal(await f.events.count(), 0);
});

test('real active registry observation excludes unactivated candidates and exposes immutable counts only', async t => {
  const f = await fixture(t), id = await f.asset();
  f.candidate(id, 2); assert.deepEqual(f.registry.observeRoutingAssets(), []);
  await f.activate(id, 2);
  const observed = f.registry.observeRoutingAssets();
  assert.deepEqual(observed, [{ runtimeAssetId: id, activeRouteCount: 2 }]);
  assert.ok(Object.isFrozen(observed)); assert.ok(Object.isFrozen(observed[0]));
  assert.equal(JSON.stringify(observed).includes('PRIVATE_INTERNAL_UPSTREAM'), false);
  f.registry.handleSnapshotRefreshRequested({ reason: 'runtime_assets.gateway_stopped', runtimeAssetId: id });
  assert.deepEqual(f.registry.observeRoutingAssets(), []);
  assert.equal(observed[0].activeRouteCount, 2);
});

test('periodic mapped observations run without traffic and route removal means only this process has no registered routes', async t => {
  const f = await fixture(t), id = await f.asset(), worker = f.makeWorker();
  await f.activate(id, 2);
  worker.onApplicationBootstrap(); worker.onApplicationBootstrap();
  let deadline = Date.now() + 4000;
  while (!(await f.row(id)) && Date.now() < deadline) await pause(20);
  assert.equal((await f.row(id)).value.activeRouteCount, 2);
  f.registry.handleSnapshotRefreshRequested({ reason: 'runtime_assets.gateway_stopped', runtimeAssetId: id });
  deadline = Date.now() + 4000;
  while ((await f.row(id)).value.activeRouteCount !== 0 && Date.now() < deadline) await pause(20);
  const row = await f.row(id), view = gatewayRoutingView(row, id, Date.now(), await f.store.watermark());
  assert.equal(view.registrationStatus, 'no_registered_routes'); assert.equal(view.observerState, 'reporting');
  assert.equal(view.businessServerLivenessEvaluated, false); assert.equal(view.isPartial, true);
  assert.equal(await f.db.getRepository(entities.RuntimeInvocationEntity).count(), 0);
  assert.equal(await f.db.getRepository(RuntimeObservabilityStateEntity).count(), 0);
  for (const event of await f.events.find()) {
    assert.equal(event.runtimeAssetId, id); assert.equal(event.details.evidenceScope, 'local_process_routing_registry');
  }
  await worker.onModuleDestroy();
  const stopped = await f.row(id); assert.equal(stopped.value.state, 'stopped');
  assert.equal(stopped.value.lastHeartbeatAt, row.value.lastHeartbeatAt);
  assert.equal(stopped.value.activeRouteCount, row.value.activeRouteCount);
});

test('database asset type is authoritative and missing or MCP IDs in the local registry never create Gateway evidence', async t => {
  const f = await fixture(t), gateway = await f.asset(), mcp = await f.asset(AssetType.MCP_SERVER), absent = randomUUID();
  await f.activate(gateway); await f.activate(mcp); await f.activate(absent);
  const result = await f.makeWorker().runOnce(); assert.equal(result.reportedAssets, 1);
  assert.ok(await f.row(gateway)); assert.equal(await f.row(mcp), null); assert.equal(await f.row(absent), null);
  assert.equal(await f.db.getRepository(Asset).count(), 2);
  assert.deepEqual((await f.events.find()).map(row => row.runtimeAssetId), [gateway]);
});

test('another observer is fenced until lease expiry and former owner shutdown cannot overwrite takeover', async t => {
  const f = await fixture(t), id = await f.asset(), first = f.makeWorker(), second = f.makeWorker(); await f.activate(id);
  await first.runOnce(); assert.equal((await second.runOnce()).status, 'busy');
  const lease = await f.lease(); lease.value.leaseUntil = new Date(Date.now() - 1).toISOString(); await f.states.save(lease);
  await second.runOnce(); const row = await f.row(id); await first.onModuleDestroy();
  assert.deepEqual((await f.row(id)).value, row.value);
});

test('oversized catalog or registry and event insertion failures do not publish partial observations', async t => {
  const f = await fixture(t), id = await f.asset(), worker = f.makeWorker();
  await f.activate(id);
  await f.db.query("CREATE TRIGGER fail_routing BEFORE INSERT ON runtime_observability_events BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  await assert.rejects(worker.runOnce(), /fixture failure/);
  assert.equal(await f.row(id), null); assert.equal(await f.lease(), null); assert.equal(await f.store.watermark(), '0');
  await f.db.query('DROP TRIGGER fail_routing');
  await f.db.getRepository(Asset).insert(Array.from({ length: 200 }, () => { const id = randomUUID(); return { id, name: id, type: AssetType.GATEWAY_SERVICE }; }));
  await assert.rejects(worker.runOnce(), /GATEWAY_ROUTE_OBSERVATION_TOO_LARGE/);
  assert.equal(await f.lease(), null); assert.equal(await f.events.count(), 0);
  f.registry.snapshot = Array.from({ length: 10001 }, () => ({}));
  assert.throws(() => f.registry.observeRoutingAssets(), /GATEWAY_ROUTE_OBSERVATION_TOO_LARGE/);
});

test('asset scoped views expose only their own local routing evidence and never promote it to business health', async t => {
  const f = await fixture(t), visible = await f.asset(), hidden = await f.asset();
  await f.activate(visible, 2); await f.activate(hidden, 1); await f.makeWorker().runOnce();
  const service = new CallObservabilityServerStatusService(f.store);
  const authorization = { principalId: randomUUID(), runtimeAssetIds: [visible], requiredPermissions: ['monitoring:read'], fingerprint: 'a'.repeat(64) };
  const result = await service.list({}, authorization);
  assert.equal(result.data.items.length, 1); assert.equal(result.data.items[0].runtimeAssetId, visible);
  const item = result.data.items[0];
  assert.equal(item.gatewayRoutingObservation.activeRouteCount, 2);
  assert.equal(item.gatewayRoutingObservation.freshnessStatus, 'recent');
  assert.equal(item.healthStatus, 'unknown'); assert.equal(item.lastHeartbeatAt, null); assert.equal(item.freshnessStatus, 'unknown');
  assert.equal(JSON.stringify(result).includes(hidden), false); assert.equal(JSON.stringify(result).includes('PRIVATE_INTERNAL_UPSTREAM'), false);
  const row = await f.row(visible);
  assert.equal(gatewayRoutingView(row, visible, Date.parse(row.value.lastHeartbeatAt) + 3000, await f.store.watermark()).freshnessStatus, 'stale');
  assert.equal(gatewayRoutingView(row, hidden, Date.now(), await f.store.watermark()).registrationStatus, 'unknown');
});

test('registry sampling occurs after the Store writer wait and uses one coherent snapshot', async t => {
  const f = await fixture(t), id = await f.asset(), worker = f.makeWorker(); await f.activate(id);
  const transaction = f.store.transaction.bind(f.store);
  let release, entered;
  const held = new Promise(resolve => { release = resolve; }), blocked = new Promise(resolve => { entered = resolve; });
  let first = true;
  f.store.transaction = async callback => { if (first) { first = false; entered(); await held; } return transaction(callback); };
  const report = worker.runOnce(); await blocked;
  f.registry.handleSnapshotRefreshRequested({ reason: 'runtime_assets.gateway_stopped', runtimeAssetId: id });
  release(); await report;
  assert.equal((await f.row(id)).value.activeRouteCount, 0);
});


test('observer enablement is independent and strict bounded scheduling configuration is enforced', () => {
  assert.equal(gatewayRoutingObservationConfiguration(new ConfigService({ API_NOVA_OBSERVABILITY_HEARTBEAT_ENABLED: 'true' })).enabled, false);
  assert.deepEqual(gatewayRoutingObservationConfiguration(new ConfigService()), { enabled: false, intervalMs: 15000, staleAfterMs: 45000 });
  for (const value of [true, 'TRUE', '', null]) {
    assert.throws(() => gatewayRoutingObservationConfiguration(new ConfigService({ API_NOVA_OBSERVABILITY_GATEWAY_ROUTING_OBSERVER_ENABLED: value })), /INVALID_HEARTBEAT_CONFIGURATION/);
  }
  for (const value of [999, 60001, '1e3', ' 1000', null]) {
    assert.throws(() => gatewayRoutingObservationConfiguration(new ConfigService({ ...enabled, API_NOVA_OBSERVABILITY_GATEWAY_ROUTING_OBSERVER_INTERVAL_MS: value })), /INVALID_HEARTBEAT_CONFIGURATION/);
  }
});

test('shutdown waits for an active report and rejects overlapping and subsequent reports', async t => {
  const f = await fixture(t), id = await f.asset(), worker = f.makeWorker(); await f.activate(id);
  const transaction = f.store.transaction.bind(f.store);
  let release, entered;
  const held = new Promise(resolve => { release = resolve; }), blocked = new Promise(resolve => { entered = resolve; });
  let first = true;
  f.store.transaction = async callback => { if (first) { first = false; entered(); await held; } return transaction(callback); };
  const report = worker.runOnce(); await blocked;
  await assert.rejects(worker.runOnce(), error => error.code === 'STORAGE_BUSY');
  let stopped = false;
  const shutdown = worker.onModuleDestroy().then(() => { stopped = true; });
  await pause(10); assert.equal(stopped, false);
  release(); await report; await shutdown;
  assert.equal((await f.row(id)).value.state, 'stopped');
  await assert.rejects(worker.runOnce(), error => error.code === 'GATEWAY_ROUTING_OBSERVER_STOPPED');
});

test('an unready registry fails safely and periodic storage failure recovers without leaking diagnostics', async t => {
  const f = await fixture(t), id = await f.asset(), worker = f.makeWorker();
  f.registry.snapshotInitialized = false;
  await assert.rejects(worker.runOnce(), /GATEWAY_ROUTE_REGISTRY_NOT_READY/);
  assert.equal(await f.lease(), null);
  f.registry.snapshotInitialized = true;
  const transaction = f.store.transaction.bind(f.store);
  let fail = true;
  f.store.transaction = callback => { if (fail) { fail = false; return Promise.reject(new Error('PRIVATE_INTERNAL_UPSTREAM')); } return transaction(callback); };
  const write = process.stderr.write, messages = [];
  process.stderr.write = function (chunk) { messages.push(String(chunk)); return true; };
  try {
    assert.doesNotThrow(() => worker.onApplicationBootstrap());
    const deadline = Date.now() + 4000;
    while (!(await f.row(id)) && Date.now() < deadline) await pause(20);
    assert.equal((await f.row(id)).value.state, 'reporting');
    assert.ok(messages.some(message => message.includes('GATEWAY_ROUTING_OBSERVATION_DEGRADED')));
    assert.equal(messages.join('').includes('PRIVATE_INTERNAL_UPSTREAM'), false);
    await worker.onModuleDestroy();
  } finally { process.stderr.write = write; }
});
