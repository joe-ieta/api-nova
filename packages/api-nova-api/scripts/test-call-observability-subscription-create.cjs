require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ConfigService } = require('@nestjs/config');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { JwtService } = require('@nestjs/jwt');
const entities = require('../dist/src/database/entities/runtime-call-observability.entity');
const { CallObservabilityStore } = require('../dist/src/modules/call-observability/call-observability.store');
const { ObservabilityCommandStore } = require('../dist/src/modules/call-observability/call-observability-command.store');
const { CallObservabilitySubscriptionsService } = require('../dist/src/modules/call-observability/call-observability-subscriptions.service');
const { ObservabilityCursorService } = require('../dist/src/modules/call-observability/call-observability-cursor.service');
const { CallObservabilitySubscriptionsController } = require('../dist/src/modules/call-observability/call-observability-subscriptions.controller');
const { ObservabilityAccessGuard } = require('../dist/src/modules/call-observability/call-observability-access.guard');
const { ObservabilityApiExceptionFilter } = require('../dist/src/modules/call-observability/call-observability-api.contract');
const { UserService } = require('../dist/src/modules/security/services/user.service');
const tokens = require('../dist/src/modules/security/management-access-token');

const defaultConfig = {
  API_NOVA_OBSERVABILITY_IDEMPOTENCY_SECRET: 'i'.repeat(32),
  API_NOVA_OBSERVABILITY_WEBHOOK_ALLOWED_HOSTS: 'monitor.example,127.0.0.1:18080',
  API_NOVA_OBSERVABILITY_WEBHOOK_SECRET_REFS: 'webhook-orders-v1,local-test-key',
  API_NOVA_OBSERVABILITY_CURSOR_SECRET: 'c'.repeat(32),
  API_NOVA_OBSERVABILITY_CURSOR_KEY_ID: 'v1',
};
const scoped = { principalId: 'owner-a', runtimeAssetIds: ['runtime-a'],
  requiredPermissions: ['monitoring:read', 'monitoring:subscription:manage'], fingerprint: 'a'.repeat(64) };
const global = { ...scoped, runtimeAssetIds: null, fingerprint: 'b'.repeat(64) };
const body = {
  name: 'Orders runtime',
  destination: { type: 'webhook', url: 'https://monitor.example/api-nova/events' },
  secretRef: 'webhook-orders-v1',
  filter: { eventTypes: ['invocation.completed'] },
  enabled: true,
  reason: 'runtime monitoring',
};

async function fixture(t, overrides = {}, auditFailure = false) {
  const database = new DataSource({ type: 'sqljs', entities: entities.CALL_OBSERVABILITY_ENTITIES,
    synchronize: true, logging: false });
  await database.initialize();
  t.after(() => database.destroy());
  const store = new CallObservabilityStore(database, {});
  const config = new ConfigService({ ...defaultConfig, ...overrides });
  const auditEntries = [];
  const audit = { async log(entry) {
    auditEntries.push(entry);
    if (auditFailure) throw new Error('audit failure');
    return { id: randomUUID() };
  } };
  const service = new CallObservabilitySubscriptionsService(store,
    new ObservabilityCommandStore(store, config), config, audit, new ObservabilityCursorService(config));
  return { database, store, service, config, auditEntries,
    subscriptions: database.getRepository(entities.RuntimeEventSubscriptionEntity),
    revisions: database.getRepository(entities.RuntimeSubscriptionRevisionEntity),
    receipts: database.getRepository(entities.RuntimeObservabilityIdempotencyEntity) };
}

function code(expected) { return error => error?.code === expected; }

test('creates a scoped version-one subscription after the current event watermark', async t => {
  const f = await fixture(t);
  const response = await f.service.create(body, {}, undefined, scoped, randomUUID());
  assert.equal(response.status, 'success');
  assert.equal(response.data.version, 1);
  assert.equal(response.data.state, 'enabled');
  assert.equal(response.data.effectiveFromSeq, '1');
  assert.equal(response.data.replayed, false);
  assert.equal(response.data.signingKeyId, body.secretRef);
  assert.equal(response.data.secretConfigured, true);
  assert.match(response.data.editEtag, /^"obs\.[a-f0-9]{32}\.1"$/);
  const subscription = await f.subscriptions.findOneByOrFail({ id: response.data.id });
  const revision = await f.revisions.findOneByOrFail({ subscriptionId: response.data.id, version: 1 });
  assert.deepEqual(subscription.scope, { mode: 'assets', runtimeAssetIds: ['runtime-a'] });
  assert.deepEqual(revision.config.scope, subscription.scope);
  assert.equal(revision.effectiveUntilSequence, null);
  assert.equal(await f.receipts.count(), 0);
  const serializedAudit = JSON.stringify(f.auditEntries);
  assert.equal(serializedAudit.includes(body.destination.url), false);
  assert.equal(serializedAudit.includes(body.secretRef), false);
});

