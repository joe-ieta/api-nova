'use strict';
process.env.DB_TYPE = 'sqlite';
for (const key of ['JWT_SECRET', 'API_NOVA_OBSERVABILITY_CURSOR_SECRET',
  'API_NOVA_OBSERVABILITY_CURSOR_KEY_ID']) delete process.env[key];
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHmac } = require('node:crypto');
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
const { CallObservabilityInvocationsService, INVOCATION_QUERY_KEYS } =
  require('../dist/src/modules/call-observability/call-observability-invocations.service.js');
const { CallObservabilityInvocationsController } =
  require('../dist/src/modules/call-observability/call-observability-invocations.controller.js');
const { ObservabilityAccessGuard } = require('../dist/src/modules/call-observability/call-observability-access.guard.js');
const { ObservabilityCursorService } = require('../dist/src/modules/call-observability/call-observability-cursor.service.js');
const { ObservabilityApiExceptionFilter } = require('../dist/src/modules/call-observability/call-observability-api.contract.js');
const { authorizeObservability } = require('../dist/src/modules/call-observability/call-observability-access.js');
const root = path.resolve(__dirname, '../../../tmp/observability-invocations-tests');
const READ = 'monitoring:read', SOURCE = 'monitoring:source:read';
const decode = token => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));

function role(names = [READ], assets = ['asset-a']) {
  return Object.assign(new Role(), {
    id: randomUUID(), name: 'fixture-role', type: RoleType.CUSTOM, enabled: true,
    permissions: names.map(name => Object.assign(new Permission(), { id: randomUUID(), name, enabled: true })),
    metadata: { observabilityScope: assets === null ? { mode: 'all' } : { mode: 'assets', runtimeAssetIds: assets } },
  });
}
async function fixture(t) {
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
  const config = new ConfigService({ JWT_SECRET: secret, API_NOVA_OBSERVABILITY_CURSOR_SECRET: cursorSecret });
  const jwt = new JwtService(), users = new Map();
  const store = new CallObservabilityStore(database, payloads);
  const cursors = new ObservabilityCursorService(config);
  const service = new CallObservabilityInvocationsService(store, cursors);
  let payloadReads = 0;
  payloads.read = async () => { payloadReads++; throw new Error('Metadata APIs must not open body objects'); };
  const resolver = { async findUserById(id) {
    if (!users.has(id)) throw new NotFoundException();
    return users.get(id);
  } };
  class FixtureModule {}
  Module({
    controllers: [CallObservabilityInvocationsController],
    providers: [
      { provide: CallObservabilityInvocationsService, useValue: service },
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
  async function request(route = '/invocations', query = {}, who = user) {
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
      runtimeAssetId: 'asset-a', identitySource: 'authenticated', callerId: 'caller-a',
      credentialId: 'credential-private-marker', clientIp: '192.0.2.10', peerIp: '192.0.2.20',
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
    const result = await store.ingest(row, {}, async (_tx, _before, after) => { after.sourceId = 'source-a'; });
    assert.ok(['inserted', 'updated'].includes(result.status), JSON.stringify(result));
    return row;
  }
  const binding = (who = user) => ({ kind: 'query', endpoint: 'obsListInvocations',
    sort: 'timeBasis:desc,invocationId:desc', authorization: authorizeObservability(who) });
  const signedChange = (value, changes) => {
    const state = { ...decode(value), ...changes };
    const body = Buffer.from(JSON.stringify(state)).toString('base64url');
    const signature = createHmac('sha256', cursorSecret).update('observability.cursor.v1.' + body).digest('base64url');
    return body + '.' + signature;
  };
  return { app, database, store, cursors, service, user, users, account, sign, request, ingest,
    source, now, range, binding, signedChange, payloadReads: () => payloadReads };
}
const ids = result => result.body.data.items.map(row => row.invocationId);

test('empty authorized HTTP query is read-only, unknown coverage is not reported healthy', async t => {
  const f = await fixture(t);
  const result = await f.request();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data, { items: [], nextCursor: null, hasMore: false, timeBasis: 'startedAt' });
  assert.equal(result.body.meta.snapshotSeq, '0');
  assert.equal(result.body.meta.dataWatermark, '0');
  assert.equal(result.body.meta.lagMs, null);
  assert.equal(result.body.meta.historyCompleteSince, null);
  assert.equal(result.body.meta.isPartial, true);
  assert.equal(result.cache, 'no-store');
  assert.equal(await f.database.getRepository(entities.RuntimePipelineStateEntity).count(), 0);
});

test('list returns scoped metadata only and opt-in total excludes hidden assets and origins', async t => {
  const f = await fixture(t);
  await f.ingest({ invocationId: 'visible' });
  await f.ingest({ invocationId: 'hidden', runtimeAssetId: 'asset-b' });
  await f.ingest({ invocationId: 'test-origin', origin: 'test' });
  const result = await f.request('/invocations', { ...f.range, includeTotal: 'true' });
  assert.equal(result.status, 200);
  assert.deepEqual(ids(result), ['visible']);
  assert.equal(result.body.data.total, 1);
  const serialized = JSON.stringify(result.body);
  for (const value of ['private-marker', 'credentialId', 'requestHeaders', 'responseHeaders',
    'fileKey', 'storageOwnerId', '192.0.2.', 'https://example.invalid', 'hidden']) {
    assert.equal(serialized.includes(value), false, value);
  }
  const item = result.body.data.items[0];
  assert.equal(item.request.state, 'captured');
  assert.equal(item.request.readLink, '/api/v1/monitoring/observability/invocations/visible/payloads/request');
  assert.equal(item.sourceRestricted, true);
  assert.equal(item.publicationSnapshot, null);
  assert.ok(item.missingFields.includes('publicationSnapshot'));
  assert.equal(f.payloadReads(), 0);
});

test('detail is latest, exact, scoped, no-store and rejects unknown query parameters', async t => {
  const f = await fixture(t);
  await f.ingest({ invocationId: 'visible' });
  await f.ingest({ invocationId: 'hidden', runtimeAssetId: 'asset-b' });
  const result = await f.request('/invocations/visible', { timeBasis: 'completedAt' });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.invocationId, 'visible');
  assert.equal(result.body.data.recordVersion, 1);
  assert.equal(result.body.data.timeBasis, 'completedAt');
  assert.equal(result.cache, 'no-store');
  for (const id of ['hidden', 'nonexistent']) {
    const missing = await f.request('/invocations/' + id);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'NOT_FOUND');
  }
  assert.equal((await f.request('/invocations/visible', { includeTotal: 'true' })).status, 400);
  assert.equal(f.payloadReads(), 0);
});

