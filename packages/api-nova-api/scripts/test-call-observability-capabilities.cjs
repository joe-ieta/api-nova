'use strict';
process.env.DB_TYPE = 'sqlite';
for (const key of ['JWT_SECRET', 'API_NOVA_OBSERVABILITY_CURSOR_SECRET',
  'API_NOVA_OBSERVABILITY_CURSOR_KEY_ID']) delete process.env[key];
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { Module, NotFoundException } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { ConfigService } = require('@nestjs/config');
const { JwtService } = require('@nestjs/jwt');
const { SwaggerModule, DocumentBuilder } = require('@nestjs/swagger');
const { captureAuditBody } = require('api-nova-parser');
const entities = require('../dist/src/database/entities/runtime-call-observability.entity.js');
const { RuntimeObservabilityEventEntity } = require('../dist/src/database/entities/runtime-observability-event.entity.js');
const { User, UserStatus } = require('../dist/src/database/entities/user.entity.js');
const { Role, RoleType } = require('../dist/src/database/entities/role.entity.js');
const { Permission } = require('../dist/src/database/entities/permission.entity.js');
const { UserService } = require('../dist/src/modules/security/services/user.service.js');
const tokens = require('../dist/src/modules/security/management-access-token.js');
const { CallObservabilityStore } = require('../dist/src/modules/call-observability/call-observability.store.js');
const { CallObservabilityPayloadStore } = require('../dist/src/modules/call-observability/call-observability-payload.store.js');
const { CallObservabilityVisitorsService, CALLER_QUERY_KEYS, SOURCE_QUERY_KEYS, CALLER_DETAIL_QUERY_KEYS, MAX_VISITOR_QUERY_INVOCATIONS } =
  require('../dist/src/modules/call-observability/call-observability-visitors.service.js');
const { CallObservabilityVisitorsController } =
  require('../dist/src/modules/call-observability/call-observability-visitors.controller.js');
const { ObservabilityAccessGuard } = require('../dist/src/modules/call-observability/call-observability-access.guard.js');
const { ObservabilityCursorService } = require('../dist/src/modules/call-observability/call-observability-cursor.service.js');
const { ObservabilityApiExceptionFilter } = require('../dist/src/modules/call-observability/call-observability-api.contract.js');
const { authorizeObservability } = require('../dist/src/modules/call-observability/call-observability-access.js');
const { CallObservabilityCapabilitiesService } = require('../dist/src/modules/call-observability/call-observability-capabilities.service.js');
const { CallObservabilityStatisticsService, STATISTICS_SCOPES, STATISTICS_SUMMARY_QUERY_KEYS } = require('../dist/src/modules/call-observability/call-observability-statistics.service.js');
const { MAX_METRIC_OBSERVATIONS } = require('../dist/src/modules/call-observability/call-observability-metrics.js');
const { CallObservabilityModule } = require('../dist/src/modules/call-observability/call-observability.module.js');
const { CallObservabilityInvocationsService, INVOCATION_QUERY_KEYS, MAX_TRACE_NODES } = require('../dist/src/modules/call-observability/call-observability-invocations.service.js');
const { CallObservabilityPayloadsService } = require('../dist/src/modules/call-observability/call-observability-payloads.service.js');
const { CallObservabilityCallerLabelsService } = require('../dist/src/modules/call-observability/call-observability-caller-labels.service.js');
const { parseObservabilityQuery } = require('../dist/src/modules/call-observability/call-observability-query.js');
const root = path.resolve(__dirname, '../../../tmp/observability-capabilities-tests');
const READ = 'monitoring:read', SOURCE = 'monitoring:source:read', PAYLOAD = 'monitoring:payload:read', MANAGE = 'monitoring:manage';

