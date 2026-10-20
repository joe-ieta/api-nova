"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), Module = require("node:module");
const ts = require("typescript");
const filename = path.resolve(__dirname, "../src/services/runtime-logs.ts");
const loaded = new Module(filename, module);
loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, filename);
const { RuntimeLogPager, runtimeLogState, fetchRuntimeLogs } = loaded.exports;
const event = { id: "real-event", occurredAt: "2026-10-20T00:00:00Z", severity: "warning",
  summary: "<script>untrusted</script>", eventFamily: "deployment", eventName: "deploy.failed" };
const response = (page = 1) => ({ data: [event], page, limit: 50, total: 60, hasNext: page === 1, hasPrev: page > 1 });
const pending = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test("runtime logs HTTP adapter authenticates bounded real event query and rejects HTTP errors", async t => {
  const original = global.fetch; t.after(() => { global.fetch = original; });
  global.fetch = async (url, options) => {
    assert.equal(new URL(url, "http://local").pathname, "/api/v1/monitoring/management/events");
    assert.equal(options.headers.Authorization, "Bearer token");
    assert.equal(options.cache, "no-store");
    return { ok: true, json: async () => ({ status: "success", data: response() }) };
  };
  assert.equal((await fetchRuntimeLogs({ page: "1", limit: "50" }, "token", new AbortController().signal)).total, 60);
  for (const [status, code] of [[401, "unauthenticated"], [403, "forbidden"], [500, "unavailable"]]) {
    global.fetch = async () => ({ ok: false, status });
    await assert.rejects(fetchRuntimeLogs({}, "token", new AbortController().signal), new RegExp(code));
  }
});
test("paging and severity mapping preserve real identity, timestamp and untrusted text for escaped rendering", async () => {
  const state = runtimeLogState(), queries = [];
  const pager = new RuntimeLogPager(state, () => "token", async query => { queries.push(query); return response(Number(query.page)); });
  await pager.read(1, "warn");
  assert.deepEqual(queries[0], { page: "1", limit: "50", level: "warning" });
  assert.equal(state.items[0].id, event.id); assert.equal(state.items[0].level, "warn");
  assert.equal(state.items[0].timestamp.toISOString(), "2026-10-20T00:00:00.000Z");
  assert.equal(state.items[0].message, event.summary);
  await pager.read(2, "fatal"); assert.equal(queries[1].level, "critical");
  assert.equal(state.page, 2); assert.equal(state.hasPrev, true);
});
test("failed or malformed pages clear old rows and pagination without exposing error payloads", async () => {
  for (const bad of [
    () => { throw new Error("sensitive server error"); },
    () => ({ ...response(), data: [{ ...event, occurredAt: "invalid" }] }),
    () => ({ ...response(), data: [{ ...event, severity: "invented" }] }),
    () => ({ ...response(), data: [{ ...event, severity: "constructor" }] }),
    () => ({ ...response(), data: Array(51).fill(event) }),
    () => ({ ...response(), total: -1 }),
  ]) {
    const state = runtimeLogState(); let fail = false;
    const pager = new RuntimeLogPager(state, () => "token", async () => fail ? bad() : response());
    await pager.read(); fail = true; await pager.read();
    assert.deepEqual(state.items, []); assert.equal(state.total, 0); assert.equal(state.hasNext, false);
    assert.ok(["invalid", "unavailable"].includes(state.error));
  }
});
test("a real event with nullable summary displays its persisted event name", async () => {
  const state = runtimeLogState();
  const pager = new RuntimeLogPager(state, () => "token", async () => ({
    ...response(), data: [{ ...event, summary: null }],
  }));
  await pager.read();
  assert.equal(state.error, null);
  assert.equal(state.items[0].message, event.eventName);
});
test("late responses after refresh, clear, unmount or session change cannot restore old logs", async () => {
  for (const action of ["refresh", "reset", "session"]) {
    const held = pending(); const state = runtimeLogState(); let calls = 0, token = "old";
    const pager = new RuntimeLogPager(state, () => token, async () => ++calls === 1 ? held.promise : { ...response(), data: [{ ...event, id: "new" }] });
    const old = pager.read();
    if (action === "refresh") await pager.read();
    if (action === "reset") pager.reset();
    if (action === "session") token = "new";
    held.resolve(response()); await old;
    assert.deepEqual(state.items.map(row => row.id), action === "refresh" ? ["new"] : []);
    assert.equal(state.loading, false);
  }
});
test("missing login never queries backend; aborting a deadline clears loading and reports timeout", async t => {
  const state = runtimeLogState();
  await new RuntimeLogPager(state, () => null, async () => { throw new Error("must not fetch"); }).read();
  assert.equal(state.error, "unauthenticated");
  const original = global.setTimeout; t.after(() => { global.setTimeout = original; });
  global.setTimeout = callback => original(callback, 1);
  const pager = new RuntimeLogPager(state, () => "token", async (_q, _t, signal) =>
    new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("abort")))));
  await pager.read(); assert.equal(state.error, "timeout"); assert.equal(state.loading, false);
});
