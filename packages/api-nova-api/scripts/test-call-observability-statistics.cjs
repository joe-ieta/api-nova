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
const root = path.resolve(__dirname, '../../../tmp/observability-statistics-tests');
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

test('empty summary is read-only and reports unknown coverage rather than runtime health', async t => {
  const f = await fixture(t), result = await summary(f), value = data(result);
  assert.equal(result.cache, 'no-store'); assert.equal(value.queryMode, 'retained_invocation_snapshot');
  assert.equal(value.maxQueryInvocations, MAX_METRIC_OBSERVATIONS); assert.equal(value.livenessEvaluated, false);
  assert.equal(value.metrics.selectedInvocations, 0); assert.equal(value.metrics.successRate, null);
  assert.equal(value.metrics.requestBytes, null); assert.equal(value.coverage.observationHealth, 'unknown');
  assert.equal(result.body.meta.snapshotSeq, '0'); assert.equal(result.body.meta.dataWatermark, '0');
  assert.equal(result.body.meta.lagMs, null); assert.equal(result.body.meta.historyCompleteSince, null);
  assert.equal(result.body.meta.isPartial, true);
  assert.equal(await f.database.getRepository(entities.RuntimePipelineStateEntity).count(), 0);
  assert.equal(await f.database.getRepository(RuntimeObservabilityEventEntity).count(), 0);
  assert.equal(f.payloadReads(), 0);
});

test('summary requires current management JWT and refreshes read scope rather than trusting old claims', async t => {
  const f = await fixture(t); await f.ingest();
  for (const who of [null, f.sign(f.user, { tokenUse: 'business' }), f.sign(f.user, {}, { expiresIn: '-1s' })]) {
    assert.equal((await summary(f, {}, who)).status, 401);
  }
  assert.equal((await summary(f, {}, f.account([role([SOURCE])]))).status, 403);
  const token = f.sign(f.user);
  assert.equal(counts(await summary(f, {}, token)).selectedInvocations, 1);
  f.user.roles = [role([READ], ['asset-b'])];
  assert.equal(counts(await summary(f, {}, token)).selectedInvocations, 0);
  f.user.roles = [];
  assert.equal((await summary(f, {}, token)).status, 403);
  f.users.delete(f.user.id);
  assert.equal((await summary(f, {}, token)).status, 401);
});

test('asset intersection, empty scope and explicit global grants preserve unassigned access boundaries', async t => {
  const f = await fixture(t);
  await f.ingest(); await f.ingest({ runtimeAssetId: 'asset-b', callerId: 'hidden-caller' });
  await f.ingest({ runtimeAssetId: null, callerId: 'unassigned-caller' });
  assert.equal(counts(await summary(f)).selectedInvocations, 1);
  assert.equal(counts(await summary(f, { runtimeAssetId: 'asset-b' })).selectedInvocations, 0);
  assert.equal(counts(await summary(f, {}, f.account([role([READ], [])]))).selectedInvocations, 0);
  const global = f.account([role([READ], null)]);
  assert.equal(counts(await summary(f, {}, global)).selectedInvocations, 3);
  assert.equal(counts(await summary(f, { runtimeAssetId: 'asset-b' }, global)).selectedInvocations, 1);
});

test('SQL scope selection matches business, HTTP, STDIO protocol, tool and upstream semantics', async t => {
  const f = await fixture(t);
  await f.ingest();
  await f.ingest({ serverType: 'mcp', spanKind: 'mcp_protocol' });
  await f.ingest({ serverType: 'mcp', spanKind: 'mcp_protocol', protocolTransport: 'stdio' });
  await f.ingest({ serverType: 'mcp', spanKind: 'mcp_tool', protocolTransport: 'stdio', byteMeasurement: 'serialized_payload' });
  await f.ingest({ spanKind: 'upstream_api' });
  for (const [scope, count] of [['business', 2], ['http_ingress', 2], ['protocol', 2], ['tool', 1], ['upstream', 1]]) {
    const value = data(await summary(f, { scope }));
    assert.equal(value.metrics.selectedInvocations, count, scope);
    assert.equal(value.window.scope, scope);
  }
});

