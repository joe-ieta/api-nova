'use strict';
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
require('ts-node').register({ project: require('node:path').join(__dirname, '../tsconfig.json'), transpileOnly: true });
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const request = require('supertest');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { ConfigService } = require('@nestjs/config');
const { JwtService } = require('@nestjs/jwt');
const { SwaggerModule, DocumentBuilder } = require('@nestjs/swagger');
const { normalizeRuntimeAuditRecord } = require('../../api-nova-parser/src/audit/runtime-observability-contract.ts');
const { RuntimeInvocationRevisionEntity: Revision, RuntimeAccessSourceEntity: Source, RuntimePipelineStateEntity: Pipeline } =
  require('../src/database/entities/runtime-call-observability.entity.ts');
const { RuntimeAssetEntity: Asset } = require('../src/database/entities/runtime-asset.entity.ts');
const { RuntimeObservabilityStateEntity: State } = require('../src/database/entities/runtime-observability-state.entity.ts');
const { CallObservabilityStore } = require('../src/modules/call-observability/call-observability.store.ts');
const { sequenceKey } = require('../src/modules/call-observability/call-observability-storage.ts');
const { CallObservabilityOverviewSnapshotAuthorizer: Snapshots } = require('../src/modules/call-observability/call-observability-overview-snapshot-authorizer.service.ts');
const { RuntimeObservabilityEventEntity: Event } = require('../src/database/entities/runtime-observability-event.entity.ts');
const { CallObservabilityEventsService: Events } = require('../src/modules/call-observability/call-observability-events.service.ts');
const { ObservabilityCursorService: Cursors } = require('../src/modules/call-observability/call-observability-cursor.service.ts');
const { CallObservabilityOverviewService: Overview } = require('../src/modules/call-observability/call-observability-overview.service.ts');
const { CallObservabilityDependenciesService: Dependencies } = require('../src/modules/call-observability/call-observability-dependencies.service.ts');
const { CallObservabilityServerStatusService: Servers } = require('../src/modules/call-observability/call-observability-server-status.service.ts');
const { CallObservabilityOverviewController } = require('../src/modules/call-observability/call-observability-overview.controller.ts');
const { CallObservabilityDependenciesController } = require('../src/modules/call-observability/call-observability-dependencies.controller.ts');
const { CallObservabilityServerStatusController } = require('../src/modules/call-observability/call-observability-server-status.controller.ts');
const { ObservabilityAccessGuard } = require('../src/modules/call-observability/call-observability-access.guard.ts');
const { UserService } = require('../src/modules/security/services/user.service.ts');
const window = { from: '2026-09-09T00:00:00.000Z', to: '2026-09-09T01:00:00.000Z' };
const authorization = ids => ({ principalId: 'reader', runtimeAssetIds: ids, requiredPermissions: ['monitoring:read'], fingerprint: require('node:crypto').createHash('sha256').update(JSON.stringify(ids)).digest('hex') });
async function fixture(t) {
  const db = new DataSource({ type: 'sqljs', entities: [Revision, Source, Pipeline, Asset, State, Event],
    synchronize: true, logging: false });
  await db.initialize();
  t.after(async () => { if (db.isInitialized) await db.destroy(); });
  await db.getRepository(Pipeline).save({ id: 'call-observability:commit-sequence',
    value: { sequence: sequenceKey(20) }, updatedAt: new Date().toISOString() });
  const store = new CallObservabilityStore(db, { read() { throw new Error('Payload reads forbidden'); } });
  const original = store.readSnapshot.bind(store);
  let snapshots = 0;
  store.readSnapshot = callback => { snapshots++; return original(callback); };
  const grants = new Snapshots(), servers = new Servers(store), overview = new Overview(store, servers, grants), dependencies = new Dependencies(store);
  async function asset(id = 'asset-a', type = 'gateway_service', status = 'active') {
    return db.getRepository(Asset).save({ id, name: id, type, status, metadata: { secret: 'private-marker' } });
  }
  async function add(overrides = {}, projection = {}) {
    const record = normalizeRuntimeAuditRecord({ schemaVersion: 2, invocationId: randomUUID(), eventId: randomUUID(),
      sourceInstanceId: 'producer', sourceSequence: 1, recordVersion: 1, requestId: 'private-marker',
      runtimeAssetId: 'asset-a', serverType: 'gateway', spanKind: 'gateway_request', phase: 'finished',
      startedAt: '2026-09-09T00:00:01.000Z', completedAt: '2026-09-09T00:00:02.000Z',
      outcome: 'success', origin: 'external', cacheHit: true, ...overrides });
    const row = { id: randomUUID(), invocationId: record.invocationId, sourceInstanceId: 'producer',
      sourceRecordVersion: 1, recordVersion: 1, recordHash: 'hash', createdSequence: sequenceKey(1),
      updatedSequence: sequenceKey(1), traceId: record.traceId, parentInvocationId: record.parentInvocationId,
      runtimeAssetId: record.runtimeAssetId, serverType: record.serverType, spanKind: record.spanKind,
      origin: record.origin, callerId: record.callerId, sourceId: null,
      endpointDefinitionId: record.endpointDefinitionId, sourceServiceInstanceId: record.sourceServiceInstanceId,
      toolName: record.toolName, startedAt: record.startedAt, completedAt: record.completedAt,
      outcome: record.outcome, phase: record.phase, requestPayloadId: null, responsePayloadId: null,
      record, expiresAt: '2099-01-01T00:00:00.000Z', ingestedAt: '2026-09-09T00:00:03.000Z',
      validFromSequence: sequenceKey(1), validUntilSequence: null, ...projection };
    await db.getRepository(Revision).insert(row);
    return row;
  }
  return { db, store, servers, overview, dependencies, grants, asset, add, snapshots: () => snapshots };
}
test('overview shares one read snapshot, authorization and honest per-block watermarks', async t => {
  const f = await fixture(t);
  await f.asset(); await f.asset('hidden-asset'); await f.asset('idle-asset', 'mcp_server', 'offline');
  await f.add(); await f.add({ spanKind: 'upstream_api', outcome: 'timeout' });
  await f.add({ runtimeAssetId: 'hidden-asset' });
  const before = await f.db.getRepository(Pipeline).findOneBy({ id: 'call-observability:commit-sequence' });
  const result = await f.overview.get(window, authorization(['asset-a', 'idle-asset']));
  assert.equal(f.snapshots(), 1);
  assert.equal(result.data.businessSummary.metrics.selectedInvocations, 1);
  assert.equal(result.data.upstreamSummary.metrics.failures, 1);
  assert.equal(result.data.snapshotSeq, '20');
  for (const block of [result.data.businessSummary, result.data.upstreamSummary]) {
    assert.equal(block.dataWatermark, '20'); assert.equal(block.coverage.isPartial, true);
    assert.equal(block.coverage.historyCompleteSince, null);
  }
  assert.equal(result.data.serverStates.dataWatermark, null);
  assert.equal(result.data.serverStates.invocationDataWatermark, '20');
  assert.equal('dataWatermark' in result.meta, false);
  assert.deepEqual(result.data.unavailableSections, ['pipeline', 'recentEvents']);
  assert.equal('pipeline' in result.data, false);
  assert.equal('recentEvents' in result.data, false);
  assert.equal(result.data.serverStates.items.length, 2);
  assert.equal(JSON.stringify(result).includes('hidden-asset'), false);
  assert.equal(JSON.stringify(result).includes('private-marker'), false);
  assert.deepEqual(await f.db.getRepository(Pipeline).findOneBy({ id: before.id }), before);
});
test('empty observed traffic preserves unknown coverage, including an authorized idle asset', async t => {
  const f = await fixture(t); await f.asset();
  const result = await f.overview.get(window, authorization(['asset-a']));
  assert.equal(result.data.upstreamSummary.metrics.upstreamRequests, 0);
  assert.equal(result.data.upstreamSummary.coverage.observationHealth, 'unknown');
  const value = result.data.serverStates.items[0];
  assert.equal(value.observedBusinessRequests, 0);
  assert.equal(value.activeInvocations, null); assert.equal(value.healthStatus, 'unknown');
});
test('no-grant and forbidden requested assets return no resource identifiers or hidden totals', async t => {
  const f = await fixture(t); await f.asset(); await f.add();
  for (const [query, auth] of [[window, authorization([])], [{ ...window, runtimeAssetId: 'asset-a' }, authorization(['other'])]]) {
    const a = (await f.overview.get(query, auth)).data;
    assert.equal(a.businessSummary.metrics.selectedInvocations, 0); assert.deepEqual(a.serverStates.items, []);
    assert.deepEqual((await f.dependencies.list(query, auth)).data.items, []);
    assert.deepEqual((await f.servers.list(query, auth)).data.items, []);
  }
});
test('window, origin, serverType, retention and MVCC revision predicates precede aggregation', async t => {
  const f = await fixture(t); await f.asset(); await f.asset('mcp', 'mcp_server');
  await f.add({ invocationId: 'revised', outcome: 'error' }, { validUntilSequence: sequenceKey(10) });
  await f.add({ invocationId: 'revised' }, { recordVersion: 2, validFromSequence: sequenceKey(10) });
  await f.add({ invocationId: 'future' }, { validFromSequence: sequenceKey(21) });
  await f.add({}, { expiresAt: '2000-01-01T00:00:00.000Z' });
  await f.add({ startedAt: window.to }); await f.add({ origin: 'probe' });
  await f.add({ runtimeAssetId: 'mcp', serverType: 'mcp', spanKind: 'mcp_tool' });
  const result = (await f.overview.get({ ...window, serverType: 'gateway' }, authorization(null))).data;
  assert.equal(result.businessSummary.metrics.selectedInvocations, 1); assert.equal(result.businessSummary.metrics.failures, 0);
  assert.equal(result.serverStates.items.length, 1);
  assert.equal((await f.overview.get({ ...window, origin: 'probe' }, authorization(null))).data.businessSummary.metrics.selectedInvocations, 1);
});
test('dependency failures deduplicate affected roots and retry redirects without exposing links', async t => {
  const f = await fixture(t);
  await f.add({ invocationId: 'root', traceId: 'trace', rootInvocationId: 'root' });
  const up = { spanKind: 'upstream_api', parentInvocationId: 'root', rootInvocationId: 'root', traceId: 'trace',
    endpointDefinitionId: 'endpoint', sourceServiceInstanceId: 'upstream', upstreamOperationId: 'operation',
    attemptIndex: 2, outcome: 'error' };
  await f.add({ ...up, redirectHopIndex: 0 }); await f.add({ ...up, redirectHopIndex: 1 });
  await f.add({ ...up, outcome: 'success', attemptIndex: 3 });
  const data = (await f.dependencies.list(window, authorization(['asset-a']))).data;
  assert.equal(data.items.length, 1);
  const item = data.items[0];
  assert.equal(item.upstreamRequests, 3); assert.equal(item.failures, 2); assert.equal(item.retryAttempts, 2);
  assert.equal(item.affectedBusinessRequests, 1); assert.equal(item.unlinkedFailureRecords, 0);
  assert.equal(item.relationshipsComplete, true); assert.equal(item.lastFailureAt, '2026-09-09T00:00:02.000Z');
  assert.equal(JSON.stringify(data).includes('"root"'), false);
});
test('hidden, expired, cross-asset and cross-trace roots remain unresolved, including for global readers', async t => {
  const f = await fixture(t);
  await f.add({ invocationId: 'hidden-root', runtimeAssetId: 'hidden', traceId: 'trace' });
  await f.add({ invocationId: 'expired-root', traceId: 'trace' }, { expiresAt: '2000-01-01T00:00:00.000Z' });
  await f.add({ invocationId: 'other-trace', traceId: 'other' });
  for (const root of ['hidden-root', 'expired-root', 'other-trace', 'missing-root']) {
    await f.add({ spanKind: 'upstream_api', traceId: 'trace', parentInvocationId: root, rootInvocationId: root, outcome: 'error' });
  }
  for (const auth of [authorization(['asset-a']), authorization(null)]) {
    const item = (await f.dependencies.list(window, auth)).data.items[0];
    assert.equal(item.affectedBusinessRequests, 0); assert.equal(item.unlinkedFailureRecords, 4);
    assert.equal(item.relationshipsComplete, false);
  }
});
test('visible parent chains resolve roots, cycles do not and probes do not count external impact', async t => {
  const f = await fixture(t);
  await f.add({ invocationId: 'root', traceId: 'trace' });
  await f.add({ invocationId: 'tool', serverType: 'mcp', spanKind: 'mcp_tool', parentInvocationId: 'root', traceId: 'trace' });
  await f.add({ spanKind: 'upstream_api', parentInvocationId: 'tool', traceId: 'trace', outcome: 'error' });
  await f.add({ invocationId: 'cycle', spanKind: 'upstream_api', parentInvocationId: 'cycle', traceId: 'trace', outcome: 'error' });
  await f.add({ spanKind: 'upstream_api', parentInvocationId: 'root', traceId: 'trace', outcome: 'error', origin: 'probe' });
  const item = (await f.dependencies.list(window, authorization(null))).data.items[0];
  assert.equal(item.affectedBusinessRequests, 1); assert.equal(item.unlinkedFailureRecords, 1);
  const probe = (await f.dependencies.list({ ...window, origin: 'probe' }, authorization(null))).data.items[0];
  assert.equal(probe.affectedBusinessRequests, 0); assert.equal(probe.unlinkedFailureRecords, 0);
});
test('server status returns persisted lifecycle and latest historical evidence without fabricated health', async t => {
  const f = await fixture(t); await f.asset('asset-a', 'gateway_service', 'offline'); await f.asset('hidden');
  await f.add({ phase: 'started', completedAt: undefined });
  await f.add({ outcome: 'error' }); await f.add();
  const base = { scopeType: 'runtime_asset', runtimeAssetId: 'asset-a', runtimeAssetEndpointBindingId: null,
    currentStatus: 'active', healthStatus: 'healthy', lastErrorMessage: 'private-marker', dimensions: { private: 'private-marker' } };
  await f.db.getRepository(State).save({ ...base, id: 'older', updatedAt: new Date('2026-09-01T00:00:00Z') });
  await f.db.getRepository(State).save({ ...base, id: 'latest', healthStatus: 'degraded',
    updatedAt: new Date('2026-09-02T00:00:00Z'), lastEventAt: new Date('2026-09-02T00:00:00Z') });
  await f.db.getRepository(State).save({ ...base, id: 'membership', scopeType: 'runtime_membership',
    runtimeAssetEndpointBindingId: 'binding', updatedAt: new Date('2026-09-03T00:00:00Z') });
  const data = (await f.servers.list(window, authorization(['asset-a']))).data;
  const item = data.items[0]; assert.equal(data.items.length, 1);
  assert.equal(item.lifecycleStatus, 'offline'); assert.equal(item.lifecycleSource, 'runtime_assets');
  assert.equal(item.reportedState.healthStatus, 'degraded'); assert.equal(item.reportedState.lifecycleStatus, 'active');
  assert.equal(item.healthStatus, 'unknown'); assert.equal(item.dependencyHealth, 'unknown');
  assert.equal(item.freshnessStatus, 'unknown'); assert.equal(item.lastHeartbeatAt, null);
  assert.equal(item.stateVersion, null); assert.equal(item.processInstanceId, null); assert.equal(item.activeInvocations, null);
  assert.equal(item.unknownInFlight, 1); assert.equal(item.observedBusinessRequests, 3);
  assert.equal(item.lastSuccessAt, '2026-09-09T00:00:02.000Z'); assert.equal(item.lastFailureAt, item.lastSuccessAt);
  assert.equal(JSON.stringify(data).includes('private-marker'), false); assert.equal(data.dataWatermark, null);
});
test('unsupported and malformed parameters fail before snapshot reads', async t => {
  const f = await fixture(t);
  f.store.readSnapshot = () => { throw new Error('Unexpected snapshot'); };
  for (const query of [{ scope: 'business' }, { timeBasis: 'completedAt' }, { limit: '1' }, { endpointDefinitionId: 'x' },
    { origin: ['external'] }, { serverType: 'invalid' }, { from: window.from }, { runtimeAssetId: { x: 'y' } }]) {
    for (const [service, method] of [[f.overview, 'get'], [f.servers, 'list'], [f.dependencies, 'list']]) {
      await assert.rejects(service[method](query, authorization(null)), error => error.code === 'INVALID_QUERY');
    }
  }
});
test('authorized invocation budget rejects overflow and hidden traffic does not consume the budget', async t => {
  const f = await fixture(t);
  const template = await f.add({ runtimeAssetId: 'hidden' });
  for (let offset = 0; offset < 5000; offset += 40) {
    const rows = Array.from({ length: Math.min(40, 5000 - offset) }, (_, i) => {
      const id = 'budget-' + (offset + i);
      return { ...template, id, invocationId: id, record: { ...template.record, invocationId: id } };
    });
    await f.db.getRepository(Revision).insert(rows);
  }
  assert.equal((await f.overview.get(window, authorization(['asset-a']))).data.businessSummary.metrics.selectedInvocations, 0);
  await assert.rejects(f.overview.get(window, authorization(null)), error => error.code === 'QUERY_TOO_LARGE');
});
test('asset budget fails explicitly instead of silently truncating server status', async t => {
  const f = await fixture(t);
  for (let offset = 0; offset < 201; offset += 20) {
    await f.db.getRepository(Asset).insert(Array.from({ length: Math.min(20, 201 - offset) }, (_, i) => ({
      id: 'asset-' + (offset + i), name: 'asset-' + (offset + i), type: 'gateway_service', status: 'draft' })));
  }
  await assert.rejects(f.servers.list(window, authorization(null)), error => error.code === 'QUERY_TOO_LARGE');
  assert.equal((await f.servers.list({ ...window, runtimeAssetId: 'asset-0' }, authorization(null))).data.items.length, 1);
});
test('isolated HTTP routes enforce JWT/asset roles, safe errors and generated Swagger contracts', async t => {
  const f = await fixture(t); await f.asset(); await f.asset('hidden'); await f.add(); await f.add({ runtimeAssetId: 'hidden' });
  const secret = randomUUID() + randomUUID(), jwt = new JwtService();
  const user = { id: 'reader', isActive: true, isLocked: false, roles: [{ enabled: true, name: 'reader', type: 'custom',
    permissions: [{ name: 'monitoring:read', enabled: true }],
    metadata: { observabilityScope: { mode: 'assets', runtimeAssetIds: ['asset-a'] } } }] };
  class FixtureModule {}
  Module({ controllers: [CallObservabilityOverviewController, CallObservabilityDependenciesController, CallObservabilityServerStatusController],
    providers: [{ provide: Overview, useValue: f.overview }, { provide: Dependencies, useValue: f.dependencies },
      { provide: Servers, useValue: f.servers }, ObservabilityAccessGuard, { provide: JwtService, useValue: jwt },
      { provide: ConfigService, useValue: new ConfigService({ JWT_SECRET: secret }) },
      { provide: UserService, useValue: { findUserById: async () => user } }] })(FixtureModule);
  const app = await NestFactory.create(FixtureModule, { logger: false });
  app.setGlobalPrefix('api/v1'); await app.init();
  t.after(() => app.close());
  const token = jwt.sign({ sub: 'reader', tokenUse: 'management_access' }, {
    secret, audience: 'api-nova-management', issuer: 'api-nova', expiresIn: '5m' });
  const paths = [['overview', 'obsGetOverview'], ['dependencies', 'obsGetDependencies'], ['servers/status', 'obsGetServerStatuses']];
  const swagger = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Overview subset').setVersion('1').build());
  for (const [path, operationId] of paths) {
    const uri = '/api/v1/monitoring/observability/' + path;
    assert.equal((await request(app.getHttpServer()).get(uri)).status, 401);
    const response = await request(app.getHttpServer()).get(uri).query(window).set('Authorization', 'Bearer ' + token);
    assert.equal(response.status, 200); assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(JSON.stringify(response.body).includes('hidden'), false);
    assert.equal(JSON.stringify(response.body).includes('private-marker'), false);
    const operation = swagger.paths[uri].get;
    assert.equal(operation.operationId, operationId);
    assert.deepEqual(operation.parameters.map(x => x.name).sort(), ['from', 'to', 'origin', 'serverType', 'runtimeAssetId'].sort());
    assert.ok(operation.responses['413']); assert.ok(operation.responses['503']);
    const invalid = await request(app.getHttpServer()).get(uri).query({ scope: 'all' }).set('Authorization', 'Bearer ' + token);
    assert.equal(invalid.status, 400); assert.equal(invalid.body.error.code, 'INVALID_QUERY');
  }
  user.roles = [];
  assert.equal((await request(app.getHttpServer()).get('/api/v1/monitoring/observability/overview')
    .set('Authorization', 'Bearer ' + token)).status, 403);
  user.roles = [{ enabled: true, name: 'super_admin', type: 'system' }];
  f.store.readSnapshot = async () => { throw new Error('private-marker database password'); };
  const failed = await request(app.getHttpServer()).get('/api/v1/monitoring/observability/overview')
    .set('Authorization', 'Bearer ' + token);
  assert.equal(failed.status, 503); assert.equal(failed.body.error.code, 'OBSERVABILITY_UNAVAILABLE');
  assert.equal(JSON.stringify(failed.body).includes('private-marker'), false);
});