function role(names = [READ], assets = ['asset-a']) {
  return Object.assign(new Role(), {
    id: randomUUID(), name: 'fixture-role', type: RoleType.CUSTOM, enabled: true,
    permissions: names.map(name => Object.assign(new Permission(), { id: randomUUID(), name, enabled: true })),
    metadata: { observabilityScope: assets === null ? { mode: 'all' } : { mode: 'assets', runtimeAssetIds: assets } },
  });
}
async function fixture(t, sourceCap = 10000) {
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'run-'));
  let app, database;
  const oldData = process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  process.env.API_NOVA_OBSERVABILITY_DATA_DIR = path.join(directory, 'data');
  const payloads = new CallObservabilityPayloadStore();
  if (oldData === undefined) delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  else process.env.API_NOVA_OBSERVABILITY_DATA_DIR = oldData;
  t.after(async () => {
    if (app) await app.close();
    await payloads.onModuleDestroy();
    if (database?.isInitialized) await database.destroy();
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith('run-')) {
      throw new Error('Refusing a non-owned invocation test directory');
    }
    await fs.rm(resolved, { recursive: true, force: true });
  });
  database = new DataSource({ type: 'sqljs',
    entities: [...entities.CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity],
    synchronize: true, logging: false });
  await database.initialize();
  const secret = randomUUID() + randomUUID(), cursorSecret = randomUUID() + randomUUID();
  const config = new ConfigService({ JWT_SECRET: secret, API_NOVA_OBSERVABILITY_CURSOR_SECRET: cursorSecret,
    API_NOVA_OBSERVABILITY_SOURCE_ID_SECRET: randomUUID() + randomUUID(),
    API_NOVA_OBSERVABILITY_SOURCES_PER_DAY: sourceCap });
  const jwt = new JwtService(), users = new Map();
  const store = new CallObservabilityStore(database, payloads);
  const cursors = new ObservabilityCursorService(config);
  const service = new CallObservabilityVisitorsService(store, cursors);
  const { CallObservabilityCallersProjector } = require('../dist/src/modules/call-observability/call-observability-callers.projector.js');
  const projector = new CallObservabilityCallersProjector(config);
  let payloadReads = 0;
  payloads.read = async () => { payloadReads++; throw new Error('Metadata APIs must not open body objects'); };
  const resolver = { async findUserById(id) {
    if (!users.has(id)) throw new NotFoundException();
    return users.get(id);
  } };
  class FixtureModule {}
  Module({
    controllers: Reflect.getMetadata('controllers', CallObservabilityModule),
    providers: [
      { provide: CallObservabilityCapabilitiesService, useValue: new CallObservabilityCapabilitiesService(store) },
      { provide: CallObservabilityStatisticsService, useValue: new CallObservabilityStatisticsService(store) },
      { provide: CallObservabilityInvocationsService, useValue: new CallObservabilityInvocationsService(store, cursors) },
      // These controllers are registered for their actual Swagger contracts, never invoked here.
      { provide: CallObservabilityPayloadsService, useValue: {} },
      { provide: CallObservabilityCallerLabelsService, useValue: {} },
      { provide: CallObservabilityVisitorsService, useValue: service },
      { provide: ConfigService, useValue: config }, { provide: JwtService, useValue: jwt },
      { provide: UserService, useValue: resolver }, ObservabilityAccessGuard, ObservabilityApiExceptionFilter,
    ],
  })(FixtureModule);
  app = await NestFactory.create(FixtureModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api/v1');
  await app.listen(0, '127.0.0.1');
  const base = 'http://127.0.0.1:' + app.getHttpServer().address().port + '/api/v1/monitoring/observability';
  const now = Date.now() - 5000, sourceInstanceId = randomUUID();
  const range = { from: new Date(now - 60000).toISOString(), to: new Date(now + 60000).toISOString() };
  function account(roles = [role()]) {
    const user = Object.assign(new User(), { id: randomUUID(), username: 'fixture', email: 'fixture@example.invalid',
      status: UserStatus.ACTIVE, emailVerified: true, lockedUntil: null, roles });
    users.set(user.id, user);
    return user;
  }
  const user = account();
  function sign(user, claims = {}, options = {}) {
    return jwt.sign({ sub: user.id, tokenUse: tokens.MANAGEMENT_TOKEN_USE, ...claims }, {
      secret, algorithm: 'HS256', issuer: tokens.MANAGEMENT_TOKEN_ISSUER,
      audience: tokens.MANAGEMENT_TOKEN_AUDIENCE, expiresIn: '5m', ...options,
    });
  }
  async function request(route = '/capabilities', query = {}, who = user) {
    const queryString = typeof query === 'string' ? query : new URLSearchParams(query).toString();
    const access = typeof who === 'string' ? who : who ? sign(who) : null;
    const response = await fetch(base + route + (queryString ? '?' + queryString : ''), {
      headers: access ? { authorization: 'Bearer ' + access } : {},
    });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  }
  function source(overrides = {}) {
    const row = {
      schemaVersion: 2, sourceInstanceId, sourceSequence: 1, eventId: randomUUID(), recordVersion: 1,
      invocationId: randomUUID(), requestId: 'request-fixture', phase: 'finished',
      serverType: 'gateway', spanKind: 'gateway_request', protocolTransport: 'http', origin: 'external',
      runtimeAssetId: 'asset-a', identitySource: 'authenticated', authState: 'authenticated', callerId: 'caller-a',
      credentialId: 'credential-a', clientIp: '192.0.2.10', peerIp: '192.0.2.20',
      ipSource: 'trusted_proxy', proxyTrusted: true,
      startedAt: new Date(now).toISOString(), completedAt: new Date(now + 10).toISOString(),
      durationMs: 10, outcome: 'success', statusCode: 200, byteMeasurement: 'observed_body',
      measurementStage: 'http_body', requestHeaders: { authorization: 'Bearer private-marker' },
      url: 'https://example.invalid/private?secret=private-marker',
      request: captureAuditBody({ password: 'private-marker', value: 'body-private-marker' }),
      response: captureAuditBody({ result: 'response-private-marker' }), ...overrides,
    };
    if (row.phase !== 'finished') { delete row.completedAt; delete row.durationMs; delete row.outcome; }
    return row;
  }
  async function ingest(overrides = {}) {
    const row = source(overrides);
    const result = await store.ingest(row, {}, projector.project);
    assert.ok(['inserted', 'updated'].includes(result.status), JSON.stringify(result));
    return row;
  }
  return { app, database, store, cursors, service, user, users, account, sign, request, ingest,
    source, now, range, projector, payloads, payloadReads: () => payloadReads };
}
const data = result => { assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.data; };


