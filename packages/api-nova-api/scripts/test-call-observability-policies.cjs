'use strict';
process.env.DB_TYPE = 'sqlite';
delete process.env.JWT_SECRET;
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, project: require('path').resolve(__dirname, '../tsconfig.json') });
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { captureAuditBody } = require('api-nova-parser');
const { CallObservabilityPayloadStore } = require('../src/modules/call-observability/call-observability-payload.store.ts');
const { DataSource } = require('typeorm');
const { Module, NotFoundException } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { ConfigService } = require('@nestjs/config');
const { JwtService } = require('@nestjs/jwt');
const { SwaggerModule, DocumentBuilder } = require('@nestjs/swagger');
const source = name => require('../src/' + name + '.ts');
const entities = source('database/entities/runtime-call-observability.entity');
const { RuntimeObservabilityEventEntity } = source('database/entities/runtime-observability-event.entity');
const { User, UserStatus } = source('database/entities/user.entity');
const { Role, RoleType } = source('database/entities/role.entity');
const { Permission } = source('database/entities/permission.entity');
const { AuditLog } = source('database/entities/audit-log.entity');
const { AuditService } = source('modules/security/services/audit.service');
const { UserService } = source('modules/security/services/user.service');
const tokens = source('modules/security/management-access-token');
const { CallObservabilityPoliciesService } = source('modules/call-observability/call-observability-policies.service');
const { CallObservabilityPoliciesController } = source('modules/call-observability/call-observability-policies.controller');
const { CallObservabilityStore } = source('modules/call-observability/call-observability.store');
const { ObservabilityAccessGuard } = source('modules/call-observability/call-observability-access.guard');
const { ObservabilityApiExceptionFilter } = source('modules/call-observability/call-observability-api.contract');
const { readEventRetentionPolicy, EVENT_RETENTION_POLICY_ID: id } = source('modules/call-observability/call-observability-policy');
const { authorizeObservability } = source('modules/call-observability/call-observability-access');
const DAY = 86400000;
function role(names = ['monitoring:read', 'monitoring:manage'], assets = null) {
  return Object.assign(new Role(), { id: randomUUID(), name: 'test-policy', type: RoleType.CUSTOM, enabled: true,
    permissions: names.map(name => Object.assign(new Permission(), { id: randomUUID(), name, enabled: true })),
    metadata: { observabilityScope: assets === null ? { mode: 'all' } : { mode: 'assets', runtimeAssetIds: assets } } });
}
async function fixture(t, withPayloads = false) {
  const db = new DataSource({ type: 'sqljs', synchronize: true, logging: false,
    entities: [...entities.CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity, User, Role, Permission, AuditLog] });
  await db.initialize();
  let app;
  t.after(async () => { if (app) await app.close(); await db.destroy(); });
  let payloadStore = {}, directory;
  if (withPayloads) {
    const root = path.resolve(__dirname, '../../../tmp/observability-policy-payload-tests');
    await fs.mkdir(root, { recursive: true });
    directory = await fs.mkdtemp(path.join(root, 'run-'));
    const oldData = process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
    process.env.API_NOVA_OBSERVABILITY_DATA_DIR = directory;
    try { payloadStore = new CallObservabilityPayloadStore(); }
    finally { if (oldData === undefined) delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
      else process.env.API_NOVA_OBSERVABILITY_DATA_DIR = oldData; }
    t.after(async () => {
      await payloadStore.onModuleDestroy();
      const resolved = path.resolve(directory);
      if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith('run-')) throw new Error('Non-owned fixture');
      await fs.rm(resolved, { recursive: true, force: true });
    });
  }
  const store = new CallObservabilityStore(db, payloadStore);
  const users = new Map(), userRepository = db.getRepository(User), auditRepository = db.getRepository(AuditLog);
  const resolver = { async findUserById(id) { if (!users.has(id)) throw new NotFoundException(); return users.get(id); } };
  const audit = new AuditService(auditRepository, userRepository);
  const service = new CallObservabilityPoliciesService(store, audit, resolver);
  const jwt = new JwtService(), secret = randomUUID() + randomUUID();
  class FixtureModule {}
  Module({ controllers: [CallObservabilityPoliciesController], providers: [
    { provide: CallObservabilityPoliciesService, useValue: service },
    { provide: ConfigService, useValue: new ConfigService({ JWT_SECRET: secret }) },
    { provide: JwtService, useValue: jwt }, { provide: UserService, useValue: resolver },
    ObservabilityAccessGuard, ObservabilityApiExceptionFilter,
  ] })(FixtureModule);
  app = await NestFactory.create(FixtureModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const base = 'http://127.0.0.1:' + app.getHttpServer().address().port + '/api/monitoring/observability';
  async function account(roles = [role()]) {
    const user = Object.assign(new User(), { id: randomUUID(), status: UserStatus.ACTIVE, emailVerified: true, lockedUntil: null, roles });
    await userRepository.insert({ id: user.id, username: user.id, email: user.id + '@example.invalid',
      password: 'test-only', status: UserStatus.ACTIVE, emailVerified: true });
    users.set(user.id, user); return user;
  }
  const user = await account();
  function sign(who) { return jwt.sign({ sub: who.id, tokenUse: tokens.MANAGEMENT_TOKEN_USE }, { secret,
    algorithm: 'HS256', issuer: tokens.MANAGEMENT_TOKEN_ISSUER, audience: tokens.MANAGEMENT_TOKEN_AUDIENCE, expiresIn: '5m' }); }
  async function request(method = 'GET', body, etag, who = user, route = '/policies') {
    const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json',
      ...(who ? { authorization: 'Bearer ' + sign(who) } : {}), ...(etag === undefined ? {} : { 'if-match': etag }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json(), etag: response.headers.get('x-policy-etag'), cache: response.headers.get('cache-control') };
  }
  const get = who => request('GET', undefined, undefined, who);
  const patch = (body, etag, who = user, route = '/policies/' + id) => request('PATCH', body, etag, who, route);
  async function event() {
    await store.transaction(tx => store.projectionEvent(tx, 'pipeline.state_changed', randomUUID(), 1, { state: 'healthy' }, {}));
    return db.getRepository(RuntimeObservabilityEventEntity).find({ order: { sequence: 'ASC' } });
  }
  return { db, store, payloadStore, service, audit, auditRepository, users, user, resolver, account, get, patch, event, request, app };
}
const input = eventDays => ({ retention: { eventDays }, reason: 'operator changed event retention' });

