'use strict';
// OBS-16-03 Stage 2: controlled loopback receiver matrix for the real webhook delivery worker.
//
// Matrix: 2xx success, retryable 408/429/5xx with Retry-After seconds and HTTP date,
// terminal 4xx and redirects (never followed), missing local secret, unresolvable host,
// unconditionally blocked metadata address, self-signed/unreachable TLS, and the bounded
// socket-inactivity timeout. Bounds are observed (ranges), never a strict total deadline.
//
// TLS success against a self-signed CA is expected BLOCKED: the retained worker has no
// CA/trust-root injection contract; this runner verifies the absence and records the
// concrete prerequisite instead of adding production code.
//
// TAP: node --test --test-reporter=tap scripts/test-obs-16-03-receiver-matrix.cjs
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { randomUUID, createHmac } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ConfigService } = require('@nestjs/config');
const entities = require('../dist/src/database/entities/runtime-call-observability.entity');
const { RuntimeObservabilityEventEntity } =
  require('../dist/src/database/entities/runtime-observability-event.entity');
const { CallObservabilityStore } =
  require('../dist/src/modules/call-observability/call-observability.store');
const { ObservabilityCommandStore } =
  require('../dist/src/modules/call-observability/call-observability-command.store');
const { ObservabilityCursorService } =
  require('../dist/src/modules/call-observability/call-observability-cursor.service');
const { CallObservabilitySubscriptionsService } =
  require('../dist/src/modules/call-observability/call-observability-subscriptions.service');
const { CallObservabilityDeliveriesService } =
  require('../dist/src/modules/call-observability/call-observability-deliveries.service');
const { CallObservabilityDeliveryWorker } =
  require('../dist/src/modules/call-observability/call-observability-delivery.worker');

const READ = 'monitoring:read';
const SUBSCRIBE = 'monitoring:subscription:manage';
const SECRET = 'obs16-receiver-synthetic-secret-'.repeat(2);

