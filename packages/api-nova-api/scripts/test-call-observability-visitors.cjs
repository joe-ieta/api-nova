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
const { CallObservabilityVisitorsService, CALLER_QUERY_KEYS, SOURCE_QUERY_KEYS, CALLER_DETAIL_QUERY_KEYS, MAX_VISITOR_QUERY_INVOCATIONS } =
  require('../dist/src/modules/call-observability/call-observability-visitors.service.js');
const { CallObservabilityVisitorsController } =
  require('../dist/src/modules/call-observability/call-observability-visitors.controller.js');
const { ObservabilityAccessGuard } = require('../dist/src/modules/call-observability/call-observability-access.guard.js');
const { ObservabilityCursorService } = require('../dist/src/modules/call-observability/call-observability-cursor.service.js');
const { ObservabilityApiExceptionFilter } = require('../dist/src/modules/call-observability/call-observability-api.contract.js');
const { authorizeObservability } = require('../dist/src/modules/call-observability/call-observability-access.js');
const root = path.resolve(__dirname, '../../../tmp/observability-visitors-tests');
const READ = 'monitoring:read', SOURCE = 'monitoring:source:read';
const decode = token => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));

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
    controllers: [CallObservabilityVisitorsController],
    providers: [
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
  async function request(route = '/callers', query = {}, who = user) {
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
  const binding = (who = user) => ({ kind: 'query', endpoint: 'obsListCallers',
    sort: 'lastSeenAt:desc,visitorId:desc', authorization: authorizeObservability(who) });
  const signedChange = (value, changes) => {
    const state = { ...decode(value), ...changes };
    const body = Buffer.from(JSON.stringify(state)).toString('base64url');
    const signature = createHmac('sha256', cursorSecret).update('observability.cursor.v1.' + body).digest('base64url');
    return body + '.' + signature;
  };
  return { app, database, store, cursors, service, user, users, account, sign, request, ingest,
    source, now, range, binding, signedChange, projector, payloadReads: () => payloadReads };
}
const ids = result => result.body.data.items.map(row => row.callerId || row.sourceId);
const data = result => { assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.data; };


test('empty visitor queries are read-only with unknown coverage rather than fabricated healthy zeros', async t => {
  const f = await fixture(t);
  for (const route of ['/callers', '/sources']) {
    const result = await f.request(route, { includeTotal: 'true' });
    assert.deepEqual(data(result).items, []); assert.equal(data(result).total, 0);
    assert.equal(result.body.meta.snapshotSeq, '0'); assert.equal(result.body.meta.lagMs, null);
    assert.equal(result.body.meta.historyCompleteSince, null); assert.equal(result.body.meta.isPartial, true);
    assert.equal(result.cache, 'no-store');
  }
  assert.equal(await f.database.getRepository(entities.RuntimePipelineStateEntity).count(), 0);
  assert.equal(f.payloadReads(), 0);
});

test('all visitor routes require current management identity and base read permission', async t => {
  const f = await fixture(t);
  for (const route of ['/callers', '/callers/caller-a', '/sources']) {
    assert.equal((await f.request(route, {}, null)).status, 401);
    assert.equal((await f.request(route, {}, f.sign(f.user, { tokenUse: 'business' }))).status, 401);
    assert.equal((await f.request(route, {}, f.account([role([SOURCE])]))).status, 403);
  }
  f.users.delete(f.user.id);
  assert.equal((await f.request('/callers')).status, 401);
});

test('caller times, asset counts and summaries are scoped rather than copied from a global profile', async t => {
  const f = await fixture(t);
  await f.ingest({ credentialId: 'visible-credential' });
  await f.ingest({ runtimeAssetId: 'asset-b', serverType: 'mcp', spanKind: 'mcp_tool',
    startedAt: new Date(f.now - 1000).toISOString(), completedAt: new Date(f.now + 1000).toISOString(),
    credentialId: 'hidden-credential' });
  const scoped = data(await f.request('/callers', { ...f.range, includeTotal: 'true' })).items[0];
  assert.equal(scoped.callerId, 'caller-a'); assert.equal(scoped.observedServerCount, 1);
  assert.deepEqual(scoped.serverTypes, ['gateway']); assert.equal(scoped.summary.invocationCount, 1);
  assert.equal(scoped.firstSeenAt, new Date(f.now).toISOString());
  assert.equal(scoped.lastSeenAt, new Date(f.now + 10).toISOString());
  assert.equal('version' in scoped, false); assert.equal('profileVersion' in scoped, false);
  assert.equal(scoped.profileSnapshot, 'current');
  const global = f.account([role([READ], null)]);
  const all = data(await f.request('/callers', f.range, global)).items[0];
  assert.equal(all.observedServerCount, 2); assert.deepEqual(all.serverTypes, ['gateway', 'mcp']);
  assert.equal(all.summary.invocationCount, 2);
  assert.equal(JSON.stringify(scoped).includes('hidden-credential'), false);
});

test('same IP never merges trusted subjects and credential rotation preserves one caller', async t => {
  const f = await fixture(t);
  await f.ingest({ callerId: 'caller-a', credentialId: 'key-a' });
  await f.ingest({ callerId: 'caller-a', credentialId: 'key-rotated', clientIp: '192.0.2.11' });
  await f.ingest({ callerId: 'caller-b', credentialId: 'key-b' });
  assert.deepEqual(ids(await f.request('/callers', f.range)), ['caller-b', 'caller-a']);
  const a = data(await f.request('/callers/caller-a', f.range));
  assert.deepEqual(a.credentialIds, ['key-a', 'key-rotated']); assert.equal(a.summary.invocationCount, 2);
  const sources = data(await f.request('/sources', f.range)).items;
  assert.equal(sources.length, 2); assert.deepEqual(sources.map(s => s.summary.invocationCount).sort(), [1, 2]);
});

test('anonymous and failed authentication observations cannot promote supplied caller or credential IDs', async t => {
  const f = await fixture(t);
  await f.ingest();
  for (const authState of ['anonymous', 'authentication_failed']) {
    await f.ingest({ authState, identitySource: authState === 'anonymous' ? 'anonymous' : 'unknown', callerId: 'caller-a', credentialId: 'forged-secret' });
    const sources = data(await f.request('/sources', { ...f.range, authState })).items;
    assert.equal(sources.length, 1); assert.equal(sources[0].authState, authState);
    assert.equal(data(await f.request('/sources', { ...f.range, authState, callerId: 'caller-a' })).items.length, 0);
  }
  assert.equal(data(await f.request('/callers', f.range)).items[0].summary.invocationCount, 1);
  assert.deepEqual(data(await f.request('/callers/caller-a', f.range)).credentialIds, ['credential-a']);
});

test('caller detail exposes only visible-window credential references and current safe editable labels', async t => {
  const f = await fixture(t);
  await f.ingest({ credentialId: 'key-visible' });
  await f.ingest({ runtimeAssetId: 'asset-b', credentialId: 'key-hidden' });
  await f.database.getRepository(entities.RuntimeCallerEntity).update({ callerId: 'caller-a' },
    { displayName: 'Orders', note: 'Service owner', labels: ['production', 'orders'] });
  const result = await f.request('/callers/caller-a', f.range);
  const item = data(result);
  assert.deepEqual(item.credentialIds, ['key-visible']); assert.equal(item.note, 'Service owner');
  assert.equal(item.displayName, 'Orders'); assert.deepEqual(item.labels, ['production', 'orders']);
  assert.equal(item.window.timeBasis, 'startedAt');
  const encoded = JSON.stringify(item);
  for (const secret of ['key-hidden', 'private-marker', 'secretHash', 'requestHeaders', '192.0.2.', 'fileKey']) {
    assert.equal(encoded.includes(secret), false, secret);
  }
  assert.equal(f.payloadReads(), 0);
});

test('hidden, missing and empty-scope caller details share 404 while explicit global scope can see unassigned calls', async t => {
  const f = await fixture(t);
  await f.ingest({ runtimeAssetId: null, callerId: 'unassigned' });
  await f.ingest({ runtimeAssetId: 'asset-b', callerId: 'hidden' });
  for (const id of ['missing', 'hidden', 'unassigned']) assert.equal((await f.request('/callers/' + id, f.range)).status, 404);
  const empty = f.account([role([READ], [])]);
  assert.deepEqual(data(await f.request('/callers', f.range, empty)).items, []);
  assert.deepEqual(data(await f.request('/sources', f.range, empty)).items, []);
  const global = f.account([role([READ], null)]);
  const item = data(await f.request('/callers/unassigned', f.range, global));
  assert.equal(item.observedServerCount, 0); assert.equal(item.unassignedInvocationCount, 1);
  const sources = data(await f.request('/sources', f.range, global)).items;
  assert.equal(sources.length, 2); assert.ok(sources.every(source => source.sourceRestricted));
});

test('visitor registry queries exclude test, probe, internal and upstream facts and reject nonexternal origin', async t => {
  const f = await fixture(t);
  await f.ingest();
  for (const origin of ['test', 'probe', 'internal']) {
    await f.ingest({ origin, callerId: 'not-a-visitor-' + origin });
    for (const route of ['/callers', '/sources']) assert.equal((await f.request(route, { origin })).status, 400);
  }
  await f.ingest({ spanKind: 'upstream_api', callerId: 'not-a-visitor-upstream' });
  assert.deepEqual(ids(await f.request('/callers', f.range)), ['caller-a']);
  assert.equal(data(await f.request('/sources', f.range)).items.length, 1);
});

test('filters use authorized half-open invocation windows and distinguish completion from ongoing calls', async t => {
  const f = await fixture(t);
  await f.ingest({ callerId: 'at-start', startedAt: f.range.from, completedAt: new Date(Date.parse(f.range.from) + 10).toISOString() });
  await f.ingest({ callerId: 'at-end', startedAt: f.range.to, completedAt: new Date(Date.parse(f.range.to) + 10).toISOString() });
  await f.ingest({ callerId: 'running', phase: 'started', serverType: 'mcp', spanKind: 'mcp_tool' });
  const start = data(await f.request('/callers', f.range));
  assert.equal(start.items.length, 2);
  const finished = data(await f.request('/callers', { ...f.range, timeBasis: 'completedAt' }));
  assert.deepEqual(finished.items.map(i => i.callerId), ['at-start']);
  const mcp = data(await f.request('/callers', { ...f.range, serverType: 'mcp' }));
  assert.deepEqual(mcp.items.map(i => i.callerId), ['running']);
  assert.equal(data(await f.request('/callers', { ...f.range, runtimeAssetId: 'asset-b' })).items.length, 0);
  const sourceId = data(await f.request('/sources', { ...f.range, callerId: 'running' })).items[0].sourceId;
  assert.deepEqual(ids(await f.request('/callers', { ...f.range, sourceId })), ['running']);
});

test('visitor queries reject unsupported, duplicated, nested, raw-IP and oversized parameters', async t => {
  const f = await fixture(t);
  for (const query of [{ clientIp: '192.0.2.1' }, { peerIp: '192.0.2.1' }, { labels: 'production' },
    { includeTotal: 'yes' }, { limit: '201' }, { from: f.range.from }, { authState: 'invalid' },
    'serverType=gateway&serverType=mcp', 'runtimeAssetId[x]=asset-a']) {
    assert.equal((await f.request('/sources', query)).status, 400, JSON.stringify(query));
  }
  for (const query of [{ cursor: 'x' }, { limit: '1' }, { callerId: 'another' }, { authState: 'authenticated' }]) {
    assert.equal((await f.request('/callers/caller-a', query)).status, 400);
  }
  assert.equal((await f.request('/callers/' + 'x'.repeat(241))).status, 400);
  assert.equal((await f.request('/callers', { authState: 'anonymous' })).status, 400);
});

test('caller and source filters remain parameterized for quote and SQL-looking identifiers', async t => {
  const f = await fixture(t);
  const id = "caller-' OR 1=1 --";
  await f.ingest({ callerId: id }); await f.ingest({ callerId: 'other' });
  assert.deepEqual(ids(await f.request('/callers', { ...f.range, callerId: id })), [id]);
  assert.equal(data(await f.request('/callers/' + encodeURIComponent(id), f.range)).callerId, id);
  assert.deepEqual(data(await f.request('/sources', { ...f.range, sourceId: "' OR 1=1 --" })).items, []);
});

test('caller pagination fixes revision membership, last-seen ordering and summary despite late updates', async t => {
  const f = await fixture(t);
  const running = await f.ingest({ callerId: 'caller-a', invocationId: 'a-running', phase: 'started' });
  await f.ingest({ callerId: 'caller-b' }); await f.ingest({ callerId: 'caller-c' });
  const first = await f.request('/callers', { ...f.range, limit: '1', includeTotal: 'true' });
  assert.deepEqual(ids(first), ['caller-c']); assert.equal(data(first).total, 3);
  await f.ingest({ ...running, eventId: randomUUID(), recordVersion: 2, phase: 'finished',
    completedAt: new Date(f.now + 1000).toISOString(), outcome: 'success' });
  await f.ingest({ callerId: 'caller-d' });
  const second = await f.request('/callers', { cursor: data(first).nextCursor, limit: '2', includeTotal: 'true' });
  assert.deepEqual(ids(second), ['caller-b', 'caller-a']);
  assert.equal(data(second).total, 3); assert.equal(data(second).hasMore, false);
  assert.equal(data(second).items[1].summary.groups[0].runningCount, 1);
  assert.equal(second.body.meta.snapshotSeq, first.body.meta.snapshotSeq);
  assert.equal(data(await f.request('/callers/caller-a', f.range)).summary.groups[0].runningCount, 0);
});

test('source pagination stays fixed when later traffic changes a source last-seen time', async t => {
  const f = await fixture(t);
  await f.ingest({ clientIp: '192.0.2.1' }); await f.ingest({ clientIp: '192.0.2.2' });
  const first = await f.request('/sources', { ...f.range, limit: '1' });
  const allBefore = data(await f.request('/sources', f.range)).items;
  const last = allBefore[1];
  const admin = f.account([role([READ, SOURCE], null)]);
  const lastIp = data(await f.request('/sources', { ...f.range, sourceId: last.sourceId }, admin)).items[0].clientIp;
  await f.ingest({ clientIp: lastIp, completedAt: new Date(f.now + 2000).toISOString() });
  const second = data(await f.request('/sources', { cursor: data(first).nextCursor }));
  assert.deepEqual(second.items.map(s => s.sourceId), [last.sourceId]);
  assert.equal(second.items[0].lastSeenAt, last.lastSeenAt);
  assert.equal(second.items[0].summary.invocationCount, 1);
  assert.equal(second.hasMore, false);
});

test('visitor cursors bind endpoint, current principal, asset scope, filters, signature and positions', async t => {
  const f = await fixture(t);
  await f.ingest({ callerId: 'caller-a' }); await f.ingest({ callerId: 'caller-b', clientIp: '192.0.2.11' });
  const token = data(await f.request('/callers', { ...f.range, limit: '1' })).nextCursor;
  assert.equal((await f.request('/sources', { cursor: token })).body.error.code, 'CURSOR_SCOPE_MISMATCH');
  assert.equal((await f.request('/callers', { cursor: token, serverType: 'mcp' })).body.error.code, 'CURSOR_SCOPE_MISMATCH');
  assert.equal((await f.request('/callers', { cursor: token }, f.account())).body.error.code, 'CURSOR_SCOPE_MISMATCH');
  assert.equal((await f.request('/callers', { cursor: token + 'x' })).status, 400);
  const cursor = decode(token);
  assert.equal((await f.request('/callers', { cursor: f.signedChange(token, { position: { ...cursor.position, extra: 'bad' } }) })).status, 400);
  assert.equal((await f.request('/callers', { cursor: f.signedChange(token, { snapshotSeq: '999999' }) })).status, 400);
  f.user.roles = [role([READ], ['asset-b'])];
  assert.equal((await f.request('/callers', { cursor: token })).body.error.code, 'CURSOR_SCOPE_MISMATCH');
});

test('visitor cursors retain their default window and fixed metadata-retention deadline', async t => {
  const f = await fixture(t);
  await f.ingest({ callerId: 'caller-a' }); await f.ingest({ callerId: 'caller-b' }); await f.ingest({ callerId: 'caller-c' });
  const expiry = new Date(Date.now() + 60000).toISOString();
  await f.database.getRepository(entities.RuntimeInvocationRevisionEntity).update({ callerId: 'caller-a' }, { expiresAt: expiry });
  const first = data(await f.request('/callers', { limit: '1' }));
  const a = decode(first.nextCursor); assert.equal(a.position.expiresAt, expiry);
  const next = data(await f.request('/callers', { cursor: first.nextCursor, limit: '1' }));
  const b = decode(next.nextCursor);
  assert.deepEqual(b.filter, a.filter); assert.equal(b.position.expiresAt, a.position.expiresAt);
  const expired = f.signedChange(first.nextCursor, { position: { ...a.position, expiresAt: new Date(Date.now() - 1000).toISOString() } });
  assert.equal((await f.request('/callers', { cursor: expired })).body.error.code, 'QUERY_CURSOR_EXPIRED');
});

test('phase revisions count once and unknown inference can be corrected without manufacturing a second visit', async t => {
  const f = await fixture(t);
  const row = await f.ingest({ phase: 'started', request: undefined, response: undefined });
  let group = data(await f.request('/callers', f.range)).items[0].summary.groups[0];
  assert.equal(group.invocationCount, 1); assert.equal(group.runningCount, 1);
  await f.store.reconcile(row.invocationId, 1, { reason: 'progress_timeout', observedBefore: new Date().toISOString() }, f.projector.project);
  group = data(await f.request('/callers', f.range)).items[0].summary.groups[0];
  assert.equal(group.runningCount, 0); assert.equal(group.outcomeCounts.unknown, 1);
  assert.equal(group.responseObservedBytes, null);
  await f.ingest({ ...row, phase: 'finished', eventId: randomUUID(), recordVersion: 2, outcome: 'success',
    completedAt: new Date(f.now + 100).toISOString(), request: captureAuditBody('a'), response: captureAuditBody('bb') });
  group = data(await f.request('/callers', f.range)).items[0].summary.groups[0];
  assert.equal(group.invocationCount, 1); assert.equal(group.outcomeCounts.success, 1);
  assert.equal(group.outcomeCounts.unknown, 0); assert.equal(group.responseObservedBytes, 2);
});

test('summary separates span kinds and byte stages and treats HTTP 200 tool errors as errors', async t => {
  const f = await fixture(t);
  await f.ingest({ request: captureAuditBody('ab'), response: captureAuditBody('c') });
  await f.ingest({ serverType: 'mcp', spanKind: 'mcp_protocol', byteMeasurement: 'serialized_payload',
    measurementStage: 'protocol_payload', request: captureAuditBody('abc') });
  await f.ingest({ serverType: 'mcp', spanKind: 'mcp_tool', toolIsError: true, statusCode: 200,
    byteMeasurement: 'serialized_payload', measurementStage: 'tool_payload', request: captureAuditBody('abcd') });
  const summary = data(await f.request('/callers', f.range)).items[0].summary;
  assert.equal(summary.invocationCount, 3); assert.equal(summary.groups.length, 3);
  assert.equal(summary.groups.find(g => g.spanKind === 'gateway_request').requestObservedBytes, 2);
  assert.equal(summary.groups.find(g => g.spanKind === 'mcp_tool').outcomeCounts.error, 1);
  assert.equal(summary.groups.find(g => g.spanKind === 'mcp_protocol').requestObservedBytes, 3);
  assert.equal(summary.isPartial, true); assert.equal(summary.historyCompleteSince, null);
});

test('summary preserves unknown, observed empty, incomplete and integers beyond JS safe totals', async t => {
  const f = await fixture(t);
  await f.ingest({ callerId: 'unknown', request: undefined, response: undefined });
  await f.ingest({ callerId: 'empty', request: captureAuditBody(''), response: captureAuditBody('') });
  await f.ingest({ callerId: 'partial', request: { state: 'incomplete', observedBytes: 7, capturedBytes: 0 },
    response: { state: 'incomplete', observedBytes: 9, capturedBytes: 0 } });
  for (let i = 0; i < 2; i++) await f.ingest({ callerId: 'large',
    request: { state: 'omitted', reason: 'oversize', observedBytes: Number.MAX_SAFE_INTEGER },
    response: { state: 'omitted', reason: 'oversize', observedBytes: Number.MAX_SAFE_INTEGER } });
  const map = new Map(data(await f.request('/callers', f.range)).items.map(i => [i.callerId, i.summary.groups[0]]));
  assert.equal(map.get('unknown').requestObservedBytes, null); assert.equal(map.get('unknown').requestMissingMeasurements, 1);
  assert.equal(map.get('empty').requestObservedBytes, 0); assert.equal(map.get('empty').requestMissingMeasurements, 0);
  assert.equal(map.get('partial').requestObservedBytes, 7); assert.equal(map.get('partial').requestIncompleteMeasurements, 1);
  assert.equal(map.get('large').requestObservedBytes, (BigInt(Number.MAX_SAFE_INTEGER) * 2n).toString());
});

test('source IP fields are asset-wise AND authorized and revoked source access is respected on every page', async t => {
  const f = await fixture(t);
  await f.ingest(); await f.ingest({ runtimeAssetId: 'asset-b', clientIp: '192.0.2.11' });
  const mixed = f.account([role([READ], ['asset-a', 'asset-b']), role([SOURCE], ['asset-b'])]);
  const items = data(await f.request('/sources', f.range, mixed)).items;
  const a = items.find(s => s.runtimeAssetId === 'asset-a'), b = items.find(s => s.runtimeAssetId === 'asset-b');
  assert.equal(a.sourceRestricted, true); assert.equal('clientIp' in a, false); assert.equal('ipSource' in a, false);
  assert.equal(b.sourceRestricted, false); assert.equal(b.clientIp, '192.0.2.11');
  const first = data(await f.request('/sources', { ...f.range, limit: '1' }, mixed));
  mixed.roles = [role([READ], ['asset-a', 'asset-b'])];
  const second = data(await f.request('/sources', { cursor: first.nextCursor }, mixed));
  assert.ok(second.items.every(s => s.sourceRestricted && !('clientIp' in s)));
  assert.equal(f.payloadReads(), 0);
});

test('overflow sources remain explicit daily buckets rather than invented people or disclosed IPs', async t => {
  const f = await fixture(t, 1);
  for (const clientIp of ['192.0.2.1', '192.0.2.2', '192.0.2.3']) await f.ingest({ clientIp });
  const viewer = f.account([role([READ, SOURCE])]);
  const items = data(await f.request('/sources', f.range, viewer)).items;
  assert.equal(items.length, 2);
  const overflow = items.find(source => source.sourceOverflow);
  assert.ok(overflow); assert.equal(overflow.summary.invocationCount, 2);
  assert.equal(overflow.clientIp, null); assert.equal(overflow.peerIp, null); assert.equal(overflow.ipSource, 'overflow');
  assert.equal(overflow.day, new Date(f.now).toISOString().slice(0, 10));
  assert.equal(data(await f.request('/callers', f.range)).items.length, 1);
});

test('expired observations disappear even while the global caller and source registries retain their records', async t => {
  const f = await fixture(t);
  const row = await f.ingest();
  const expiresAt = new Date(Date.now() - 1000).toISOString();
  await f.database.getRepository(entities.RuntimeInvocationRevisionEntity).update({ invocationId: row.invocationId }, { expiresAt });
  await f.database.getRepository(entities.RuntimeInvocationEntity).update({ invocationId: row.invocationId }, { expiresAt });
  assert.equal(await f.database.getRepository(entities.RuntimeCallerEntity).count(), 1);
  assert.equal(await f.database.getRepository(entities.RuntimeAccessSourceEntity).count(), 1);
  assert.deepEqual(data(await f.request('/callers', f.range)).items, []);
  assert.deepEqual(data(await f.request('/sources', f.range)).items, []);
  assert.equal((await f.request('/callers/caller-a', f.range)).status, 404);
});

test('query budget accepts exactly 5000 scoped revisions, rejects overflow, and never counts hidden assets', async t => {
  const f = await fixture(t);
  const row = await f.ingest({ runtimeAssetId: 'asset-b' });
  const sample = await f.database.getRepository(entities.RuntimeInvocationRevisionEntity).findOneBy({ invocationId: row.invocationId });
  // Owned SQL.js projection data exercises an exact query bound, not a load/ingestion SLA.
  await f.store.transaction(async tx => {
    const repository = tx.manager.getRepository(entities.RuntimeInvocationRevisionEntity);
    for (let start = 1; start < MAX_VISITOR_QUERY_INVOCATIONS; start += 16) {
      const values = [];
      for (let i = start; i < Math.min(start + 16, MAX_VISITOR_QUERY_INVOCATIONS); i++) {
        const id = 'budget-' + String(i).padStart(5, '0');
        values.push(repository.create({ ...sample, id: id + ':1', invocationId: id,
          validFromSequence: tx.nextSequence(), record: { ...sample.record, invocationId: id } }));
      }
      await repository.insert(values);
    }
  });
  const global = f.account([role([READ], null)]);
  for (const route of ['/callers', '/sources']) {
    const result = data(await f.request(route, { ...f.range, runtimeAssetId: 'asset-b' }, global));
    assert.equal(result.items[0].summary.invocationCount, MAX_VISITOR_QUERY_INVOCATIONS);
    assert.equal(result.maxQueryInvocations, MAX_VISITOR_QUERY_INVOCATIONS);
  }
  await f.ingest({ runtimeAssetId: 'asset-b' });
  await f.ingest({ callerId: 'visible' });
  for (const route of ['/callers', '/sources']) {
    const tooLarge = await f.request(route, { ...f.range, runtimeAssetId: 'asset-b' }, global);
    assert.equal(tooLarge.status, 413); assert.equal(tooLarge.body.error.code, 'QUERY_TOO_LARGE');
    assert.equal('data' in tooLarge.body, false);
    assert.equal(data(await f.request(route, f.range)).items[0].summary.invocationCount, 1);
  }
});

test('visitor database failure maps to a safe error without disclosing driver or source content', async t => {
  const f = await fixture(t);
  f.store.readSnapshot = async () => { throw new Error('password=private-marker at internal-driver'); };
  for (const route of ['/callers', '/sources', '/callers/caller-a']) {
    const result = await f.request(route);
    assert.equal(result.status, 503); assert.equal(result.body.error.code, 'OBSERVABILITY_UNAVAILABLE');
    assert.equal(JSON.stringify(result.body).includes('private-marker'), false);
    assert.ok(result.body.error.requestId);
  }
});

test('generated visitor Swagger matches operation IDs, exact query allowlists, DTOs and error statuses', async t => {
  const f = await fixture(t);
  const swagger = SwaggerModule.createDocument(f.app, new DocumentBuilder().setTitle('Visitors').setVersion('1').build());
  const prefix = '/api/v1/monitoring/observability';
  const definitions = [['/callers', 'obsListCallers', CALLER_QUERY_KEYS, 'ObservabilityCallerListEnvelopeDto'],
    ['/callers/{id}', 'obsGetCaller', CALLER_DETAIL_QUERY_KEYS, 'ObservabilityCallerEnvelopeDto'],
    ['/sources', 'obsListSources', SOURCE_QUERY_KEYS, 'ObservabilitySourceListEnvelopeDto']];
  assert.equal(Object.keys(swagger.paths).length, 3);
  for (const [path, operationId, keys, schema] of definitions) {
    const operation = swagger.paths[prefix + path].get;
    assert.equal(operation.operationId, operationId);
    assert.deepEqual(operation.parameters.filter(p => p.in === 'query').map(p => p.name).sort(), [...keys].sort());
    assert.equal(operation.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/' + schema);
    for (const status of ['400', '401', '403', '413', '503']) assert.ok(operation.responses[status]);
  }
  const source = swagger.components.schemas.ObservabilitySourceDto;
  assert.ok(source.properties.clientIp); assert.equal(source.required.includes('clientIp'), false);
  const caller = swagger.components.schemas.ObservabilityCallerDto;
  assert.equal('clientIp' in caller.properties, false); assert.equal('profileVersion' in caller.properties, false);
  assert.ok(swagger.components.schemas.ObservabilityVisitorMeasureDto.properties.requestObservedBytes.oneOf);
});
