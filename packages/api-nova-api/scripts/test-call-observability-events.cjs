'use strict';
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { ConfigService } = require('@nestjs/config');
const { JwtService } = require('@nestjs/jwt');
const { SwaggerModule, DocumentBuilder } = require('@nestjs/swagger');
const base = '../dist/src/';
const { CALL_OBSERVABILITY_ENTITIES } = require(base + 'database/entities/runtime-call-observability.entity.js');
const { RuntimeObservabilityEventEntity: Event } = require(base + 'database/entities/runtime-observability-event.entity.js');
const { User, UserStatus } = require(base + 'database/entities/user.entity.js');
const { Role, RoleType } = require(base + 'database/entities/role.entity.js');
const { Permission } = require(base + 'database/entities/permission.entity.js');
const { UserService } = require(base + 'modules/security/services/user.service.js');
const token = require(base + 'modules/security/management-access-token.js');
const { CallObservabilityStore } = require(base + 'modules/call-observability/call-observability.store.js');
const { ObservabilityCursorService } = require(base + 'modules/call-observability/call-observability-cursor.service.js');
const { ObservabilityAccessGuard } = require(base + 'modules/call-observability/call-observability-access.guard.js');
const { ObservabilityApiExceptionFilter } = require(base + 'modules/call-observability/call-observability-api.contract.js');
const { CallObservabilityEventsService } = require(base + 'modules/call-observability/call-observability-events.service.js');
const { CallObservabilityEventsController } = require(base + 'modules/call-observability/call-observability-events.controller.js');

