"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const { createPinia, setActivePinia } = require("pinia");
const { reactive } = require("vue");

function load(relative, overrides = {}) {
  const filename = path.resolve(__dirname, "../src", relative);
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filename,
  }).outputText;
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = loaded.require.bind(loaded);
  loaded.require = id => Object.hasOwn(overrides, id) ? overrides[id] :
    id === "@/services/gateway-invocations" ? load("services/gateway-invocations.ts") :
    id === "./auth" ? { useAuthStore: () => reactive({ accessToken: "token", currentUser: { id: "user" } }) } : original(id);
  loaded._compile(compiled, filename);
  return loaded.exports;
}
const stream = load("services/observability-stream.ts");
class Socket {
  handlers = new Map();
  emitted = [];
  disconnected = false;
  on(name, cb) { this.handlers.set(name, cb); }
  emit(name, data) { this.emitted.push({ name, data }); }
  connect() {}
  disconnect() { this.disconnected = true; }
  removeAllListeners() { this.handlers.clear(); }
  fire(name, ...args) { return this.handlers.get(name)?.(...args); }
}
const snapshot = seq => ({ invocationSnapshotAuthorized: true,
  invocationSnapshotScope: "invocation_facts_only", invocationSnapshotSeq: String(seq),
  businessSummary: { metrics: { selectedInvocations: 2, failures: 1 } } });
const item = seq => ({ eventId: "event-" + seq, sequence: String(seq),
  eventType: "invocation.completed", occurredAt: new Date().toISOString(), server: { runtimeAssetId: "asset-a" } });
const page = (cursor, items = []) => ({ status: "success", data: { nextCursor: cursor, items } });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture(t, overrides = {}) {
  const sockets = [], snapshots = [], pages = [], states = [], tokens = [];
  let resets = 0;
  const client = new stream.ObservabilityStreamClient({
    socket(token) { tokens.push(token); const socket = new Socket(); sockets.push(socket); return socket; },
    snapshot: async () => snapshot(20),
    snapshotReceived: value => snapshots.push(value), pageReceived: value => { pages.push(value); },
    reset: () => resets++, state: (status, error) => states.push({ status, error }), retryDelayMs: 0,
    ...overrides,
  });
  t.after(() => client.stop());
  return { client, sockets, snapshots, pages, states, tokens, resets: () => resets };
}

test("authorized snapshot starts exact external stream and ACK follows the completed consumer", async t => {
  const pending = deferred();
  const f = fixture(t, { pageReceived: () => pending.promise });
  f.client.setSession("token-a", "user-a");
  await f.sockets[0].fire("connect");
  assert.deepEqual(f.tokens, ["token-a"]);
  assert.deepEqual(f.sockets[0].emitted, [{ name: "subscribe-observability", data: { afterSequence: "20", origin: "external" } }]);
  const acks = [];
  const processing = f.sockets[0].fire("observability-event", page("signed-cursor", [item(21)]), value => acks.push(value));
  assert.deepEqual(acks, []);
  pending.resolve();
  await processing;
  assert.deepEqual(acks, [{ nextCursor: "signed-cursor" }]);
  assert.equal(f.states.at(-1).status, "live");
});

test("reconnect resumes only the processed signed cursor without fetching a fresh snapshot", async t => {
  let reads = 0;
  const f = fixture(t, { snapshot: async () => { reads++; return snapshot(20); } });
  f.client.setSession("token-a", "user-a");
  await f.sockets[0].fire("connect");
  await f.sockets[0].fire("observability-event", page("processed"), () => {});
  f.sockets[0].fire("disconnect");
  await tick();
  await f.sockets[1].fire("connect");
  assert.deepEqual(f.sockets[1].emitted[0].data, { after: "processed" });
  assert.equal(reads, 1);
});

test("failed page processing and malformed frames never advance the checkpoint", async t => {
  let fail = false;
  const f = fixture(t, { pageReceived: () => { if (fail) throw new Error("consumer failed"); } });
  f.client.setSession("token", "user");
  await f.sockets[0].fire("connect");
  await f.sockets[0].fire("observability-event", page("safe"), () => {});
  fail = true;
  let acked = false;
  await f.sockets[0].fire("observability-event", page("unsafe"), () => { acked = true; });
  await tick(); await f.sockets[1].fire("connect");
  assert.equal(acked, false); assert.deepEqual(f.sockets[1].emitted[0].data, { after: "safe" });
  await f.sockets[1].fire("observability-event", { status: "success", data: { items: [], nextCursor: "" } }, () => { acked = true; });
  assert.equal(acked, false); assert.equal(f.states.at(-1).error, "INVALID_PAGE");
});