const feature = (value, name) => value.features.find(item => item.name === name);
const endpointIds = value => value.endpoints.map(item => item.endpointId);
const allPermissions = [READ, PAYLOAD, SOURCE, MANAGE];

test('empty capabilities are a read-only snapshot, not a healthy zero or an initialized pipeline', async t => {
  const f = await fixture(t), result = await f.request(), value = data(result);
  assert.equal(value.availabilitySemantics, 'implementation_and_scope_eligibility_not_runtime_health');
  assert.equal(result.cache, 'no-store');
  assert.equal(result.body.meta.schemaVersion, '1.0');
  assert.equal(result.body.meta.snapshotSeq, '0'); assert.equal(result.body.meta.dataWatermark, '0');
  assert.equal(result.body.meta.historyCompleteSince, null);
  assert.equal(result.body.meta.lagMs, null); assert.equal(result.body.meta.isPartial, true);
  for (const entity of [entities.RuntimePipelineStateEntity, entities.RuntimeInvocationEntity,
    entities.RuntimeCallerEntity, RuntimeObservabilityEventEntity]) {
    assert.equal(await f.database.getRepository(entity).count(), 0);
  }
  assert.equal(f.payloadReads(), 0);
});

test('capabilities require current management JWT and base read permission', async t => {
  const f = await fixture(t);
  for (const token of [null, f.sign(f.user, { tokenUse: 'business' }),
    f.sign(f.user, {}, { expiresIn: '-1s' })]) {
    const result = await f.request('/capabilities', {}, token);
    assert.equal(result.status, 401); assert.equal(result.body.error.code, 'UNAUTHENTICATED');
  }
  assert.equal((await f.request('/capabilities', {}, f.account([role([SOURCE, MANAGE])]))).status, 403);
  f.users.delete(f.user.id);
  assert.equal((await f.request()).status, 401);
});

test('read-only grants advertise ten eligible routes and no private payload or management capability', async t => {
  const f = await fixture(t), value = data(await f.request());
  assert.equal(value.resourceScope, 'scoped');
  assert.deepEqual(endpointIds(value), ['OBS-API-01', 'OBS-API-03', 'OBS-API-04', 'OBS-API-06',
    'OBS-API-07', 'OBS-API-08', 'OBS-API-10', 'OBS-API-11', 'OBS-API-12', 'OBS-API-13']);
  for (const name of ['payloadRead', 'sourceIpRead', 'callerProfileUpdate']) {
    assert.equal(feature(value, name).state, 'restricted');
    assert.equal(feature(value, name).scopeMode, 'none');
    assert.equal(value.enabledFeatures.includes(name), false);
  }
  assert.equal(value.payloadLimits, null);
  assert.equal(value.retentionWindows.payloadDefaultMs, null);
  assert.ok(value.endpoints.every(item => item.requiredPermissions.length === 1 && item.requiredPermissions[0] === READ));
});

