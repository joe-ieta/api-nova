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
const { CallObservabilitySubscriptionsController } = require('../dist/src/modules/call-observability/call-observability-subscriptions.controller');
const { ObservabilityAccessGuard } = require('../dist/src/modules/call-observability/call-observability-access.guard');
const { ObservabilityApiExceptionFilter } = require('../dist/src/modules/call-observability/call-observability-api.contract');
const { UserService } = require('../dist/src/modules/security/services/user.service');
const tokens = require('../dist/src/modules/security/management-access-token');

const defaultConfig = {
  API_NOVA_OBSERVABILITY_IDEMPOTENCY_SECRET: 'i'.repeat(32),
  API_NOVA_OBSERVABILITY_WEBHOOK_ALLOWED_HOSTS: 'monitor.example,127.0.0.1:18080',
  API_NOVA_OBSERVABILITY_WEBHOOK_SECRET_REFS: 'webhook-orders-v1,local-test-key',
};
const scoped = { principalId: 'owner-a', runtimeAssetIds: ['runtime-a'],
  requiredPermissions: ['monitoring:read', 'monitoring:subscription:manage'], fingerprint: 'scope-a' };
const global = { ...scoped, runtimeAssetIds: null, fingerprint: 'scope-all' };
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
    new ObservabilityCommandStore(store, config), config, audit);
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

test('real HTTP route enforces management JWT and subscription permission before returning 201', async t => {
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
});