test('API27/28 effective default, atomic policy audit, retention affects only new events, and persists across service recreation', async t => {
  const f = await fixture(t);
  const first = await f.get(); assert.equal(first.status, 200); assert.equal(first.cache, 'no-store');
  assert.equal(first.body.data.items[0].retention.eventDays, 14);
  assert.equal(await f.db.getRepository(entities.RuntimeObservabilityPolicyEntity).count(), 0);
  const oldEvent = (await f.event())[0]; assert.equal(oldEvent.expiresAt - oldEvent.createdAt, 14 * DAY);
  const changed = await f.patch(input(3), first.body.data.items[0].policyEtag);
  assert.equal(changed.status, 200); assert.equal(changed.body.data.revision, 2);
  assert.equal(changed.etag, changed.body.data.policyEtag); assert.equal(changed.body.data.existingRecordsChanged, false);
  assert.equal(changed.body.data.cleanupTriggered, false); assert.equal(changed.body.data.retentionImpact, 'new_observability_events_and_payloads_only');
  const logs = await f.auditRepository.find(); assert.equal(logs.length, 1);
  assert.equal(logs[0].id, changed.body.data.auditId); assert.equal(logs[0].details.before.eventDays, 14);
  assert.equal(logs[0].details.after.eventDays, 3);
  const events = await f.event(); assert.equal(events[0].expiresAt - events[0].createdAt, 14 * DAY);
  assert.equal(events[1].expiresAt - events[1].createdAt, 3 * DAY);
  const freshStore = new CallObservabilityStore(f.db, {});
  assert.equal((await freshStore.readSnapshot(tx => readEventRetentionPolicy(tx.manager))).eventDays, 3);
  const noop = await f.patch(input(3), changed.etag); assert.equal(noop.status, 200); assert.equal(noop.etag, changed.etag);
  assert.equal(noop.body.data.changed, false); assert.equal(await f.auditRepository.count(), 2);
});