async function fixture(t, assets = ['asset-a']) {
  const database = new DataSource({ type: 'sqljs', entities: [...CALL_OBSERVABILITY_ENTITIES, Event], synchronize: true });
  await database.initialize();
  const store = new CallObservabilityStore(database, {});
  const secret = randomUUID() + randomUUID();
  const config = new ConfigService({ JWT_SECRET: secret, API_NOVA_OBSERVABILITY_CURSOR_SECRET: secret });
  const cursors = new ObservabilityCursorService(config);
  const service = new CallObservabilityEventsService(store, cursors);
  const role = Object.assign(new Role(), { id: randomUUID(), name: 'reader', type: RoleType.CUSTOM, enabled: true,
    permissions: [Object.assign(new Permission(), { name: 'monitoring:read', enabled: true })],
    metadata: { observabilityScope: assets === null ? { mode: 'all' } : { mode: 'assets', runtimeAssetIds: assets } } });
  const user = Object.assign(new User(), { id: randomUUID(), username: 'reader', status: UserStatus.ACTIVE,
    emailVerified: true, lockedUntil: null, roles: [role] });
  const jwt = new JwtService();
  class Fixture {}
  Module({ controllers: [CallObservabilityEventsController], providers: [
    { provide: CallObservabilityEventsService, useValue: service }, { provide: ConfigService, useValue: config },
    { provide: JwtService, useValue: jwt }, { provide: UserService, useValue: { findUserById: async () => user } },
    ObservabilityAccessGuard, ObservabilityApiExceptionFilter,
  ] })(Fixture);
  const app = await NestFactory.create(Fixture, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api/v1');
  await app.listen(0, '127.0.0.1');
  t.after(async () => { await app.close(); await database.destroy(); });
  async function request(query = {}, auth = true) {
    const qs = typeof query === 'string' ? query : new URLSearchParams(query).toString();
    const bearer = jwt.sign({ sub: user.id, tokenUse: token.MANAGEMENT_TOKEN_USE }, { secret, algorithm: 'HS256',
      issuer: token.MANAGEMENT_TOKEN_ISSUER, audience: token.MANAGEMENT_TOKEN_AUDIENCE, expiresIn: '5m' });
    const response = await fetch('http://127.0.0.1:' + app.getHttpServer().address().port +
      '/api/v1/monitoring/observability/events?' + qs, { headers: auth ? { authorization: 'Bearer ' + bearer } : {} });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  }
  async function insert(inputs = [{}]) {
    return store.transaction(async tx => {
      const rows = inputs.map(input => ({ id: randomUUID(), sequence: tx.nextSequence(), schemaVersion: '1.0',
        subjectId: randomUUID(), subjectVersion: 1, eventName: 'invocation.completed', runtimeAssetId: 'asset-a',
        eventFamily: 'runtime.request', severity: 'info', status: 'success', actorType: 'runtime',
        retentionClass: 'standard', occurredAt: new Date(), createdAt: new Date(),
        expiresAt: new Date(Date.now() + 14 * 86400000), dispatchState: 'pending',
        dimensions: { serverType: 'gateway', callerId: 'caller-a', endpointDefinitionId: 'endpoint-a' },
        details: { spanKind: 'gateway_request', outcome: 'success', durationMs: 1, toolName: 'tool-a' }, ...input }));
      for (let index = 0; index < rows.length; index += 100) {
        await tx.manager.getRepository(Event).insert(rows.slice(index, index + 100));
      }
      return rows;
    });
  }
  return { database, store, service, cursors, app, user, role, request, insert };
}

test('history uses management authentication and refreshed read permission', async t => {
  const f = await fixture(t);
  assert.equal((await f.request({}, false)).status, 401);
  f.role.permissions = [];
  assert.equal((await f.request()).status, 403);
});

test('history excludes hidden and unbound assets; global readers can see pipeline state', async t => {
  const f = await fixture(t);
  await f.insert([{}, { runtimeAssetId: 'asset-b' }, { runtimeAssetId: null, eventName: 'pipeline.state_changed' }]);
  let response = await f.request();
  assert.equal(response.status, 200);
  assert.equal(response.cache, 'no-store');
  assert.equal(response.body.data.items.length, 1);
  assert.equal((await f.request({ runtimeAssetId: 'asset-b' })).body.data.items.length, 0);
  f.role.metadata.observabilityScope = { mode: 'all' };
  response = await f.request();
  assert.equal(response.body.data.items.length, 3);
});

test('empty asset scope never becomes a global query', async t => {
  const f = await fixture(t, []);
  await f.insert();
  assert.equal((await f.request()).body.data.items.length, 0);
});

test('fixed high watermark excludes concurrent writes until the next completed poll', async t => {
  const f = await fixture(t);
  await f.insert([{}, {}, {}]);
  let page = (await f.request({ limit: '1' })).body.data;
  assert.equal(page.hasMore, true);
  assert.equal(page.highWatermark, '3');
  await f.insert();
  page = (await f.request({ after: page.nextCursor, limit: '200' })).body.data;
  assert.deepEqual(page.items.map(row => row.sequence), ['2', '3']);
  assert.equal(page.hasMore, false);
  const poll = (await f.request({ after: page.nextCursor })).body.data;
  assert.deepEqual(poll.items.map(row => row.sequence), ['4']);
});

test('signed until cursor bounds the interval and can be reused at completion', async t => {
  const f = await fixture(t);
  await f.insert([{}, {}]);
  const first = (await f.request({ limit: '1' })).body.data;
  await f.insert();
  const last = (await f.request({ after: first.nextCursor, until: first.highWatermarkCursor })).body.data;
  assert.deepEqual(last.items.map(row => row.sequence), ['2']);
  const empty = (await f.request({ after: last.nextCursor, until: first.highWatermarkCursor })).body.data;
  assert.equal(empty.items.length, 0);
  assert.equal(empty.highWatermark, '2');
});

test('bounded filtered scans advance empty pages and resume without dropping a match', async t => {
  const f = await fixture(t);
  await f.insert([...Array.from({ length: 1000 }, () => ({})), { severity: 'warning' }]);
  const first = (await f.request({ severities: 'warning' })).body.data;
  assert.equal(first.items.length, 0);
  assert.equal(first.scannedEvents, 1000);
  assert.equal(first.hasMore, true);
  const second = (await f.request({ after: first.nextCursor })).body.data;
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].sequence, '1001');
});

test('event filters are OR within a list and AND across fields', async t => {
  const f = await fixture(t);
  await f.insert([{}, { severity: 'warning' }, { eventName: 'metrics.bucket_updated' }]);
  const result = await f.request({ eventTypes: 'invocation.completed,invocation.reconciled',
    severities: 'warning,info', outcomes: 'success', spanKinds: 'gateway_request', serverType: 'gateway',
    callerId: 'caller-a', endpointDefinitionId: 'endpoint-a', toolName: 'tool-a' });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.items.length, 2);
});

test('malformed, duplicate and unsupported query parameters are rejected', async t => {
  const f = await fixture(t);
  for (const query of ['limit=0', 'limit=201', 'limit=1&limit=2', 'severities=info,info', 'outcomes=bogus',
    'afterSequence=1', 'cursor=x', 'clientIp=secret', 'eventTypes[x]=invocation.completed', 'until=123']) {
    const result = await f.request(query);
    assert.equal(result.status, 400, query);
    assert.equal(result.cache, 'no-store');
  }
});