test('empty asset scope never drops its SQL authorization predicate', async t => {
  const f = await fixture(t);
  await f.ingest({ invocationId: 'visible' });
  const nobody = f.account([role([READ], [])]);
  const list = await f.request('/invocations', { ...f.range, includeTotal: 'true' }, nobody);
  assert.equal(list.status, 200);
  assert.equal(list.body.data.total, 0);
  assert.deepEqual(ids(list), []);
  assert.equal((await f.request('/invocations/visible', {}, nobody)).status, 404);
  const outside = await f.request('/invocations', { ...f.range, runtimeAssetId: 'asset-b', includeTotal: 'true' });
  assert.equal(outside.body.data.total, 0);
});

test('explicit global scope can read unassigned assets but does not implicitly expose IP', async t => {
  const f = await fixture(t);
  await f.ingest({ invocationId: 'unassigned', runtimeAssetId: null });
  const global = f.account([role([READ], null)]);
  const result = await f.request('/invocations/unassigned', {}, global);
  assert.equal(result.status, 200);
  assert.equal(result.body.data.runtimeAssetId, null);
  assert.equal(result.body.data.sourceRestricted, true);
  assert.equal((await f.request('/invocations/unassigned')).status, 404);
});

test('IP fields require an asset-wise AND of read and source permissions', async t => {
  const f = await fixture(t);
  await f.ingest({ invocationId: 'a' });
  await f.ingest({ invocationId: 'b', runtimeAssetId: 'asset-b' });
  const reader = f.account([role([READ], ['asset-a', 'asset-b']), role([SOURCE], ['asset-a'])]);
  const result = await f.request('/invocations', f.range, reader);
  assert.equal(result.status, 200);
  const a = result.body.data.items.find(item => item.invocationId === 'a');
  const b = result.body.data.items.find(item => item.invocationId === 'b');
  assert.equal(a.clientIp, '192.0.2.10');
  assert.equal(a.peerIp, '192.0.2.20');
  assert.equal(a.sourceRestricted, false);
  assert.equal(Object.hasOwn(b, 'clientIp'), false);
  assert.equal(Object.hasOwn(b, 'ipSource'), false);
  assert.equal(b.sourceRestricted, true);
});

test('current management identity is required; business JWT and deleted user fail closed', async t => {
  const f = await fixture(t);
  for (const access of [null, 'invalid.token', f.sign(f.user, { tokenUse: 'business' })]) {
    const result = await f.request('/invocations', {}, access);
    assert.equal(result.status, 401);
    assert.equal(result.body.error.code, 'UNAUTHENTICATED');
  }
  const denied = f.account([role([], ['asset-a'])]);
  assert.equal((await f.request('/invocations', {}, denied)).status, 403);
  const oldToken = f.sign(f.user);
  f.users.delete(f.user.id);
  assert.equal((await f.request('/invocations', {}, oldToken)).status, 401);
});

test('all documented equality filters work without interpolating SQL input', async t => {
  const f = await fixture(t);
  await f.ingest({ invocationId: 'target', requestId: "request' OR 1=1 --", serverType: 'mcp',
    spanKind: 'upstream_api', endpointDefinitionId: 'endpoint-a', toolName: 'tool-a',
    sourceServiceInstanceId: 'upstream-a', errorCategory: 'connection', outcome: 'error', traceId: 'trace-a' });
  await f.ingest({ invocationId: 'other' });
  const result = await f.request('/invocations', { ...f.range, serverType: 'mcp', spanKind: 'upstream_api',
    runtimeAssetId: 'asset-a', callerId: 'caller-a', sourceId: 'source-a',
    endpointDefinitionId: 'endpoint-a', toolName: 'tool-a', sourceServiceInstanceId: 'upstream-a',
    outcome: 'error', errorCategory: 'connection', traceId: 'trace-a', requestId: "request' OR 1=1 --" });
  assert.equal(result.status, 200);
  assert.deepEqual(ids(result), ['target']);
  const missing = await f.request('/invocations', { ...f.range, requestId: "' OR 1=1 --", includeTotal: 'true' });
  assert.equal(missing.body.data.total, 0);
});

