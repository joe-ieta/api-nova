'use strict';
process.env.DB_TYPE = 'sqlite';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const path = require('node:path');
require('ts-node').register({ transpileOnly: true, project: path.join(__dirname, '../tsconfig.json') });
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(name, ...args) {
  if (name === 'api-nova-parser') return path.resolve(__dirname, '../../api-nova-parser/src/index.ts');
  return originalResolve.call(this, name, ...args);
};
const { resolveObservabilityWebhookSecret, createObservabilityWebhookSecretResolver } =
  require('../src/modules/call-observability/call-observability-webhook-secret-resolver');
const { CallObservabilityWebhookWorker } =
  require('../src/modules/call-observability/call-observability-webhook.worker');
const { CallObservabilityWebhookSender } =
  require('../src/modules/call-observability/call-observability-webhook-sender');
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const requestContext = overrides => ({
  ownerId: 'owner-a', subscriptionId: 'subscription-a', revision: 2,
  secretRef: 'webhook/key-a', signingKeyId: 'key-a', ...overrides,
});
const senderContext = overrides => ({
  ownerId: 'owner-a', subscriptionId: 'subscription-a', subscriptionRevision: 2,
  secretRef: 'webhook/key-a', signingKeyId: 'key-a', signal: new AbortController().signal, ...overrides,
});
const zero = bytes => assert.ok(bytes.every(value => value === 0), 'owned key bytes must be wiped');
function safeError(code) {
  return error => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(error.cause, undefined);
    assert.ok(!JSON.stringify(error).includes('secret-marker'));
    return true;
  };
}
test('secret resolver authorizes freshly on every call, transfers copies and disposes idempotently', async () => {
  const calls = [], buffers = [];
  const backend = { resolveAuthorized: async context => {
    calls.push(context);
    const ownedBytes = new Uint8Array(32).fill(calls.length);
    buffers.push(ownedBytes);
    return { signingKeyId: 'key-a', ownedBytes };
  } };
  const first = await resolveObservabilityWebhookSecret(requestContext(), backend);
  const second = await resolveObservabilityWebhookSecret(requestContext(), backend);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], requestContext({ signal: undefined }));
  assert.ok(Object.isFrozen(calls[0]));
  assert.ok(first.ownedBytes.every(x => x === 1));
  assert.ok(second.ownedBytes.every(x => x === 2));
  buffers.forEach(zero);
  assert.notEqual(first.ownedBytes, second.ownedBytes);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), { signingKeyId: 'key-a' });
  first.dispose(); first.dispose(); second.dispose();
  zero(first.ownedBytes); zero(second.ownedBytes);
});
test('secret context is snapshotted before the deferred backend invocation', async () => {
  const request = requestContext();
  let observed;
  const promise = resolveObservabilityWebhookSecret(request, { resolveAuthorized: async input => {
    observed = input;
    return { signingKeyId: 'key-a', ownedBytes: new Uint8Array(32).fill(3) };
  } });
  request.ownerId = 'other-owner'; request.revision = 99;
  const secret = await promise;
  assert.equal(observed.ownerId, 'owner-a');
  assert.equal(observed.revision, 2);
  secret.dispose();
});
test('wrong key ID fails closed and clears backend-owned bytes', async () => {
  const bytes = new Uint8Array(32).fill(7);
  await assert.rejects(resolveObservabilityWebhookSecret(requestContext(), {
    resolveAuthorized: async () => ({ signingKeyId: 'wrong-key', ownedBytes: bytes }),
  }), safeError('WEBHOOK_SECRET_UNAVAILABLE'));
  zero(bytes);
});
for (const length of [0, 1, 31, 4097]) {
  test('rejects secret length ' + length + ' and clears backend bytes', async () => {
    const bytes = new Uint8Array(length).fill(9);
    await assert.rejects(resolveObservabilityWebhookSecret(requestContext(), {
      resolveAuthorized: async () => ({ signingKeyId: 'key-a', ownedBytes: bytes }),
    }), safeError('WEBHOOK_SECRET_UNAVAILABLE'));
    zero(bytes);
  });
}
for (const length of [32, 4096]) {
  test('accepts secret length boundary ' + length + ', then disposes', async () => {
    const bytes = new Uint8Array(length).fill(11);
    const result = await resolveObservabilityWebhookSecret(requestContext(), {
      resolveAuthorized: async () => ({ signingKeyId: 'key-a', ownedBytes: bytes }),
    });
    assert.equal(result.ownedBytes.length, length);
    assert.ok(result.ownedBytes.every(x => x === 11));
    zero(bytes); result.dispose(); zero(result.ownedBytes);
  });
}
test('invalid contexts fail before backend authorization', async () => {
  let calls = 0;
  const backend = { resolveAuthorized: async () => { calls++; throw new Error('must not execute'); } };
  for (const changes of [{ ownerId: '' }, { subscriptionId: 'x\r\nsecret-marker' },
    { revision: 0 }, { revision: 1.5 }, { secretRef: '' }, { signingKeyId: 'key with spaces' }]) {
    await assert.rejects(resolveObservabilityWebhookSecret(requestContext(changes), backend),
      safeError('INVALID_WEBHOOK_SECRET_CONTEXT'));
  }
  assert.equal(calls, 0);
});
for (const synchronous of [true, false]) {
  test('backend ' + (synchronous ? 'throw' : 'rejection') + ' never exposes original exception', async () => {
    const error = new Error('secret-marker');
    const backend = { resolveAuthorized: () => {
      if (synchronous) throw error;
      return Promise.reject(error);
    } };
    await assert.rejects(resolveObservabilityWebhookSecret(requestContext(), backend),
      safeError('WEBHOOK_SECRET_UNAVAILABLE'));
  });
}
test('abort before execution skips backend and removes no unrelated listeners', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(resolveObservabilityWebhookSecret(requestContext({ signal: controller.signal }), {
    resolveAuthorized: async () => { calls++; return null; },
  }), safeError('WEBHOOK_SECRET_ABORTED'));
  assert.equal(calls, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
test('abort in flight rejects promptly and wipes late backend success', async () => {
  const pending = deferred(), entered = deferred(), controller = new AbortController();
  const bytes = new Uint8Array(48).fill(12);
  const promise = resolveObservabilityWebhookSecret(requestContext({ signal: controller.signal }), {
    resolveAuthorized: input => { assert.equal(input.signal, controller.signal); entered.resolve(); return pending.promise; },
  });
  const rejected = assert.rejects(promise, safeError('WEBHOOK_SECRET_ABORTED'));
  await entered.promise; controller.abort(); await rejected;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  pending.resolve({ signingKeyId: 'key-a', ownedBytes: bytes });
  await flush(); zero(bytes);
});
test('late backend rejection after abort is consumed', async () => {
  const pending = deferred(), entered = deferred(), controller = new AbortController();
  const promise = resolveObservabilityWebhookSecret(requestContext({ signal: controller.signal }), {
    resolveAuthorized: () => { entered.resolve(); return pending.promise; },
  });
  const rejected = assert.rejects(promise, safeError('WEBHOOK_SECRET_ABORTED'));
  await entered.promise; controller.abort(); await rejected;
  pending.reject(new Error('secret-marker'));
  await flush();
});
test('successful resolution removes abort listener; caller owns lifetime until dispose', async () => {
  const controller = new AbortController();
  const result = await resolveObservabilityWebhookSecret(requestContext({ signal: controller.signal }), {
    resolveAuthorized: async () => ({ signingKeyId: 'key-a', ownedBytes: new Uint8Array(32).fill(6) }),
  });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort();
  assert.ok(result.ownedBytes.every(x => x === 6));
  result.dispose(); zero(result.ownedBytes);
});
test('bridge translates revision and returns independent sender-owned bytes', async () => {
  const backendBytes = new Uint8Array(32).fill(10);
  let observed;
  const bridge = createObservabilityWebhookSecretResolver({ resolveAuthorized: async input => {
    observed = input; return { signingKeyId: 'key-a', ownedBytes: backendBytes };
  } });
  const input = senderContext();
  const bytes = await bridge(input);
  assert.equal(observed.revision, 2);
  assert.equal(observed.subscriptionRevision, undefined);
  assert.equal(observed.ownerId, input.ownerId);
  assert.equal(observed.signal, input.signal);
  assert.ok(bytes.every(x => x === 10));
  zero(backendBytes);
  bytes.fill(0);
});
test('bridge abort late success clears transferred backend bytes', async () => {
  const pending = deferred(), entered = deferred(), controller = new AbortController();
  const bytes = new Uint8Array(32).fill(13);
  const bridge = createObservabilityWebhookSecretResolver({ resolveAuthorized: () => {
    entered.resolve(); return pending.promise;
  } });
  const result = bridge(senderContext({ signal: controller.signal }));
  const rejected = assert.rejects(result, safeError('WEBHOOK_SECRET_ABORTED'));
  await entered.promise; controller.abort(); await rejected;
  pending.resolve({ signingKeyId: 'key-a', ownedBytes: bytes });
  await flush(); zero(bytes);
});
for (const outcome of ['success', 'send-throws', 'stale']) {
  test('actual sender releases bridge bytes on ' + outcome, async () => {
    const backendBytes = new Uint8Array(32).fill(15);
    const bridge = createObservabilityWebhookSecretResolver({ resolveAuthorized: async () =>
      ({ signingKeyId: 'key-a', ownedBytes: backendBytes }) });
    let supplied, reads = 0, sends = 0, completed;
    const lease = { deliveryId: 'delivery-a', token: 'token-a', version: 1, attemptNo: 1,
      eventId: 'event-a', subscriptionId: 'subscription-a', subscriptionRevision: 2,
      startedAt: new Date().toISOString(), leaseUntil: new Date(Date.now() + 30000).toISOString() };
    const context = { ownerId: 'owner-a', destination: 'https://hooks.acme.com/events',
      secretRef: 'webhook/key-a', signingKeyId: 'key-a', event: {
        id: 'event-a', sequence: '00000000000000000001', eventName: 'invocation.completed',
        occurredAt: new Date(), createdAt: new Date(), runtimeAssetId: 'asset-a',
        subjectId: 'invocation-a', subjectVersion: 1, severity: 'info', details: {}, dimensions: {},
      } };
    const sender = new CallObservabilityWebhookSender({
      claim: async () => ({ leases: [lease] }),
      readForSend: async () => { reads++; return outcome === 'stale' && reads === 2 ? null : context; },
      complete: async (_lease, result) => { completed = result; return true; },
    }, {
      allowedOrigins: ['https://hooks.acme.com'],
      resolveAll: async () => [{ address: '8.8.8.8', family: 4 }],
      resolveSecret: async input => { supplied = await bridge(input); return supplied; },
      send: async () => {
        sends++; assert.ok(supplied.every(x => x === 15));
        if (outcome === 'send-throws') throw new Error('secret-marker');
        return { kind: 'success', httpStatus: 202 };
      },
    });
    const result = await sender.runOnce(1);
    zero(backendBytes); assert.ok(supplied); zero(supplied);
    if (outcome === 'stale') { assert.equal(sends, 0); assert.equal(result.stale, 1); }
    else { assert.equal(sends, 1); assert.equal(completed.kind, outcome === 'success' ? 'success' : 'failure'); }
  });
}
async function schedulerTest(callback) {
  const originalSet = global.setTimeout, originalClear = global.clearTimeout;
  const pending = new Map(), workers = [];
  let scheduled = 0;
  global.setTimeout = (fn, delay) => {
    const timer = { unref() { return this; } };
    scheduled++; pending.set(timer, { fn, delay }); return timer;
  };
  global.clearTimeout = timer => { pending.delete(timer); };
  const api = {
    create(enabled, sender) {
      const worker = new CallObservabilityWebhookWorker({ get: () => enabled }, sender);
      workers.push(worker); return worker;
    },
    count: () => pending.size,
    scheduled: () => scheduled,
    fire() {
      assert.equal(pending.size, 1, 'one pending scheduler timer');
      const [timer, entry] = pending.entries().next().value;
      pending.delete(timer); assert.equal(entry.delay, 1000); entry.fn();
    },
  };
  try { await callback(api); }
  finally {
    // Cases must release their own active barriers before returning.
    await Promise.all(workers.map(worker => worker.stop()));
    global.setTimeout = originalSet; global.clearTimeout = originalClear;
  }
}
test('worker defaults disabled and only explicit string true enables scheduling', async () => {
  await schedulerTest(async clock => {
    for (const enabled of [undefined, false, true, 'false', 'TRUE', '1']) {
      const worker = clock.create(enabled, { runOnce: () => assert.fail('must remain disabled') });
      worker.onModuleInit();
      assert.equal(worker.getStatus().state, 'disabled');
      assert.equal(clock.count(), 0);
    }
  });
});
test('enabled worker without usable sender reports blocked', async () => {
  await schedulerTest(async clock => {
    for (const sender of [undefined, {}, { runOnce: false }]) {
      const worker = clock.create('true', sender); worker.start();
      assert.equal(worker.getStatus().state, 'blocked');
      assert.equal(clock.count(), 0);
    }
  });
});
test('duplicate start creates one timer and stop cancels pending work', async () => {
  await schedulerTest(async clock => {
    let calls = 0;
    const worker = clock.create('true', { runOnce: async () => { calls++; } });
    worker.start(); worker.start(); worker.onModuleInit();
    assert.equal(clock.count(), 1); assert.equal(clock.scheduled(), 1);
    await worker.onModuleDestroy();
    assert.equal(clock.count(), 0); assert.equal(calls, 0);
    assert.equal(worker.getStatus().state, 'stopped');
  });
});
test('worker never overlaps; repeated stop waits for active call and ignores start during drain', async () => {
  await schedulerTest(async clock => {
    const pending = deferred();
    let calls = 0;
    const worker = clock.create('true', { runOnce: async limit => {
      assert.equal(limit, 1); calls++; await pending.promise;
    } });
    worker.start(); clock.fire(); await flush();
    try {
      assert.equal(worker.getStatus().active, true);
      assert.equal(clock.count(), 0);
      worker.start(); assert.equal(calls, 1);
      const first = worker.stop(), second = worker.stop();
      assert.equal(first, second);
      let stopped = false; first.then(() => { stopped = true; });
      worker.start(); await flush();
      assert.equal(stopped, false); assert.equal(clock.count(), 0);
      assert.equal(worker.getStatus().state, 'stopped');
      pending.resolve(); await first;
      assert.equal(worker.getStatus().active, false);
      assert.equal(clock.count(), 0);
      worker.start(); assert.equal(clock.count(), 1);
    } finally { pending.resolve(); }
  });
});
for (const synchronous of [true, false]) {
  test('worker sanitizes ' + (synchronous ? 'synchronous' : 'async') + ' failure and recovers next run', async () => {
    await schedulerTest(async clock => {
      let calls = 0;
      const worker = clock.create('true', { runOnce: () => {
        calls++;
        if (calls === 1) {
          if (synchronous) throw new Error('secret-marker');
          return Promise.reject(new Error('secret-marker'));
        }
        return Promise.resolve();
      } });
      worker.start(); clock.fire(); await flush();
      assert.deepEqual(worker.getStatus(), {
        state: 'running', active: false, lastRunFailed: true, runCount: 1, failedRunCount: 1,
      });
      assert.ok(!JSON.stringify(worker.getStatus()).includes('secret-marker'));
      assert.equal(clock.count(), 1);
      clock.fire(); await flush();
      assert.equal(worker.getStatus().lastRunFailed, false);
      assert.equal(worker.getStatus().runCount, 2);
      assert.equal(worker.getStatus().failedRunCount, 1);
    });
  });
}
test('worker detects missing sender at scheduled execution and blocks without throwing', async () => {
  await schedulerTest(async clock => {
    const sender = { runOnce: async () => assert.fail('removed dependency') };
    const worker = clock.create('true', sender); worker.start();
    delete sender.runOnce; clock.fire(); await flush();
    assert.equal(worker.getStatus().state, 'blocked');
    assert.equal(worker.getStatus().runCount, 0);
    assert.equal(clock.count(), 0);
  });
});