test('explicit all-resource grants expose twelve implemented endpoints and qualified payload object limits', async t => {
  const f = await fixture(t), viewer = f.account([role(allPermissions, null)]);
  const value = data(await f.request('/capabilities', {}, viewer));
  assert.equal(value.resourceScope, 'all'); assert.equal(value.endpoints.length, 12);
  assert.equal(value.maxStatisticsQueryInvocations, MAX_METRIC_OBSERVATIONS);
  assert.equal(feature(value, 'statistics').state, 'enabled');
  assert.deepEqual(value.endpoints.find(item => item.endpointId === 'OBS-API-11').queryParameters, [...STATISTICS_SUMMARY_QUERY_KEYS]);
  for (const name of ['payloadRead', 'sourceIpRead', 'callerProfileUpdate']) {
    assert.equal(feature(value, name).state, 'enabled');
    assert.equal(feature(value, name).scopeMode, 'all');
  }
  assert.equal(value.payloadLimits.readObjectMaxBytes, f.payloads.readLimit);
  assert.equal(value.payloadLimits.readObjectMaxBytes, 128 * 1024 * 1024);
  assert.equal(value.payloadLimits.readLimitScope, 'single_stored_object_not_total_http_memory');
  assert.equal(value.retentionWindows.payloadDefaultMs, 7 * 86400000);
  assert.deepEqual(value.endpoints.find(item => item.endpointId === 'OBS-API-05').requiredPermissions.sort(), [READ, PAYLOAD].sort());
});

test('optional permissions intersect base-read assets rather than unioning unrelated grants', async t => {
  const f = await fixture(t), viewer = f.account([
    role([READ], ['asset-a']), role([PAYLOAD, SOURCE], ['private-asset-b']), role([MANAGE], ['private-asset-c']),
  ]);
  const value = data(await f.request('/capabilities', {}, viewer));
  assert.equal(value.resourceScope, 'scoped'); assert.equal(value.endpoints.length, 10);
  for (const name of ['payloadRead', 'sourceIpRead', 'callerProfileUpdate']) {
    assert.equal(feature(value, name).state, 'restricted');
  }
  const encoded = JSON.stringify(value);
  for (const secret of ['asset-a', 'private-asset-b', 'private-asset-c', viewer.id]) {
    assert.equal(encoded.includes(secret), false);
  }
});

test('partial optional scope advertises eligibility without promising arbitrary caller edits', async t => {
  const f = await fixture(t), viewer = f.account([
    role([READ], null), role([PAYLOAD, SOURCE, MANAGE], ['asset-b']),
  ]);
  const value = data(await f.request('/capabilities', {}, viewer));
  assert.equal(value.resourceScope, 'all');
  for (const name of ['payloadRead', 'sourceIpRead', 'callerProfileUpdate']) {
    assert.equal(feature(value, name).state, 'enabled');
    assert.equal(feature(value, name).scopeMode, 'scoped');
  }
  const patch = value.endpoints.find(item => item.endpointId === 'OBS-API-09');
  assert.equal(patch.scopeMode, 'scoped');
  assert.equal(patch.authorizationRule, 'all_registered_caller_assets');
  assert.deepEqual(patch.requiredPermissions.sort(), [READ, MANAGE].sort());
});

test('empty explicit asset scope retains only self discovery, not global data access', async t => {
  const f = await fixture(t), viewer = f.account([role(allPermissions, [])]);
  const value = data(await f.request('/capabilities', {}, viewer));
  assert.equal(value.resourceScope, 'none');
  assert.deepEqual(value.supportedScopes, []); assert.equal(feature(value, 'statistics').state, 'restricted');
  assert.deepEqual(endpointIds(value), ['OBS-API-01']);
  assert.deepEqual(value.enabledFeatures, ['capabilities']);
  assert.equal(feature(value, 'capabilities').state, 'enabled');
  assert.equal(feature(value, 'capabilities').scopeMode, 'none');
  assert.equal(feature(value, 'invocationQueries').state, 'restricted');
  assert.equal(value.endpoints[0].authorizationRule, 'capability_only');
});