test('strict query rejects duplicates, nested values, unsupported filters and invalid bounds', async t => {
  const f = await fixture(t);
  for (const query of ['limit=0', 'limit=201', 'limit=2&limit=3', 'callerId[x]=value', 'includeTotal=1',
    'timeBasis=foo', 'origin=telemetry', 'from=2026-09-09T00:00:00Z', 'clientIp=192.0.2.1',
    'sort=startedAt', 'from=2026-02-30T00:00:00Z&to=2026-03-01T00:00:00Z',
    'from=2026-01-01T00:00:00Z&to=2026-03-01T00:00:00Z']) {
    const result = await f.request('/invocations', query);
    assert.equal(result.status, 400, query);
    assert.equal(result.body.error.code, 'INVALID_QUERY', query);
  }
});

test('half-open time range, completedAt basis and null completion are distinct', async t => {
  const f = await fixture(t);
  const from = new Date(f.now).toISOString(), to = new Date(f.now + 1000).toISOString();
  await f.ingest({ invocationId: 'at-from', startedAt: from, completedAt: new Date(f.now + 500).toISOString() });
  await f.ingest({ invocationId: 'at-to', startedAt: to, completedAt: new Date(f.now + 1010).toISOString() });
  await f.ingest({ invocationId: 'running', startedAt: from, phase: 'started' });
  const starts = await f.request('/invocations', { from, to });
  assert.deepEqual(ids(starts), ['running', 'at-from']);
  const completed = await f.request('/invocations', { from, to, timeBasis: 'completedAt' });
  assert.deepEqual(ids(completed), ['at-from']);
  assert.equal(completed.body.data.timeBasis, 'completedAt');
});

test('snapshot paging stays stable after inserts and terminal updates; detail sees the update', async t => {
  const f = await fixture(t);
  await f.ingest({ invocationId: 'inv-a' });
  const running = await f.ingest({ invocationId: 'inv-b', phase: 'started' });
  await f.ingest({ invocationId: 'inv-c' });
  const first = await f.request('/invocations', { ...f.range, limit: '1', includeTotal: 'true' });
  assert.deepEqual(ids(first), ['inv-c']);
  assert.equal(first.body.data.total, 3);
  await f.store.ingest({ ...running, eventId: randomUUID(), sourceSequence: 2, recordVersion: 2,
    phase: 'finished', completedAt: new Date(f.now + 20).toISOString(), outcome: 'timeout', statusCode: 504 });
  await f.ingest({ invocationId: 'inv-d' });
  const second = await f.request('/invocations', { cursor: first.body.data.nextCursor, limit: '1', includeTotal: 'true' });
  assert.equal(second.status, 200);
  assert.deepEqual(ids(second), ['inv-b']);
  assert.equal(second.body.data.items[0].lifecycle, 'running');
  assert.equal(second.body.data.items[0].recordVersion, 1);
  assert.equal(second.body.data.total, 3);
  assert.equal(second.body.meta.snapshotSeq, first.body.meta.snapshotSeq);
  const last = await f.request('/invocations', { cursor: second.body.data.nextCursor, limit: '10' });
  assert.deepEqual(ids(last), ['inv-a']);
  assert.equal(last.body.data.nextCursor, null);
  assert.equal(last.body.data.hasMore, false);
  assert.equal(Object.hasOwn(last.body.data, 'total'), false);
  const detail = await f.request('/invocations/inv-b');
  assert.equal(detail.body.data.recordVersion, 2);
  assert.equal(detail.body.data.outcome, 'timeout');
  assert.deepEqual(ids(await f.request('/invocations', f.range)), ['inv-d', 'inv-c', 'inv-b', 'inv-a']);
});

test('completedAt descending pagination uses selected time rather than startedAt', async t => {
  const f = await fixture(t);
  await f.ingest({ invocationId: 'early-start-late-finish', startedAt: new Date(f.now - 1000).toISOString(),
    completedAt: new Date(f.now + 1000).toISOString() });
  await f.ingest({ invocationId: 'late-start-early-finish' });
  const first = await f.request('/invocations', { ...f.range, timeBasis: 'completedAt', limit: '1' });
  assert.deepEqual(ids(first), ['early-start-late-finish']);
  const second = await f.request('/invocations', { cursor: first.body.data.nextCursor, limit: '1' });
  assert.deepEqual(ids(second), ['late-start-early-finish']);
  assert.equal(second.body.data.timeBasis, 'completedAt');
});

test('cursor retains default window, allows page size changes and rejects changed filters or principal', async t => {
  const f = await fixture(t);
  await f.ingest({ invocationId: 'a' }); await f.ingest({ invocationId: 'b' });
  const first = await f.request('/invocations', { limit: '1' });
  const cursor = first.body.data.nextCursor;
  assert.ok(cursor);
  const resumed = await f.request('/invocations', { cursor, limit: '2', includeTotal: 'true' });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.data.total, 2);
  for (const extra of [{ origin: 'test' }, { timeBasis: 'completedAt' }, { runtimeAssetId: 'asset-a' }]) {
    const result = await f.request('/invocations', { cursor, ...extra });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'CURSOR_SCOPE_MISMATCH');
  }
  const other = f.account();
  assert.equal((await f.request('/invocations', { cursor }, other)).body.error.code, 'CURSOR_SCOPE_MISMATCH');
  f.user.roles = [role([READ], ['asset-a', 'asset-b'])];
  assert.equal((await f.request('/invocations', { cursor })).body.error.code, 'CURSOR_SCOPE_MISMATCH');
});

