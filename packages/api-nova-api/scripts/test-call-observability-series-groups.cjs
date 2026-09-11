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
const root = path.resolve(__dirname, '../../../tmp/observability-series-groups-tests');
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

const summary = (f, query = {}, who = f.user) =>
  f.request('/statistics/summary', { ...f.range, scope: 'business', ...query }, who);
const counts = result => data(result).metrics;


const series = (f, query = {}, who = f.user) =>
  f.request('/statistics/time-series', { ...f.range, scope: 'business', interval: '1m', ...query }, who);
const grouped = (f, query = {}, who = f.user) =>
  f.request('/statistics/groups', { ...f.range, scope: 'business', groupBy: 'callerId', ...query }, who);
const iso = value => new Date(value).toISOString();
const put = (f, overrides = {}, at = f.now) =>
  f.ingest(f.source({ startedAt: iso(at), completedAt: iso(at + 10), durationMs: 10, ...overrides }));
const dimensions = ['runtimeAssetId', 'serverType', 'callerId', 'endpointDefinitionId', 'toolName',
  'sourceServiceInstanceId', 'outcome'];

test('series and groups reject missing required fields and non-whitelisted queries', async t => {
  const f = await fixture(t);
  for (const [route, query] of [
    ['/statistics/time-series', { scope: 'business' }],
    ['/statistics/time-series', { interval: '1m' }],
    ['/statistics/time-series', { scope: 'business', interval: '2m' }],
    ['/statistics/time-series', { scope: 'business', interval: '1m', fill: 'invented' }],
    ['/statistics/time-series', { scope: 'business', interval: '1m', top: '2' }],
    ['/statistics/groups', { scope: 'business' }],
    ['/statistics/groups', { groupBy: 'callerId' }],
    ...['clientIp', 'sourceId', 'record.password', 'callerId,callerId', 'callerId,serverType,outcome']
      .map(groupBy => ['/statistics/groups', { scope: 'business', groupBy }]),
    ...['durationMs', 'selectedInvocations desc', '__proto__']
      .map(orderBy => ['/statistics/groups', { scope: 'business', groupBy: 'callerId', orderBy }]),
    ...['0', '101', '1.5'].map(top => ['/statistics/groups', { scope: 'business', groupBy: 'callerId', top }]),
  ]) {
    assert.equal((await f.request(route, { ...f.range, ...query })).status, 400, JSON.stringify(query));
  }
});

test('series align to UTC and expose clipped edge windows without persisted versions', async t => {
  const f = await fixture(t);
  const base = Math.floor(f.now / 60000) * 60000 - 180000;
  await put(f, {}, base + 20000);
  await put(f, {}, base + 65000);
  const response = await series(f, { from: iso(base + 10000), to: iso(base + 70000) });
  assert.equal(response.status, 200);
  const value = data(response);
  assert.equal(value.items.length, 2);
  assert.equal(value.items[0].bucketStart, iso(base));
  assert.equal(value.items[0].bucketEnd, iso(base + 60000));
  assert.equal(value.items[0].effectiveFrom, iso(base + 10000));
  assert.equal(value.items[1].effectiveTo, iso(base + 70000));
  assert.equal(value.bucketVersionSemantics, 'not_persisted');
  assert.equal(value.queryMode, 'retained_invocation_snapshot');
  for (const item of value.items) {
    assert.equal(item.bucketVersion, null);
    assert.equal(item.synthetic, false);
    assert.equal(item.coverage.isPartial, true);
    assert.equal(item.coverage.observationHealth, 'unknown');
    assert.equal(typeof item.dataWatermark, 'string');
  }
});

test('fill none returns occupied buckets only in chronological order', async t => {
  const f = await fixture(t);
  const base = Math.floor(f.now / 60000) * 60000 - 180000;
  await put(f, {}, base + 121000);
  await put(f, {}, base + 1000);
  const value = data(await series(f, { from: iso(base), to: iso(base + 180000) }));
  assert.equal(value.fill, 'none');
  assert.deepEqual(value.items.map(item => item.bucketStart), [iso(base), iso(base + 120000)]);
  assert.equal(value.metrics.selectedInvocations, 2);
});

test('fill zero retains unknown coverage and null rates for synthetic buckets', async t => {
  const f = await fixture(t);
  const base = Math.floor(f.now / 60000) * 60000 - 180000;
  await put(f, {}, base + 61000);
  const value = data(await series(f, { from: iso(base), to: iso(base + 180000), fill: 'zero' }));
  assert.equal(value.items.length, 3);
  assert.deepEqual(value.items.map(item => item.synthetic), [true, false, true]);
  for (const item of [value.items[0], value.items[2]]) {
    assert.equal(item.metrics.selectedInvocations, 0);
    assert.equal(item.metrics.successRate, null);
    assert.equal(item.metrics.errorRate, null);
    assert.equal(item.metrics.requestBytes, null);
    assert.equal(item.coverage.historyCompleteSince, null);
    assert.equal(item.coverage.observationHealth, 'unknown');
  }
});