test('strict query/body validation and If-Match protect version without mutation', async t => {
  const f = await fixture(t), initial = (await f.get()).body.data.items[0];
  assert.equal((await f.patch(input(7))).status, 428);
  assert.equal((await f.patch(input(7), '*')).status, 400);
  for (const body of [{}, [], null, input(0), input(366), input(1.5), input('7'),
    { ...input(7), quotas: {} }, { retention: {}, reason: 'test' }, { retention: { unsupported: 7 }, reason: 'test' },
    ...[0, 366, -1, 1.5, '7', null].map(payloadDays => ({ retention: { payloadDays }, reason: 'test' })),
    { retention: { eventDays: 7 }, reason: '' }, { retention: { eventDays: 7 }, reason: 'bad\nreason' }]) {
    assert.equal((await f.patch(body, initial.policyEtag)).status, 400, JSON.stringify(body));
  }
  assert.equal((await f.patch(input(7), initial.policyEtag, f.user, '/policies/' + id + '?scope=all')).status, 400);
  assert.equal((await f.request('GET', undefined, undefined, f.user, '/policies?scope=all')).status, 400);
  assert.equal((await f.patch(input(7), initial.policyEtag, f.user, '/policies/unknown')).status, 404);
  assert.equal(await f.db.getRepository(entities.RuntimeObservabilityPolicyEntity).count(), 0);
  const results = await Promise.all([f.patch(input(5), initial.policyEtag), f.patch(input(6), initial.policyEtag)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 412]);
  assert.equal(await f.auditRepository.count(), 1);
});

test('authorization scope intersection, token authentication, and fresh transaction permission revocation', async t => {
  const f = await fixture(t), etag = (await f.get()).body.data.items[0].policyEtag;
  assert.equal((await f.get(null)).status, 401);
  const reader = await f.account([role(['monitoring:read'])]);
  assert.equal((await f.get(reader)).status, 200); assert.equal((await f.patch(input(5), etag, reader)).status, 403);
  const scoped = await f.account([role(['monitoring:read', 'monitoring:manage'], ['asset-a'])]);
  assert.equal((await f.get(scoped)).status, 200); assert.equal((await f.patch(input(5), etag, scoped)).status, 403);
  const mixed = await f.account([role(['monitoring:read'], ['asset-a']), role(['monitoring:manage'])]);
  assert.equal((await f.patch(input(5), etag, mixed)).status, 403);
  f.user.roles = [role(['monitoring:read'])];
  await assert.rejects(f.service.update(id, input(5), {}, etag, f.user.id), error => error.code === 'FORBIDDEN');
  assert.equal(await f.auditRepository.count(), 0);
});

test('audit failure rolls back policy and sequence; malformed durable policy fails closed', async t => {
  const f = await fixture(t), initial = (await f.get()).body.data.items[0];
  const before = await f.store.watermark(), log = f.audit.log;
  f.audit.log = async () => { throw new Error('fixture audit unavailable'); };
  await assert.rejects(f.service.update(id, input(2), {}, initial.policyEtag, f.user.id), /audit unavailable/);
  assert.equal(await f.store.watermark(), before);
  assert.equal(await f.db.getRepository(entities.RuntimeObservabilityPolicyEntity).count(), 0);
  f.audit.log = log;
  await f.db.getRepository(entities.RuntimeObservabilityPolicyEntity).insert({ id, version: 2,
    scope: { mode: 'all' }, settings: { eventDays: -1 }, updatedAt: new Date().toISOString(), updatedBy: f.user.id });
  assert.equal((await f.get()).status, 503);
  await assert.rejects(f.event(), error => error.code === 'OBSERVABILITY_UNAVAILABLE');
  assert.equal(await f.db.getRepository(RuntimeObservabilityEventEntity).count(), 0);
});