test('cursor signature, endpoint, position, snapshot and expiry failures are explicit', async t => {
  const f = await fixture(t);
  await f.ingest({ invocationId: 'a' }); await f.ingest({ invocationId: 'b' });
  const first = await f.request('/invocations', { ...f.range, limit: '1' });
  const cursor = first.body.data.nextCursor, decoded = decode(cursor);
  for (const [value, status, code] of [
    [cursor + 'x', 400, 'INVALID_QUERY'],
    [f.signedChange(cursor, { endpoint: 'obsListCallers' }), 400, 'CURSOR_SCOPE_MISMATCH'],
    [f.signedChange(cursor, { position: { ...decoded.position, time: 'not-a-time' } }), 400, 'INVALID_QUERY'],
    [f.signedChange(cursor, { position: { ...decoded.position, extra: 'unknown' } }), 400, 'INVALID_QUERY'],
    [f.signedChange(cursor, { snapshotSeq: '18446744073709551615' }), 400, 'INVALID_QUERY'],
    [f.signedChange(cursor, { issuedAt: Date.now() - 2000, expiresAt: Date.now() - 1000 }), 410, 'QUERY_CURSOR_EXPIRED'],
    [f.signedChange(cursor, { position: { ...decoded.position, expiresAt: new Date(Date.now() - 1).toISOString() } }),
      410, 'QUERY_CURSOR_EXPIRED'],
  ]) {
    const result = await f.request('/invocations', { cursor: value });
    assert.equal(result.status, status);
    assert.equal(result.body.error.code, code);
  }
});

test('cursor lifetime is bounded by earliest metadata retention and does not grow across pages', async t => {
  const f = await fixture(t);
  for (const invocationId of ['a', 'b', 'c']) await f.ingest({ invocationId });
  const expiry = new Date(Date.now() + 60000).toISOString();
  await f.database.getRepository(entities.RuntimeInvocationRevisionEntity).update({ invocationId: 'a' }, { expiresAt: expiry });
  const first = await f.request('/invocations', { ...f.range, limit: '1' });
  assert.equal(decode(first.body.data.nextCursor).position.expiresAt, expiry);
  const second = await f.request('/invocations', { cursor: first.body.data.nextCursor, limit: '1' });
  assert.equal(decode(second.body.data.nextCursor).position.expiresAt, expiry);
});

test('cross-asset parent and root identifiers are clipped without exposing hidden node counts', async t => {
  const f = await fixture(t);
  await f.ingest({ invocationId: 'hidden-parent', runtimeAssetId: 'asset-b' });
  await f.ingest({ invocationId: 'visible-child', parentInvocationId: 'hidden-parent',
    rootInvocationId: 'hidden-parent', traceId: 'hidden-parent', requestId: 'hidden-parent', spanKind: 'upstream_api' });
  const result = await f.request('/invocations/visible-child');
  assert.equal(result.status, 200);
  const item = result.body.data;
  for (const field of ['parentInvocationId', 'rootInvocationId', 'traceId', 'requestId']) assert.equal(item[field], null);
  assert.equal(item.linksRestricted, true);
  assert.equal(JSON.stringify(result.body).includes('hidden-parent'), false);
  assert.equal(Object.hasOwn(item, 'hiddenNodeCount'), false);
  const global = f.account([role([READ], null)]);
  assert.equal((await f.request('/invocations/visible-child', {}, global)).body.data.parentInvocationId, 'hidden-parent');
});

test('authorized references outside the current time/filter page remain linked', async t => {
  const f = await fixture(t);
  await f.ingest({ invocationId: 'parent', startedAt: new Date(f.now - 120000).toISOString(),
    completedAt: new Date(f.now - 119000).toISOString() });
  await f.ingest({ invocationId: 'child', parentInvocationId: 'parent', rootInvocationId: 'parent', traceId: 'parent' });
  const result = await f.request('/invocations', f.range);
  assert.deepEqual(ids(result), ['child']);
  assert.equal(result.body.data.items[0].parentInvocationId, 'parent');
  assert.equal(result.body.data.items[0].linksRestricted, false);
});

test('HTTP 200 tool errors, running, reconciled unknown and unavailable bytes remain distinct', async t => {
  const f = await fixture(t);
  await f.ingest({ invocationId: 'tool', serverType: 'mcp', spanKind: 'mcp_tool', toolIsError: true,
    errorCategory: 'secret=private-marker', failureStage: 'password=private-marker' });
  const running = await f.ingest({ invocationId: 'unknown', phase: 'started', request: undefined, response: undefined });
  await f.store.reconcile(running.invocationId, 1, { reason: 'progress_timeout', observedBefore: new Date().toISOString() });
  const tool = (await f.request('/invocations/tool')).body.data;
  assert.equal(tool.httpStatus, 200); assert.equal(tool.outcome, 'error');
  assert.equal(JSON.stringify(tool).includes('private-marker'), false);
  const unknown = (await f.request('/invocations/unknown')).body.data;
  assert.equal(unknown.outcome, 'unknown'); assert.equal(unknown.completionSource, 'reconciled');
  assert.equal(unknown.completedAt, null); assert.equal(unknown.durationMs, null);
  assert.equal(unknown.requestBytes, null); assert.equal(unknown.partial, true);
});

test('payload retention overrides snapshot metadata without reading body objects', async t => {
  const f = await fixture(t);
  await f.ingest({ invocationId: 'old-body', startedAt: new Date(f.now - 8 * 86400000).toISOString(),
    completedAt: new Date(f.now - 8 * 86400000 + 10).toISOString() });
  const detail = await f.request('/invocations/old-body');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.request.state, 'expired');
  assert.equal(detail.body.data.request.reason, 'retention_elapsed');
  assert.equal(f.payloadReads(), 0);
});

