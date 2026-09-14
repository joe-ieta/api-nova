"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), Module = require("node:module");
const ts = require("typescript");
const { reactive } = require("vue");
const { createPinia, setActivePinia } = require("pinia");
function load(file, mocks = {}) {
  const filename = path.resolve(__dirname, "../src", file);
  const loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = loaded.require.bind(loaded);
  loaded.require = id => Object.hasOwn(mocks, id) ? mocks[id] : original(id);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: filename,
  }).outputText, filename);
  return loaded.exports;
}
const gateway = load("services/gateway-invocations.ts");
const stream = load("services/observability-stream.ts");
const invocation = id => ({ invocationId: id, runtimeAssetId: "asset-a", serverType: "gateway",
  spanKind: "gateway_request", origin: "external", startedAt: "2026-09-14T00:00:00.000Z",
  requestId: "request-a", httpStatus: null, durationMs: null, outcome: null });
const response = (items = [invocation("one")], cursor = "signed-next", snapshotSeq = "20") =>
  ({ status: "success", data: { items, nextCursor: cursor, hasMore: cursor !== null }, meta: { snapshotSeq, isPartial: true } });
function pending() { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; }

test("HTTP adapter uses new authorized endpoint and preserves nullable metadata", async t => {
  const before = global.fetch; t.after(() => { global.fetch = before; });
  let captured;
  global.fetch = async (url, options) => { captured = { url, options }; return { ok: true, json: async () => response() }; };
  const result = await gateway.fetchGatewayInvocations({ requestId: "r & ? token", limit: "20" }, "bearer", new AbortController().signal);
  const url = new URL(captured.url, "http://localhost");
  assert.equal(url.pathname, "/api/monitoring/observability/invocations");
  assert.equal(url.searchParams.get("requestId"), "r & ? token");
  assert.equal(captured.options.headers.Authorization, "Bearer bearer");
  assert.equal(captured.options.cache, "no-store");
  assert.equal(result.data.items[0].httpStatus, null);
});

test("first page sends supported filters; signed continuation pins snapshot and polling preserves history", async () => {
  const state = gateway.gatewayInvocationPageState(), requests = [];
  const pager = new gateway.GatewayInvocationPager(state, () => "token", async query => {
    requests.push(query); return response([invocation(String(requests.length))], "signed-next", "20");
  });
  await pager.latest({ runtimeAssetId: "asset-a", outcome: "timeout", requestId: " request-a " });
  assert.deepEqual(Object.keys(requests[0]).sort(), ["from", "to", "limit", "serverType", "spanKind", "origin", "timeBasis",
    "runtimeAssetId", "outcome", "requestId"].sort());
  assert.equal(Date.parse(requests[0].to) - Date.parse(requests[0].from), 3600000);
  assert.equal(requests[0].serverType, "gateway"); assert.equal(requests[0].spanKind, "gateway_request");
  assert.equal(requests[0].origin, "external"); assert.equal(requests[0].requestId, "request-a");
  await pager.next();
  assert.deepEqual(requests[1], { cursor: "signed-next", limit: "20" });
  assert.equal(state.page, 2); assert.equal(state.snapshotSeq, "20");
  await pager.refresh(); assert.equal(requests.length, 2);
  await pager.latest(); assert.equal(state.page, 1); assert.equal(requests[2].outcome, "timeout");
});

test("expired/denied/error pages clear old rows and never fall back or retain a usable cursor", async () => {
  for (const code of ["QUERY_CURSOR_EXPIRED", "CURSOR_SCOPE_MISMATCH", "FORBIDDEN", "OBSERVABILITY_UNAVAILABLE"]) {
    let failing = false, reads = 0;
    const state = gateway.gatewayInvocationPageState();
    const pager = new gateway.GatewayInvocationPager(state, () => "token", async () => {
      reads++; if (failing) throw Object.assign(new Error(code), { code }); return response();
    });
    await pager.latest(); failing = true; await pager.next();
    assert.deepEqual(state.items, []); assert.equal(state.hasMore, false); assert.equal(state.error, code);
    await pager.next(); assert.equal(reads, 2);
  }
});