test('series overall unique callers are deduplicated rather than summed across buckets', async t => {
  const f = await fixture(t);
  const base = Math.floor(f.now / 60000) * 60000 - 180000;
  await put(f, { callerId: 'caller-a' }, base + 1000);
  await put(f, { callerId: 'caller-a' }, base + 61000);
  const value = data(await series(f, { from: iso(base), to: iso(base + 120000) }));
  assert.equal(value.metrics.uniqueCallers, 1);
  assert.deepEqual(value.items.map(item => item.metrics.uniqueCallers), [1, 1]);
});

test('completedAt assigns the completion bucket and does not invent totalStarted', async t => {
  const f = await fixture(t);
  const base = Math.floor(f.now / 60000) * 60000 - 180000;
  await put(f, { completedAt: iso(base + 61000), durationMs: 2000 }, base + 59000);
  await put(f, { phase: 'started' }, base + 2000);
  const value = data(await series(f, { from: iso(base), to: iso(base + 120000), timeBasis: 'completedAt' }));
  assert.equal(value.items.length, 1);
  assert.equal(value.items[0].bucketStart, iso(base + 60000));
  assert.equal(value.metrics.selectedInvocations, 1);
  assert.equal(value.metrics.totalStarted, null);
  assert.equal(value.items[0].metrics.totalStarted, null);
});

test('both APIs preserve the half-open window boundary', async t => {
  const f = await fixture(t);
  const base = Math.floor(f.now / 60000) * 60000 - 180000;
  await put(f, {}, base);
  await put(f, {}, base + 60000);
  const query = { from: iso(base), to: iso(base + 60000) };
  for (const request of [series, grouped]) {
    const response = await request(f, query);
    assert.equal(response.status, 200);
    assert.equal(data(response).metrics.selectedInvocations, 1);
  }
});

test('all advertised intervals use their exact UTC width', async t => {
  const f = await fixture(t);
  await put(f);
  for (const [interval, width] of [['1m', 60000], ['5m', 300000], ['1h', 3600000], ['1d', 86400000]]) {
    const response = await series(f, { interval });
    assert.equal(response.status, 200);
    const item = data(response).items[0];
    assert.equal(Date.parse(item.bucketStart) % width, 0);
    assert.equal(Date.parse(item.bucketEnd) - Date.parse(item.bucketStart), width);
  }
});

test('the 1440 touched-bucket budget includes a partially touched edge', async t => {
  const f = await fixture(t);
  const to = Math.floor(f.now / 60000) * 60000;
  const from = to - 1440 * 60000;
  assert.equal((await series(f, { from: iso(from), to: iso(to) })).status, 200);
  assert.equal((await series(f, { from: iso(from), to: iso(to + 1) })).status, 413);
});

test('asset authorization is applied before series and group totals', async t => {
  const f = await fixture(t);
  await put(f, { runtimeAssetId: 'asset-a', callerId: 'caller-a' });
  await put(f, { runtimeAssetId: 'asset-b', callerId: 'hidden-caller' });
  for (const request of [series, grouped]) {
    const response = await request(f);
    assert.equal(response.status, 200);
    assert.equal(data(response).metrics.selectedInvocations, 1);
    assert.equal(JSON.stringify(response.body).includes('hidden-caller'), false);
    assert.equal(JSON.stringify(response.body).includes('asset-b'), false);
  }
});

test('an explicitly filtered unauthorized asset cannot expand either result', async t => {
  const f = await fixture(t);
  await put(f, { runtimeAssetId: 'asset-b' });
  for (const request of [series, grouped]) {
    const response = await request(f, { runtimeAssetId: 'asset-b' });
    assert.equal(response.status, 200);
    assert.equal(data(response).metrics.selectedInvocations, 0);
    assert.deepEqual(data(response).items, []);
  }
});

test('caller groups never trust an unauthenticated caller identifier', async t => {
  const f = await fixture(t);
  await put(f, { callerId: 'caller-a' });
  await put(f, { callerId: 'forged-caller', identitySource: 'anonymous', authState: 'anonymous' });
  const value = data(await grouped(f));
  assert.equal(value.totalGroups, 2);
  assert.deepEqual(value.items.map(item => item.dimensionValues.callerId).sort(), ['caller-a', null].sort());
  assert.equal(value.metrics.uniqueCallers, 1);
  assert.equal(JSON.stringify(value).includes('forged-caller'), false);
});

