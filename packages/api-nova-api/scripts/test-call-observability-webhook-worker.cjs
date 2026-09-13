'use strict';
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { DataSource } = require('typeorm');
const { ConfigService } = require('@nestjs/config');
const entities = require('../dist/src/database/entities/runtime-call-observability.entity');
const { RuntimeObservabilityEventEntity } = require('../dist/src/database/entities/runtime-observability-event.entity');
const { CallObservabilityStore } = require('../dist/src/modules/call-observability/call-observability.store');
const { ObservabilityCommandStore } = require('../dist/src/modules/call-observability/call-observability-command.store');
const { ObservabilityCursorService } = require('../dist/src/modules/call-observability/call-observability-cursor.service');
const { CallObservabilitySubscriptionsService } = require('../dist/src/modules/call-observability/call-observability-subscriptions.service');
const { CallObservabilityDeliveriesService } = require('../dist/src/modules/call-observability/call-observability-deliveries.service');
const { CallObservabilityDeliveryWorker } = require('../dist/src/modules/call-observability/call-observability-delivery.worker');

const READ = 'monitoring:read', SUBSCRIBE = 'monitoring:subscription:manage';
const secret = 's'.repeat(48);
async function fixture(t, options = {}) {
  const calls = [];
  const responder = options.responder || (() => ({ status: 202, body: 'accepted' }));
  let transactionDepth = 0;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const result = responder(calls.length, request, body);
      calls.push({ headers: request.headers, body, transactionDepth });
      response.statusCode = result.status;
      for (const [name, value] of Object.entries(result.headers || {})) response.setHeader(name, value);
      response.end(result.body || '');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const database = new DataSource({ type: 'sqljs',
    entities: [...entities.CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity],
    synchronize: true, logging: false });
  await database.initialize();
  t.after(() => database.destroy());
  const store = new CallObservabilityStore(database, {});
  const originalTransaction = store.transaction.bind(store);
  store.transaction = callback => originalTransaction(async tx => {
    transactionDepth++;
    try { return await callback(tx); } finally { transactionDepth--; }
  });
  const config = new ConfigService({
    API_NOVA_OBSERVABILITY_IDEMPOTENCY_SECRET: 'i'.repeat(32),
    API_NOVA_OBSERVABILITY_CURSOR_SECRET: 'c'.repeat(32),
    API_NOVA_OBSERVABILITY_CURSOR_KEY_ID: 'v1',
    API_NOVA_OBSERVABILITY_WEBHOOK_ALLOW_HTTP: 'true',
    API_NOVA_OBSERVABILITY_WEBHOOK_ALLOWED_HOSTS: '127.0.0.1:' + port,
    API_NOVA_OBSERVABILITY_WEBHOOK_ALLOWED_PRIVATE_IPS:
      options.allowPrivate === false ? '' : '127.0.0.1',
    API_NOVA_OBSERVABILITY_WEBHOOK_SECRET_REFS: 'worker-key',
    API_NOVA_OBSERVABILITY_WEBHOOK_SECRETS:
      JSON.stringify(options.missingSecret ? {} : { 'worker-key': secret }),
    API_NOVA_OBSERVABILITY_WEBHOOK_TIMEOUT_MS: '1000',
  });
  const principalId = randomUUID();
  const role = { enabled: true, type: 'custom', name: 'worker-fixture',
    permissions: [READ, SUBSCRIBE].map(name => ({ name, enabled: true })),
    metadata: { observabilityScope: { mode: 'assets', runtimeAssetIds: ['runtime-a'] } } };
  const user = { id: principalId, isActive: true, isLocked: false, roles: [role] };
  const users = { async findUserById(id) { if (id !== user.id) throw new Error('missing'); return user; } };
  const audit = { async log() { return { id: randomUUID() }; } };
  const commands = new ObservabilityCommandStore(store, config);
  const cursors = new ObservabilityCursorService(config);
  const subscriptions = new CallObservabilitySubscriptionsService(store, commands, config, audit, cursors);
  const deliveries = new CallObservabilityDeliveriesService(store, commands, cursors, audit);
  const authorization = { principalId, runtimeAssetIds: ['runtime-a'],
    requiredPermissions: [READ, SUBSCRIBE], fingerprint: 'a'.repeat(64) };
  const subscription = await subscriptions.create({
    name: 'Webhook worker', destination: { type: 'webhook', url: 'http://127.0.0.1:' + port + '/events' },
    secretRef: 'worker-key', filter: { runtimeAssetIds: ['runtime-a'] },
    enabled: options.paused !== true,
  }, {}, undefined, authorization, randomUUID());
  const delivery = await deliveries.testSubscription(
    subscription.data.id, {}, {}, undefined, authorization, randomUUID());
  return {
    database, store, calls, role, delivery,
    worker: new CallObservabilityDeliveryWorker(store, config, users),
    rows: database.getRepository(entities.RuntimeEventDeliveryEntity),
    attempts: database.getRepository(entities.RuntimeEventDeliveryAttemptEntity),
    pipeline: database.getRepository(entities.RuntimePipelineStateEntity),
  };
}

