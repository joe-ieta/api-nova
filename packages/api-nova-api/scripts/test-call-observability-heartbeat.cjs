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
const { RuntimeAssetEntity, RuntimeAssetType } = source('database/entities/runtime-asset.entity');
const { RuntimeObservabilityStateEntity } = source('database/entities/runtime-observability-state.entity');
const { CallObservabilityStore } = source('modules/call-observability/call-observability.store');
const { CallObservabilityHeartbeatWorker, MANAGEMENT_HEARTBEAT_ID, managementHeartbeatConfiguration } = source('modules/call-observability/call-observability-heartbeat.worker');
const { managementHeartbeatView } = source('modules/call-observability/call-observability-heartbeat.dto');
const { CallObservabilityServerStatusService } = source('modules/call-observability/call-observability-server-status.service');
const enabled = { API_NOVA_OBSERVABILITY_HEARTBEAT_ENABLED: 'true', API_NOVA_OBSERVABILITY_HEARTBEAT_INTERVAL_MS: '1000' };
async function fixture(t) {
  const db = new DataSource({ type: 'sqljs', synchronize: true, logging: false,
    entities: [...entities.CALL_OBSERVABILITY_ENTITIES, Event, RuntimeAssetEntity, RuntimeObservabilityStateEntity] });
  await db.initialize();
  const store = new CallObservabilityStore(db, {}), workers = [];
  const makeWorker = (options = enabled, target = store) => {
    const worker = new CallObservabilityHeartbeatWorker(target, new ConfigService(options));
    workers.push(worker); return worker;
  };
  t.after(async () => { for (const worker of workers) await worker.onModuleDestroy(); await db.destroy(); });
  return { db, store, makeWorker,
    states: db.getRepository(entities.RuntimePipelineStateEntity), events: db.getRepository(Event),
    row: () => db.getRepository(entities.RuntimePipelineStateEntity).findOneBy({ id: MANAGEMENT_HEARTBEAT_ID }) };
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: () => resolve() }; };

test('default disabled heartbeat creates no state, events or business rows', async t => {
  const f = await fixture(t), worker = f.makeWorker({});
  worker.onApplicationBootstrap();
  await assert.rejects(worker.runOnce(), error => error.code === 'HEARTBEAT_DISABLED');
  await worker.onModuleDestroy();
  assert.equal(await f.states.count(), 0); assert.equal(await f.events.count(), 0);
  assert.equal(await f.db.getRepository(RuntimeAssetEntity).count(), 0);
});

test('configuration is strict and defaults to fifteen-second reports with forty-five-second staleness', () => {
  assert.deepEqual(managementHeartbeatConfiguration(new ConfigService()), { enabled: false, intervalMs: 15000, staleAfterMs: 45000 });
  for (const value of ['TRUE', '', true, false, null, ' true']) {
    assert.throws(() => managementHeartbeatConfiguration(new ConfigService({ API_NOVA_OBSERVABILITY_HEARTBEAT_ENABLED: value })), /INVALID_HEARTBEAT_CONFIGURATION/);
  }
  for (const value of [null, true, '', '01', ' 1000', 999, 60001, 1.5, '1e3']) {
    assert.throws(() => managementHeartbeatConfiguration(new ConfigService({ ...enabled, API_NOVA_OBSERVABILITY_HEARTBEAT_INTERVAL_MS: value })), /INVALID_HEARTBEAT_CONFIGURATION/);
  }
});

test('periodic reports occur without calls, increment state version and use policy event TTL without creating business assets', async t => {
  const f = await fixture(t), worker = f.makeWorker();
  await f.db.getRepository(entities.RuntimeObservabilityPolicyEntity).insert({ id: 'global-event-retention', version: 2,
    scope: { mode: 'all' }, settings: { eventDays: 3 }, updatedAt: new Date().toISOString(), updatedBy: randomUUID() });
  worker.onApplicationBootstrap(); worker.onApplicationBootstrap();
  const deadline = Date.now() + 4000;
  while ((await f.events.count()) < 2 && Date.now() < deadline) await pause(20);
  const events = await f.events.find({ order: { sequence: 'ASC' } });
  assert.ok(events.length >= 2);
  assert.equal(events[0].subjectVersion, 1); assert.equal(events[1].subjectVersion, 2);
  for (const event of events) {
    assert.equal(event.eventName, 'pipeline.state_changed');
    assert.equal(event.details.evidenceScope, 'management_process_store_roundtrip');
    assert.equal(event.details.businessServerLivenessEvaluated, false);
    assert.equal(event.runtimeAssetId, null);
    assert.equal(event.expiresAt - event.createdAt, 3 * 86400000);
  }
  assert.equal(await f.db.getRepository(entities.RuntimeInvocationEntity).count(), 0);
  assert.equal(await f.db.getRepository(RuntimeAssetEntity).count(), 0);
  assert.equal(await f.db.getRepository(RuntimeObservabilityStateEntity).count(), 0);
  await worker.onModuleDestroy();
  assert.equal((await f.row()).value.state, 'stopped');
  const count = await f.events.count(); await pause(1050); assert.equal(await f.events.count(), count);
  await assert.rejects(worker.runOnce(), error => error.code === 'HEARTBEAT_STOPPED');
});