test('optional idempotency returns the original result and rejects changed content', async t => {
  const f = await fixture(t);
  const first = await f.service.create(body, {}, 'create-orders', scoped, randomUUID());
  const replay = await f.service.create(body, {}, 'create-orders', scoped, randomUUID());
  assert.equal(replay.data.id, first.data.id);
  assert.equal(replay.data.auditId, first.data.auditId);
  assert.equal(replay.data.replayed, true);
  assert.equal(await f.subscriptions.count(), 1);
  assert.equal(await f.revisions.count(), 1);
  assert.equal(await f.receipts.count(), 1);
  assert.equal(f.auditEntries.length, 1);
  await assert.rejects(() => f.service.create({ ...body, name: 'Changed' }, {}, 'create-orders', scoped, randomUUID()),
    code('IDEMPOTENCY_CONFLICT'));
  assert.equal(await f.subscriptions.count(), 1);
});

test('idempotency infrastructure is not required when the optional key is absent', async t => {
  const f = await fixture(t, { API_NOVA_OBSERVABILITY_IDEMPOTENCY_SECRET: '' });
  const response = await f.service.create(body, {}, undefined, scoped, randomUUID());
  assert.equal(response.data.replayed, false);
  assert.equal(await f.receipts.count(), 0);
});

test('global and initially paused subscriptions preserve their exact routing scope', async t => {
  const f = await fixture(t);
  const response = await f.service.create({ ...body, enabled: false, filter: {} }, {}, undefined, global, randomUUID());
  const subscription = await f.subscriptions.findOneByOrFail({ id: response.data.id });
  const revision = await f.revisions.findOneByOrFail({ subscriptionId: response.data.id });
  assert.equal(response.data.state, 'paused');
  assert.deepEqual(subscription.scope, { mode: 'all' });
  assert.equal(subscription.pausedFromSequence, subscription.effectiveFromSequence);
  assert.equal(revision.config.state, 'paused');
});

test('asset escalation and malformed filters fail before durable writes', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.service.create({ ...body,
    filter: { runtimeAssetIds: ['runtime-b'] } }, {}, undefined, scoped, randomUUID()), code('FORBIDDEN'));
  await assert.rejects(() => f.service.create({ ...body,
    filter: { eventTypes: ['unknown.event'] } }, {}, undefined, scoped, randomUUID()), code('INVALID_QUERY'));
  await assert.rejects(() => f.service.create({ ...body, unexpected: true }, {}, undefined, scoped, randomUUID()),
    code('INVALID_QUERY'));
  await assert.rejects(() => f.service.create(body, {}, ['not', 'a-string'], scoped, randomUUID()),
    code('INVALID_QUERY'));
  assert.equal(await f.subscriptions.count(), 0);
});

test('destination and signing reference require explicit deployment authorization', async t => {
  const f = await fixture(t);
  for (const url of [
    'http://monitor.example/api-nova/events',
    'https://user:pass@monitor.example/api-nova/events',
    'https://monitor.example/api-nova/events?token=secret',
  ]) await assert.rejects(() => f.service.create({ ...body, destination: { type: 'webhook', url } },
    {}, undefined, scoped, randomUUID()), code('INVALID_QUERY'));
  await assert.rejects(() => f.service.create({ ...body,
    destination: { type: 'webhook', url: 'https://other.example/events' } }, {}, undefined, scoped, randomUUID()),
    code('FORBIDDEN'));
  await assert.rejects(() => f.service.create({ ...body, secretRef: 'missing-key' }, {}, undefined, scoped, randomUUID()),
    code('FORBIDDEN'));
  assert.equal(await f.subscriptions.count(), 0);
});

test('HTTP requires an explicit test switch and the metadata endpoint remains blocked', async t => {
  const f = await fixture(t, { API_NOVA_OBSERVABILITY_WEBHOOK_ALLOW_HTTP: 'true',
    API_NOVA_OBSERVABILITY_WEBHOOK_ALLOWED_HOSTS: '127.0.0.1:18080,169.254.169.254' });
  const local = await f.service.create({ ...body, destination: {
    type: 'webhook', url: 'http://127.0.0.1:18080/events' }, secretRef: 'local-test-key' },
  {}, undefined, scoped, randomUUID());
  assert.equal(local.data.destination.url, 'http://127.0.0.1:18080/events');
  await assert.rejects(() => f.service.create({ ...body, destination: {
    type: 'webhook', url: 'http://169.254.169.254/latest/meta-data' } }, {}, undefined, scoped, randomUUID()),
    code('INVALID_QUERY'));
});