// Synthetic self-signed certificate generated locally for this runner. It exists only to
// prove that the retained worker rejects an untrusted certificate; no CA is injected.
const TLS_KEY = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCm7wDZ8UUsypPs',
  'Z41VVbjk0sLgueckfuCr1P9mAUPLwoUgxB3iONb/k+avBdN230GWs7cfFYM+cDMP',
  'OXIVdjEzfFm8EGu8ahNrB76yH0vCSh1JMcvz3cskFD8DbSDx3VOuGha6YYDbmT4y',
  'qk2kt7qsb/pCEPIa6u0uGLHJVYSxyq0xj/gIZChGFREpKCIAPD2IqzwjDShPsHY4',
  'EjbajBO8ZR2fRTnpEkdZ/5s9Z4lgA1aRk2A8vnCzGy41D/8JlxksAhiV9wiChOAp',
  'qxWBKx9bbtoHqdwKw9ICrjgtHUsRRapY21q4nLIwa74hXc7v6LIwCeLrYKCMbq4B',
  '+xpZSSuHAgMBAAECggEABc0ZfPlu+3sAv/7rQPNtLPqMDi43s6N7IE2TIJLbrcmR',
  'Qc2+8h0ij5gutJdhvWhNybRuITTorjNM+vL2nXtRg2YHYks5yz7udNI8lMkUo2ha',
  '8y+5VDy5cgQIGpDgy7by0QKUFp8L0NXW/QDBGP/Pi22Kx1/6YegXHPp7tzDzHxCL',
  'HaG8Avst5MgL91qod/I2+TXy5J1WHzVQIVMkIDMBalfNG8amvUqAqH8xxy9jXJlo',
  'CHqfRYMJaiL+DA95PwTgJU7X0Kw+3OJr1AI3PClI8GfUPtvd4lbC+aycCmHptoGa',
  'XwalE5/oAlXiEPuyo3cxewUoeXbUFRRixcRUNQiRrQKBgQDihkrfECbPUNvpVuAx',
  'uALMWGjaUVtPLlVTrbXVAwmuimmBtehxjvMKIc3LQnr+TeXmdgCCjaT7JYaVFTYY',
  'odNV/cLfy26FV31QOEHZhlz4BTVL6pzdpo/k/ZHT+lFWRnFPgWkjvXNjDNBsTn8j',
  'YHM7+it+fYzTbPpUguLRePvwNQKBgQC8p7CYhiDPms0NIvkbbvuvaZgUFaxet6W7',
  'rOUDxxVoIoDByHR/hVBr7GUJqC0Oz0K9vEs8ibDDX4++fifft9a9e86USUMK7/xM',
  'SKGwnNVWE1B38uL7yHNmFhMJqG7DOzKs8CxYHCdiG7HBV+0oFemxiST7itmHVJGl',
  'vtEGAuQcSwKBgGRFccr/yU4nytClRiR8AbEWyYMqVDLenaKm2EBsUdLTLhTewv/R',
  'eT/Y6tG4od0D+mpjfaJMtOT/HW3Mr9+Dcpsz8xlBYbDgo3XpES0Kzwhytb7fIYTz',
  '/+orXGvq+CoqkGnTLQlHCValC3WF4b11Kk04Vhxt0vKb4MucDG8REOSpAoGACtf8',
  'r5euFSDJvoKPHQORFfEU27qvMLaPoSz78O6ljVnGWt0hzR6lk75/xEFVba9+H5fO',
  'H0muzlwU0BdCRXq0rimKoz1ezCclMmFOYe9x18O+cVaVs3E/KNQF/h0fWLtzWztm',
  '4R2lKd97pShfqlkwGJNQe+DsRfoXcRZ5v0W1ROcCgYEAvl2Duc9FU+sDTm2y21cZ',
  'uvlAa2DQ3nXrSIXP+eH8bPnLLw8dhVCcEtGyiWLmjSzVHPRZYFto0EF+a6Dxde/8',
  'vwFDgHim2xqtp9pYO3sV8ma8Xvcl9YOdDcZZNHNUDr/WuyJiawNxRCZknSgR9Tkz',
  'RK1XjZlmagU3tl+S8wjXt/s=',
  '-----END PRIVATE KEY-----',
].join('\n');
const TLS_CERT = [
  '-----BEGIN CERTIFICATE-----',
  'MIIDMTCCAhmgAwIBAgIUJbUJ4vYcwHJgDpR8MKKJ3EqN0i0wDQYJKoZIhvcNAQEL',
  'BQAwGjEYMBYGA1UEAwwPb2JzMTYtbG9jYWxob3N0MB4XDTI2MDkyODEwMzEyMVoX',
  'DTM2MDkyNTEwMzEyMVowGjEYMBYGA1UEAwwPb2JzMTYtbG9jYWxob3N0MIIBIjAN',
  'BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApu8A2fFFLMqT7GeNVVW45NLC4Lnn',
  'JH7gq9T/ZgFDy8KFIMQd4jjW/5PmrwXTdt9BlrO3HxWDPnAzDzlyFXYxM3xZvBBr',
  'vGoTawe+sh9LwkodSTHL893LJBQ/A20g8d1TrhoWumGA25k+MqpNpLe6rG/6QhDy',
  'GurtLhixyVWEscqtMY/4CGQoRhURKSgiADw9iKs8Iw0oT7B2OBI22owTvGUdn0U5',
  '6RJHWf+bPWeJYANWkZNgPL5wsxsuNQ//CZcZLAIYlfcIgoTgKasVgSsfW27aB6nc',
  'CsPSAq44LR1LEUWqWNtauJyyMGu+IV3O7+iyMAni62CgjG6uAfsaWUkrhwIDAQAB',
  'o28wbTAdBgNVHQ4EFgQUQClfLn+DhzZ0oasz+UtBqEu7dCkwHwYDVR0jBBgwFoAU',
  'QClfLn+DhzZ0oasz+UtBqEu7dCkwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzAR',
  'hwR/AAABgglsb2NhbGhvc3QwDQYJKoZIhvcNAQELBQADggEBAA4VUsLTju2gvjdZ',
  'p3Lg4oSai8UR4DA77aitrJf+d9ibWIaGKwShXo2J2NPqJ7J78LCm4HJm3WwwhOKC',
  'lVUcU0Bdx6RmGALJe7cNrUKxdSbBEgokD3ob8O50BL16hzaYJurRojwF7sLIn6bO',
  'rGh/st1bmecfHHeyLaOKgU5v1B+gzAaBr2BPb57pu38PQxQWA59vrqU9u6JacQGu',
  'rczUatIxdK7f6j22Ifb3beGi5txH0RjhaPqx8HqF4CsLvngjoUf3ZDIS6JAjAX5/',
  'DbMb5ybOYcZQ+3veCZxF8BQNPmXade1qBZUAoLlZ2Qj7M+932QYFyTyYP3xRJY7A',
  '4/MJf8Q=',
  '-----END CERTIFICATE-----',
].join('\n');