test('all equality filters remain parameterized, including JSON record fields and quote-shaped values', async t => {
  const f = await fixture(t), marker = "value' OR 1=1 --";
  const source = await f.ingest({ serverType: 'mcp', spanKind: 'mcp_tool', toolName: marker,
    endpointDefinitionId: marker, sourceServiceInstanceId: marker, traceId: marker,
    requestId: marker, errorCategory: marker, callerId: marker });
  await f.ingest();
  const row = await f.database.getRepository(entities.RuntimeInvocationRevisionEntity).findOneBy({ invocationId: source.invocationId });
  for (const [key, value] of [['serverType', 'mcp'], ['spanKind', 'mcp_tool'], ['toolName', marker],
    ['endpointDefinitionId', marker], ['sourceServiceInstanceId', marker], ['traceId', marker], ['requestId', marker],
    ['errorCategory', marker], ['callerId', marker], ['sourceId', row.sourceId]]) {
    const result = counts(await summary(f, { [key]: value }));
    // Source identity includes serverType, so Gateway and MCP calls stay separate even at the same IP.
    assert.equal(result.selectedInvocations, 1, key);
  }
  assert.equal(counts(await summary(f, { outcome: 'error' })).selectedInvocations, 0);
});

test('origin defaults exclude test, probe and internal calls while explicit origin stays isolated', async t => {
  const f = await fixture(t);
  for (const origin of ['external', 'test', 'probe', 'internal']) await f.ingest({ origin });
  assert.equal(counts(await summary(f)).selectedInvocations, 1);
  for (const origin of ['test', 'probe', 'internal']) {
    const value = data(await summary(f, { origin }));
    assert.equal(value.metrics.selectedInvocations, 1); assert.equal(value.window.origin, origin);
  }
});

test('half-open timestamps and completion basis do not turn unfinished calls into completed throughput', async t => {
  const f = await fixture(t);
  await f.ingest({ startedAt: f.range.from, completedAt: new Date(Date.parse(f.range.from) + 10).toISOString() });
  await f.ingest({ startedAt: f.range.to, completedAt: new Date(Date.parse(f.range.to) + 10).toISOString() });
  await f.ingest({ phase: 'started' });
  const started = counts(await summary(f));
  assert.equal(started.selectedInvocations, 2); assert.equal(started.totalStarted, 2);
  assert.equal(started.unknownInFlight, 1); assert.equal(started.inFlight, 0);
  const completed = counts(await summary(f, { timeBasis: 'completedAt' }));
  assert.equal(completed.selectedInvocations, 1); assert.equal(completed.totalStarted, null);
  assert.equal(completed.unknownInFlight, 0);
});

test('real stored phase updates and reconciliation select one latest database revision per call', async t => {
  const f = await fixture(t), initial = await f.ingest({ phase: 'started' });
  assert.equal(counts(await summary(f)).unknownInFlight, 1);
  const reconciled = await f.store.reconcile(initial.invocationId, 1,
    { reason: 'progress_timeout', observedBefore: new Date().toISOString() }, f.projector.project);
  assert.equal(reconciled.status, 'updated');
  const inferred = counts(await summary(f));
  assert.equal(inferred.unknown, 1); assert.equal(inferred.selectedInvocations, 1);
  assert.equal(inferred.latency.sampleCount, 0);
  await f.ingest({ ...initial, eventId: randomUUID(), recordVersion: 2, phase: 'finished',
    completedAt: new Date(f.now + 100).toISOString(), durationMs: 100, outcome: 'success' });
  const actual = counts(await summary(f));
  assert.equal(actual.selectedInvocations, 1); assert.equal(actual.successes, 1);
  assert.equal(actual.unknown, 0); assert.equal(actual.latency.sampleCount, 1);
  assert.equal(await f.database.getRepository(entities.RuntimeInvocationRevisionEntity).count(), 3);
});