test('Swagger exposes both operation IDs, required edit token and strict supported retention fields', async t => {
  const f = await fixture(t);
  const doc = SwaggerModule.createDocument(f.app, new DocumentBuilder().addBearerAuth().build());
  assert.equal(doc.paths['/api/monitoring/observability/policies'].get.operationId, 'obsGetPolicies');
  const patch = doc.paths['/api/monitoring/observability/policies/{id}'].patch;
  assert.equal(patch.operationId, 'obsUpdatePolicy');
  assert.equal(patch.parameters.find(p => p.name === 'If-Match').required, true);
  const body = patch.requestBody.content['application/json'].schema;
  assert.equal(body.additionalProperties, false); assert.equal(body.properties.retention.additionalProperties, false);
});

test('invocation event variants and subscription.test consume policy while delivery retains 30 days', async t => {
  const f = await fixture(t), etag = (await f.get()).body.data.items[0].policyEtag;
  assert.equal((await f.patch(input(4), etag)).status, 200);
  for (const eventType of ['invocation.completed', 'invocation.reconciled']) {
    await f.store.transaction(async tx => {
      const invocationId = randomUUID();
      await f.store.invocationEvent(tx, { invocationId, recordVersion: 1,
        record: { invocationId, outcome: 'success', completedAt: tx.now, request: { state: 'empty' }, response: { state: 'empty' } } },
      tx.nextSequence(), eventType);
    });
  }
  const subscriptionId = randomUUID(), now = new Date().toISOString();
  await f.db.getRepository(entities.RuntimeEventSubscriptionEntity).insert({ id: subscriptionId, ownerId: f.user.id,
    name: 'policy fixture', version: 1, state: 'enabled', destination: 'https://example.invalid/hook', secretRef: 'fixture',
    filter: {}, scope: { mode: 'all' }, effectiveFromSequence: '00000000000000000000', createdAt: now, updatedAt: now });
  await f.db.getRepository(entities.RuntimeSubscriptionRevisionEntity).insert({ id: randomUUID(), subscriptionId,
    version: 1, effectiveFromSequence: '00000000000000000000', config: {}, revoked: false, createdAt: now });
  const { CallObservabilityDeliveriesService } = source('modules/call-observability/call-observability-deliveries.service');
  const { ObservabilityCommandStore } = source('modules/call-observability/call-observability-command.store');
  const commands = new ObservabilityCommandStore(f.store, new ConfigService());
  const deliveries = new CallObservabilityDeliveriesService(f.store, commands, {}, f.audit);
  await deliveries.testSubscription(subscriptionId, {}, {}, undefined,
    authorizeObservability(f.user, ['monitoring:manage']), undefined);
  const events = await f.db.getRepository(RuntimeObservabilityEventEntity).find();
  assert.equal(events.length, 3);
  for (const event of events) assert.ok(Math.abs(event.expiresAt - event.createdAt - 4 * DAY) < 1000, event.eventName);
  const delivery = await f.db.getRepository(entities.RuntimeEventDeliveryEntity).findOneBy({ subscriptionId });
  assert.equal(Date.parse(delivery.expiresAt) - Date.parse(delivery.createdAt), 30 * DAY);
});


function invocation(overrides = {}) {
  const now = Date.now() - 1000;
  return { schemaVersion: 2, sourceInstanceId: randomUUID(), sourceSequence: 1, eventId: randomUUID(), recordVersion: 1,
    invocationId: randomUUID(), requestId: randomUUID(), phase: 'finished', serverType: 'gateway', spanKind: 'gateway_request',
    protocolTransport: 'http', origin: 'external', runtimeAssetId: 'asset-a', identitySource: 'authenticated', callerId: 'caller-a',
    startedAt: new Date(now).toISOString(), completedAt: new Date(now + 10).toISOString(), outcome: 'success', statusCode: 200,
    request: captureAuditBody({ body: 'request-value' }), response: captureAuditBody({ body: 'response-value' }), ...overrides };
}
const payloadInput = payloadDays => ({ retention: { payloadDays }, reason: 'operator changed body retention' });