test('owner lease fences a second process, permits stale takeover and prevents old shutdown from overwriting the new owner', async t => {
  const f = await fixture(t), first = f.makeWorker(), second = f.makeWorker();
  assert.equal((await first.runOnce()).status, 'reported');
  const original = await f.row();
  assert.equal((await second.runOnce()).status, 'busy'); assert.equal(await f.events.count(), 1);
  original.value.leaseUntil = new Date(Date.now() - 1).toISOString(); await f.states.save(original);
  assert.equal((await second.runOnce()).status, 'reported');
  const replacement = await f.row();
  assert.notEqual(replacement.value.processInstanceId, original.value.processInstanceId);
  assert.equal(replacement.value.stateVersion, 2);
  await first.onModuleDestroy();
  assert.deepEqual((await f.row()).value, replacement.value);
});

test('failed event insert rolls back heartbeat and retries with the same first version', async t => {
  const f = await fixture(t), worker = f.makeWorker();
  await f.db.query("CREATE TRIGGER fail_heartbeat BEFORE INSERT ON runtime_observability_events BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  await assert.rejects(worker.runOnce(), /synthetic failure/);
  assert.equal(await f.row(), null); assert.equal(await f.events.count(), 0); assert.equal(await f.store.watermark(), '0');
  await f.db.query('DROP TRIGGER fail_heartbeat');
  assert.equal((await worker.runOnce()).stateVersion, 1);
});

test('single flight and shutdown wait for the pending store transaction', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const transaction = f.store.transaction.bind(f.store);
  let blocked = true;
  f.store.transaction = async callback => { if (blocked) { blocked = false; entered.resolve(); await release.promise; } return transaction(callback); };
  const worker = f.makeWorker(), active = worker.runOnce(); await entered.promise;
  await assert.rejects(worker.runOnce(), error => error.code === 'STORAGE_BUSY');
  let stopped = false;
  const shutdown = worker.onModuleDestroy().then(() => { stopped = true; });
  await pause(10); assert.equal(stopped, false);
  release.resolve(); await active; await shutdown;
  assert.equal((await f.row()).value.state, 'stopped');
});

test('freshness becomes stale without asserting offline, rejects future and malformed evidence', async t => {
  const f = await fixture(t), worker = f.makeWorker(); await worker.runOnce();
  const row = await f.row(), at = Date.parse(row.value.lastHeartbeatAt);
  assert.equal(managementHeartbeatView(row, at, row.value.snapshotSeq).freshnessStatus, 'recent');
  const stale = managementHeartbeatView(row, at + 3000, row.value.snapshotSeq);
  assert.equal(stale.freshnessStatus, 'stale'); assert.equal(stale.reportedState, 'reporting');
  assert.equal(stale.businessServerLivenessEvaluated, false);
  for (const modify of [
    value => { value.lastHeartbeatAt = new Date(at + 1000).toISOString(); },
    value => { value.snapshotSeq = '999'; }, value => { value.processInstanceId = 'secret-path'; },
    value => { value.state = 'stopped'; value.stoppedAt = new Date(at + 1).toISOString(); },
  ]) {
    const invalid = { ...row, value: { ...row.value } }; modify(invalid.value);
    const view = managementHeartbeatView(invalid, at + 10, row.value.snapshotSeq);
    assert.equal(view.freshnessStatus, 'unknown'); assert.equal(view.processInstanceId, null);
  }
  assert.equal(managementHeartbeatView(null, at).reportedState, 'unknown');
});

test('only globally authorized server status exposes management heartbeat; business server health remains unknown', async t => {
  const f = await fixture(t), worker = f.makeWorker(); await worker.runOnce();
  const assetId = randomUUID();
  await f.db.getRepository(RuntimeAssetEntity).insert({ id: assetId, name: 'synthetic-heartbeat-fixture', type: RuntimeAssetType.GATEWAY_SERVICE });
  const service = new CallObservabilityServerStatusService(f.store);
  const global = { principalId: randomUUID(), runtimeAssetIds: null, requiredPermissions: ['monitoring:read'], fingerprint: 'a'.repeat(64) };
  const result = await service.list({}, global);
  assert.equal(result.data.managementHeartbeat.freshnessStatus, 'recent');
  assert.equal(result.data.livenessEvaluated, false);
  assert.equal(result.data.items[0].lastHeartbeatAt, null);
  assert.equal(result.data.items[0].healthStatus, 'unknown');
  assert.equal(result.data.items[0].freshnessStatus, 'unknown');
  const scoped = await service.list({}, { ...global, runtimeAssetIds: [assetId] });
  assert.equal(scoped.data.managementHeartbeat, null);
  assert.equal(scoped.data.items.length, 1);
});


test('bootstrap storage failure is nonblocking, logs only a static diagnostic and retries automatically', async t => {
  const f = await fixture(t), worker = f.makeWorker();
  const transaction = f.store.transaction.bind(f.store);
  let fail = true;
  f.store.transaction = callback => {
    if (fail) { fail = false; return Promise.reject(new Error('private-password-and-path')); }
    return transaction(callback);
  };
  const write = process.stderr.write;
  const messages = [];
  process.stderr.write = function (chunk) { messages.push(String(chunk)); return true; };
  try {
    assert.doesNotThrow(() => worker.onApplicationBootstrap());
    const deadline = Date.now() + 4000;
    while (!(await f.row()) && Date.now() < deadline) await pause(20);
    assert.equal((await f.row()).value.state, 'reporting');
    assert.ok(messages.some(message => message.includes('OBSERVABILITY_HEARTBEAT_DEGRADED')));
    assert.equal(messages.join('').includes('private-password-and-path'), false);
    const invalid = f.makeWorker({ ...enabled, API_NOVA_OBSERVABILITY_HEARTBEAT_INTERVAL_MS: 'private-config' });
    assert.doesNotThrow(() => invalid.onApplicationBootstrap());
    assert.equal(messages.join('').includes('private-config'), false);
    await worker.onModuleDestroy();
  } finally { process.stderr.write = write; }
});