test('missing dimensions remain null and do not collide with a literal unknown identifier', async t => {
  const f = await fixture(t);
  await put(f, { endpointDefinitionId: null });
  await put(f, { endpointDefinitionId: 'unknown' });
  const value = data(await grouped(f, { groupBy: 'endpointDefinitionId' }));
  assert.equal(value.totalGroups, 2);
  assert.equal(value.items.some(item => item.dimensionValues.endpointDefinitionId === null), true);
  assert.equal(value.items.some(item => item.dimensionValues.endpointDefinitionId === 'unknown'), true);
});

test('equal-ranked groups have deterministic tuple ordering and one-based ranks', async t => {
  const f = await fixture(t);
  await put(f, { callerId: 'caller-z' });
  await put(f, { callerId: 'caller-a' });
  const first = data(await grouped(f));
  const second = data(await grouped(f));
  assert.deepEqual(first.items, second.items);
  assert.deepEqual(first.items.map(item => item.dimensionValues.callerId), ['caller-a', 'caller-z']);
  assert.deepEqual(first.items.map(item => item.rank), [1, 2]);
});

test('top truncates items but retains whole-window totals and distinct counts', async t => {
  const f = await fixture(t);
  await put(f, { callerId: 'caller-a' });
  await put(f, { callerId: 'caller-a' });
  await put(f, { callerId: 'caller-b' });
  await put(f, { callerId: 'caller-c' });
  const value = data(await grouped(f, { top: '1' }));
  assert.equal(value.items.length, 1);
  assert.equal(value.items[0].dimensionValues.callerId, 'caller-a');
  assert.equal(value.items[0].metrics.selectedInvocations, 2);
  assert.equal(value.metrics.selectedInvocations, 4);
  assert.equal(value.metrics.uniqueCallers, 3);
  assert.equal(value.totalGroups, 3);
  assert.equal(value.hasMoreGroups, true);
});

test('failure ordering uses the shared failure definition rather than traffic volume', async t => {
  const f = await fixture(t);
  await put(f, { callerId: 'caller-a' });
  await put(f, { callerId: 'caller-a' });
  await put(f, { callerId: 'caller-z', outcome: 'error', statusCode: 500 });
  const value = data(await grouped(f, { orderBy: 'failures' }));
  assert.equal(value.orderBy, 'failures');
  assert.equal(value.items[0].dimensionValues.callerId, 'caller-z');
  assert.equal(value.items[0].metrics.failures, 1);
  for (const orderBy of ['selectedInvocations', 'successes', 'uniqueCallers', 'upstreamRequests']) {
    assert.equal((await grouped(f, { orderBy })).status, 200);
  }
});

test('all seven dimensions and their twenty-one pairs are supported', async t => {
  const f = await fixture(t);
  await put(f);
  const combinations = dimensions.flatMap((dimension, index) =>
    [[dimension], ...dimensions.slice(index + 1).map(other => [dimension, other])]);
  assert.equal(combinations.length, 28);
  for (const groupBy of combinations) {
    const response = await grouped(f, { groupBy: groupBy.join(',') });
    assert.equal(response.status, 200, groupBy.join(','));
    assert.deepEqual(data(response).groupBy, groupBy);
    assert.equal(data(response).metrics.selectedInvocations, 1);
    assert.deepEqual(Object.keys(data(response).items[0].dimensionValues), groupBy);
  }
});

test('two-dimensional groups accept reversed order and preserve that order', async t => {
  const f = await fixture(t);
  await put(f);
  const value = data(await grouped(f, { groupBy: 'outcome,callerId' }));
  assert.deepEqual(value.groupBy, ['outcome', 'callerId']);
  assert.deepEqual(value.items[0].dimensionValues, { outcome: 'success', callerId: 'caller-a' });
});

test('empty groups retain unknown history instead of inventing a healthy group', async t => {
  const f = await fixture(t);
  const value = data(await grouped(f));
  assert.deepEqual(value.items, []);
  assert.equal(value.totalGroups, 0);
  assert.equal(value.hasMoreGroups, false);
  assert.equal(value.top, 20);
  assert.equal(value.metrics.successRate, null);
  assert.equal(value.coverage.observationHealth, 'unknown');
  assert.equal(value.coverage.isPartial, true);
});

test('each request uses exactly one read snapshot even with many buckets or groups', async t => {
  const f = await fixture(t);
  await put(f);
  const readSnapshot = f.store.readSnapshot.bind(f.store);
  let calls = 0;
  f.store.readSnapshot = callback => { calls++; return readSnapshot(callback); };
  assert.equal((await series(f, { fill: 'zero' })).status, 200);
  assert.equal(calls, 1);
  assert.equal((await grouped(f, { groupBy: 'serverType,callerId' })).status, 200);
  assert.equal(calls, 2);
});