test('expired invocation revisions are excluded even while source and caller registries remain', async t => {
  const f = await fixture(t), row = await f.ingest();
  const expiresAt = new Date(Date.now() - 1000).toISOString();
  await f.database.getRepository(entities.RuntimeInvocationRevisionEntity).update({ invocationId: row.invocationId }, { expiresAt });
  assert.equal(await f.database.getRepository(entities.RuntimeCallerEntity).count(), 1);
  assert.equal(counts(await summary(f)).selectedInvocations, 0);
});

test('registered anonymous identities and overflow are distinct from trusted unique callers', async t => {
  const f = await fixture(t, 1);
  for (const clientIp of ['192.0.2.1', '192.0.2.2', '192.0.2.3']) {
    await f.ingest({ clientIp, identitySource: 'anonymous', authState: 'anonymous' });
  }
  const value = counts(await summary(f));
  assert.equal(value.selectedInvocations, 3); assert.equal(value.uniqueCallers, 0);
  assert.equal(value.anonymousSources, 1); assert.equal(value.anonymousSourceOverflowRecords, 2);
  assert.equal(value.anonymousSourceCoveragePartial, true);
  assert.equal(counts(await summary(f, { callerId: 'caller-a' })).selectedInvocations, 0);
});

test('source association requires the same asset and cannot turn a hidden registry row into a visible identity', async t => {
  const f = await fixture(t), input = await f.ingest({ identitySource: 'anonymous', authState: 'anonymous' });
  const row = await f.database.getRepository(entities.RuntimeInvocationRevisionEntity).findOneBy({ invocationId: input.invocationId });
  await f.database.getRepository(entities.RuntimeAccessSourceEntity).update({ sourceId: row.sourceId }, { runtimeAssetId: 'asset-b' });
  const value = counts(await summary(f));
  assert.equal(value.selectedInvocations, 1); assert.equal(value.anonymousSources, 0);
  assert.equal(value.unidentifiedSourceRecords, 1);
});

test('stored metric metadata preserves exact large bytes, missing sides and partial lower bounds without payload reads', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 2; i++) {
    const input = await f.ingest(), repository = f.database.getRepository(entities.RuntimeInvocationRevisionEntity);
    const row = await repository.findOneBy({ invocationId: input.invocationId });
    const record = { ...row.record,
      request: { ...row.record.request, observedBytes: Number.MAX_SAFE_INTEGER, digestScope: 'partial' },
      response: { ...row.record.response, observedBytes: null } };
    // Isolated projection data tests numeric/query semantics, not actual network byte production.
    await repository.update({ id: row.id }, { record });
  }
  const value = counts(await summary(f));
  assert.equal(value.requestBytes, (2n * BigInt(Number.MAX_SAFE_INTEGER)).toString());
  assert.equal(value.responseBytes, null); assert.equal(value.partialRecords, 2);
  assert.equal(value.byteGroups[0].request.isLowerBound, true);
  assert.equal(value.byteGroups[0].response.unmeasuredRecords, 2);
  assert.equal(f.payloadReads(), 0);
});

test('HTTP 200 tool errors retain logical failure ratios and explicit approximate latency intervals', async t => {
  const f = await fixture(t);
  await f.ingest({ serverType: 'mcp', spanKind: 'mcp_tool', toolIsError: true, durationMs: 60001 });
  await f.ingest({ serverType: 'mcp', spanKind: 'mcp_tool', durationMs: 5 });
  const value = counts(await summary(f, { scope: 'tool' }));
  assert.equal(value.successes, 1); assert.equal(value.failures, 1);
  assert.equal(value.successRate, 0.5); assert.equal(value.errorRate, 0.5);
  assert.equal(value.latency.approximate, true); assert.equal(value.latency.p95.overflow, true);
  assert.equal(value.latency.p95.estimateMs, null);
});

