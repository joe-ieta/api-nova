'use strict';
process.env.DB_TYPE = 'sqlite';
for (const key of ['JWT_SECRET', 'API_NOVA_OBSERVABILITY_CURSOR_SECRET',
  'API_NOVA_OBSERVABILITY_CURSOR_KEY_ID']) delete process.env[key];
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
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
const { AuditService } = require('../dist/src/modules/security/services/audit.service.js');
const { AuditLog, AuditStatus } = require('../dist/src/database/entities/audit-log.entity.js');
const { CallObservabilityCallerLabelsService } = require('../dist/src/modules/call-observability/call-observability-caller-labels.service.js');
const { CallObservabilityCallerLabelsController } = require('../dist/src/modules/call-observability/call-observability-caller-labels.controller.js');
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
const root = path.resolve(__dirname, '../../../tmp/observability-caller-labels-tests');
const READ = 'monitoring:read', SOURCE = 'monitoring:source:read', MANAGE = 'monitoring:manage';
const decode = token => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));

function role(names = [READ, MANAGE], assets = ['asset-a']) {
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
    entities: [...entities.CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity, User, Role, Permission, AuditLog],
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
  const auditLogs = database.getRepository(AuditLog), userRepository = database.getRepository(User);
  const audit = new AuditService(auditLogs, userRepository);
  const labels = new CallObservabilityCallerLabelsService(store, audit, resolver);
  class FixtureModule {}
  Module({
    controllers: [CallObservabilityVisitorsController, CallObservabilityCallerLabelsController],
    providers: [
      { provide: CallObservabilityCallerLabelsService, useValue: labels },
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
  async function account(roles = [role()]) {
    const user = Object.assign(new User(), { id: randomUUID(), username: 'fixture', email: 'fixture@example.invalid',
      status: UserStatus.ACTIVE, emailVerified: true, lockedUntil: null, roles });
    user.username = 'fixture-' + user.id; user.email = user.id + '@example.invalid';
    await userRepository.insert({ id: user.id, username: user.username, email: user.email,
      password: '$2b$fixture-not-for-login', status: UserStatus.ACTIVE, emailVerified: true });
    users.set(user.id, user);
    return user;
  }
  const user = await account();
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
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control'), etag: response.headers.get('etag'), profileEtag: response.headers.get('x-profile-etag') };
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
  async function patch(id, body, etag, who = user, query = '') {
    const access = typeof who === 'string' ? who : who ? sign(who) : null;
    const response = await fetch(base + '/callers/' + encodeURIComponent(id) + query, {
      method: 'PATCH', headers: { 'content-type': 'application/json',
        ...(access ? { authorization: 'Bearer ' + access } : {}), ...(etag === undefined ? {} : { 'if-match': etag }),
        'x-request-id': 'untrusted-private-marker', 'user-agent': 'private-agent-marker' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    return { status: response.status, body: await response.json(), etag: response.headers.get('etag'), profileEtag: response.headers.get('x-profile-etag'),
      cache: response.headers.get('cache-control') };
  }

  function conditional(id, headers = {}, who = user, query = range) {
    const url = base + '/callers/' + encodeURIComponent(id) + '?' + new URLSearchParams(query);
    return new Promise((resolve, reject) => {
      // Use raw HTTP: fetch can add no-cache and accidentally mask a broken validator.
      const request = http.get(url, { headers: { ...(who ? { authorization: 'Bearer ' + sign(who) } : {}), ...headers } }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            resolve({ status: response.statusCode, body: body ? JSON.parse(body) : null,
              etag: response.headers.etag || null, profileEtag: response.headers['x-profile-etag'] || null,
              cache: response.headers['cache-control'] });
          } catch (error) { reject(error); }
        });
      });
      request.on('error', reject);
      request.setTimeout(10000, () => request.destroy(new Error('Conditional request timeout')));
    });
  }

  const logs = () => auditLogs.find({ order: { createdAt: 'ASC', id: 'ASC' } });
  const profile = (id = 'caller-a') => database.getRepository(entities.RuntimeCallerEntity).findOneBy({ callerId: id });
  const etag = async (id = 'caller-a', who = user) => {
    const result = await request('/callers/' + encodeURIComponent(id), range, who);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.profileEtag, result.body.data.profileEtag);
    return result.profileEtag;
  };
  const binding = (who = user) => ({ kind: 'query', endpoint: 'obsListCallers',
    sort: 'lastSeenAt:desc,visitorId:desc', authorization: authorizeObservability(who) });
  const signedChange = (value, changes) => {
    const state = { ...decode(value), ...changes };
    const body = Buffer.from(JSON.stringify(state)).toString('base64url');
    const signature = createHmac('sha256', cursorSecret).update('observability.cursor.v1.' + body).digest('base64url');
    return body + '.' + signature;
  };
  return { app, database, store, cursors, service, user, users, account, sign, request, ingest,
    source, now, range, binding, signedChange, projector, labels, audit, logs, profile, patch, etag, conditional, payloadReads: () => payloadReads };
}
const ids = result => result.body.data.items.map(row => row.callerId || row.sourceId);
const data = result => { assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.data; };


test('profile mutation and metadata-only management audit commit together without changing call facts or watermark', async t => {
  const f = await fixture(t), invocation = await f.ingest();
  const before = await f.database.getRepository(entities.RuntimeInvocationEntity).findOneBy({ invocationId: invocation.invocationId });
  const snapshot = await f.store.readSnapshot(tx => tx.snapshotSeq);
  const result = await f.patch('caller-a', { displayName: 'Orders', note: 'Owned integration', labels: ['production'] }, await f.etag());
  const item = data(result);
  assert.equal(item.displayName, 'Orders'); assert.equal(item.note, 'Owned integration');
  assert.deepEqual(item.labels, ['production']); assert.equal(item.changed, true);
  assert.deepEqual(item.changedFields, ['displayName', 'note', 'labels']);
  assert.equal(result.profileEtag, item.profileEtag); assert.equal(result.cache, 'no-store');
  assert.equal(result.body.meta.snapshotSeq, snapshot);
  assert.deepEqual(await f.database.getRepository(entities.RuntimeInvocationEntity).findOneBy({ invocationId: invocation.invocationId }), before);
  const logs = await f.logs(); assert.equal(logs.length, 1);
  assert.equal(logs[0].id, item.auditId); assert.equal(logs[0].userId, f.user.id);
  assert.equal(logs[0].status, AuditStatus.SUCCESS); assert.equal(logs[0].resourceId, 'caller-a');
  assert.equal(logs[0].details.operation, 'observability.caller.update');
  assert.equal(logs[0].details.previousVersion, 1); assert.equal(logs[0].details.version, 2);
  assert.deepEqual(logs[0].details.changedFields, item.changedFields);
  assert.equal(JSON.stringify(logs[0]).includes('Owned integration'), false);
  assert.equal(f.payloadReads(), 0);
});

test('partial updates normalize labels, preserve omitted fields and support explicit clearing', async t => {
  const f = await fixture(t); await f.ingest();
  let result = data(await f.patch('caller-a', { displayName: ' Orders ', note: 'line one\r\nline two', labels: [' z ', 'a'] }, await f.etag()));
  assert.equal(result.displayName, 'Orders'); assert.equal(result.note, 'line one\nline two'); assert.deepEqual(result.labels, ['a', 'z']);
  result = data(await f.patch('caller-a', { labels: [] }, result.profileEtag));
  assert.equal(result.displayName, 'Orders'); assert.equal(result.note, 'line one\nline two'); assert.deepEqual(result.labels, []);
  result = data(await f.patch('caller-a', { displayName: null, note: '   ' }, result.profileEtag));
  assert.equal(result.displayName, null); assert.equal(result.note, null);
});

test('profile ETags are disclosed only when management covers every registered asset', async t => {
  const f = await fixture(t); await f.ingest(); await f.ingest({ runtimeAssetId: 'asset-b' });
  for (const who of [await f.account([role([READ], ['asset-a', 'asset-b'])]), f.user]) {
    const result = await f.request('/callers/caller-a', f.range, who);
    assert.equal(result.status, 200); assert.equal('profileEtag' in result.body.data, false);
    assert.equal(/^"obs\./.test(result.etag || ''), false);
    assert.equal(result.profileEtag, null);
    assert.equal('profileVersion' in result.body.data, false);
  }
  const both = await f.account([role([READ, MANAGE], ['asset-a', 'asset-b'])]);
  assert.match(await f.etag('caller-a', both), /^"obs\.[a-f0-9]{32}\.1"$/);
});

test('management and read must intersect on all caller assets, not merely be granted somewhere', async t => {
  const f = await fixture(t); await f.ingest();
  const etag = await f.etag();
  const readOnly = await f.account([role([READ])]);
  const manageOnly = await f.account([role([MANAGE])]);
  const disjoint = await f.account([role([READ], ['asset-a']), role([MANAGE], ['asset-b'])]);
  assert.equal((await f.patch('caller-a', { labels: ['x'] }, etag, readOnly)).status, 403);
  assert.equal((await f.patch('caller-a', { labels: ['x'] }, etag, manageOnly)).status, 403);
  assert.equal((await f.patch('caller-a', { labels: ['x'] }, etag, disjoint)).status, 404);
  assert.deepEqual((await f.profile()).labels, []);
});

test('new hidden observations prevent use of a previously issued profile ETag', async t => {
  const f = await fixture(t); await f.ingest();
  const before = await f.etag();
  const hidden = await f.ingest({ runtimeAssetId: 'asset-b', credentialId: 'hidden-key' });
  assert.equal((await f.patch('caller-a', { note: 'must not apply' }, before)).status, 404);
  const expiresAt = new Date(Date.now() - 1000).toISOString();
  await f.database.getRepository(entities.RuntimeInvocationEntity).update({ invocationId: hidden.invocationId }, { expiresAt });
  assert.equal((await f.patch('caller-a', { note: 'still must not apply' }, before)).status, 404);
  const all = await f.account([role([READ, MANAGE], ['asset-a', 'asset-b'])]);
  assert.equal((await f.patch('caller-a', { note: 'authorized' }, before, all)).status, 200);
  assert.equal((await f.profile()).note, 'authorized');
});

test('an unassigned association requires explicit global authority rather than an empty asset grant', async t => {
  const f = await fixture(t);
  await f.ingest({ runtimeAssetId: null });
  assert.equal((await f.patch('caller-a', { labels: [] }, '"obs.' + 'a'.repeat(32) + '.1"')).status, 404);
  const global = await f.account([role([READ, MANAGE], null)]);
  const token = await f.etag('caller-a', global);
  assert.equal((await f.patch('caller-a', { labels: ['unassigned'] }, token, global)).status, 200);
  const empty = await f.account([role([READ, MANAGE], [])]);
  assert.equal((await f.patch('caller-a', { labels: ['no'] }, token, empty)).status, 404);
});

test('unknown, untrusted and fully expired caller profiles share the same safe not-found result', async t => {
  const f = await fixture(t);
  const row = await f.ingest();
  const token = await f.etag();
  const expiresAt = new Date(Date.now() - 1000).toISOString();
  await f.database.getRepository(entities.RuntimeInvocationEntity).update({ invocationId: row.invocationId }, { expiresAt });
  await f.ingest({ callerId: 'anonymous-forged', identitySource: 'anonymous', authState: 'anonymous' });
  for (const id of ['missing-private-marker', 'anonymous-forged', 'caller-a']) {
    const response = await f.patch(id, { labels: ['no'] }, token);
    assert.equal(response.status, 404); assert.equal(response.body.error.code, 'NOT_FOUND');
  }
  assert.ok((await f.logs()).every(log => !log.resourceId && !JSON.stringify(log.details).includes('private-marker')));
});

test('If-Match is mandatory, strong, single, resource-bound and version-bound', async t => {
  const f = await fixture(t); await f.ingest(); await f.ingest({ callerId: 'caller-b' });
  const token = await f.etag(), other = await f.etag('caller-b');
  assert.equal((await f.patch('caller-a', { labels: [] })).status, 428);
  for (const invalid of ['*', 'W/' + token, token + ', ' + token, '1']) {
    assert.equal((await f.patch('caller-a', { labels: [] }, invalid)).status, 400);
  }
  assert.equal((await f.patch('caller-a', { labels: [] }, other)).status, 412);
  assert.equal((await f.patch('caller-a', { labels: ['changed'] }, token)).status, 200);
  assert.equal((await f.patch('caller-a', { labels: ['lost'] }, token)).status, 412);
  assert.deepEqual((await f.profile()).labels, ['changed']);
  assert.ok((await f.logs()).some(log => log.status === AuditStatus.FAILED && log.details.reasonCode === 'PRECONDITION_FAILED'));
});

test('concurrent edits using one ETag have exactly one winner and one audited conflict', async t => {
  const f = await fixture(t); await f.ingest();
  const token = await f.etag();
  const results = await Promise.all([f.patch('caller-a', { note: 'one' }, token), f.patch('caller-a', { note: 'two' }, token)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 412]);
  const winner = results.find(r => r.status === 200);
  assert.equal((await f.profile()).note, winner.body.data.note);
  assert.equal((await f.profile()).version, 2);
  const logs = await f.logs();
  assert.equal(logs.filter(log => log.status === AuditStatus.SUCCESS).length, 1);
  assert.equal(logs.filter(log => log.status === AuditStatus.FAILED).length, 1);
});

test('ordinary traffic updates observation time without changing the editable profile version or ETag', async t => {
  const f = await fixture(t); await f.ingest();
  const token = await f.etag();
  await f.ingest({ startedAt: new Date(f.now + 1000).toISOString(), completedAt: new Date(f.now + 2000).toISOString() });
  assert.equal(await f.etag(), token); assert.equal((await f.profile()).version, 1);
  const changed = data(await f.patch('caller-a', { displayName: 'Orders' }, token));
  await f.ingest({ completedAt: new Date(f.now + 3000).toISOString() });
  assert.equal(await f.etag(), changed.profileEtag);
  assert.equal((await f.profile()).displayName, 'Orders'); assert.equal((await f.profile()).version, 2);
});

test('normalized no-op updates remain audited without consuming a new profile version', async t => {
  const f = await fixture(t); await f.ingest();
  const first = data(await f.patch('caller-a', { labels: ['b', 'a'] }, await f.etag()));
  const result = data(await f.patch('caller-a', { labels: [' a ', 'b'] }, first.profileEtag));
  assert.equal(result.changed, false); assert.deepEqual(result.changedFields, []);
  assert.equal(result.profileEtag, first.profileEtag); assert.equal((await f.profile()).version, 2);
  assert.equal((await f.logs()).find(log => log.id === result.auditId).details.result, 'unchanged');
});

test('audit failure rolls back the profile mutation and does not leave a successful receipt', async t => {
  const f = await fixture(t); await f.ingest();
  const token = await f.etag(), original = await f.profile();
  f.audit.log = async () => { throw new Error('audit-private-marker'); };
  const result = await f.patch('caller-a', { note: 'must rollback' }, token);
  assert.equal(result.status, 503); assert.equal('data' in result.body, false);
  assert.equal(JSON.stringify(result.body).includes('audit-private-marker'), false);
  assert.deepEqual(await f.profile(), original); assert.equal(await f.etag(), token);
  assert.equal((await f.logs()).length, 0);
});

test('audit failure during a denied mutation fails closed without altering the profile', async t => {
  const f = await fixture(t); await f.ingest();
  const original = await f.profile();
  f.audit.log = async () => { throw new Error('audit-unavailable'); };
  assert.equal((await f.patch('caller-a', { labels: ['x'] })).status, 503);
  assert.deepEqual(await f.profile(), original);
});

test('invalid fields, types, duplicate labels and unsafe controls cannot modify trusted identity or evidence', async t => {
  const f = await fixture(t); await f.ingest();
  const token = await f.etag();
  for (const body of [null, [], {}, { callerId: 'other' }, { version: 90 }, { identitySource: 'anonymous' },
    { displayName: 1 }, { note: false }, { labels: null }, { labels: [1] }, { labels: ['', 'a'] },
    { labels: ['a', ' a '] }, { displayName: 'a\nb' }, { labels: ['a\u0000b'] },
    { displayName: 'x'.repeat(201) }, { note: 'x'.repeat(2001) },
    { labels: Array.from({ length: 33 }, (_, i) => 'label-' + i) }, { labels: ['x'.repeat(65)] }]) {
    const result = await f.patch('caller-a', body, token);
    assert.equal(result.status, 400, JSON.stringify(body));
  }
  assert.equal((await f.profile()).version, 1); assert.deepEqual((await f.profile()).labels, []);
});

test('body budget, ID and unsupported query validation use explicit safe errors', async t => {
  const f = await fixture(t); await f.ingest();
  const token = await f.etag();
  assert.equal((await f.patch('caller-a', { note: 'x'.repeat(20000) }, token)).status, 413);
  assert.equal((await f.patch('x'.repeat(241), { labels: [] }, token)).status, 400);
  assert.equal((await f.patch('caller-a', { labels: [] }, token, f.user, '?runtimeAssetId=asset-a')).status, 400);
  assert.equal((await f.patch('caller-a', { labels: [] }, token, f.user, '?cursor=abc')).status, 400);
  assert.equal((await f.profile()).version, 1);
});

test('mutation authorization is refreshed after the HTTP guard and before the transaction changes data', async t => {
  const f = await fixture(t); await f.ingest();
  const token = await f.etag(), original = await f.profile();
  const transaction = f.store.transaction.bind(f.store);
  f.store.transaction = callback => {
    f.user.roles = [role([READ])];
    return transaction(callback);
  };
  assert.equal((await f.patch('caller-a', { note: 'must not apply' }, token)).status, 403);
  assert.deepEqual(await f.profile(), original);
});

test('anonymous or business tokens cannot enter the profile mutation service', async t => {
  const f = await fixture(t); await f.ingest();
  const token = await f.etag();
  assert.equal((await f.patch('caller-a', { note: 'no' }, token, null)).status, 401);
  assert.equal((await f.patch('caller-a', { note: 'no' }, token, f.sign(f.user, { tokenUse: 'business' }))).status, 401);
  assert.equal((await f.logs()).length, 0);
});

test('management audit never copies editable values, caller-supplied request IDs, headers or payloads', async t => {
  const f = await fixture(t); await f.ingest();
  const result = data(await f.patch('caller-a', { displayName: 'display-private-marker',
    note: 'note-private-marker', labels: ['label-private-marker'] }, await f.etag()));
  const log = (await f.logs()).find(log => log.id === result.auditId);
  const serialized = JSON.stringify(log);
  for (const marker of ['display-private-marker', 'note-private-marker', 'label-private-marker',
    'untrusted-private-marker', 'private-agent-marker', 'credential-a', '192.0.2.', 'fileKey', 'requestHeaders']) {
    assert.equal(serialized.includes(marker), false, marker);
  }
  assert.match(log.details.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(log.details.labelCount, 1);
});

test('profile changes do not invalidate call snapshots but resumed pages show the explicitly current profile', async t => {
  const f = await fixture(t); await f.ingest(); await f.ingest({ callerId: 'caller-b' });
  const first = await f.request('/callers', { ...f.range, limit: '1' });
  assert.deepEqual(ids(first), ['caller-b']);
  await f.patch('caller-a', { displayName: 'Updated profile' }, await f.etag());
  const second = await f.request('/callers', { cursor: data(first).nextCursor });
  assert.deepEqual(ids(second), ['caller-a']);
  assert.equal(data(second).items[0].displayName, 'Updated profile');
  assert.equal(data(second).items[0].profileSnapshot, 'current');
  assert.equal(second.body.meta.snapshotSeq, first.body.meta.snapshotSeq);
});

test('profile version exhaustion prevents edits but never prevents new call observations', async t => {
  const f = await fixture(t); await f.ingest();
  await f.database.getRepository(entities.RuntimeCallerEntity).update({ callerId: 'caller-a' }, { version: 2147483647 });
  const token = await f.etag();
  assert.equal((await f.patch('caller-a', { note: 'cannot advance' }, token)).status, 503);
  await f.ingest({ completedAt: new Date(f.now + 1000).toISOString() });
  assert.equal(await f.etag(), token); assert.equal((await f.profile()).version, 2147483647);
  assert.equal((await f.profile()).note, null);
  assert.equal((await f.patch('caller-a', { note: null }, token)).status, 200);
});

test('caller IDs containing quotes stay parameterized through profile updates and their audit references', async t => {
  const f = await fixture(t);
  const id = "caller-' OR 1=1 --";
  await f.ingest({ callerId: id }); await f.ingest({ callerId: 'other' });
  const result = data(await f.patch(id, { labels: ['safe'] }, await f.etag(id)));
  assert.equal(result.callerId, id); assert.deepEqual((await f.profile(id)).labels, ['safe']);
  assert.deepEqual((await f.profile('other')).labels, []);
  assert.equal((await f.logs())[0].resourceId, id);
});

test('generated profile Swagger documents the closed patch body, If-Match, conditional ETag and error contract', async t => {
  const f = await fixture(t);
  const swagger = SwaggerModule.createDocument(f.app, new DocumentBuilder().setTitle('Profiles').setVersion('1').build());
  const path = swagger.paths['/api/v1/monitoring/observability/callers/{id}'];
  assert.equal(path.patch.operationId, 'obsUpdateCallerLabels');
  assert.equal(path.get.operationId, 'obsGetCaller');
  assert.equal(path.patch.parameters.find(p => p.in === 'header' && p.name.toLowerCase() === 'if-match').required, true);
  const body = path.patch.requestBody.content['application/json'].schema;
  assert.equal(body.additionalProperties, false); assert.equal(body.minProperties, 1);
  assert.deepEqual(Object.keys(body.properties).sort(), ['displayName', 'labels', 'note']);
  assert.equal(body.properties.labels.maxItems, 32); assert.equal(body.properties.note.maxLength, 2000);
  for (const status of ['200', '400', '401', '403', '404', '412', '413', '428', '503']) assert.ok(path.patch.responses[status]);
  assert.ok(path.patch.responses['200'].headers['X-Profile-ETag']); assert.ok(path.get.responses['200'].headers['X-Profile-ETag']);
  assert.equal(path.get.responses['200'].headers.ETag, undefined);
  const detail = swagger.components.schemas.ObservabilityCallerDetailDto;
  assert.ok(detail.properties.profileEtag); assert.equal(detail.required.includes('profileEtag'), false);
});

test('real conditional caller GET never treats the unchanged profile token as a full-response validator', async t => {
  const f = await fixture(t); await f.ingest();
  const first = await f.conditional('caller-a');
  assert.equal(first.status, 200); assert.equal(first.profileEtag, first.body.data.profileEtag);
  assert.notEqual(first.etag, first.profileEtag);
  await f.ingest({ completedAt: new Date(f.now + 1000).toISOString() });
  const next = await f.conditional('caller-a', { 'if-none-match': first.profileEtag });
  assert.equal(next.status, 200); assert.equal(next.body.data.summary.invocationCount, 2);
  assert.equal(next.profileEtag, first.profileEtag); assert.notEqual(next.etag, first.etag);
  assert.equal(next.cache, 'no-store');
});

test('real full-response validators still distinguish unchanged 304 from changed-observation 200', async t => {
  const f = await fixture(t); await f.ingest();
  const first = await f.conditional('caller-a');
  assert.equal(first.status, 200); assert.equal(typeof first.etag, 'string');
  const same = await f.conditional('caller-a', { 'if-none-match': first.etag });
  assert.equal(same.status, 304); assert.equal(same.body, null);
  await f.ingest({ completedAt: new Date(f.now + 2000).toISOString() });
  const changed = await f.conditional('caller-a', { 'if-none-match': first.etag });
  assert.equal(changed.status, 200); assert.equal(changed.body.data.summary.invocationCount, 2);
  assert.equal(changed.profileEtag, first.profileEtag); assert.notEqual(changed.etag, first.etag);
});

test('a changed query window changes the full-response validator without invalidating profile editing', async t => {
  const f = await fixture(t); await f.ingest();
  const first = await f.conditional('caller-a');
  const window = { from: new Date(f.now - 30000).toISOString(), to: f.range.to };
  const next = await f.conditional('caller-a', { 'if-none-match': first.etag }, f.user, window);
  assert.equal(next.status, 200); assert.equal(next.body.data.window.from, window.from);
  assert.equal(next.profileEtag, first.profileEtag); assert.notEqual(next.etag, first.etag);
});

test('conditional reads recheck permission and never replay a privileged profile token after revocation', async t => {
  const f = await fixture(t); await f.ingest();
  const first = await f.conditional('caller-a');
  f.user.roles = [role([READ])];
  const readOnly = await f.conditional('caller-a', { 'if-none-match': first.etag });
  assert.equal(readOnly.status, 200); assert.equal(readOnly.profileEtag, null);
  assert.equal('profileEtag' in readOnly.body.data, false);
  f.user.roles = [];
  const denied = await f.conditional('caller-a', { 'if-none-match': readOnly.etag });
  assert.equal(denied.status, 403); assert.equal(denied.profileEtag, null);
  assert.equal(denied.body.error.code, 'FORBIDDEN');
});

test('PATCH uses only the explicit profile token while its complete response keeps an independent validator', async t => {
  const f = await fixture(t); await f.ingest();
  const first = await f.conditional('caller-a');
  const wrong = await f.patch('caller-a', { note: 'not applied' }, first.etag);
  assert.equal(wrong.status, 400);
  const changed = await f.patch('caller-a', { note: 'profile update' }, first.profileEtag);
  assert.equal(changed.status, 200); assert.equal(changed.profileEtag, changed.body.data.profileEtag);
  assert.notEqual(changed.etag, changed.profileEtag); assert.notEqual(changed.profileEtag, first.profileEtag);
  const next = await f.conditional('caller-a', { 'if-none-match': first.etag });
  assert.equal(next.status, 200); assert.equal(next.profileEtag, changed.profileEtag);
  assert.equal(next.body.data.note, 'profile update');
});