test('metadata aggregation never exposes captured payloads or credentials', async t => {
  const f = await fixture(t);
  await put(f);
  for (const request of [series, grouped]) {
    const response = await request(f);
    assert.equal(response.status, 200);
    assert.doesNotMatch(JSON.stringify(response.body), /private-marker|body-private|response-private|Bearer /);
  }
});

test('new database revisions replace unfinished observations instead of double counting', async t => {
  const f = await fixture(t);
  const initial = f.source({ phase: 'started' });
  await f.ingest(initial);
  await f.ingest(f.source({ ...initial, eventId: require('node:crypto').randomUUID(), sourceSequence: 2,
    recordVersion: 2, phase: 'finished', outcome: 'success', completedAt: iso(f.now + 10), durationMs: 10 }));
  for (const request of [series, grouped]) {
    const value = data(await request(f));
    assert.equal(value.metrics.selectedInvocations, 1);
    assert.equal(value.metrics.successes, 1);
    assert.equal(value.metrics.unknownInFlight, 0);
  }
});

test('external is the default origin and explicit internal queries stay separate', async t => {
  const f = await fixture(t);
  await put(f, { origin: 'external' });
  await put(f, { origin: 'internal' });
  for (const request of [series, grouped]) {
    assert.equal(data(await request(f)).metrics.selectedInvocations, 1);
    const value = data(await request(f, { origin: 'internal' }));
    assert.equal(value.metrics.selectedInvocations, 1);
    assert.equal(value.window.origin, 'internal');
  }
});

test('both APIs reuse exact request and endpoint filters from summary', async t => {
  const f = await fixture(t);
  await put(f, { requestId: 'request-a', endpointDefinitionId: 'endpoint-a' });
  await put(f, { requestId: 'request-b', endpointDefinitionId: 'endpoint-b' });
  for (const request of [series, grouped]) {
    assert.equal(data(await request(f, { requestId: 'request-a' })).metrics.selectedInvocations, 1);
    assert.equal(data(await request(f, { endpointDefinitionId: 'endpoint-b' })).metrics.selectedInvocations, 1);
    assert.equal(data(await request(f, { requestId: 'request-a', endpointDefinitionId: 'endpoint-b' })).metrics.selectedInvocations, 0);
  }
});

test('Swagger contains both stable operation IDs, required query fields and bounded top', async t => {
  const f = await fixture(t);
  const swagger = require('@nestjs/swagger');
  const doc = swagger.SwaggerModule.createDocument(f.app, new swagger.DocumentBuilder().setTitle('Statistics').setVersion('1').build());
  const operations = Object.values(doc.paths).flatMap(path => Object.values(path)).filter(value => value && value.operationId);
  for (const [operationId, required] of [
    ['obsGetStatisticsTimeSeries', ['scope', 'interval']],
    ['obsGetStatisticsGroups', ['scope', 'groupBy']],
  ]) {
    const operation = operations.find(value => value.operationId === operationId);
    assert.ok(operation);
    for (const name of required) assert.equal(operation.parameters.find(parameter => parameter.name === name).required, true);
    assert.ok(operation.responses['413']);
  }
  const operation = operations.find(value => value.operationId === 'obsGetStatisticsGroups');
  assert.equal(operation.parameters.find(parameter => parameter.name === 'top').schema.maximum, 100);
  assert.ok(doc.components.schemas.ObservabilityStatisticsTimeSeriesEnvelopeDto);
  assert.ok(doc.components.schemas.ObservabilityStatisticsGroupsEnvelopeDto);
});

test('capabilities advertise the implemented series and grouping bounds without enabling future push', async t => {
  const f = await fixture(t);
  const value = data(await f.request());
  assert.equal(endpointIds(value).includes('OBS-API-12'), true);
  assert.equal(endpointIds(value).includes('OBS-API-13'), true);
  assert.equal(value.maxBuckets, 1440);
  assert.equal(value.maxGroupLimit, 100);
  assert.equal(value.maxStatisticsQueryInvocations, 5000);
  assert.equal(value.supportedGroupByCombinations.length, 28);
  for (const name of ['statisticsTimeSeries', 'statisticsGroups']) {
    assert.ok(feature(value, name));
    assert.equal(JSON.stringify(feature(value, name)).includes('not_implemented'), false);
  }
  assert.equal(JSON.stringify(feature(value, 'webhook')).includes('not_implemented'), true);
});