test('cursor signature, filter, principal and current asset scope cannot be changed', async t => {
  const f = await fixture(t);
  await f.insert([{}, {}]);
  const cursor = (await f.request({ limit: '1' })).body.data.nextCursor;
  assert.equal((await f.request({ after: cursor.slice(0, -2) + 'aa' })).status, 400);
  assert.equal((await f.request({ after: cursor, outcomes: 'error' })).body.error.code, 'CURSOR_SCOPE_MISMATCH');
  const oldId = f.user.id;
  f.user.id = randomUUID();
  assert.equal((await f.request({ after: cursor })).body.error.code, 'CURSOR_SCOPE_MISMATCH');
  f.user.id = oldId;
  f.role.metadata.observabilityScope = { mode: 'assets', runtimeAssetIds: ['asset-b'] };
  assert.equal((await f.request({ after: cursor })).body.error.code, 'CURSOR_SCOPE_MISMATCH');
});

test('expired remaining evidence returns 410 instead of silently skipping a page', async t => {
  const f = await fixture(t);
  const rows = await f.insert([{}, {}]);
  const first = (await f.request({ limit: '1' })).body.data;
  // Bulk insert may mutate fixture IDs during generated-value hydration; select the persisted sequence.
  const remaining = await f.database.getRepository(Event).findOneByOrFail({ sequence: '00000000000000000002' });
  await f.database.getRepository(Event).update(remaining.id, { expiresAt: new Date('2000-01-01T00:00:00.000Z') });
  const response = await f.request({ after: first.nextCursor });
  assert.equal(response.status, 410);
  assert.equal(response.body.error.code, 'EVENT_CURSOR_EXPIRED');
  assert.equal(response.body.error.details.resnapshotRequired, true);
  assert.equal(response.body.error.details.availableFrom, '1');
});

test('initial history omits expired evidence and includes suppressed metadata safely', async t => {
  const f = await fixture(t);
  await f.insert([{ expiresAt: new Date('2000-01-01T00:00:00.000Z') }, { dispatchState: 'suppressed',
    details: { outcome: 'success', requestHeaders: { authorization: 'private-marker' },
      request: { data: 'private-marker' }, clientIp: 'private-marker', traceId: 'private-marker' } }]);
  const response = await f.request();
  assert.equal(response.body.data.items.length, 1);
  assert.equal(response.body.data.items[0].historical, true);
  assert.equal(JSON.stringify(response.body).includes('private-marker'), false);
});

test('bucket events carry replacement version and explicit refresh semantics', async t => {
  const f = await fixture(t);
  await f.insert([{ eventName: 'metrics.bucket_updated', subjectVersion: 7,
    details: { bucketId: 'bucket-a', bucketVersion: 7, metrics: { private: 'private-marker' } } }]);
  const event = (await f.request()).body.data.items[0];
  assert.equal(event.subject.kind, 'bucket');
  assert.equal(event.subject.version, 7);
  assert.equal(event.data.refreshRequired, true);
  assert.equal(event.data.metrics, undefined);
});

test('history opens one consistent read snapshot and never writes a sequence', async t => {
  const f = await fixture(t);
  await f.insert();
  const watermark = await f.store.watermark();
  const original = f.store.readSnapshot.bind(f.store);
  let reads = 0;
  f.store.readSnapshot = callback => { reads++; return original(callback); };
  assert.equal((await f.request()).status, 200);
  assert.equal(reads, 1);
  assert.equal(await f.store.watermark(), watermark);
});

test('Swagger advertises the authorized endpoint and its bounded query contract', async t => {
  const f = await fixture(t);
  const spec = SwaggerModule.createDocument(f.app, new DocumentBuilder().addBearerAuth().build());
  const operation = spec.paths['/api/v1/monitoring/observability/events'].get;
  assert.equal(operation.operationId, 'obsListEvents');
  assert.equal(operation.parameters.find(param => param.name === 'limit').schema.maximum, 200);
  assert.ok(operation.responses['410']);
  assert.ok(operation.security.length);
});

test('signed cursor lifetime expires without silently restarting history', async t => {
  const f = await fixture(t);
  const { authorizeObservability } = require(base + 'modules/call-observability/call-observability-access.js');
  const now = Date.now();
  const clock = t.mock.method(Date, 'now', () => now - 5000);
  const after = f.cursors.issue({ kind: 'event', endpoint: 'obsListEvents', sort: 'sequence:asc',
    authorization: authorizeObservability(f.user) }, { filter: {}, snapshotSeq: '0', position: { sequence: '0' } }, 1000);
  clock.mock.restore();
  assert.equal((await f.request({ after })).body.error.code, 'EVENT_CURSOR_EXPIRED');
});

test('storage failures fail closed without disclosing internals', async t => {
  const f = await fixture(t);
  f.store.readSnapshot = async () => { throw new Error('private-marker'); };
  const response = await f.request();
  assert.equal(response.status, 503);
  assert.equal(JSON.stringify(response.body).includes('private-marker'), false);
});