test('expired invocation metadata is absent from both detail and list', async t => {
  const f = await fixture(t);
  await f.ingest({ invocationId: 'expired' });
  // Advance retention only in this owned in-memory fixture, not the producer clock.
  const expiresAt = new Date(Date.now() - 1000).toISOString();
  await f.database.getRepository(entities.RuntimeInvocationEntity).update({ invocationId: 'expired' }, { expiresAt });
  await f.database.getRepository(entities.RuntimeInvocationRevisionEntity).update({ invocationId: 'expired' }, { expiresAt });
  assert.equal((await f.request('/invocations/expired')).status, 404);
  const list = await f.request('/invocations', { ...f.range, includeTotal: 'true' });
  assert.equal(list.body.data.total, 0);
  const outsideRetention = await f.store.ingest(f.source({ invocationId: 'never-indexed',
    startedAt: new Date(f.now - 31 * 86400000).toISOString(),
    completedAt: new Date(f.now - 31 * 86400000 + 10).toISOString() }));
  assert.equal(outsideRetention.status, 'quarantined');
  assert.equal(outsideRetention.reason, 'OUTSIDE_METADATA_RETENTION');
});

test('failed database reads return a safe envelope, never private driver details', async t => {
  const f = await fixture(t);
  f.store.readSnapshot = async () => { throw new Error('password=private-marker E:/private/db.sqlite'); };
  const result = await f.request();
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'OBSERVABILITY_UNAVAILABLE');
  assert.equal(JSON.stringify(result.body).includes('private'), false);
  assert.equal(result.cache, 'no-store');
});

test('generated Swagger matches real paths, operation IDs, query allowlist and safe response DTOs', async t => {
  const f = await fixture(t);
  const document = SwaggerModule.createDocument(f.app, new DocumentBuilder().setTitle('Fixture').setVersion('1.0').addBearerAuth().build());
  const listPath = '/api/v1/monitoring/observability/invocations';
  const detailPath = listPath + '/{id}';
  assert.deepEqual(Object.keys(document.paths).sort(), [listPath, detailPath,
    '/api/v1/monitoring/observability/traces/{traceId}'].sort());
  const list = document.paths[listPath].get, detail = document.paths[detailPath].get;
  assert.equal(list.operationId, 'obsListInvocations');
  assert.equal(detail.operationId, 'obsGetInvocation');
  assert.deepEqual(list.parameters.filter(item => item.in === 'query').map(item => item.name).sort(),
    [...INVOCATION_QUERY_KEYS].sort());
  assert.equal(list.parameters.find(item => item.name === 'limit').schema.maximum, 200);
  assert.deepEqual(list.security, [{ bearer: [] }]);
  assert.ok(list.responses['410']); assert.ok(detail.responses['404']);
  assert.equal(list.responses['200'].content['application/json'].schema.$ref,
    '#/components/schemas/ObservabilityInvocationListEnvelopeDto');
  const schema = document.components.schemas.ObservabilityInvocationDto;
  for (const field of ['invocationId', 'recordVersion', 'linksRestricted', 'sourceRestricted', 'request', 'response']) {
    assert.ok(schema.properties[field], field);
  }
  for (const field of ['credentialId', 'requestHeaders', 'fileKey', 'record']) assert.equal(schema.properties[field], undefined);
  assert.equal(schema.required.includes('clientIp'), false);
  assert.ok(document.components.schemas.ObservabilityInvocationDetailDto.properties.timeBasis);
});

const traceRoute = id => '/traces/' + encodeURIComponent(id);
const traceIds = result => result.body.data.nodes.map(node => node.invocationId);

async function seedTraceProjection(f, count, traceId, runtimeAssetId = 'asset-a') {
  // Size-bound fixture only: use real metadata/revision tables without 200 body writes.
  const prefix = randomUUID();
  const first = await f.ingest({ invocationId: prefix + '-000', traceId, runtimeAssetId,
    request: undefined, response: undefined });
  const template = await f.database.getRepository(entities.RuntimeInvocationEntity).findOneBy({ invocationId: first.invocationId });
  await f.store.transaction(async tx => {
    let current = [], revisions = [];
    async function flush() {
      if (!current.length) return;
      await tx.manager.getRepository(entities.RuntimeInvocationEntity).insert(current);
      await tx.manager.getRepository(entities.RuntimeInvocationRevisionEntity).insert(revisions);
      current = []; revisions = [];
    }
    for (let i = 1; i < count; i++) {
      const invocationId = prefix + '-' + String(i).padStart(3, '0'), sequence = tx.nextSequence();
      const row = { ...template, invocationId, createdSequence: sequence, updatedSequence: sequence,
        record: { ...template.record, invocationId, rootInvocationId: invocationId,
          sourceEventId: randomUUID(), requestId: 'request-' + i } };
      current.push(row);
      revisions.push({ ...row, id: randomUUID(), validFromSequence: sequence, validUntilSequence: null });
      if (current.length === 16) await flush();
    }
    await flush();
  });
  return prefix;
}