test('runtime states, event history and push remain unavailable even for global grants', async t => {
  const f = await fixture(t), viewer = f.account([role(allPermissions, null)]);
  const value = data(await f.request('/capabilities', {}, viewer));
  for (const name of ['overview', 'dependencies', 'serverStatus',
    'eventHistory', 'webhook', 'socketPush', 'pipelineStatus', 'policyManagement']) {
    assert.equal(feature(value, name).state, 'not_implemented');
    assert.equal(feature(value, name).scopeMode, null);
    assert.equal(value.enabledFeatures.includes(name), false);
  }
  assert.deepEqual(value.supportedScopes, [...STATISTICS_SCOPES]); assert.deepEqual(value.supportedGroupByCombinations.length, 28);
  assert.equal(value.maxBuckets, 1440); assert.equal(value.eventRetention, null);
  assert.equal(value.retentionWindows.aggregateRetentionMs, null);
});

test('unknown, repeated and nested query parameters fail before storage access', async t => {
  const f = await fixture(t);
  f.store.readSnapshot = async () => { throw new Error('unexpected-private-storage-access'); };
  for (const query of ['limit=1', 'scope=business', 'from=2026-01-01T00%3A00%3A00Z',
    'origin=external&origin=internal', 'filter%5Blimit%5D=1', 'cursor=private-marker']) {
    const result = await f.request('/capabilities', query);
    assert.equal(result.status, 400, query); assert.equal(result.body.error.code, 'INVALID_QUERY');
    assert.equal(JSON.stringify(result.body).includes('private-marker'), false);
  }
});

test('capabilities database faults fail closed with safe unavailable errors', async t => {
  const f = await fixture(t);
  f.store.readSnapshot = async () => { throw new Error('password=private-marker internal-driver E:/private-path'); };
  const result = await f.request();
  assert.equal(result.status, 503); assert.equal(result.body.error.code, 'OBSERVABILITY_UNAVAILABLE');
  assert.ok(result.body.error.requestId); assert.equal(result.cache, 'no-store');
  for (const secret of ['private-marker', 'internal-driver', 'E:/private-path']) {
    assert.equal(JSON.stringify(result.body).includes(secret), false);
  }
});

test('capability reads track the real watermark without changing facts, events or opening payloads', async t => {
  const f = await fixture(t);
  await f.ingest();
  const before = await f.store.readSnapshot(tx => tx.snapshotSeq);
  const tables = [entities.RuntimePipelineStateEntity, entities.RuntimeInvocationEntity,
    entities.RuntimeCallerEntity, entities.RuntimeAccessSourceEntity, RuntimeObservabilityEventEntity];
  const counts = [];
  for (const entity of tables) counts.push(await f.database.getRepository(entity).count());
  const result = await f.request(), value = data(result);
  assert.notEqual(before, '0');
  assert.equal(result.body.meta.snapshotSeq, before); assert.equal(result.body.meta.dataWatermark, before);
  assert.equal(await f.store.readSnapshot(tx => tx.snapshotSeq), before);
  for (let i = 0; i < tables.length; i++) assert.equal(await f.database.getRepository(tables[i]).count(), counts[i]);
  for (const secret of ['private-marker', 'credential-a', 'caller-a', '192.0.2.', 'asset-a', f.user.id]) {
    assert.equal(JSON.stringify(result.body).includes(secret), false);
  }
  assert.equal(value.observationHealth, 'unknown'); assert.equal(f.payloadReads(), 0);
});