test('audit failure rolls back subscription, revision and allocated sequence', async t => {
  const f = await fixture(t, {}, true);
  await assert.rejects(() => f.service.create(body, {}, undefined, scoped, randomUUID()), /audit failure/);
  assert.equal(await f.subscriptions.count(), 0);
  assert.equal(await f.revisions.count(), 0);
  assert.equal(await f.store.watermark(), '0');
});

test('list and detail enforce scope while signed cursors retain a fixed filter and snapshot', async t => {
  const f = await fixture(t);
  const scopeB = { ...scoped, principalId: 'owner-b', runtimeAssetIds: ['runtime-b'], fingerprint: 'c'.repeat(64) };
  const first = await f.service.create(body, {}, undefined, scoped, randomUUID());
  const second = await f.service.create({ ...body, name: 'Runtime B', filter: { runtimeAssetIds: ['runtime-b'] } },
    {}, undefined, scopeB, randomUUID());
  const page = await f.service.list({ limit: '1', state: 'enabled' }, global);
  assert.equal(page.data.items.length, 1);
  assert.equal(page.data.hasMore, true);
  assert.ok(page.data.nextCursor);
  const remaining = page.data.items[0].id === first.data.id ? second : first;
  await f.service.update(remaining.data.id, { name: 'Changed after snapshot' }, {},
    remaining.data.editEtag, global, randomUUID());
  const next = await f.service.list({ cursor: page.data.nextCursor }, global);
  assert.equal(next.data.items.length, 1);
  assert.notEqual(next.data.items[0].id, page.data.items[0].id);
  assert.notEqual(next.data.items[0].name, 'Changed after snapshot');
  assert.equal(next.data.items[0].version, 1);
  await assert.rejects(() => f.service.list({ cursor: page.data.nextCursor, state: 'paused' }, global),
    code('CURSOR_SCOPE_MISMATCH'));
  await assert.rejects(() => f.service.list({ cursor: page.data.nextCursor }, scoped),
    code('CURSOR_SCOPE_MISMATCH'));
  const visible = await f.service.list({}, scoped);
  assert.deepEqual(visible.data.items.map(item => item.id), [first.data.id]);
  const detail = await f.service.get(first.data.id, {}, scoped);
  assert.equal(detail.data.id, first.data.id);
  await assert.rejects(() => f.service.get(first.data.id, {}, scopeB), code('NOT_FOUND'));
});

test('updates create half-open revisions and report the exact paused gap on resume', async t => {
  const f = await fixture(t);
  const created = await f.service.create(body, {}, undefined, scoped, randomUUID());
  const paused = await f.service.update(created.data.id, { enabled: false, reason: 'maintenance' }, {},
    created.data.editEtag, scoped, randomUUID());
  assert.equal(paused.data.version, 2);
  assert.equal(paused.data.state, 'paused');
  assert.equal(paused.data.changed, true);
  await assert.rejects(() => f.service.update(created.data.id, { name: 'stale' }, {},
    created.data.editEtag, scoped, randomUUID()), code('PRECONDITION_FAILED'));
  const resume = await f.service.update(created.data.id, { enabled: true }, {},
    paused.data.editEtag, scoped, randomUUID());
  assert.equal(resume.data.version, 3);
  assert.deepEqual(resume.data.pausedGapRange, { from: '2', to: '3' });
  const revisions = await f.revisions.find({ where: { subscriptionId: created.data.id }, order: { version: 'ASC' } });
  assert.equal(revisions.length, 3);
  assert.equal(revisions[0].effectiveUntilSequence, revisions[1].effectiveFromSequence);
  assert.equal(revisions[1].effectiveUntilSequence, revisions[2].effectiveFromSequence);
  const unchanged = await f.service.update(created.data.id, { name: body.name }, {},
    resume.data.editEtag, scoped, randomUUID());
  assert.equal(unchanged.data.changed, false);
  assert.equal(unchanged.data.version, 3);
});