test('trace returns all retained Gateway/protocol/tool/upstream boundaries without a one-hour cutoff', async t => {
  const f = await fixture(t), traceId = 'trace-full';
  f.user.roles = [role([READ], ['asset-a', 'asset-b'])];
  await f.ingest({ invocationId: 'gateway-root', traceId, startedAt: new Date(f.now - 7200000).toISOString() });
  await f.ingest({ invocationId: 'protocol', traceId, serverType: 'mcp', spanKind: 'mcp_protocol',
    runtimeAssetId: 'asset-b', parentInvocationId: 'gateway-root', rootInvocationId: 'gateway-root' });
  await f.ingest({ invocationId: 'tool', traceId, serverType: 'mcp', spanKind: 'mcp_tool',
    runtimeAssetId: 'asset-b', parentInvocationId: 'protocol', rootInvocationId: 'gateway-root' });
  await f.ingest({ invocationId: 'upstream', traceId, serverType: 'mcp', spanKind: 'upstream_api',
    runtimeAssetId: 'asset-b', parentInvocationId: 'tool', rootInvocationId: 'gateway-root',
    outcome: 'timeout', statusCode: 504, attemptIndex: 2, upstreamOperationId: 'operation-fixture' });
  const watermark = await f.store.watermark();
  const result = await f.request(traceRoute(traceId));
  assert.equal(result.status, 200);
  assert.deepEqual(traceIds(result), ['gateway-root', 'protocol', 'tool', 'upstream']);
  assert.deepEqual(result.body.data.edges, [
    { parentInvocationId: 'gateway-root', childInvocationId: 'protocol' },
    { parentInvocationId: 'protocol', childInvocationId: 'tool' },
    { parentInvocationId: 'tool', childInvocationId: 'upstream' },
  ]);
  assert.equal(result.body.data.relationshipsComplete, true);
  assert.equal(result.body.data.maxNodes, 200);
  assert.equal(result.body.data.nodes[3].outcome, 'timeout');
  assert.equal(result.body.data.nodes[3].attemptIndex, 2);
  assert.equal(result.body.meta.snapshotSeq, watermark);
  assert.equal(result.body.meta.lagMs, null);
  assert.equal(result.body.meta.isPartial, true);
  assert.equal(result.cache, 'no-store');
  assert.equal(f.payloadReads(), 0);
  assert.equal(await f.store.watermark(), watermark);
});

test('trace clips a hidden root without removing authorized child-to-child edges or revealing hidden IDs', async t => {
  const f = await fixture(t), traceId = 'trace-scoped';
  await f.ingest({ invocationId: 'private-root', runtimeAssetId: 'asset-b', traceId });
  await f.ingest({ invocationId: 'visible-tool', spanKind: 'mcp_tool', serverType: 'mcp',
    traceId, parentInvocationId: 'private-root', rootInvocationId: 'private-root', requestId: 'private-root' });
  await f.ingest({ invocationId: 'visible-upstream', spanKind: 'upstream_api', traceId,
    parentInvocationId: 'visible-tool', rootInvocationId: 'private-root' });
  const result = await f.request(traceRoute(traceId));
  assert.equal(result.status, 200);
  assert.deepEqual(traceIds(result), ['visible-tool', 'visible-upstream']);
  assert.deepEqual(result.body.data.edges, [{ parentInvocationId: 'visible-tool', childInvocationId: 'visible-upstream' }]);
  assert.deepEqual(result.body.data.missingParentReferences, [{ invocationId: 'visible-tool', reason: 'unavailable_or_restricted' }]);
  assert.equal(result.body.data.nodes[0].requestId, null);
  assert.ok(result.body.data.nodes.every(node => node.rootInvocationId === null && node.traceId === null));
  assert.equal(result.body.data.relationshipsComplete, false);
  const serialized = JSON.stringify(result.body);
  assert.equal(serialized.includes('private-root'), false);
  for (const field of ['hiddenNodeCount', 'totalNodeCount', 'restrictedCount']) assert.equal(serialized.includes(field), false);
});

test('trace reports absent parents without fabricating nodes or distinguishing absent from inaccessible', async t => {
  const f = await fixture(t);
  await f.ingest({ invocationId: 'orphan', traceId: 'trace-orphan',
    parentInvocationId: 'unknown-parent', rootInvocationId: 'unknown-root', requestId: 'unknown-parent' });
  const result = await f.request(traceRoute('trace-orphan'));
  assert.equal(result.status, 200);
  assert.deepEqual(traceIds(result), ['orphan']);
  assert.deepEqual(result.body.data.edges, []);
  assert.deepEqual(result.body.data.missingParentReferences, [{ invocationId: 'orphan', reason: 'unavailable_or_restricted' }]);
  assert.equal(result.body.data.relationshipsComplete, false);
  assert.equal(JSON.stringify(result.body).includes('unknown-parent'), false);
  assert.equal(JSON.stringify(result.body).includes('unknown-root'), false);
});

test('trace responses stay closed when globally visible references belong to another trace', async t => {
  const f = await fixture(t), global = f.account([role([READ], null)]);
  await f.ingest({ invocationId: 'other-trace-parent', traceId: 'trace-other' });
  await f.ingest({ invocationId: 'child', traceId: 'trace-child',
    parentInvocationId: 'other-trace-parent', rootInvocationId: 'other-trace-parent' });
  const result = await f.request(traceRoute('trace-child'), {}, global);
  assert.equal(result.status, 200);
  assert.deepEqual(traceIds(result), ['child']);
  assert.equal(result.body.data.nodes[0].parentInvocationId, null);
  assert.equal(JSON.stringify(result.body).includes('other-trace-parent'), false);
  assert.equal(result.body.data.relationshipsComplete, false);
});

test('hidden, empty-scope, unassigned and nonexistent traces follow the same not-found policy', async t => {
  const f = await fixture(t);
  await f.ingest({ invocationId: 'hidden', traceId: 'trace-hidden', runtimeAssetId: 'asset-b' });
  await f.ingest({ invocationId: 'unassigned', traceId: 'trace-unassigned', runtimeAssetId: null });
  const nobody = f.account([role([READ], [])]);
  for (const [traceId, user] of [['trace-hidden', f.user], ['missing-trace', f.user],
    ['trace-unassigned', f.user], ['trace-hidden', nobody]]) {
    const result = await f.request(traceRoute(traceId), {}, user);
    assert.equal(result.status, 404);
    assert.equal(result.body.error.code, 'NOT_FOUND');
  }
  const global = f.account([role([READ], null)]);
  assert.equal((await f.request(traceRoute('trace-unassigned'), {}, global)).status, 200);
});