test('legacy event-only durable policy keeps revision and defaults body TTL until an atomic partial edit', async t => {
  const f = await fixture(t);
  await f.db.getRepository(entities.RuntimeObservabilityPolicyEntity).insert({ id, version: 8,
    scope: { mode: 'all' }, settings: { eventDays: 4 }, updatedAt: new Date().toISOString(), updatedBy: f.user.id });
  const initial = (await f.get()).body.data.items[0];
  assert.equal(initial.revision, 8); assert.deepEqual(initial.retention, { eventDays: 4, payloadDays: 7 });
  const noop = await f.patch(payloadInput(7), initial.policyEtag);
  assert.equal(noop.body.data.revision, 8); assert.equal(noop.body.data.changed, false);
  assert.deepEqual((await f.db.getRepository(entities.RuntimeObservabilityPolicyEntity).findOneBy({ id })).settings, { eventDays: 4 });
  const updated = await f.patch(payloadInput(2), initial.policyEtag);
  assert.equal(updated.status, 200); assert.equal(updated.body.data.revision, 9);
  assert.deepEqual(updated.body.data.retention, { eventDays: 4, payloadDays: 2 });
  assert.deepEqual((await f.db.getRepository(entities.RuntimeObservabilityPolicyEntity).findOneBy({ id })).settings, { eventDays: 4, payloadDays: 2 });
  const eventOnly = await f.patch(input(5), updated.etag);
  assert.deepEqual(eventOnly.body.data.retention, { eventDays: 5, payloadDays: 2 });
  assert.equal((await f.patch(payloadInput(3), initial.policyEtag)).status, 412);
});

test('payload policy changes apply to new filesystem-backed payloads, preserve old TTL and never revive expired source revisions', async t => {
  const f = await fixture(t, true);
  f.user.roles = [role(['monitoring:read', 'monitoring:manage', 'monitoring:payload:read'])];
  const old = invocation();
  assert.equal((await f.store.ingest(old)).status, 'inserted');
  const repository = f.db.getRepository(entities.RuntimePayloadEntity);
  const before = await repository.findBy({ invocationId: old.invocationId });
  assert.equal(before.length, 2);
  for (const row of before) {
    assert.equal(Date.parse(row.expiresAt) - Date.parse(old.completedAt), 7 * DAY);
    assert.equal((await f.payloadStore.read(row)).state, 'captured');
  }
  const initial = (await f.get()).body.data.items[0];
  const change = await f.patch(payloadInput(1), initial.policyEtag); assert.equal(change.status, 200);
  const fresh = invocation(); assert.equal((await f.store.ingest(fresh)).status, 'inserted');
  for (const row of await repository.findBy({ invocationId: fresh.invocationId })) {
    assert.equal(Date.parse(row.expiresAt) - Date.parse(fresh.completedAt), DAY);
  }
  for (const row of before) assert.equal((await repository.findOneBy({ id: row.id })).expiresAt, row.expiresAt);
  const historic = invocation({ phase: 'started', completedAt: null, outcome: 'unknown', statusCode: null,
    startedAt: new Date(Date.now() - 2 * DAY).toISOString() });
  assert.equal((await f.store.ingest(historic)).status, 'inserted');
  const expired = await repository.findBy({ invocationId: historic.invocationId });
  for (const row of expired) { assert.equal(row.state, 'expired'); assert.equal(row.fileKey, null); }
  const longer = await f.patch(payloadInput(30), change.etag); assert.equal(longer.status, 200);
  const finished = { ...historic, phase: 'finished', outcome: 'success', statusCode: 200, eventId: randomUUID(), sourceSequence: 2,
    recordVersion: 2, completedAt: new Date().toISOString(), response: captureAuditBody({ body: 'new terminal evidence' }) };
  assert.equal((await f.store.ingest(finished)).status, 'updated');
  const current = await f.db.getRepository(entities.RuntimeInvocationEntity).findOneBy({ invocationId: historic.invocationId });
  for (const [side, payloadId] of [['request', current.requestPayloadId], ['response', current.responsePayloadId]]) {
    const row = await repository.findOneBy({ id: payloadId });
    assert.equal(row.expiresAt, expired.find(item => item.side === side).expiresAt);
    await assert.rejects(f.payloadStore.read(row), error => error.code === 'PAYLOAD_EXPIRED');
  }
  const { CallObservabilityPayloadsService } = source('modules/call-observability/call-observability-payloads.service');
  const service = new CallObservabilityPayloadsService(f.store, f.payloadStore, f.audit, f.resolver);
  await assert.rejects(service.get(historic.invocationId, 'request', {}, authorizeObservability(f.user, ['monitoring:read', 'monitoring:payload:read']), randomUUID()), error => error.code === 'PAYLOAD_EXPIRED');
  const logs = await f.auditRepository.find();
  const changed = logs.find(log => log.id === change.body.data.auditId);
  assert.deepEqual(changed.details.before, { eventDays: 14, payloadDays: 7 });
  assert.deepEqual(changed.details.after, { eventDays: 14, payloadDays: 1 });
});