test('summary discloses no invocation, credential, body, raw source or caller identifiers even with extra grants', async t => {
  const f = await fixture(t), row = await f.ingest(), viewer = f.account([role(allPermissions, null)]);
  const result = await summary(f, {}, viewer), encoded = JSON.stringify(data(result));
  for (const secret of ['private-marker', 'credential-a', 'caller-a', '192.0.2.', 'asset-a', row.invocationId,
    'requestHeaders', 'responseHeaders', 'payloadId', 'fileKey']) assert.equal(encoded.includes(secret), false, secret);
  assert.equal(f.payloadReads(), 0);
});

test('5000 boundary is enforced after permissions, origin, scope and HTTP transport predicates', async t => {
  const f = await fixture(t);
  const input = await f.ingest({ runtimeAssetId: 'asset-b', serverType: 'mcp', spanKind: 'mcp_protocol', protocolTransport: 'stdio' });
  const sample = await f.database.getRepository(entities.RuntimeInvocationRevisionEntity).findOneBy({ invocationId: input.invocationId });
  await f.store.transaction(async tx => {
    const repository = tx.manager.getRepository(entities.RuntimeInvocationRevisionEntity);
    for (let start = 1; start < MAX_METRIC_OBSERVATIONS; start += 16) {
      const values = [];
      for (let i = start; i < Math.min(start + 16, MAX_METRIC_OBSERVATIONS); i++) {
        const id = 'metric-budget-' + String(i).padStart(5, '0');
        values.push(repository.create({ ...sample, id: id + ':1', invocationId: id,
          validFromSequence: tx.nextSequence(), record: { ...sample.record, invocationId: id } }));
      }
      await repository.insert(values);
    }
  });
  const global = f.account([role([READ], null)]);
  assert.equal(counts(await summary(f, { scope: 'protocol' }, global)).selectedInvocations, MAX_METRIC_OBSERVATIONS);
  await f.ingest({ runtimeAssetId: 'asset-b', serverType: 'mcp', spanKind: 'mcp_protocol', protocolTransport: 'stdio' });
  await f.ingest();
  const large = await summary(f, { scope: 'protocol' }, global);
  assert.equal(large.status, 413); assert.equal(large.body.error.code, 'QUERY_TOO_LARGE');
  assert.equal('data' in large.body, false);
  assert.equal(counts(await summary(f, { scope: 'protocol' })).selectedInvocations, 0);
  assert.equal(counts(await summary(f, { scope: 'http_ingress' }, global)).selectedInvocations, 1);
  assert.equal(counts(await summary(f, { scope: 'business' }, global)).selectedInvocations, 1);
});

test('unsupported, missing, repeated and nested queries fail before database access', async t => {
  const f = await fixture(t);
  f.store.readSnapshot = async () => { throw new Error('unexpected database access'); };
  for (const query of ['', 'scope=all', 'scope=business&scope=tool', 'scope=business&limit=1',
    'scope=business&cursor=x', 'scope=business&interval=1m', 'scope=business&groupBy=callerId',
    'scope=business&from%5B0%5D=x', 'scope=business&from=2026-01-01T00%3A00%3A00Z',
    'scope=business&from=2026-01-01T00%3A00%3A00Z&to=2026-03-01T00%3A00%3A00Z']) {
    const result = await f.request('/statistics/summary', query);
    assert.equal(result.status, 400, query); assert.equal(result.body.error.code, 'INVALID_QUERY');
  }
});

test('database failures return a safe unavailable envelope without leaking driver state', async t => {
  const f = await fixture(t);
  f.store.readSnapshot = async () => { throw new Error('password=private-marker internal-driver'); };
  const result = await summary(f);
  assert.equal(result.status, 503); assert.equal(result.body.error.code, 'OBSERVABILITY_UNAVAILABLE');
  assert.equal(JSON.stringify(result.body).includes('private-marker'), false);
  assert.ok(result.body.error.requestId); assert.equal(result.cache, 'no-store');
});

