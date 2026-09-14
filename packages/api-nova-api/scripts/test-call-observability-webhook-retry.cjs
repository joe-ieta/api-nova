'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('ts-node').register({ project: path.resolve(__dirname, '../tsconfig.json'), transpileOnly: true });
const { planWebhookRetry, isRetryableWebhookFailure, WEBHOOK_RETRY_DELAYS_MS } = require('../src/modules/call-observability/call-observability-webhook-retry.ts');
const now = new Date('2026-09-11T00:00:00.000Z');
const input = (extra = {}) => ({ completedAttempts: 1, now, startedAt: now,
  expiresAt: new Date(now.getTime() + 48 * 3600000), jitterSample: 0, ...extra });
const scheduled = (extra = {}) => Date.parse(planWebhookRetry(input(extra)).nextAttemptAt);

test('six TOTAL attempts: exactly five retry delays, no seventh send', () => {
  assert.deepEqual(WEBHOOK_RETRY_DELAYS_MS, [5000, 30000, 120000, 600000, 1800000]);
  for (let attempt = 1; attempt <= 5; attempt++) {
    assert.equal(scheduled({ completedAttempts: attempt }), now.getTime() + WEBHOOK_RETRY_DELAYS_MS[attempt - 1]);
  }
  for (const completedAttempts of [6, 7, 100]) {
    assert.deepEqual(planWebhookRetry(input({ completedAttempts })), { status: 'dead', reason: 'retry_limit', nextAttemptAt: null });
  }
});
test('jitter adds bounded delay without going below base', () => {
  assert.equal(scheduled({ jitterSample: 0.5 }), now.getTime() + 5500);
  assert.equal(scheduled({ jitterSample: 1 }), now.getTime() + 6000);
  const actual = scheduled({ jitterSample: undefined });
  assert.ok(actual >= now.getTime() + 5000 && actual <= now.getTime() + 6000);
});
test('Retry-After delta and HTTP-date are lower bounds, never shorten backoff', () => {
  assert.equal(scheduled({ retryAfter: '60' }), now.getTime() + 60000);
  assert.equal(scheduled({ retryAfter: '1' }), now.getTime() + 5000);
  assert.equal(scheduled({ retryAfter: 'Fri, 11 Sep 2026 00:02:00 GMT' }), now.getTime() + 120000);
  assert.equal(scheduled({ retryAfter: 'Thu, 10 Sep 2026 00:00:00 GMT' }), now.getTime() + 5000);
});
test('malformed Retry-After falls back to backoff', () => {
  for (const retryAfter of ['', '-1', '1.5', 'tomorrow', '2026-09-12', 'NaN', 'Fri, 31 Feb 2026 00:00:00 GMT']) {
    assert.equal(scheduled({ retryAfter }), now.getTime() + 5000);
  }
});
test('24h window uses persisted generation start, including exact boundary', () => {
  for (const elapsed of [86400000, 86400000 - 5000]) {
    assert.equal(planWebhookRetry(input({ startedAt: new Date(now.getTime() - elapsed) })).reason, 'retry_window_exceeded');
  }
  assert.equal(planWebhookRetry(input({ retryAfter: '86400' })).reason, 'retry_window_exceeded');
  assert.equal(planWebhookRetry(input({ retryAfter: '9'.repeat(400) })).reason, 'retry_window_exceeded');
});
test('earlier delivery TTL takes precedence and is never extended', () => {
  for (const delta of [-1, 0, 5000]) {
    assert.equal(planWebhookRetry(input({ expiresAt: new Date(now.getTime() + delta) })).reason, 'delivery_expired');
  }
  assert.equal(planWebhookRetry(input({ expiresAt: new Date(now.getTime() + 10000), retryAfter: '20' })).reason, 'delivery_expired');
});
test('invalid attempts, clocks and jitter fail closed', () => {
  for (const completedAttempts of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => planWebhookRetry(input({ completedAttempts })), /INVALID_WEBHOOK_RETRY_POLICY/);
  for (const jitterSample of [-0.1, 1.1, NaN, Infinity]) assert.throws(() => planWebhookRetry(input({ jitterSample })), /INVALID_WEBHOOK_RETRY_POLICY/);
  for (const field of ['now', 'startedAt', 'expiresAt']) assert.throws(() => planWebhookRetry(input({ [field]: new Date(NaN) })), /INVALID_WEBHOOK_RETRY_POLICY/);
  assert.throws(() => planWebhookRetry(input({ startedAt: new Date(now.getTime() + 1) })), /INVALID_WEBHOOK_RETRY_POLICY/);
});
test('only network errors, 408, 429 and 5xx are retryable', () => {
  assert.equal(isRetryableWebhookFailure({ kind: 'network' }), true);
  for (const statusCode of [408, 429, 500, 503, 599]) assert.equal(isRetryableWebhookFailure({ kind: 'http', statusCode }), true);
  for (const statusCode of [200, 202, 301, 302, 307, 400, 401, 403, 404, 409, 600, NaN, 500.5]) assert.equal(isRetryableWebhookFailure({ kind: 'http', statusCode }), false);
});