test('body TTL bounds and atomic failure leave durable settings and sequence unchanged', async t => {
  const f = await fixture(t), initial = (await f.get()).body.data.items[0];
  const low = await f.patch({ retention: { payloadDays: 1, eventDays: 1 }, reason: 'minimum' }, initial.policyEtag);
  assert.equal(low.status, 200);
  const high = await f.patch({ retention: { payloadDays: 365, eventDays: 365 }, reason: 'maximum' }, low.etag);
  assert.equal(high.status, 200);
  const before = await f.store.watermark();
  f.audit.log = async () => { throw new Error('fixture unavailable audit'); };
  await assert.rejects(f.service.update(id, payloadInput(7), {}, high.etag, f.user.id), /unavailable audit/);
  assert.equal(await f.store.watermark(), before);
  assert.deepEqual((await f.db.getRepository(entities.RuntimeObservabilityPolicyEntity).findOneBy({ id })).settings, { eventDays: 365, payloadDays: 365 });
});


test('both payload sides use the policy snapshot taken before file preparation while subsequent invocations use the new revision', async t => {
  const f = await fixture(t, true);
  const initial = (await f.get()).body.data.items[0];
  const prepare = f.payloadStore.prepare.bind(f.payloadStore);
  let edited = false;
  f.payloadStore.prepare = async (...args) => {
    if (!edited) {
      edited = true;
      assert.equal((await f.patch(payloadInput(2), initial.policyEtag)).status, 200);
    }
    return prepare(...args);
  };
  const captured = invocation();
  assert.equal((await f.store.ingest(captured)).status, 'inserted');
  const later = invocation();
  assert.equal((await f.store.ingest(later)).status, 'inserted');
  const repository = f.db.getRepository(entities.RuntimePayloadEntity);
  for (const [record, days] of [[captured, 7], [later, 2]]) {
    const rows = await repository.findBy({ invocationId: record.invocationId });
    assert.equal(rows.length, 2);
    for (const row of rows) assert.equal(Date.parse(row.expiresAt) - Date.parse(record.completedAt), days * DAY);
  }
});


test('a competing Store commit during preparation cannot extend the prior payload deadline', async t => {
  const f = await fixture(t, true);
  const initial = (await f.get()).body.data.items[0];
  const started = invocation({ phase: 'started', completedAt: null, outcome: 'unknown', statusCode: null,
    startedAt: new Date(Date.now() - 2 * DAY).toISOString() });
  const finished = { ...started, eventId: randomUUID(), sourceSequence: 2, recordVersion: 2,
    phase: 'finished', outcome: 'success', completedAt: new Date().toISOString(), statusCode: 200 };
  const competing = new CallObservabilityStore(f.db, f.payloadStore);
  const prepare = f.payloadStore.prepare.bind(f.payloadStore);
  let inserted = false;
  f.payloadStore.prepare = async (...args) => {
    if (!inserted) {
      inserted = true;
      assert.equal((await f.patch(payloadInput(1), initial.policyEtag)).status, 200);
      assert.equal((await competing.ingest(started)).status, 'inserted');
    }
    return prepare(...args);
  };
  assert.equal((await f.store.ingest(finished)).status, 'updated');
  const current = await f.db.getRepository(entities.RuntimeInvocationEntity).findOneBy({ invocationId: started.invocationId });
  for (const id of [current.requestPayloadId, current.responsePayloadId]) {
    const payload = await f.db.getRepository(entities.RuntimePayloadEntity).findOneBy({ id });
    assert.equal(Date.parse(payload.expiresAt), Date.parse(started.startedAt) + DAY);
    await assert.rejects(f.payloadStore.read(payload), error => error.code === 'PAYLOAD_EXPIRED');
  }
});