test('capability inventory and explicit DTOs match all actual module Swagger operations and allowlists', async t => {
  const f = await fixture(t), viewer = f.account([role(allPermissions, null)]);
  const value = data(await f.request('/capabilities', {}, viewer));
  const swagger = SwaggerModule.createDocument(f.app, new DocumentBuilder().setTitle('Capabilities').setVersion('1').build());
  const operations = Object.entries(swagger.paths).flatMap(([route, item]) =>
    Object.entries(item).filter(([method]) => ['get', 'patch'].includes(method)).map(([method, operation]) =>
      ({ route, method, operation })));
  assert.equal(operations.length, 12); assert.equal(value.endpoints.length, operations.length);
  for (const endpoint of value.endpoints) {
    const actual = operations.find(item => item.route === endpoint.path && item.method === endpoint.method.toLowerCase());
    assert.ok(actual, endpoint.endpointId);
    assert.equal(actual.operation.operationId, endpoint.operationId);
    assert.deepEqual((actual.operation.parameters || []).filter(item => item.in === 'query').map(item => item.name).sort(),
      [...endpoint.queryParameters].sort(), endpoint.endpointId);
  }
  const own = swagger.paths['/api/v1/monitoring/observability/capabilities'].get;
  assert.equal(own.responses['200'].content['application/json'].schema.$ref,
    '#/components/schemas/ObservabilityCapabilitiesEnvelopeDto');
  for (const status of ['400', '401', '403', '503']) assert.ok(own.responses[status]);
  const schemas = swagger.components.schemas, shape = schemas.ObservabilityCapabilitiesDto;
  assert.deepEqual(Object.keys(shape.properties).sort(), Object.keys(value).sort());
  assert.equal(shape.properties.maxBuckets.nullable, true);
  assert.equal(shape.properties.eventRetention.nullable, true);
  assert.equal(shape.properties.payloadLimits.nullable, true);
  assert.equal(schemas.ObservabilityPayloadLimitsDto.properties.effectiveCaptureBytes.nullable, true);
  assert.deepEqual(schemas.ObservabilityFeatureCapabilityDto.properties.state.enum, ['enabled', 'restricted', 'not_implemented']);
});

test('reported paging, trace, visitor and time bounds match real parser and HTTP enforcement', async t => {
  const f = await fixture(t), value = data(await f.request());
  assert.deepEqual(value.schemaVersions, { sourceRecords: 2, http: '1.0' });
  assert.equal(value.traceMaxNodes, MAX_TRACE_NODES);
  assert.equal(value.maxVisitorQueryInvocations, MAX_VISITOR_QUERY_INVOCATIONS);
  const defaults = parseObservabilityQuery({}, INVOCATION_QUERY_KEYS, { now: f.now });
  assert.equal(defaults.page.limit, value.defaultLimit);
  assert.equal(Date.parse(defaults.filter.to) - Date.parse(defaults.filter.from), value.defaultQueryWindowMs);
  const from = new Date(f.now - value.maxQueryRange).toISOString(), to = new Date(f.now).toISOString();
  assert.equal((await f.request('/invocations', { from, to, limit: String(value.maxLimit) })).status, 200);
  assert.equal((await f.request('/invocations', { from, to, limit: String(value.maxLimit + 1) })).status, 400);
  assert.equal((await f.request('/invocations', { from: new Date(Date.parse(from) - 1).toISOString(), to })).status, 400);
  assert.equal(value.errorCategoryMode, 'suggested_values_free_text_filter');
  assert.equal((await f.request('/invocations', { errorCategory: 'producer-specific-category' })).status, 200);
  assert.deepEqual(value.byteMeasurements, ['observed_body', 'serialized_payload', 'unavailable']);
});

test('current optional grants are refreshed with the same JWT while coverage and capture policy stay unknown', async t => {
  const f = await fixture(t), viewer = f.account([role(allPermissions, null)]), token = f.sign(viewer);
  const initial = data(await f.request('/capabilities', {}, token));
  assert.equal(initial.payloadLimits.effectiveCaptureBytes, null);
  assert.equal(initial.payloadLimits.capturePolicyState, 'not_reported_by_producers');
  assert.equal(initial.retentionWindows.basis, 'storage_defaults_not_coverage_guarantees');
  assert.equal(initial.retentionWindows.effectiveHistoryCompleteSince, null);
  assert.equal(initial.retentionWindows.invocationMetadataDefaultMs, 30 * 86400000);
  assert.equal(initial.maxQueryCursorLifetimeMs, 900000);
  viewer.roles = [role([READ], null)];
  const revoked = data(await f.request('/capabilities', {}, token));
  assert.equal(revoked.payloadLimits, null); assert.equal(revoked.endpoints.length, 10);
  assert.equal(revoked.observationHealth, 'unknown');
  viewer.roles = [];
  assert.equal((await f.request('/capabilities', {}, token)).status, 403);
});