test('trace still requires current management authorization rather than a known correlation ID', async t => {
  const f = await fixture(t);
  await f.ingest({ invocationId: 'root', traceId: 'trace-auth' });
  assert.equal((await f.request(traceRoute('trace-auth'), {}, null)).status, 401);
  assert.equal((await f.request(traceRoute('trace-auth'), {}, f.sign(f.user, { tokenUse: 'business' }))).status, 401);
  const denied = f.account([role([], ['asset-a'])]);
  assert.equal((await f.request(traceRoute('trace-auth'), {}, denied)).status, 403);
  const token = f.sign(f.user);
  f.user.roles = [role([READ], ['asset-b'])];
  assert.equal((await f.request(traceRoute('trace-auth'), {}, token)).status, 404);
});

test('trace origin defaults to external and does not mix test/probe/internal evidence', async t => {
  const f = await fixture(t);
  for (const origin of ['external', 'test', 'probe', 'internal']) {
    await f.ingest({ invocationId: 'root-' + origin, traceId: 'trace-origins', origin });
  }
  assert.deepEqual(traceIds(await f.request(traceRoute('trace-origins'))), ['root-external']);
  for (const origin of ['test', 'probe', 'internal']) {
    const result = await f.request(traceRoute('trace-origins'), { origin });
    assert.deepEqual(traceIds(result), ['root-' + origin]);
    assert.equal(result.body.data.origin, origin);
  }
});

test('trace rejects unsupported filters, repeated origin and malformed correlation IDs', async t => {
  const f = await fixture(t);
  for (const query of [{ from: f.range.from, to: f.range.to }, { limit: '1' }, { cursor: 'opaque' },
    { includeTotal: 'true' }, { callerId: 'caller-a' }, { origin: 'telemetry' }, 'origin=external&origin=internal']) {
    const result = await f.request(traceRoute('trace-query'), query);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'INVALID_QUERY');
  }
  for (const traceId of ['x'.repeat(241), '\u0000']) {
    assert.equal((await f.request(traceRoute(traceId))).status, 400);
  }
});

test('trace ID values are SQL parameters, including quotes and injection-shaped values', async t => {
  const f = await fixture(t), quoted = "trace' OR 1=1 --";
  await f.ingest({ invocationId: 'quoted', traceId: quoted });
  await f.ingest({ invocationId: 'unrelated', traceId: 'another-trace' });
  const result = await f.request(traceRoute(quoted));
  assert.equal(result.status, 200);
  assert.deepEqual(traceIds(result), ['quoted']);
  assert.equal((await f.request(traceRoute("' OR 1=1 --"))).status, 404);
});

test('trace selects one latest revision per invocation through running, inferred and observed completion', async t => {
  const f = await fixture(t);
  const row = await f.ingest({ invocationId: 'root', traceId: 'trace-revision', phase: 'started' });
  let result = await f.request(traceRoute('trace-revision'));
  assert.equal(result.body.data.nodes.length, 1);
  assert.equal(result.body.data.nodes[0].recordVersion, 1);
  assert.equal(result.body.data.nodes[0].lifecycle, 'running');
  await f.store.reconcile(row.invocationId, 1, { reason: 'progress_timeout', observedBefore: new Date().toISOString() });
  result = await f.request(traceRoute('trace-revision'));
  assert.equal(result.body.data.nodes.length, 1);
  assert.equal(result.body.data.nodes[0].recordVersion, 2);
  assert.equal(result.body.data.nodes[0].outcome, 'unknown');
  assert.equal(result.body.data.nodes[0].completedAt, null);
  const finished = await f.store.ingest({ ...row, eventId: randomUUID(), sourceSequence: 2, recordVersion: 2,
    phase: 'finished', completedAt: new Date().toISOString(), outcome: 'success', statusCode: 200 });
  assert.equal(finished.status, 'updated');
  result = await f.request(traceRoute('trace-revision'));
  assert.equal(result.body.data.nodes.length, 1);
  assert.equal(result.body.data.nodes[0].recordVersion, 3);
  assert.equal(result.body.data.nodes[0].outcome, 'success');
  assert.equal(result.body.meta.snapshotSeq, await f.store.watermark());
});

test('trace omits expired metadata and marks its retained children as incomplete references', async t => {
  const f = await fixture(t);
  await f.ingest({ invocationId: 'expired-parent', traceId: 'trace-retention' });
  await f.ingest({ invocationId: 'child', traceId: 'trace-retention',
    parentInvocationId: 'expired-parent', rootInvocationId: 'expired-parent' });
  const expiresAt = new Date(Date.now() - 1000).toISOString();
  await f.database.getRepository(entities.RuntimeInvocationEntity).update({ invocationId: 'expired-parent' }, { expiresAt });
  await f.database.getRepository(entities.RuntimeInvocationRevisionEntity).update({ invocationId: 'expired-parent' }, { expiresAt });
  const result = await f.request(traceRoute('trace-retention'));
  assert.deepEqual(traceIds(result), ['child']);
  assert.equal(result.body.data.missingParentReferences.length, 1);
  assert.equal(JSON.stringify(result.body).includes('expired-parent'), false);
});