const detail = { scenarios: [], tlsSuccess: null };

async function fixture(t, options = {}) {
  const calls = [];
  const responder = options.responder || (() => ({ status: 202, body: 'accepted' }));
  const handler = (request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const result = responder(calls.length, request, body) || {};
      calls.push({ headers: request.headers, body, path: request.url });
      if (result.hold) {
        if (result.writeAfterMs) {
          setTimeout(() => {
            if (response.destroyed) return;
            response.writeHead(200, { 'transfer-encoding': 'chunked' });
            response.write('x');
          }, result.writeAfterMs);
        }
        return;
      }
      response.statusCode = result.status ?? 202;
      for (const [name, value] of Object.entries(result.headers || {})) response.setHeader(name, value);
      response.end(result.body ?? '');
    });
  };
  const server = options.protocol === 'https'
    ? https.createServer({ cert: TLS_CERT, key: TLS_KEY }, handler)
    : http.createServer(handler);
  if (options.protocol === 'https') server.on('tlsClientError', () => undefined);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const port = options.port || server.address().port;
  const database = new DataSource({ type: 'sqljs',
    entities: [...entities.CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity],
    synchronize: true, logging: false });
  await database.initialize();
  t.after(() => database.destroy());
  const store = new CallObservabilityStore(database, {});
  const host = options.host || '127.0.0.1';
  const destinationHost = `${host}:${port}`;
  const destinationPath = options.path || '/events';
  const config = new ConfigService({
    API_NOVA_OBSERVABILITY_IDEMPOTENCY_SECRET: 'i'.repeat(32),
    API_NOVA_OBSERVABILITY_CURSOR_SECRET: 'c'.repeat(32),
    API_NOVA_OBSERVABILITY_CURSOR_KEY_ID: 'v1',
    API_NOVA_OBSERVABILITY_WEBHOOK_ALLOW_HTTP: 'true',
    API_NOVA_OBSERVABILITY_WEBHOOK_ALLOWED_HOSTS: options.allowedHosts !== undefined
      ? options.allowedHosts
      : (options.allowedHost !== undefined ? `${options.allowedHost}:${port}` : destinationHost),
    API_NOVA_OBSERVABILITY_WEBHOOK_ALLOWED_PRIVATE_IPS: options.allowPrivate === false ? '' : '127.0.0.1',
    API_NOVA_OBSERVABILITY_WEBHOOK_SECRET_REFS: 'obs16-receiver-key',
    API_NOVA_OBSERVABILITY_WEBHOOK_SECRETS:
      JSON.stringify(options.missingSecret ? {} : { 'obs16-receiver-key': SECRET }),
    API_NOVA_OBSERVABILITY_WEBHOOK_TIMEOUT_MS: String(options.timeoutMs || 1000),
  });
  const principalId = randomUUID();
  const role = { enabled: true, type: 'custom', name: 'obs16-receiver-fixture',
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
  const protocol = options.protocol || 'http';
  let delivery;
  if (options.direct) {
    // The production create path rejects metadata addresses up front. This fixture seeds a
    // pre-existing row to exercise the worker's independent defense-in-depth rejection.
    const now = new Date().toISOString();
    const subscriptionId = randomUUID();
    const eventId = randomUUID();
    const deliveryId = randomUUID();
    const scope = { mode: 'assets', runtimeAssetIds: ['runtime-a'] };
    const filter = { runtimeAssetIds: ['runtime-a'] };
    const destination = { type: 'webhook', url: `${protocol}://${destinationHost}${destinationPath}` };
    await database.getRepository(entities.RuntimeEventSubscriptionEntity).insert({
      id: subscriptionId, ownerId: principalId, name: 'OBS-16-03 seeded', version: 1, state: 'enabled',
      destination: JSON.stringify(destination), secretRef: 'obs16-receiver-key', filter, scope,
      effectiveFromSequence: '00000000000000000001', createdAt: now, updatedAt: now,
      pausedFromSequence: null, deletedAt: null,
    });
    await database.getRepository(entities.RuntimeSubscriptionRevisionEntity).insert({
      id: randomUUID(), subscriptionId, version: 1, effectiveFromSequence: '00000000000000000001',
      effectiveUntilSequence: null,
      config: { name: 'OBS-16-03 seeded', state: 'enabled', destination, secretRef: 'obs16-receiver-key',
        filter, scope },
      revoked: false, createdAt: now,
    });
    await database.getRepository(RuntimeObservabilityEventEntity).insert({
      id: eventId, eventFamily: 'runtime.control', eventName: 'subscription.test', severity: 'info',
      status: 'success', occurredAt: new Date(now), actorType: 'user', actorId: principalId,
      details: { test: true }, dimensions: { subscriptionId }, retentionClass: 'short', sequence: '1',
      schemaVersion: '1.0', subjectId: subscriptionId, subjectVersion: 1, dispatchState: 'materialized',
      expiresAt: new Date(Date.now() + 14 * 86400000), runtimeAssetId: 'runtime-a',
    });
    await database.getRepository(entities.RuntimeEventDeliveryEntity).insert({
      id: deliveryId, subscriptionId, subscriptionRevision: 1, eventId, eventSequence: '1',
      status: 'pending', version: 1, attemptCount: 0, replayGeneration: 0, nextAttemptAt: now,
      leaseOwner: null, leaseUntil: null, lastError: {}, createdAt: now, updatedAt: now,
      expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    });
    delivery = { data: { deliveryId, eventId, subscriptionId } };
  } else {
    const subscription = await subscriptions.create({
      name: 'OBS-16-03 receiver matrix',
      destination: { type: 'webhook', url: `${protocol}://${destinationHost}${destinationPath}` },
      secretRef: 'obs16-receiver-key', filter: { runtimeAssetIds: ['runtime-a'] },
      enabled: options.paused !== true,
    }, {}, undefined, authorization, randomUUID());
    delivery = await deliveries.testSubscription(
      subscription.data.id, {}, {}, undefined, authorization, randomUUID());
  }
  return {
    database, store, calls, delivery,
    worker: new CallObservabilityDeliveryWorker(store, config, users),
    rows: database.getRepository(entities.RuntimeEventDeliveryEntity),
    attempts: database.getRepository(entities.RuntimeEventDeliveryAttemptEntity),
    events: database.getRepository(RuntimeObservabilityEventEntity),
    async status() {
      return this.rows.findOneByOrFail({ id: this.delivery.data.deliveryId });
    },
  };
}