test("logout and principal replacement discard pending snapshots, cursors and late ACKs", async t => {
  const request = deferred(), consume = deferred();
  let reads = 0;
  const f = fixture(t, { snapshot: () => ++reads === 1 ? request.promise : Promise.resolve(snapshot(30)),
    pageReceived: () => consume.promise });
  f.client.setSession("old-token", "old-user");
  const oldConnect = f.sockets[0].fire("connect");
  f.client.setSession("new-token", "new-user");
  request.resolve(snapshot(20)); await oldConnect;
  assert.deepEqual(f.snapshots, []);
  await f.sockets[1].fire("connect");
  assert.equal(f.snapshots[0].invocationSnapshotSeq, "30");
  let acked = false;
  const oldPage = f.sockets[1].fire("observability-event", page("old-checkpoint"), () => { acked = true; });
  f.client.setSession(null, null); consume.resolve(); await oldPage;
  assert.equal(acked, false); assert.equal(f.sockets[1].disconnected, true);
  assert.equal(f.states.at(-1).status, "stopped");
});

test("expired and scope-mismatched cursors replace the visible snapshot; denied access is terminal", async t => {
  const f = fixture(t);
  f.client.setSession("token", "user"); await f.sockets[0].fire("connect");
  await f.sockets[0].fire("observability-event", page("old"), () => {});
  const before = f.resets();
  f.sockets[0].fire("observability-error", { code: "CURSOR_SCOPE_MISMATCH" });
  await tick(); await f.sockets[1].fire("connect");
  assert.equal(f.resets(), before + 1);
  assert.deepEqual(f.sockets[1].emitted[0].data, { afterSequence: "20", origin: "external" });
  f.sockets[1].fire("observability-error", { code: "FORBIDDEN" });
  await tick(); assert.equal(f.sockets.length, 2); assert.equal(f.states.at(-1).status, "error");
});

test("connection retries have one owner and stop after five failed retries", async t => {
  const f = fixture(t);
  f.client.setSession("token", "user");
  for (let i = 0; i < 6; i++) { f.sockets[i].fire("connect_error"); await tick(); }
  assert.equal(f.sockets.length, 6); assert.equal(f.states.at(-1).status, "error");
});

test("snapshot HTTP uses captured bearer token and the production /api path", async t => {
  const before = global.fetch;
  t.after(() => { global.fetch = before; });
  let request;
  global.fetch = async (url, options) => { request = { url, options }; return {
    ok: true, json: async () => ({ status: "success", data: snapshot(30) }) }; };
  assert.equal((await stream.fetchObservabilitySnapshot("captured-token", new AbortController().signal)).invocationSnapshotSeq, "30");
  assert.equal(request.url, "/api/monitoring/observability/overview?origin=external");
  assert.equal(request.options.headers.Authorization, "Bearer captured-token"); assert.equal(request.options.cache, "no-store");
  global.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: { code: "FORBIDDEN" } }) });
  await assert.rejects(stream.fetchObservabilitySnapshot("captured-token", new AbortController().signal), e => e.code === "FORBIDDEN");
});