test('sends signed canonical JSON outside the claim transaction and records 202 success', async t => {
  const f = await fixture(t);
  const report = await f.worker.runOnce();
  assert.deepEqual({ claimed: report.claimed, succeeded: report.succeeded, state: report.state },
    { claimed: 1, succeeded: 1, state: 'running' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].transactionDepth, 0);
  const headers = f.calls[0].headers;
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['x-apinova-event-id'], f.delivery.data.eventId);
  assert.equal(headers['x-apinova-delivery-id'], f.delivery.data.deliveryId);
  const expected = 'sha256=' + createHmac('sha256', secret)
    .update(headers['x-apinova-timestamp'] + '.' + f.calls[0].body).digest('hex');
  assert.equal(headers['x-apinova-signature'], expected);
  assert.equal(JSON.parse(f.calls[0].body).delivery.attemptNo, 1);
  const row = await f.rows.findOneByOrFail({ id: f.delivery.data.deliveryId });
  assert.equal(row.status, 'succeeded');
  assert.equal(row.attemptCount, 1);
  assert.equal((await f.attempts.findOneByOrFail({ deliveryId: row.id })).httpStatus, 202);
  assert.ok(await f.pipeline.findOneBy({ id: 'call-observability:webhook-worker' }));
});

test('retries retryable responses and becomes dead after six attempts', async t => {
  const f = await fixture(t, { responder: () => ({ status: 500, body: 'password=private-value' }) });
  for (let attempt = 1; attempt <= 6; attempt++) {
    if (attempt > 1) await f.rows.update(f.delivery.data.deliveryId, {
      nextAttemptAt: new Date(0).toISOString(),
    });
    const report = await f.worker.runOnce(1);
    const row = await f.rows.findOneByOrFail({ id: f.delivery.data.deliveryId });
    assert.equal(row.status, attempt < 6 ? 'retry_wait' : 'dead');
    assert.equal(attempt < 6 ? report.retrying : report.dead, 1);
    assert.equal(row.attemptCount, attempt);
  }
  assert.equal(f.calls.length, 6);
  assert.equal(await f.attempts.countBy({ deliveryId: f.delivery.data.deliveryId }), 6);
  assert.equal(JSON.stringify(await f.attempts.findBy({
    deliveryId: f.delivery.data.deliveryId,
  })).includes('private-value'), false);
});

test('honors bounded Retry-After for 429 responses', async t => {
  const f = await fixture(t, { responder: () => ({
    status: 429, headers: { 'retry-after': '60' }, body: 'slow down',
  }) });
  const before = Date.now();
  await f.worker.runOnce(1);
  const row = await f.rows.findOneByOrFail({ id: f.delivery.data.deliveryId });
  assert.equal(row.status, 'retry_wait');
  assert.ok(Date.parse(row.nextAttemptAt) >= before + 59000);
  assert.ok(Date.parse(row.nextAttemptAt) <= before + 62000);
});

test('treats non-retryable 4xx as permanent failure', async t => {
  const f = await fixture(t, { responder: () => ({ status: 400, body: 'bad request' }) });
  assert.equal((await f.worker.runOnce(1)).dead, 1);
  assert.equal((await f.rows.findOneByOrFail({ id: f.delivery.data.deliveryId })).status, 'dead');
  assert.equal(f.calls.length, 1);
});

test('paused subscriptions are not claimed until explicitly resumed', async t => {
  const f = await fixture(t, { paused: true });
  assert.equal((await f.worker.runOnce(1)).claimed, 0);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.rows.findOneByOrFail({ id: f.delivery.data.deliveryId })).status, 'pending');
});

test('revoked owner permission cancels a claimed delivery without network access', async t => {
  const f = await fixture(t);
  f.role.permissions = [{ name: READ, enabled: true }];
  assert.equal((await f.worker.runOnce(1)).cancelled, 1);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.rows.findOneByOrFail({ id: f.delivery.data.deliveryId })).status, 'cancelled');
});

test('private DNS results require an explicit address allow entry', async t => {
  const f = await fixture(t, { allowPrivate: false });
  assert.equal((await f.worker.runOnce(1)).dead, 1);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.rows.findOneByOrFail({
    id: f.delivery.data.deliveryId,
  })).lastError.category, 'address_blocked');
});

test('missing secrets fail closed without contacting the receiver', async t => {
  const f = await fixture(t, { missingSecret: true });
  assert.equal((await f.worker.runOnce(1)).dead, 1);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.rows.findOneByOrFail({
    id: f.delivery.data.deliveryId,
  })).lastError.category, 'configuration');
});

test('reclaims an expired in-flight lease but leaves an active lease untouched', async t => {
  const f = await fixture(t);
  await f.rows.update(f.delivery.data.deliveryId, {
    status: 'in_flight', leaseOwner: 'stale-worker',
    leaseUntil: new Date(Date.now() - 1000).toISOString(), nextAttemptAt: new Date(0).toISOString(),
  });
  assert.equal((await f.worker.runOnce(1)).succeeded, 1);
  assert.equal(f.calls.length, 1);
  const second = await fixture(t);
  await second.rows.update(second.delivery.data.deliveryId, {
    status: 'in_flight', leaseOwner: 'active-worker',
    leaseUntil: new Date(Date.now() + 60000).toISOString(), nextAttemptAt: new Date(0).toISOString(),
  });
  assert.equal((await second.worker.runOnce(1)).claimed, 0);
  assert.equal(second.calls.length, 0);
});
