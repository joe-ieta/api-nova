'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const path = require('node:path');
require('reflect-metadata');
require('ts-node').register({ project: path.resolve(__dirname, '../tsconfig.json'), transpileOnly: true });
const { CallObservabilityWebhookSender } = require('../src/modules/call-observability/call-observability-webhook-sender.ts');
function fixture(overrides = {}) {
  const state = { sends: 0, reads: 0, completions: [], key: Buffer.alloc(32, 42), batch: 0 };
  const lease = { deliveryId: 'delivery-1', token: 'lease-1', version: 2, attemptNo: 1,
    eventId: 'event-1', subscriptionId: 'sub-1', subscriptionRevision: 1,
    startedAt: new Date().toISOString(), leaseUntil: new Date(Date.now() + 30000).toISOString() };
  const context = { destination: 'https://hooks.acme.com/events', ownerId: 'owner-1', secretRef: 'secret-ref-1', signingKeyId: 'key-1',
    event: { id: 'event-1', sequence: '00000000000000000001', eventName: 'invocation.completed',
      occurredAt: new Date(), createdAt: new Date(), runtimeAssetId: 'asset-1', subjectId: 'inv-1', subjectVersion: 1,
      severity: 'info', dimensions: { serverType: 'gateway' }, details: { outcome: 'success', authorization: 'hidden', clientIp: 'hidden', payload: 'hidden' } } };
  const leases = { claim: async () => ({ leases: state.batch++ === 0 ? [lease] : [], scanned: 1 }),
    readForSend: async () => { state.reads++; return overrides.read ? overrides.read(state, context) : context; },
    complete: async (_lease, result) => { state.completions.push(result); return overrides.complete !== false; } };
  const sender = new CallObservabilityWebhookSender(leases, {
    allowedOrigins: ['https://hooks.acme.com'],
    resolveAll: async () => overrides.addresses ?? [{ address: '93.184.216.34', family: 4 }],
    resolveSecret: async () => state.key,
    send: async (destination, content, options) => { state.sends++; state.destination = destination;
      state.content = content; state.options = options;
      const expected = 'sha256=' + createHmac('sha256', Buffer.alloc(32, 42)).update(content.headers['X-ApiNova-Timestamp'] + '.').update(content.body).digest('hex');
      assert.equal(content.headers['X-ApiNova-Signature'], expected);
      return overrides.result ?? { kind: 'success', httpStatus: 202 }; }
  });
  return { state, sender };
}
test('signed metadata-only send uses checked address and records result', async () => {
  const { state, sender } = fixture();
  assert.deepEqual(await sender.runOnce(), { claimed: 1, recorded: 1, stale: 0 });
  assert.equal(state.reads, 2); assert.equal(state.sends, 1);
  assert.equal(state.destination.connection.host, '93.184.216.34');
  assert.ok(state.options.timeoutMs > 0 && state.options.timeoutMs <= 10000);
  const body = JSON.parse(state.content.body);
  assert.equal(body.eventId, 'event-1'); assert.deepEqual(body.data, { outcome: 'success' });
  assert.equal(state.content.body.includes(Buffer.from('hidden')), false);
  assert.ok(state.key.every(byte => byte === 0));
});
test('revocation between preparation and sending prevents network I/O', async () => {
  const { state, sender } = fixture({ read: (state, context) => state.reads === 1 ? context : null });
  assert.deepEqual(await sender.runOnce(), { claimed: 1, recorded: 0, stale: 1 });
  assert.equal(state.sends, 0); assert.equal(state.completions.length, 0);
  assert.ok(state.key.every(byte => byte === 0));
});
test('mixed public/private DNS fails before secret resolution and sending', async () => {
  const { state, sender } = fixture({ addresses: [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] });
  await sender.runOnce(); assert.equal(state.sends, 0);
  assert.deepEqual(state.completions, [{ kind: 'failure', reason: 'policy' }]);
  assert.ok(state.key.every(byte => byte === 42));
});
test('transport retry-after result passes through to durable completion', async () => {
  const result = { kind: 'failure', reason: 'http', httpStatus: 429, retryAfter: '60' };
  const { state, sender } = fixture({ result });
  await sender.runOnce(); assert.deepEqual(state.completions, [result]);
});
test('stale result is not counted as recorded', async () => {
  const { sender } = fixture({ complete: false });
  assert.deepEqual(await sender.runOnce(), { claimed: 1, recorded: 0, stale: 1 });
});
test('bounded batch stops when queue is empty', async () => {
  const { sender, state } = fixture();
  assert.deepEqual(await sender.runOnce(10), { claimed: 1, recorded: 1, stale: 0 });
  assert.equal(state.sends, 1);
  await assert.rejects(sender.runOnce(11), /INVALID_SENDER_BATCH/);
});