test("real Pinia websocket initialization consumes pages, preserves lifecycle updates, and clears on identity change", async t => {
  const values = new Map([["auth_token", "token-a"]]);
  global.localStorage = { getItem: key => values.get(key) || null };
  global.sessionStorage = { getItem: () => null };
  const { useMonitoringStore } = load("stores/monitoring.ts", {
    "@/services/api": { runtimeAssetsAPI: {}, runtimeObservabilityAPI: {} },
    "@/services/observability-stream": stream,
  });
  setActivePinia(createPinia());
  const monitoring = useMonitoringStore();
  const auth = reactive({ accessToken: "token-a", currentUser: { id: "user-a" } });
  const legacy = new Socket();
  Object.assign(legacy, { connect: async () => {}, getConnectionInfo: () => ({ reconnectAttempts: 0 }),
    subscribeToMetrics() {}, subscribeToLogs() {}, off() {} });
  const sockets = [], options = [], statuses = [];
  const { useWebSocketStore } = load("stores/websocket.ts", {
    "@/services/websocket": { websocketService: legacy }, "./monitoring": { useMonitoringStore },
    "./auth": { useAuthStore: () => auth },
    "./app": { useAppStore: () => ({ globalSettings: { autoRefresh: true }, addNotification() {} }) },
    "./server": { useServerStore: () => ({ updateServerStatus: (...args) => statuses.push(args), servers: [] }) },
    "@/services/observability-stream": { ...stream, fetchObservabilitySnapshot: async () => snapshot(20) },
    "socket.io-client": { io: (url, config) => { options.push({ url, config }); const socket = new Socket(); sockets.push(socket); return socket; } },
  });
  const websocket = useWebSocketStore();
  t.after(() => { monitoring.realTimeEnabled = false; websocket.disconnect(); });
  monitoring.realTimeEnabled = false;
  await websocket.initialize(); await sockets[0].fire("connect");
  assert.equal(options[0].url, "/monitoring");
  assert.deepEqual(options[0].config.auth, { observability: true, token: "token-a" });
  assert.equal(options[0].config.forceNew, true); assert.equal(options[0].config.reconnection, false);
  assert.equal(monitoring.callOverview.businessSummary.metrics.selectedInvocations, 2);
  const acks = [];
  await sockets[0].fire("observability-event", page("one", [item(21)]), value => {
    assert.equal(monitoring.callEvents[0].eventId, "event-21"); acks.push(value);
  });
  await sockets[0].fire("observability-event", page("two", [item(21), item(22)]), value => acks.push(value));
  assert.equal(monitoring.callEvents.length, 2); assert.equal(acks.length, 2);
  assert.equal(monitoring.callOverview.businessSummary.metrics.selectedInvocations, 2, "events do not double-count snapshot totals");
  assert.equal(monitoring.callOverviewStale, true);
  let refreshes = 0; monitoring.scheduleRefresh = () => { refreshes++; };
  legacy.fire("runtime:event", { family: "runtime.request" }); assert.equal(refreshes, 0);
  legacy.fire("runtime:event", { family: "runtime.lifecycle", managedServerId: "managed", status: "offline" });
  assert.equal(refreshes, 1); assert.equal(statuses[0][1], "stopped");
  auth.currentUser = { id: "user-b" };
  assert.equal(sockets[0].disconnected, true); assert.deepEqual(monitoring.callEvents, []);
  assert.equal(monitoring.callOverview, null);
  await sockets[1].fire("connect");
  assert.deepEqual(sockets[1].emitted[0].data, { afterSequence: "20", origin: "external" });
  auth.accessToken = null;
  assert.equal(sockets[1].disconnected, true); assert.equal(monitoring.callStreamStatus, "stopped");
  assert.deepEqual(monitoring.callEvents, []); assert.equal(monitoring.callOverview, null);
});

test("initial snapshot is aborted at its deadline and enters bounded recovery", async t => {
  let aborted = false;
  const f = fixture(t, { snapshotTimeoutMs: 1,
    snapshot: (_token, signal) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
    }) });
  f.client.setSession("token", "user");
  await f.sockets[0].fire("connect");
  assert.equal(aborted, true);
  assert.equal(f.states.at(-1).error, "SNAPSHOT_TIMEOUT");
  assert.equal(f.states.at(-1).status, "retrying");
  assert.deepEqual(f.sockets[0].emitted, []);
});

test("real monitoring consumer bounds replay cache and protects refresh against newer events and logout", async t => {
  global.localStorage = { getItem: () => "token" }; global.sessionStorage = { getItem: () => null };
  let pending = deferred();
  const { useMonitoringStore } = load("stores/monitoring.ts", {
    "@/services/api": { runtimeAssetsAPI: {}, runtimeObservabilityAPI: {} },
    "@/services/observability-stream": { ...stream, fetchObservabilitySnapshot: () => pending.promise },
  });
  setActivePinia(createPinia());
  const monitoring = useMonitoringStore(); monitoring.realTimeEnabled = false;
  t.after(() => monitoring.resetCallObservability());
  monitoring.applyCallSnapshot(snapshot(20));
  for (let n = 0; n < 5; n++) monitoring.applyCallEventPage(Array.from({ length: 50 }, (_, i) => item(n * 50 + i)));
  assert.equal(monitoring.callEvents.length, 200); assert.equal(monitoring.callEvents[0].sequence, "249");
  const before = monitoring.callEvents.slice();
  assert.throws(() => monitoring.applyCallEventPage([item(250), { sequence: 251, eventId: "bad", eventType: "invocation.completed" }]));
  assert.deepEqual(monitoring.callEvents, before, "invalid page must not partially apply");
  const refresh = monitoring.refreshCallOverview();
  monitoring.applyCallEventPage([item(250)]);
  pending.resolve(snapshot(249)); await refresh;
  assert.equal(monitoring.callOverviewStale, true, "a response begun before a new event cannot mark it fresh");
  pending = deferred();
  const oldRefresh = monitoring.refreshCallOverview();
  monitoring.resetCallObservability();
  pending.resolve(snapshot(250)); await oldRefresh;
  assert.equal(monitoring.callOverview, null); assert.deepEqual(monitoring.callEvents, []);
});
