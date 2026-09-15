"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), Module = require("node:module");
const ts = require("typescript");
const { reactive } = require("vue");
const { createPinia, setActivePinia } = require("pinia");
function load(file, mocks = {}) {
  const filename = path.resolve(__dirname, "../src", file), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = loaded.require.bind(loaded);
  loaded.require = id => Object.hasOwn(mocks, id) ? mocks[id] : original(id);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: filename,
  }).outputText, filename);
  return loaded.exports;
}
const api = load("services/observability-diagnostics.ts");
const time = "2026-09-14T00:00:00.000Z";
const heartbeat = { evidenceScope: "management_process_store_roundtrip", coverage: "single_lease_holder",
  businessServerLivenessEvaluated: false, reportedState: "reporting", freshnessStatus: "stale",
  lastHeartbeatAt: time, observationAgeMs: 60000 };
const route = { evidenceScope: "local_process_routing_registry", coverage: "single_lease_holder_process",
  businessServerLivenessEvaluated: false, registrationStatus: "no_registered_routes", observerState: "reporting",
  freshnessStatus: "stale", activeRouteCount: 0, observedAt: time };
const servers = () => ({ readAt: time, managementHeartbeat: heartbeat,
  items: [{ runtimeAssetId: "authorized", serverType: "gateway", gatewayRoutingObservation: route }] });
const caps = scope => ({ features: [{ name: "pipelineStatus", state: "enabled", scopeMode: scope }] });
const scan = { evidenceSource: "retention_worker_payload_scan", scope: "recognized_payload_objects_and_temporary_files",
  measurement: "logical_file_length_before_cleanup", scanCoverage: "partial", freshnessStatus: "recent",
  observedBytes: 123, observedFiles: 2, currentTotalBytes: null, scanCompletedAt: time };
const retention = () => ({ evidenceSource: "payload_retention_worker_last_report", cleanupScope: "payload_objects_only",
  state: "degraded", freshnessStatus: "recent", workerConfigured: true, observedAt: time,
  currentAttemptComplete: false, lastAttemptAt: "2026-09-14T00:01:00.000Z", lastReportAt: time,
  lastReport: { scanned: 10, deleted: 3, protected: 0, danglingReferences: null }, scanUsage: scan });
function deferred() { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, request) {
  const auth = reactive({ accessToken: "token-a", currentUser: { id: "user-a" } }), calls = [];
  const source = load("stores/observability-diagnostics.ts", {
    "./auth": { useAuthStore: () => auth },
    "@/services/observability-diagnostics": { ...api, diagnosticsRequest: (...args) => { calls.push(args); return request(...args); } },
  });
  setActivePinia(createPinia()); const store = source.useObservabilityDiagnosticsStore();
  t.after(() => store.deactivate());
  return { store, auth, calls };
}

test("HTTP diagnostics adapter performs authenticated read-only no-store calls", async t => {
  const before = global.fetch; t.after(() => { global.fetch = before; });
  let captured;
  global.fetch = async (url, options) => { captured = { url, options }; return {
    ok: true, json: async () => ({ status: "success", data: servers() }) }; };
  await api.diagnosticsRequest("servers/status", "token", new AbortController().signal);
  assert.equal(captured.url, "/api/monitoring/observability/servers/status");
  assert.equal(captured.options.headers.Authorization, "Bearer token"); assert.equal(captured.options.cache, "no-store");
  assert.equal(captured.options.method, undefined); assert.equal(captured.options.body, undefined);
});

test("evidence views preserve stale, reported stop, zero and unknown without inventing health", () => {
  assert.equal(api.heartbeatEvidence(heartbeat).freshness, "stale");
  assert.equal(api.heartbeatEvidence({ ...heartbeat, reportedState: "stopped" }).state, "stopped");
  assert.equal(api.routingEvidence(route).routeCount, 0);
  assert.equal(api.routingEvidence({ ...route, activeRouteCount: null }).routeCount, null);
  assert.equal(api.routingEvidence({ ...route, activeRouteCount: -1 }).routeCount, null);
  assert.equal(api.routingEvidence({ ...route, evidenceScope: "whole_cluster" }), null);
  assert.equal(api.heartbeatEvidence({ ...heartbeat, businessServerLivenessEvaluated: true }), null);
  assert.equal(api.diagnosticTime("12"), null);
  assert.equal(api.retentionEvidence({ state: "healthy" }), null);
});

test("scoped principal reads authorized routes while global heartbeat and retention remain unknown", async t => {
  const f = fixture(t, async resource => resource === "capabilities" ? caps("scoped") :
    { ...servers(), managementHeartbeat: null });
  await f.store.load();
  assert.equal(f.calls.some(args => args[0] === "pipeline/status"), false);
  assert.equal(f.store.routes[0].runtimeAssetId, "authorized"); assert.equal(f.store.routes[0].evidence.routeCount, 0);
  assert.equal(f.store.heartbeat, null); assert.equal(f.store.retention, null); assert.equal(f.store.pipelineRestricted, true);
});

test("partial failures are isolated by source and a failed reread clears previous data", async t => {
  let failServers = false;
  const f = fixture(t, async resource => {
    if (resource === "capabilities") return caps("all");
    if (resource === "pipeline/status" || failServers) throw new Error("unavailable");
    return servers();
  });
  await f.store.load();
  assert.equal(f.store.errors.pipeline, true); assert.equal(f.store.errors.servers, false);
  assert.equal(f.store.routes.length, 1); assert.equal(f.store.heartbeat.freshness, "stale");
  failServers = true; await f.store.load();
  assert.equal(f.store.errors.servers, true); assert.deepEqual(f.store.routes, []); assert.equal(f.store.readAt, null);
});

