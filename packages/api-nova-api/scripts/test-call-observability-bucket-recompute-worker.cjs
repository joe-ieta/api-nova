'use strict';
require('ts-node').register({ project: require('node:path').resolve(__dirname, '../tsconfig.json'), transpileOnly: true,
 compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true } });
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay, setImmediate: turn } = require('node:timers/promises');
const { CallObservabilityBucketRecomputeWorker: Worker } = require('../src/modules/call-observability/call-observability-bucket-recompute.worker.ts');
const report = { claimed: 0, completed: 0, superseded: 0, failed: 0, failures: [] };
test('aggregation scheduling defaults off and accepts only literal string true', async () => {
 for (const value of [undefined, null, false, true, 'false', 'TRUE', '1', ' true ']) {
  let calls = 0;
  const worker = new Worker({ runOnce: async () => { calls++; return report; } }, { get: () => value }, 10);
  worker.onModuleInit(); await turn(); assert.equal(calls, 0); assert.equal(worker.status.enabled, false);
  await worker.onModuleDestroy();
 }
});
test('enabled worker starts once, does not overlap, and shutdown waits for active batch', async () => {
 let calls = 0, finish;
 const batch = new Promise(resolve => { finish = resolve; });
 const worker = new Worker({ runOnce: async () => { calls++; await batch; return report; } }, { get: () => 'true' }, 10);
 worker.onModuleInit(); worker.onModuleInit(); await turn(); assert.equal(calls, 1);
 await delay(25); assert.equal(calls, 1); assert.equal(worker.status.running, true);
 let stopped = false;
 const stop = worker.onModuleDestroy().then(() => { stopped = true; });
 await turn(); assert.equal(stopped, false);
 finish(); await stop; assert.equal(stopped, true); assert.equal(worker.status.running, false);
 await delay(25); assert.equal(calls, 1);
});
test('shutdown clears the next scheduled batch', async () => {
 let calls = 0;
 const worker = new Worker({ runOnce: async () => { calls++; return report; } }, { get: () => 'true' }, 100);
 worker.onModuleInit(); await turn(); await worker.onModuleDestroy(); await delay(125); assert.equal(calls, 1);
});
test('failed batch is caught and a later scheduled batch can recover', async () => {
 let calls = 0;
 const worker = new Worker({ runOnce: async () => { if (++calls === 1) throw Error('database unavailable'); return report; } }, { get: () => 'true' }, 10);
 worker.onModuleInit(); await turn(); assert.equal(worker.status.lastRunFailed, true);
 try {
  for (let i = 0; i < 30 && calls < 2; i++) await delay(10);
  assert.ok(calls >= 2); assert.equal(worker.status.lastRunFailed, false);
 } finally { await worker.onModuleDestroy(); }
});