function attemptBounds(status, minimum, maximum, label) {
  const delta = Date.parse(status.nextAttemptAt) - Date.now();
  assert.ok(delta >= minimum && delta <= maximum,
    `${label}: nextAttemptAt delta ${delta} ms outside observed bounds [${minimum}, ${maximum}]`);
  return delta;
}

after(() => {
  console.log('OBS_16_03_RECEIVER_DETAIL ' + JSON.stringify(detail));
});

test('2xx acknowledgement records one signed attempt with bounded summary', async t => {
  const f = await fixture(t, { responder: () => ({ status: 202, body: 'x'.repeat(16384) + ' password=private-value' }) });
  const report = await f.worker.runOnce(1);
  assert.equal(report.succeeded, 1);
  assert.equal(f.calls.length, 1);
  const headers = f.calls[0].headers;
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['user-agent'], 'ApiNova-Observability-Webhook/1.0');
  assert.equal(Number(headers['content-length']), Buffer.byteLength(f.calls[0].body));
  assert.equal(headers['x-apinova-event-id'], f.delivery.data.eventId);
  assert.equal(headers['x-apinova-delivery-id'], f.delivery.data.deliveryId);
  const expected = 'sha256=' + createHmac('sha256', SECRET)
    .update(headers['x-apinova-timestamp'] + '.' + f.calls[0].body).digest('hex');
  assert.equal(headers['x-apinova-signature'], expected);
  const envelope = JSON.parse(f.calls[0].body);
  assert.deepEqual(Object.keys(envelope).sort(),
    ['data', 'delivery', 'dimensions', 'eventId', 'eventType', 'occurredAt', 'schemaVersion',
      'sequence', 'severity', 'status', 'subject']);
  assert.equal(envelope.schemaVersion, '1.0');
  assert.equal(envelope.delivery.attemptNo, 1);
  const status = await f.status();
  assert.equal(status.status, 'succeeded');
  assert.equal(status.attemptCount, 1);
  const attempt = await f.attempts.findOneByOrFail({ deliveryId: status.id });
  assert.equal(attempt.httpStatus, 202);
  assert.equal(attempt.errorCategory, null);
  assert.ok(attempt.responseSummary.startsWith('bytes='));
  assert.ok(attempt.responseSummary.length <= 2200, 'response summary is bounded, not the raw body');
  assert.equal(JSON.stringify(attempt).includes('private-value'), false);
  detail.scenarios.push({ id: 'receiver-2xx', result: 'pass', httpStatus: 202 });
});