test('trace removes cyclic parent edges without rewriting stored evidence or dropping descendants', async t => {
  const f = await fixture(t);
  await f.ingest({ invocationId: 'a', traceId: 'trace-cycle', parentInvocationId: 'b', rootInvocationId: 'a' });
  await f.ingest({ invocationId: 'b', traceId: 'trace-cycle', parentInvocationId: 'a', rootInvocationId: 'a' });
  await f.ingest({ invocationId: 'c', traceId: 'trace-cycle', parentInvocationId: 'b', rootInvocationId: 'a' });
  const result = await f.request(traceRoute('trace-cycle'));
  assert.equal(result.status, 200);
  assert.deepEqual(traceIds(result), ['a', 'b', 'c']);
  assert.deepEqual(result.body.data.edges, [{ parentInvocationId: 'b', childInvocationId: 'c' }]);
  assert.deepEqual(result.body.data.structuralIssues, [
    { invocationId: 'a', reason: 'parent_cycle' }, { invocationId: 'b', reason: 'parent_cycle' },
  ]);
  assert.equal(result.body.data.nodes[0].parentInvocationId, null);
  assert.equal(result.body.data.relationshipsComplete, false);
  assert.equal((await f.database.getRepository(entities.RuntimeInvocationEntity).findOneBy({ invocationId: 'a' })).parentInvocationId, 'b');
  await f.ingest({ invocationId: 'self', traceId: 'trace-self', parentInvocationId: 'self', rootInvocationId: 'self' });
  const self = await f.request(traceRoute('trace-self'));
  assert.deepEqual(self.body.data.edges, []);
  assert.deepEqual(self.body.data.structuralIssues, [{ invocationId: 'self', reason: 'parent_cycle' }]);
});

test('trace retains metadata-only disclosure and asset-wise source permission', async t => {
  const f = await fixture(t);
  await f.ingest({ invocationId: 'a', traceId: 'trace-source' });
  await f.ingest({ invocationId: 'b', traceId: 'trace-source', runtimeAssetId: 'asset-b',
    parentInvocationId: 'a', rootInvocationId: 'a' });
  const reader = f.account([role([READ], ['asset-a', 'asset-b']), role([SOURCE], ['asset-b'])]);
  const result = await f.request(traceRoute('trace-source'), {}, reader);
  assert.equal(result.status, 200);
  assert.equal(Object.hasOwn(result.body.data.nodes[0], 'clientIp'), false);
  assert.equal(result.body.data.nodes[1].clientIp, '192.0.2.10');
  assert.equal(result.body.data.nodes[1].sourceRestricted, false);
  assert.equal(f.payloadReads(), 0);
  for (const value of ['private-marker', 'credentialId', 'requestHeaders', 'fileKey', 'storageOwnerId']) {
    assert.equal(JSON.stringify(result.body).includes(value), false, value);
  }
});

test('trace accepts its exact node bound and rejects a larger visible graph without truncating', async t => {
  const f = await fixture(t);
  await seedTraceProjection(f, 200, 'trace-bound');
  const exact = await f.request(traceRoute('trace-bound'));
  assert.equal(exact.status, 200);
  assert.equal(exact.body.data.nodes.length, 200);
  await f.ingest({ invocationId: 'extra', traceId: 'trace-bound' });
  const tooLarge = await f.request(traceRoute('trace-bound'));
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.body.error.code, 'QUERY_TOO_LARGE');
  assert.equal(Object.hasOwn(tooLarge.body, 'data'), false);
});

test('trace node bound is applied only after authorization, not to hidden node counts', async t => {
  const f = await fixture(t);
  const hiddenPrefix = await seedTraceProjection(f, 201, 'trace-hidden-bound', 'asset-b');
  await f.ingest({ invocationId: 'visible', traceId: 'trace-hidden-bound' });
  const result = await f.request(traceRoute('trace-hidden-bound'));
  assert.equal(result.status, 200);
  assert.deepEqual(traceIds(result), ['visible']);
  assert.equal(JSON.stringify(result.body).includes(hiddenPrefix), false);
});

test('generated trace Swagger matches its strict query, graph models and error statuses', async t => {
  const f = await fixture(t);
  const document = SwaggerModule.createDocument(f.app, new DocumentBuilder().setTitle('Fixture').setVersion('1.0').addBearerAuth().build());
  const route = '/api/v1/monitoring/observability/traces/{traceId}', operation = document.paths[route].get;
  assert.equal(operation.operationId, 'obsGetTrace');
  assert.deepEqual(operation.security, [{ bearer: [] }]);
  assert.deepEqual(operation.parameters.filter(item => item.in === 'query').map(item => item.name), ['origin']);
  assert.equal(operation.parameters.find(item => item.name === 'origin').schema.default, 'external');
  for (const status of ['200', '400', '401', '403', '404', '413', '503']) assert.ok(operation.responses[status]);
  assert.equal(operation.responses['200'].content['application/json'].schema.$ref,
    '#/components/schemas/ObservabilityTraceEnvelopeDto');
  const data = document.components.schemas.ObservabilityTraceDto;
  for (const field of ['nodes', 'edges', 'missingParentReferences', 'structuralIssues', 'relationshipsComplete', 'isPartial']) {
    assert.ok(data.properties[field], field);
  }
  const missing = document.components.schemas.ObservabilityTraceMissingParentDto;
  assert.equal(Object.hasOwn(missing.properties, 'parentInvocationId'), false);
  assert.equal(Object.hasOwn(data.properties, 'totalNodeCount'), false);
});