test("retention last report counts remain separate from a failed latest attempt and sample is not disk total", async t => {
  const f = fixture(t, async resource => resource === "capabilities" ? caps("all") :
    resource === "servers/status" ? servers() : { retention: retention() });
  await f.store.load();
  const value = f.store.retention;
  assert.equal(value.currentAttemptComplete, false); assert.equal(value.lastReport.deleted, 3);
  assert.equal(value.lastAttemptAt, "2026-09-14T00:01:00.000Z"); assert.equal(value.lastReportAt, time);
  assert.equal(value.scanUsage, null, "a later incomplete attempt cannot reuse an old sample");
  const completed = api.retentionEvidence({ ...retention(), currentAttemptComplete: true });
  assert.equal(completed.scanUsage.observedBytes, 123); assert.equal(completed.scanUsage.coverage, "partial");
  assert.equal("currentTotalBytes" in completed.scanUsage, false);
  assert.equal(api.scanEvidence({ ...scan, observedBytes: null }).observedBytes, null);
  assert.equal(api.retentionEvidence({ ...retention(), cleanupScope: "entire_database" }), null);
});

test("account replacement and component deactivation discard in-flight reports and stop background reads", async t => {
  const pending = deferred();
  const f = fixture(t, async (resource, token) => resource === "capabilities" ? caps("scoped") :
    token === "token-a" ? pending.promise : { ...servers(), items: [] });
  const old = f.store.load();
  f.auth.accessToken = "token-b"; await tick();
  assert.deepEqual(f.store.routes, []);
  pending.resolve(servers()); await old;
  assert.deepEqual(f.store.routes, []);
  f.store.deactivate(); const count = f.calls.length;
  f.auth.accessToken = "token-c"; await tick();
  assert.equal(f.calls.length, count); assert.equal(f.store.heartbeat, null);
});

test("whole refresh timeout aborts pending requests and reports unknown, not old fresh evidence", async t => {
  const original = global.setTimeout;
  global.setTimeout = (callback, ms, ...args) => original(callback, ms === 10000 ? 1 : ms, ...args);
  t.after(() => { global.setTimeout = original; });
  const f = fixture(t, (_resource, _token, signal) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }));
  await f.store.load();
  assert.equal(f.store.loading, false); assert.equal(f.store.errors.servers, true);
  assert.equal(f.store.errors.capabilities, true); assert.deepEqual(f.store.routes, []);
  assert.equal(f.store.heartbeat, null); assert.equal(f.store.retention, null);
});


test("malformed capabilities fail closed without hiding routes and recover on reread", async t => {
  let features = [null, ...caps("all").features];
  const f = fixture(t, async resource => resource === "capabilities" ? { features } :
    resource === "servers/status" ? servers() : { retention: retention() });
  for (const malformed of [features, [42], undefined]) {
    features = malformed;
    await f.store.load();
    assert.equal(f.store.errors.capabilities, true);
    assert.equal(f.store.pipelineRestricted, true);
    assert.equal(f.store.loading, false);
    assert.equal(f.store.routes.length, 1);
    assert.equal(f.store.retention, null);
  }
  assert.equal(f.calls.some(args => args[0] === "pipeline/status"), false);
  features = [...caps("all").features, { name: "future", state: "not_implemented", scopeMode: null }];
  await f.store.load();
  assert.equal(f.store.error, false);
  assert.equal(f.store.pipelineRestricted, false);
  assert.equal(f.store.retention.state, "degraded");
});

test("a stalled servers source cannot consume the pipeline read deadline", async t => {
  const original = global.setTimeout;
  global.setTimeout = (callback, ms, ...args) => original(callback, ms === 10000 ? 10 : ms, ...args);
  t.after(() => { global.setTimeout = original; });
  const f = fixture(t, async (resource, _token, signal) => {
    if (resource === "capabilities") return caps("all");
    if (resource === "pipeline/status") {
      assert.equal(signal.aborted, false, "pipeline must start before the unrelated servers timeout");
      return { evaluatedAt: time, retention: retention() };
    }
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  });
  await f.store.load();
  assert.equal(f.store.errors.servers, true);
  assert.equal(f.store.errors.pipeline, false);
  assert.equal(f.store.retention.state, "degraded");
  assert.equal(f.store.pipelineReadAt, time);
  assert.deepEqual(f.store.routes, []);
});

test("logout discards a late pipeline response and does not start further reads", async t => {
  const pending = deferred();
  const f = fixture(t, async resource => resource === "capabilities" ? caps("all") :
    resource === "servers/status" ? servers() : pending.promise);
  const reading = f.store.load(); await tick();
  assert.equal(f.calls.some(args => args[0] === "pipeline/status"), true);
  f.auth.accessToken = null;
  const count = f.calls.length;
  pending.resolve({ evaluatedAt: time, retention: retention() }); await reading;
  assert.equal(f.calls.length, count);
  assert.equal(f.store.retention, null);
  assert.equal(f.store.pipelineReadAt, null);
  assert.deepEqual(f.store.routes, []);
  assert.equal(f.store.loading, false);
});
