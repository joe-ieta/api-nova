'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, getEventListeners } = require('node:events');
const { PassThrough } = require('node:stream');
const path = require('node:path');
require('ts-node').register({ transpileOnly: true, project: path.join(__dirname, '../tsconfig.json') });
const { sendObservabilityWebhook, WEBHOOK_TRANSPORT_LIMITS } =
  require('../src/modules/call-observability/call-observability-webhook-transport');
const { prepareObservabilityWebhookDestination } =
  require('../src/modules/call-observability/call-observability-webhook-destination');
const { buildObservabilityWebhookRequestContent } =
  require('../src/modules/call-observability/call-observability-webhook-signature');
async function prepared(ip = '8.8.8.8', family = 4) {
  const destination = await prepareObservabilityWebhookDestination({
    url: 'https://hooks.acme.com:8443/events', allowedOrigins: ['https://hooks.acme.com:8443'],
  }, async () => [{ address: ip, family }]);
  const content = buildObservabilityWebhookRequestContent({
    timestamp: '1789000000', eventId: 'event-a', deliveryId: 'delivery-a', signingKeyId: 'key-a',
    rawBody: Buffer.from('{ "eventId" : "event-a", "data": {"ok":true} }\n'),
  }, Buffer.alloc(32, 7));
  return { destination, content };
}
function fakeRequest(behavior) {
  const state = { calls: 0, destroyCalls: 0 };
  state.request = (options, callback) => {
    state.calls++;
    state.options = options;
    const req = new EventEmitter();
    state.req = req;
    req.destroy = () => { state.destroyCalls++; return req; };
    req.end = body => {
      state.body = Buffer.from(body);
      queueMicrotask(() => behavior?.(state, callback));
      return req;
    };
    return req;
  };
  return state;
}
function reply(state, callback, status = 200, headers = {}) {
  const response = new PassThrough();
  response.statusCode = status;
  response.headers = headers;
  response.rawHeaders = Object.entries(headers).flatMap(([name, value]) => [name, value]);
  state.response = response;
  callback(response);
  return response;
}
async function timerEvidence(operation) {
  const originalSet = global.setTimeout, originalClear = global.clearTimeout;
  const created = [], cleared = [];
  global.setTimeout = (callback, ms, ...args) => {
    const timer = originalSet(callback, ms, ...args);
    created.push({ timer, ms });
    return timer;
  };
  global.clearTimeout = timer => { cleared.push(timer); return originalClear(timer); };
  try {
    const result = await operation();
    assert.equal(created.length, 1);
    assert.ok(cleared.includes(created[0].timer), 'total timer must be cleared on settlement');
    return { result, duration: created[0].ms };
  } finally { global.setTimeout = originalSet; global.clearTimeout = originalClear; }
}
test('pins IPv4, exact bytes, Host, SNI and original-host TLS certificate validation', async () => {
  const { destination, content } = await prepared();
  const state = fakeRequest((s, callback) => reply(s, callback).end('not retained'));
  const controller = new AbortController();
  const { result, duration } = await timerEvidence(() => sendObservabilityWebhook(destination, content,
    { request: state.request, signal: controller.signal }));
  assert.deepEqual(result, { kind: 'success', httpStatus: 200 });
  assert.equal(duration, 10000);
  assert.equal(state.calls, 1);
  assert.deepEqual(state.body, content.body);
  assert.equal(state.options.hostname, '8.8.8.8');
  assert.equal(state.options.port, 8443);
  assert.equal(state.options.family, 4);
  assert.equal(state.options.servername, 'hooks.acme.com');
  assert.equal(state.options.headers.Host, 'hooks.acme.com:8443');
  assert.equal(state.options.agent, false);
  assert.equal(state.options.rejectUnauthorized, true);
  assert.equal(state.options.protocol, 'https:');
  assert.equal(state.options.path, '/events');
  assert.equal(state.options.method, 'POST');
  assert.equal(state.options.maxHeaderSize, 16384);
  assert.equal(state.options.lookup, undefined);
  assert.equal(state.options.checkServerIdentity('8.8.8.8', { subjectaltname: 'DNS:hooks.acme.com' }), undefined);
  assert.ok(state.options.checkServerIdentity('8.8.8.8', { subjectaltname: 'IP Address:8.8.8.8' }) instanceof Error);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.ok(state.response.destroyed);
  assert.ok(state.destroyCalls > 0);
});
test('pins IPv6 without dropping original-host TLS verification', async () => {
  const { destination, content } = await prepared('2606:4700:4700::1111', 6);
  const state = fakeRequest((s, callback) => reply(s, callback, 202).end());
  assert.deepEqual(await sendObservabilityWebhook(destination, content, { request: state.request }),
    { kind: 'success', httpStatus: 202 });
  assert.equal(state.options.hostname, '2606:4700:4700::1111');
  assert.equal(state.options.family, 6);
  assert.equal(state.options.servername, 'hooks.acme.com');
});
test('does not forward injected proxy/custom headers', async () => {
  const { destination, content } = await prepared();
  const state = fakeRequest((s, callback) => reply(s, callback).end());
  const oldProxy = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9999';
  try {
    await sendObservabilityWebhook(destination, { ...content, headers: {
      ...content.headers, Authorization: 'do-not-send', Host: 'other.host', 'Proxy-Authorization': 'do-not-send',
    } }, { request: state.request });
    assert.equal(state.options.headers.Authorization, undefined);
    assert.equal(state.options.headers['Proxy-Authorization'], undefined);
    assert.equal(state.options.headers.Host, destination.hostHeader);
    assert.equal(state.options.hostname, destination.connection.host);
  } finally {
    if (oldProxy === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = oldProxy;
  }
});
for (const status of [302, 400, 408, 429, 503]) {
  test('HTTP ' + status + ' is returned once without retries/redirects, with Retry-After', async () => {
    const { destination, content } = await prepared();
    const state = fakeRequest((s, callback) => reply(s, callback, status, {
      'retry-after': '120', location: 'https://different.host/secret',
    }).end('private response'));
    const { result } = await timerEvidence(() => sendObservabilityWebhook(destination, content, { request: state.request }));
    assert.deepEqual(result, { kind: 'failure', reason: 'http', httpStatus: status, retryAfter: '120' });
    assert.equal(state.calls, 1);
    assert.ok(!JSON.stringify(result).includes('private'));
    assert.ok(!JSON.stringify(result).includes('different.host'));
  });
}
test('bounded drain stops a large 2xx response without retaining body or retrying acknowledgement', async () => {
  const { destination, content } = await prepared();
  const state = fakeRequest((s, callback) => {
    const response = reply(s, callback);
    response.write(Buffer.alloc(WEBHOOK_TRANSPORT_LIMITS.maxResponseBytes, 120));
    // No end: reaching the cap must settle and destroy.
  });
  const { result } = await timerEvidence(() => sendObservabilityWebhook(destination, content, { request: state.request }));
  assert.deepEqual(result, { kind: 'success', httpStatus: 200 });
  assert.ok(state.response.destroyed);
  assert.equal(state.response.listenerCount('data'), 0);
  assert.deepEqual(Object.keys(result).sort(), ['httpStatus', 'kind']);
});
test('ignores duplicate or oversized Retry-After; preserves a valid HTTP date', async () => {
  const { destination, content } = await prepared();
  for (const [value, duplicate, expected] of [
    ['x'.repeat(129), false, undefined],
    ['1', true, undefined],
    ['Wed, 21 Oct 2030 07:28:00 GMT', false, 'Wed, 21 Oct 2030 07:28:00 GMT'],
  ]) {
    const state = fakeRequest((s, callback) => {
      const response = new PassThrough();
      response.statusCode = 429;
      response.headers = { 'retry-after': value };
      response.rawHeaders = ['Retry-After', value, ...(duplicate ? ['Retry-After', '2'] : [])];
      s.response = response;
      callback(response);
      response.end();
    });
    const result = await sendObservabilityWebhook(destination, content, { request: state.request });
    assert.equal(result.retryAfter, expected);
  }
});
test('network error is sanitized and clears timer', async () => {
  const { destination, content } = await prepared();
  const state = fakeRequest(s => s.req.emit('error', new Error('secret path certificate detail')));
  const { result } = await timerEvidence(() => sendObservabilityWebhook(destination, content, { request: state.request }));
  assert.deepEqual(result, { kind: 'failure', reason: 'network' });
  state.req.emit('error', new Error('late error'));
});
test('synchronous request construction failure is sanitized and clears timer', async () => {
  const { destination, content } = await prepared();
  const { result } = await timerEvidence(() => sendObservabilityWebhook(destination, content,
    { request: () => { throw new Error('secret'); } }));
  assert.deepEqual(result, { kind: 'failure', reason: 'network' });
});
test('remaining deadline covers response stalls and clears timer', async () => {
  const { destination, content } = await prepared();
  const state = fakeRequest((s, callback) => reply(s, callback, 200));
  const { result, duration } = await timerEvidence(() => sendObservabilityWebhook(destination, content,
    { request: state.request, timeoutMs: 15 }));
  assert.deepEqual(result, { kind: 'failure', reason: 'timeout' });
  assert.equal(duration, 15);
  assert.ok(state.response.destroyed);
});
test('pre-abort and exhausted sender budget create no request', async () => {
  const { destination, content } = await prepared();
  const controller = new AbortController();
  controller.abort();
  const state = fakeRequest();
  assert.deepEqual(await sendObservabilityWebhook(destination, content,
    { request: state.request, signal: controller.signal }), { kind: 'failure', reason: 'timeout' });
  assert.deepEqual(await sendObservabilityWebhook(destination, content,
    { request: state.request, timeoutMs: 0 }), { kind: 'failure', reason: 'timeout' });
  assert.equal(state.calls, 0);
});
test('abort in flight closes request and removes abort listener', async () => {
  const { destination, content } = await prepared();
  const controller = new AbortController();
  const state = fakeRequest(() => controller.abort());
  const { result } = await timerEvidence(() => sendObservabilityWebhook(destination, content,
    { request: state.request, signal: controller.signal }));
  assert.deepEqual(result, { kind: 'failure', reason: 'timeout' });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.ok(state.destroyCalls > 0);
});
test('truncated response is network failure and releases resources', async () => {
  const { destination, content } = await prepared();
  const state = fakeRequest((s, callback) => {
    const response = reply(s, callback, 200);
    response.emit('aborted');
  });
  const { result } = await timerEvidence(() => sendObservabilityWebhook(destination, content, { request: state.request }));
  assert.deepEqual(result, { kind: 'failure', reason: 'network' });
  assert.ok(state.response.destroyed);
});
test('invalid prepared input does not create a request or expose input', async () => {
  const { destination, content } = await prepared();
  const state = fakeRequest();
  await assert.rejects(sendObservabilityWebhook(destination, { ...content,
    headers: { ...content.headers, 'Content-Length': '999' } }, { request: state.request }),
  /INVALID_WEBHOOK_TRANSPORT_INPUT/);
  await assert.rejects(sendObservabilityWebhook(destination, content,
    { request: state.request, timeoutMs: 10001 }), /INVALID_WEBHOOK_TRANSPORT_INPUT/);
  await assert.rejects(sendObservabilityWebhook({ ...destination, connection: {
    ...destination.connection, host: '127.0.0.1' } }, content, { request: state.request }),
  /INVALID_WEBHOOK_TRANSPORT_INPUT/);
  assert.equal(state.calls, 0);
});
test('body snapshot is stable if caller mutates its buffer after invocation', async () => {
  const { destination, content } = await prepared();
  const expected = Buffer.from(content.body);
  const state = fakeRequest((s, callback) => reply(s, callback).end());
  const result = sendObservabilityWebhook(destination, content, { request: state.request });
  content.body.fill(0);
  assert.equal((await result).kind, 'success');
  assert.deepEqual(state.body, expected);
});

test('default request capability is native https.request (intercepted, no network)', async () => {
  const https = require('node:https');
  const original = https.request;
  const { destination, content } = await prepared();
  const state = fakeRequest((s, callback) => reply(s, callback).end());
  https.request = state.request;
  try {
    assert.deepEqual(await sendObservabilityWebhook(destination, content),
      { kind: 'success', httpStatus: 200 });
    assert.equal(state.calls, 1);
  } finally { https.request = original; }
});
test('external business context is preserved without creating any audit invocation', async () => {
  const audit = require('../../api-nova-parser/src/audit/runtime-call-audit');
  const { destination, content } = await prepared();
  const state = fakeRequest((s, callback) => reply(s, callback).end());
  const context = { transport: 'gateway', requestId: 'business-a', traceId: 'trace-a',
    parentInvocationId: 'parent-a', origin: 'external', identitySource: 'authenticated' };
  const before = audit.getRuntimeAuditHealth();
  await audit.withRuntimeCallContext(context, async () => {
    assert.equal((await sendObservabilityWebhook(destination, content, { request: state.request })).kind, 'success');
    assert.equal(audit.getRuntimeCallContext(), context);
  });
  const after = audit.getRuntimeAuditHealth();
  assert.equal(after.activeCalls, before.activeCalls);
  assert.equal(after.pendingWrites, before.pendingWrites);
  assert.equal(after.writtenRecords, before.writtenRecords);
  assert.equal(after.droppedRecords, before.droppedRecords);
});