test('updates cannot widen scope and delete revokes routing plus cancels unfinished deliveries', async t => {
  const f = await fixture(t);
  const created = await f.service.create(body, {}, undefined, scoped, randomUUID());
  await assert.rejects(() => f.service.update(created.data.id,
    { filter: { runtimeAssetIds: ['runtime-b'] } }, {}, created.data.editEtag, scoped, randomUUID()), code('FORBIDDEN'));
  const deliveries = f.database.getRepository(entities.RuntimeEventDeliveryEntity);
  await deliveries.insert(deliveries.create({ id: randomUUID(), subscriptionId: created.data.id,
    subscriptionRevision: 1, eventId: randomUUID(), eventSequence: '00000000000000000001',
    status: 'pending', version: 1, attemptCount: 0, replayGeneration: 0,
    nextAttemptAt: new Date().toISOString(), leaseOwner: null, leaseUntil: null, lastError: {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString() }));
  await f.service.remove(created.data.id, {}, created.data.editEtag, scoped, randomUUID());
  const deleted = await f.subscriptions.findOneByOrFail({ id: created.data.id });
  assert.equal(deleted.state, 'deleted');
  assert.ok(deleted.deletedAt);
  assert.equal((await deliveries.findOneByOrFail({ subscriptionId: created.data.id })).status, 'cancelled');
  assert.ok((await f.revisions.findBy({ subscriptionId: created.data.id })).every(revision => revision.revoked));
  assert.equal((await f.service.list({}, scoped)).data.items.length, 0);
  await assert.rejects(() => f.service.get(created.data.id, {}, scoped), code('NOT_FOUND'));
  await assert.rejects(() => f.service.remove(created.data.id, {}, created.data.editEtag, scoped, randomUUID()),
    code('NOT_FOUND'));
});

test('real HTTP routes enforce management JWT and complete the authorized subscription CRUD lifecycle', async t => {
  const jwtSecret = 'j'.repeat(32);
  const f = await fixture(t, { JWT_SECRET: jwtSecret });
  const jwt = new JwtService();
  const users = new Map();
  const permissions = names => names.map(name => ({ name, enabled: true }));
  const account = names => {
    const user = { id: randomUUID(), isActive: true, isLocked: false, roles: [{ enabled: true,
      type: 'custom', name: 'fixture', permissions: permissions(names),
      metadata: { observabilityScope: { mode: 'assets', runtimeAssetIds: ['runtime-a'] } } }] };
    users.set(user.id, user);
    return user;
  };
  const denied = account(['monitoring:read']);
  const allowed = account(['monitoring:read', 'monitoring:subscription:manage']);
  const resolver = { async findUserById(id) { if (!users.has(id)) throw new Error('missing'); return users.get(id); } };
  class FixtureModule {}
  Module({ controllers: [CallObservabilitySubscriptionsController], providers: [
    { provide: CallObservabilitySubscriptionsService, useValue: f.service },
    { provide: ConfigService, useValue: f.config }, { provide: JwtService, useValue: jwt },
    { provide: UserService, useValue: resolver }, ObservabilityAccessGuard, ObservabilityApiExceptionFilter,
  ] })(FixtureModule);
  const app = await NestFactory.create(FixtureModule, { logger: false, abortOnError: false });
  t.after(() => app.close());
  app.setGlobalPrefix('api/v1');
  await app.listen(0, '127.0.0.1');
  const url = 'http://127.0.0.1:' + app.getHttpServer().address().port +
    '/api/v1/monitoring/observability/subscriptions';
  const token = user => jwt.sign({ sub: user.id, tokenUse: tokens.MANAGEMENT_TOKEN_USE }, {
    secret: jwtSecret, algorithm: 'HS256', issuer: tokens.MANAGEMENT_TOKEN_ISSUER,
    audience: tokens.MANAGEMENT_TOKEN_AUDIENCE, expiresIn: '5m' });
  const request = authorization => fetch(url, { method: 'POST', headers: {
    'content-type': 'application/json', ...(authorization ? { authorization: 'Bearer ' + authorization } : {}),
  }, body: JSON.stringify(body) });
  assert.equal((await request()).status, 401);
  assert.equal((await request(token(denied))).status, 403);
  const response = await request(token(allowed));
  assert.equal(response.status, 201);
  assert.match(response.headers.get('x-subscription-etag'), /^"obs\.[a-f0-9]{32}\.1"$/);
  const payload = await response.json();
  assert.equal(payload.status, 'success');
  assert.equal(payload.data.secretConfigured, true);
  const authorization = { authorization: 'Bearer ' + token(allowed) };
  const listed = await fetch(url, { headers: authorization });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).data.items.length, 1);
  const itemUrl = url + '/' + payload.data.id;
  const detail = await fetch(itemUrl, { headers: authorization });
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).data.id, payload.data.id);
  const paused = await fetch(itemUrl, { method: 'PATCH', headers: { ...authorization,
    'content-type': 'application/json', 'if-match': payload.data.editEtag }, body: JSON.stringify({ enabled: false }) });
  assert.equal(paused.status, 200);
  const pausedPayload = await paused.json();
  assert.equal(pausedPayload.data.state, 'paused');
  const removed = await fetch(itemUrl, { method: 'DELETE', headers: {
    ...authorization, 'if-match': pausedPayload.data.editEtag } });
  assert.equal(removed.status, 204);
  assert.equal((await fetch(itemUrl, { headers: authorization })).status, 404);
});