test('retryable statuses schedule bounded retries with Retry-After seconds and HTTP date', async t => {
  const scenarios = [
    { id: 'retry-500', responder: () => ({ status: 500 }), min: 3000, max: 7000, expect: 500 },
    { id: 'retry-408', responder: () => ({ status: 408 }), min: 3000, max: 7000, expect: 408 },
    { id: 'retry-429-seconds', responder: () => ({ status: 429, headers: { 'retry-after': '60' } }),
      min: 59000, max: 62000, expect: 429 },
    { id: 'retry-429-http-date', responder: () => ({ status: 429,
      headers: { 'retry-after': new Date(Date.now() + 30000).toUTCString() } }),
      min: 28000, max: 32000, expect: 429 },
    { id: 'retry-429-http-date-past', responder: () => ({ status: 429,
      headers: { 'retry-after': new Date(Date.now() - 60000).toUTCString() } }),
      min: 3000, max: 7000, expect: 429 },
    { id: 'retry-503', responder: () => ({ status: 503 }), min: 3000, max: 7000, expect: 503 },
  ];
  for (const scenario of scenarios) {
    const f = await fixture(t, { responder: scenario.responder });
    const report = await f.worker.runOnce(1);
    const status = await f.status();
    assert.equal(report.retrying, 1, scenario.id);
    assert.equal(status.status, 'retry_wait', scenario.id);
    assert.equal(status.lastError.category, 'http_response', scenario.id);
    assert.equal(status.lastError.httpStatus, scenario.expect, scenario.id);
    assert.equal(status.attemptCount, 1, scenario.id);
    const delta = attemptBounds(status, scenario.min, scenario.max, scenario.id);
    assert.equal(f.calls.length, 1, scenario.id);
    detail.scenarios.push({ id: scenario.id, result: 'pass', nextAttemptAtDeltaMs: delta });
  }
});

test('oversized Retry-After stays bounded by the active retry window and expires', async t => {
  const f = await fixture(t, { responder: () => ({ status: 429, headers: { 'retry-after': '99999999' } }) });
  const report = await f.worker.runOnce(1);
  const status = await f.status();
  assert.equal(report.dead, 1);
  assert.equal(status.status, 'dead');
  assert.equal(status.attemptCount, 1);
  detail.scenarios.push({ id: 'retry-after-bounded', result: 'pass', status: 'dead' });
});

test('terminal 4xx and redirects are permanent failures and are never followed', async t => {
  const statuses = [400, 401, 403, 404, 409, 422, 301, 302, 303, 307, 308];
  for (const code of statuses) {
    const f = await fixture(t, { responder: () => ({ status: code, headers: { location: '/moved' }, body: 'no' }) });
    const report = await f.worker.runOnce(1);
    const status = await f.status();
    assert.equal(report.dead, 1, `status ${code}`);
    assert.equal(status.status, 'dead', `status ${code}`);
    assert.equal(status.attemptCount, 1, `status ${code}`);
    assert.equal(f.calls.length, 1, `status ${code} must not follow redirects`);
    detail.scenarios.push({ id: `terminal-${code}`, result: 'pass' });
  }
});

test('missing local secret fails closed without contacting the receiver', async t => {
  const f = await fixture(t, { missingSecret: true });
  const report = await f.worker.runOnce(1);
  const status = await f.status();
  assert.equal(report.dead, 1);
  assert.equal(status.status, 'dead');
  assert.equal(status.lastError.category, 'configuration');
  assert.equal(f.calls.length, 0);
  assert.equal(await f.attempts.count(), 1);
  detail.scenarios.push({ id: 'missing-secret', result: 'pass', category: 'configuration' });
});