test("changed filters and logout discard in-flight old responses", async () => {
  const first = pending(); let reads = 0, token = "old-token";
  const state = gateway.gatewayInvocationPageState();
  const pager = new gateway.GatewayInvocationPager(state, () => token, async () =>
    ++reads === 1 ? first.promise : response([invocation("new")], null));
  const old = pager.latest({ runtimeAssetId: "old-asset" });
  await pager.latest({ runtimeAssetId: "new-asset" });
  first.resolve(response([invocation("old")])); await old;
  assert.equal(state.items[0].invocationId, "new");
  token = null; await pager.latest(); assert.deepEqual(state.items, []); assert.equal(state.snapshotSeq, null);
});

test("malformed or mixed-span responses do not silently become Gateway log rows", async () => {
  for (const bad of [
    response([{ ...invocation("mcp"), serverType: "mcp", spanKind: "mcp_tool" }]),
    response([{ ...invocation("probe"), origin: "probe" }]),
    { data: { items: [], hasMore: true, nextCursor: null } },
  ]) {
    const state = gateway.gatewayInvocationPageState();
    const pager = new gateway.GatewayInvocationPager(state, () => "token", async () => bad);
    await pager.latest(); assert.deepEqual(state.items, []); assert.equal(state.error, "INVALID_PAGE");
  }
});

test("actual monitoring entry migrates independently of legacy availability and clears on auth identity changes", async t => {
  const previousFetch = global.fetch; t.after(() => { global.fetch = previousFetch; });
  const auth = reactive({ accessToken: "token-a", currentUser: { id: "user-a" } });
  global.localStorage = { getItem: () => auth.accessToken }; global.sessionStorage = { getItem: () => null };
  let legacyReads = 0; const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url: new URL(url, "http://localhost"), options });
    return { ok: true, json: async () => response() };
  };
  const { useMonitoringStore } = load("stores/monitoring.ts", {
    "./auth": { useAuthStore: () => auth },
    "@/services/gateway-invocations": gateway,
    "@/services/observability-stream": stream,
    "@/services/api": {
      runtimeAssetsAPI: { listRuntimeAssets: async () => ({ data: [] }) },
      runtimeObservabilityAPI: {
        getManagementOverview: async () => { throw { status: 404 }; },
        getGatewayAccessLogs: async () => { legacyReads++; throw new Error("legacy endpoint forbidden"); },
      },
    },
  });
  setActivePinia(createPinia()); const store = useMonitoringStore();
  await store.fetchOverview(); // Marks the old management API unavailable.
  await store.fetchGatewayAccessLogs({ outcome: "error", requestId: "r1" });
  assert.equal(legacyReads, 0); assert.equal(requests.length, 1);
  assert.equal(requests[0].url.pathname, "/api/monitoring/observability/invocations");
  assert.equal(requests[0].url.searchParams.get("outcome"), "error");
  assert.equal(store.gatewayAccessLogs.length, 1);
  await store.nextGatewayLogPage(); assert.equal(store.gatewayLogPage.page, 2);
  await store.refreshAll("manual"); assert.equal(requests.length, 2, "background overview refresh does not reset historical page");
  auth.currentUser = { id: "user-b" };
  assert.deepEqual(store.gatewayAccessLogs, []); assert.equal(store.gatewayLogPage.page, 1);
  assert.equal(store.gatewayLogPage.snapshotSeq, null);
  await store.fetchGatewayAccessLogs();
  assert.equal(requests[2].url.searchParams.get("outcome"), null, "new subject cannot inherit prior private asset filters");
  auth.accessToken = null;
  assert.deepEqual(store.gatewayAccessLogs, []); assert.equal(store.gatewayLogPage.hasMore, false);
});
