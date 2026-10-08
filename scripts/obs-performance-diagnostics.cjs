'use strict';
// Test-process preload only: no product route, persistence shortcut, or collector invocation.
const { performance, monitorEventLoopDelay, createHistogram } = require('node:perf_hooks');
const path = require('node:path');
require('reflect-metadata');
const { getRuntimeAuditHealth, flushRuntimeAudit } = require('api-nova-parser');
if (!process.send) throw new Error('Performance diagnostics requires its isolated IPC child');
const lag = monitorEventLoopDelay({ resolution: 20 });
lag.enable();
let previous = performance.eventLoopUtilization();
const phases = new Map();
const built = path.join(__dirname, '../packages/api-nova-api/dist/src/modules/call-observability');
for (const [module, type, methods] of [
  ['call-observability.store', 'CallObservabilityStore', ['ingestBatch', 'readSnapshot', 'transaction', 'saveProjection', 'markBucketsForRecompute', 'recomputePendingBuckets']],
  ['call-observability-payload.store', 'CallObservabilityPayloadStore', ['prepare']],
  ['call-observability-outbox.service', 'CallObservabilityOutboxService', ['runOnce']],
  ['call-observability-delivery.worker', 'CallObservabilityDeliveryWorker', ['runOnce']],
  ['../runtime-observability/services/runtime-observability.service', 'RuntimeObservabilityService', ['recordGatewayRequestResult', 'recordGatewayCacheResult']],
]) {
  const prototype = require(path.join(built, module + '.js'))[type].prototype;
  for (const method of methods) {
    const original = prototype[method];
    if (typeof original !== 'function') throw new Error('Missing diagnostic phase ' + type + '.' + method);
    const metric = { histogram: createHistogram(), active: 0 };
    phases.set(type + '.' + method, metric);
    prototype[method] = async function (...args) {
      const start = performance.now(); metric.active++;
      try { return await original.apply(this, args); }
      finally { metric.active--; metric.histogram.record(Math.max(1, Math.round((performance.now() - start) * 1e6))); }
    };
  }
}
// Isolated test child only: count real SQL.js exports without changing persistence.
const sqljsExports = { count: 0, bytes: 0, maxBytes: 0, totalMs: 0, maxMs: 0 };
const factory = require(path.join(__dirname, '../packages/api-nova-api/dist/src/database/sqljs-persistence.js'));
const createSource = factory.createApplicationDataSource;
factory.createApplicationDataSource = function (...args) {
  const source = createSource.apply(this, args);
  if (source.options.type !== 'sqljs') return source;
  const driver = source.driver;
  const create = driver.createDatabaseConnectionWithImport.bind(driver);
  driver.createDatabaseConnectionWithImport = async function (...parameters) {
    const database = await create(...parameters);
    const original = database.export.bind(database);
    database.export = function (...values) {
      const start = performance.now();
      const result = original(...values);
      const duration = performance.now() - start;
      sqljsExports.count++; sqljsExports.bytes += result.byteLength;
      sqljsExports.maxBytes = Math.max(sqljsExports.maxBytes, result.byteLength);
      sqljsExports.totalMs += duration; sqljsExports.maxMs = Math.max(sqljsExports.maxMs, duration);
      return result;
    };
    return database;
  };
  const save = driver.save.bind(driver);
  const metric = { histogram: createHistogram(), active: 0 };
  phases.set('SqljsDriver.save', metric);
  driver.save = async function (...parameters) {
    const start = performance.now(); metric.active++;
    try { return await save(...parameters); }
    finally { metric.active--; metric.histogram.record(Math.max(1, Math.round((performance.now() - start) * 1e6))); }
  };
  return source;
};
function phaseSnapshot() {
  return Object.fromEntries([...phases].map(([name, { histogram: h, active }]) => [name,
    { completed: h.count, active, totalMs: h.count ? h.mean * h.count / 1e6 : 0,
      meanMs: h.count ? h.mean / 1e6 : null, p95Ms: h.count ? h.percentile(95) / 1e6 : null,
      maxMs: h.count ? h.max / 1e6 : null }]));
}
function snapshot(id) {
  const current = performance.eventLoopUtilization();
  const data = { type: 'obs-perf-health', id, at: Date.now(), health: getRuntimeAuditHealth(),
    memory: process.memoryUsage(), sqljsExports: { ...sqljsExports }, phases: phaseSnapshot(), eventLoop: { ...performance.eventLoopUtilization(current, previous),
      delayP95Ms: Number.isFinite(lag.mean) ? lag.percentile(95) / 1e6 : null } };
  previous = current; lag.reset();
  if (process.connected) process.send(data, () => {});
}
const timer = setInterval(() => snapshot(), 1000);
timer.unref();
process.on('message', async message => {
  if (message?.type !== 'obs-perf-diagnostics') return;
  if (message.command === 'flush') {
    await flushRuntimeAudit();
    snapshot(message.id);
  } else if (message.command === 'snapshot') snapshot(message.id);
  else if (message.command === 'shutdown') {
    clearInterval(timer); lag.disable();
    // Runs the actual main.ts shutdown handler on Windows as well as POSIX.
    process.emit('SIGTERM');
  }
});