test('HTTP MCP protocol -> tool -> upstream attributes to nearest Tool, not protocol root', async t => {
  const f = await fixture(t);
  const common = { serverType: 'mcp', protocolTransport: 'http', traceId: 'mcp-trace', rootInvocationId: 'protocol' };
  await f.add({ ...common, invocationId: 'protocol', spanKind: 'mcp_protocol' });
  for (const tool of ['tool-a', 'tool-b']) {
    await f.add({ ...common, invocationId: tool, spanKind: 'mcp_tool', parentInvocationId: 'protocol' });
    for (const attemptIndex of [1, 2]) {
      await f.add({ ...common, spanKind: 'upstream_api', parentInvocationId: tool, outcome: 'error',
        endpointDefinitionId: 'same-api', sourceServiceInstanceId: 'same-upstream',
        upstreamOperationId: tool + '-operation', attemptIndex });
    }
  }
  const data = (await f.dependencies.list(window, authorization(['asset-a']))).data;
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].failures, 4);
  assert.equal(data.items[0].affectedBusinessRequests, 2);
  assert.equal(data.items[0].unlinkedFailureRecords, 0);
  assert.equal(data.items[0].relationshipsComplete, true);
});
test('protocol root references cannot bypass hidden or cross-asset Tool parents', async t => {
  const f = await fixture(t);
  await f.add({ invocationId: 'protocol', serverType: 'mcp', spanKind: 'mcp_protocol', traceId: 'trace' });
  await f.add({ invocationId: 'hidden-tool', runtimeAssetId: 'hidden', serverType: 'mcp',
    spanKind: 'mcp_tool', parentInvocationId: 'protocol', traceId: 'trace' });
  await f.add({ serverType: 'mcp', spanKind: 'upstream_api', parentInvocationId: 'hidden-tool',
    rootInvocationId: 'protocol', traceId: 'trace', outcome: 'error' });
  for (const scope of [authorization(['asset-a']), authorization(null)]) {
    const item = (await f.dependencies.list(window, scope)).data.items[0];
    assert.equal(item.affectedBusinessRequests, 0); assert.equal(item.unlinkedFailureRecords, 1);
  }
});
test('overview registers invocation-only grants after success and does not issue on failed transaction', async t => {
  const f = await fixture(t), scope = authorization(['asset-a']), filter = { origin: 'external', runtimeAssetId: 'asset-a' };
  assert.equal(await f.grants.authorize('20', scope, filter), false);
  const result = await f.overview.get({ ...window, runtimeAssetId: 'asset-a' }, scope);
  assert.equal(result.data.invocationSnapshotSeq, '20');
  assert.equal(result.data.invocationSnapshotScope, 'invocation_facts_only');
  assert.equal(result.data.invocationSnapshotAuthorized, true);
  assert.ok(Date.parse(result.data.invocationSnapshotExpiresAt) > Date.now());
  assert.equal(await f.grants.authorize('20', scope, filter), true);
  assert.equal(result.data.serverStates.dataWatermark, null);
  const unconfigured = await new Overview(f.store, f.servers).get(window, scope);
  assert.equal(unconfigured.data.invocationSnapshotAuthorized, false);
  assert.equal(unconfigured.data.invocationSnapshotExpiresAt, null);
  const failedGrants = new Snapshots();
  const failedStore = { readSnapshot: async callback => {
    await f.store.readSnapshot(callback);
    assert.equal(await failedGrants.authorize('20', scope, filter), false);
    throw new Error('transaction completion failed');
  } };
  await assert.rejects(new Overview(failedStore, f.servers, failedGrants)
    .get({ ...window, runtimeAssetId: 'asset-a' }, scope), /transaction completion failed/);
  assert.equal(await failedGrants.authorize('20', scope, filter), false);
});
test('real event service accepts only previously issued overview sequences with matching origin and scope', async t => {
  const f = await fixture(t), scope = authorization(['asset-a']);
  const config = new ConfigService({ API_NOVA_OBSERVABILITY_CURSOR_SECRET: randomUUID() + randomUUID(),
    API_NOVA_OBSERVABILITY_CURSOR_KEY_ID: 'overview-test' });
  const events = new Events(f.store, new Cursors(config), f.grants);
  const query = { afterSequence: '20', origin: 'external', runtimeAssetId: 'asset-a' };
  await assert.rejects(events.list(query, scope), error => error.code === 'CURSOR_SCOPE_MISMATCH');
  await f.overview.get({ ...window, runtimeAssetId: 'asset-a' }, scope);
  const result = await events.list(query, scope);
  assert.equal(result.status, 'success');
  assert.equal(result.data.highWatermark, '20');
  assert.ok(result.data.nextCursor);
  for (const changed of [{ ...query, origin: 'probe' }, { afterSequence: '20', runtimeAssetId: 'asset-a' }]) {
    await assert.rejects(events.list(changed, scope), error => error.code === 'CURSOR_SCOPE_MISMATCH');
  }
  await assert.rejects(events.list(query, { ...scope, fingerprint: 'changed' }),
    error => error.code === 'CURSOR_SCOPE_MISMATCH');
});