test('unresolvable host and metadata address fail without any delivery request', async t => {
  const dns = await fixture(t, {
    allowedHost: 'obs16-does-not-exist.invalid', timeoutMs: 15000,
    host: 'obs16-does-not-exist.invalid', path: '/events',
  });
  const dnsReport = await dns.worker.runOnce(1);
  const dnsStatus = await dns.status();
  assert.equal(dnsReport.retrying, 1);
  assert.equal(dnsStatus.status, 'retry_wait');
  assert.equal(dnsStatus.lastError.category, 'dns');
  assert.equal(dns.calls.length, 0);

  const metadata = await fixture(t, {
    direct: true, allowedHost: '169.254.169.254', host: '169.254.169.254', path: '/events',
  });
  const metadataReport = await metadata.worker.runOnce(1);
  const metadataStatus = await metadata.status();
  assert.equal(metadataReport.dead, 1);
  assert.equal(metadataStatus.status, 'dead');
  assert.equal(metadataStatus.lastError.category, 'address_blocked');
  assert.equal(metadata.calls.length, 0);
  detail.scenarios.push({ id: 'dns-failure', result: 'pass', category: 'dns' });
  detail.scenarios.push({ id: 'metadata-address-blocked', result: 'pass', category: 'address_blocked' });
});

test('self-signed and unreachable TLS are rejected, and no CA injection exists', async t => {
  const selfSigned = await fixture(t, { protocol: 'https', path: '/events' });
  const selfSignedReport = await selfSigned.worker.runOnce(1);
  const selfSignedStatus = await selfSigned.status();
  assert.equal(selfSignedReport.retrying, 1);
  assert.equal(selfSignedStatus.status, 'retry_wait');
  assert.equal(selfSignedStatus.lastError.category, 'tls',
    'self-signed certificate must be mapped to the TLS failure category');
  assert.equal(selfSigned.calls.length, 0, 'no HTTP request may complete over the untrusted TLS session');

  const closedPort = await new Promise(resolve => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
  const unreachable = await fixture(t,
    { protocol: 'https', port: closedPort, allowedHosts: `127.0.0.1:${closedPort}` });
  await unreachable.worker.runOnce(1);
  const unreachableStatus = await unreachable.status();
  assert.equal(unreachableStatus.status, 'retry_wait');
  assert.equal(unreachableStatus.lastError.category, 'connection');

  const workerSource = fs.readFileSync(path.resolve(__dirname,
    '../src/modules/call-observability/call-observability-delivery.worker.ts'), 'utf8');
  const caInjection = ['NODE_EXTRA_CA_CERTS', 'checkServerIdentity', 'rejectUnauthorized']
    .filter(token => workerSource.includes(token));
  assert.deepEqual(caInjection, [], 'retained worker must not silently accept CA injection');
  detail.scenarios.push({ id: 'tls-self-signed-rejected', result: 'pass', category: 'tls' });
  detail.scenarios.push({ id: 'tls-unreachable', result: 'pass', category: 'connection' });
  detail.tlsSuccess = {
    cell: 'receiver-tls-success-self-signed-ca',
    result: 'blocked',
    prerequisite: 'No supported CA/trust-root injection contract exists in the retained worker '
      + '(no ca option, no NODE_EXTRA_CA_CERTS handling, no config switch). A deployment-owned '
      + 'trust configuration or system trust store is required before TLS success can be validated.',
  };
});

test('request.socket timeout observes inactivity bounds instead of a strict total deadline', async t => {
  const silent = await fixture(t, { timeoutMs: 1500, responder: () => ({ hold: true }) });
  const silentStarted = Date.now();
  await silent.worker.runOnce(1);
  const silentElapsed = Date.now() - silentStarted;
  const silentStatus = await silent.status();
  assert.equal(silentStatus.status, 'retry_wait');
  assert.equal(silentStatus.lastError.category, 'timeout');
  assert.ok(silentElapsed >= 1400 && silentElapsed <= 8000,
    `silent hold completed in ${silentElapsed} ms outside observed bounds [1400, 8000]`);
  assert.equal(silent.calls.length, 1);

  const paced = await fixture(t, { timeoutMs: 1500,
    responder: () => ({ hold: true, writeAfterMs: 1000 }) });
  const pacedStarted = Date.now();
  await paced.worker.runOnce(1);
  const pacedElapsed = Date.now() - pacedStarted;
  const pacedStatus = await paced.status();
  assert.equal(pacedStatus.lastError.category, 'timeout');
  assert.ok(pacedElapsed >= 2000 && pacedElapsed <= 9000,
    `paced hold completed in ${pacedElapsed} ms outside observed bounds [2000, 9000]; `
    + 'activity must reset the socket inactivity timer');
  detail.scenarios.push({ id: 'timeout-silent-hold', result: 'pass', observedMs: silentElapsed });
  detail.scenarios.push({ id: 'timeout-activity-reset', result: 'pass', observedMs: pacedElapsed });
});