test('summary watermark is a genuine read snapshot and queries do not advance facts or events', async t => {
  const f = await fixture(t); await f.ingest();
  const before = await f.store.readSnapshot(tx => tx.snapshotSeq);
  const events = await f.database.getRepository(RuntimeObservabilityEventEntity).count();
  const result = await summary(f);
  assert.equal(result.body.meta.snapshotSeq, before); assert.equal(result.body.meta.dataWatermark, before);
  assert.equal(await f.store.readSnapshot(tx => tx.snapshotSeq), before);
  assert.equal(await f.database.getRepository(RuntimeObservabilityEventEntity).count(), events);
  assert.equal(await f.database.getRepository(entities.RuntimeMetricBucketEntity).count(), 0);
  assert.equal(await f.database.getRepository(entities.RuntimeMetricContributionEntity).count(), 0);
});

test('generated Swagger matches exact summary queries, required scope, nested DTOs and safe errors', async t => {
  const f = await fixture(t), value = data(await summary(f));
  const swagger = SwaggerModule.createDocument(f.app, new DocumentBuilder().setTitle('Statistics').setVersion('1').build());
  const operation = swagger.paths['/api/v1/monitoring/observability/statistics/summary'].get;
  assert.equal(operation.operationId, 'obsGetStatisticsSummary');
  assert.deepEqual(operation.parameters.filter(item => item.in === 'query').map(item => item.name).sort(),
    [...STATISTICS_SUMMARY_QUERY_KEYS].sort());
  assert.equal(operation.parameters.find(item => item.name === 'scope').required, true);
  for (const code of ['400', '401', '403', '413', '503']) assert.ok(operation.responses[code]);
  assert.equal(operation.responses['200'].content['application/json'].schema.$ref,
    '#/components/schemas/ObservabilityStatisticsSummaryEnvelopeDto');
  const schemas = swagger.components.schemas;
  assert.deepEqual(Object.keys(schemas.ObservabilityStatisticsSummaryDto.properties).sort(), Object.keys(value).sort());
  assert.deepEqual(Object.keys(schemas.ObservabilityStatisticsMetricsDto.properties).sort(), Object.keys(value.metrics).sort());
  assert.equal(schemas.ObservabilityStatisticsMetricsDto.properties.totalStarted.nullable, true);
  assert.ok(schemas.ObservabilityMetricByteSideDto.properties.observedBytes.oneOf);
  assert.equal(schemas.ObservabilityLatencyIntervalDto.properties.upperBoundMs.nullable, true);
});

test('capabilities advertise only the implemented summary route and scoped statistic bounds', async t => {
  const f = await fixture(t), cap = data(await f.request('/capabilities'));
  assert.equal(feature(cap, 'statistics').state, 'enabled');
  assert.equal(feature(cap, 'statisticsTimeSeries').state, 'not_implemented');
  assert.equal(feature(cap, 'statisticsGroups').state, 'not_implemented');
  assert.deepEqual(cap.supportedScopes, [...STATISTICS_SCOPES]);
  assert.deepEqual(cap.supportedGroupByCombinations, []); assert.equal(cap.maxBuckets, null);
  assert.equal(cap.maxStatisticsQueryInvocations, MAX_METRIC_OBSERVATIONS);
  const endpoint = cap.endpoints.find(item => item.endpointId === 'OBS-API-11');
  assert.equal(endpoint.operationId, 'obsGetStatisticsSummary');
  assert.deepEqual(endpoint.queryParameters, [...STATISTICS_SUMMARY_QUERY_KEYS]);
  assert.equal(cap.endpoints.some(item => ['OBS-API-12', 'OBS-API-13'].includes(item.endpointId)), false);
});
