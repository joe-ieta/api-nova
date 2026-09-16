"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), Module = require("node:module"), ts = require("typescript");
const { reactive, watch } = require("vue");
const filename = path.resolve(__dirname, "../src/services/mcp-publication.ts"), loaded = new Module(filename, module);
loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
const api = loaded.exports;
const tick = () => new Promise(r => setImmediate(r));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const detail = { asset: { type: "mcp_server" }, managedServer: { id: "server-a", port: 9033, transport: "sse", endpointPath: "/team/events", status: "stopped", endpoint: "http://localhost:9033/old" } };
const preview = input => ({ ...input, port: input.port ?? null, consumerUrl: input.port ? "http://127.0.0.1:" + input.port + input.endpointPath : null,
  messagesUrl: input.transport === "sse" && input.port ? "http://127.0.0.1:" + input.port + input.endpointPath + "/messages" : null,
  portMode: input.port ? "explicit" : "automatic", addressScope: "loopback", availability: "not_checked" });
function fixture(t, request) {
  const auth = reactive({ token: "token-a", id: "user-a" }), calls = [], state = reactive(api.mcpPublicationState());
  const form = new api.McpPublicationForm(state, () => auth.token && auth.id ? { key: auth.id + auth.token, token: auth.token } : null,
    async (...args) => { calls.push(args); return request ? request(...args) : args[1] === "detail" ? detail : preview(args[4]); });
  const stop = watch([() => auth.token, () => auth.id], () => form.close(), { flush: "sync" });
  t.after(() => { stop(); form.close(); }); return { form, state, auth, calls };
}
test("captured-token adapter uses exact authorized preview and deployment endpoints without retry", async t => {
  const previous = global.fetch; t.after(() => { global.fetch = previous; }); const calls = [];
  global.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({}) }; };
  const input = { port: 9033, transport: "sse", endpointPath: "/events" };
  await api.mcpPublicationRequest("asset", "preview", "captured", new AbortController().signal, input);
  await api.mcpPublicationRequest("asset", "deploy", "captured", new AbortController().signal, input);
  assert.equal(calls[0].url, "/api/v1/runtime-assets/asset/mcp-endpoint-preview");
  assert.equal(calls[1].url, "/api/v1/runtime-assets/asset/deploy-mcp");
  assert.equal(calls[1].options.headers.Authorization, "Bearer captured");
  assert.deepEqual(JSON.parse(calls[1].options.body), input); assert.equal(calls.length, 2);
});
test("saved SSE configuration fills actual form and submits all fields with waiver", async t => {
  const f = fixture(t); const done = f.form.open("asset", "authorized smoke waiver"); await tick();
  assert.equal(f.state.transport, "sse"); assert.equal(f.state.endpointPath, "/team/events");
  assert.equal(f.state.actualEndpoint, "http://localhost:9033/old");
  assert.equal(f.state.preview.consumerUrl, "http://127.0.0.1:9033/team/events");
  f.state.endpointPath = "/new"; await f.form.refresh(); await f.form.save(); assert.equal(await done, true);
  const deployment = f.calls.find(args => args[1] === "deploy");
  assert.deepEqual(deployment[4], { targetServerId: "server-a", transport: "sse", port: 9033, endpointPath: "/new", missingSmokeWaiverReason: "authorized smoke waiver" });
});
test("first deployment automatic port stays unassigned and is omitted from submitted body", async t => {
  const f = fixture(t, async (_id, op, _token, _signal, input) => op === "detail" ? { asset: { type: "mcp_server" } } : preview(input));
  f.form.open("asset"); await tick(); assert.equal(f.state.preview.consumerUrl, null); assert.equal(f.state.port, undefined);
  await f.form.save(); assert.equal(Object.hasOwn(f.calls.find(args => args[1] === "deploy")[4], "port"), false);
});
test("field changes and switching assets discard late preview responses", async t => {
  const old = deferred(); let reads = 0;
  const f = fixture(t, async (_id, op, _token, _signal, input) => op === "detail" ? detail : ++reads === 1 ? old.promise : preview(input));
  const first = f.form.open("first"); await tick(); f.state.endpointPath = "/latest"; await f.form.refresh();
  old.resolve(preview({ transport: "sse", port: 9033, endpointPath: "/old" })); await tick();
  assert.equal(f.state.preview.endpointPath, "/latest");
  f.form.open("second"); assert.equal(await first, false); await tick(); assert.equal(f.state.id, "second");
});
test("logout discards pending deployment completion and clears private draft", async t => {
  const waiting = deferred();
  const f = fixture(t, async (_id, op, _token, _signal, input) => op === "detail" ? detail : op === "deploy" ? waiting.promise : preview(input));
  const result = f.form.open("asset"); await tick(); const saving = f.form.save(); f.auth.token = null;
  assert.equal(await result, false); waiting.resolve({}); await saving;
  assert.equal(f.state.visible, false); assert.equal(f.state.id, ""); assert.equal(f.state.actualEndpoint, null);
});
test("uncertain deployment preserves draft, invalidates preview and never automatically resubmits", async t => {
  const f = fixture(t, async (_id, op, _token, _signal, input) => { if (op === "deploy") throw new Error("network"); return op === "detail" ? detail : preview(input); });
  f.form.open("asset"); await tick(); f.state.endpointPath = "/edited"; await f.form.refresh(); await f.form.save(); await f.form.save();
  assert.equal(f.state.endpointPath, "/edited"); assert.equal(f.state.error, "deploy"); assert.equal(f.state.preview, null);
  assert.equal(f.calls.filter(args => args[1] === "deploy").length, 1); assert.equal(f.state.saving, false);
});
test("preview timeout leaves no stale success and supports an explicit reread", async t => {
  const original = global.setTimeout; global.setTimeout = (fn, ms, ...args) => original(fn, ms === 10000 ? 5 : ms, ...args);
  t.after(() => { global.setTimeout = original; }); let fail = true;
  const f = fixture(t, async (_id, op, _token, signal, input) => op === "detail" ? detail : fail ? new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true })) : preview(input));
  f.form.open("asset"); await new Promise(r => original(r, 30)); assert.equal(f.state.error, "preview"); assert.equal(f.state.preview, null);
  fail = false; await f.form.refresh(); assert.equal(f.state.error, null); assert.equal(f.state.preview.endpointPath, "/team/events");
});

test("redeploy form submits the same edited contract to the existing redeploy action", async t => {
  const f = fixture(t); const result = f.form.open("asset", undefined, "redeploy"); await tick();
  f.state.port = 9044; await f.form.refresh(); await f.form.save(); assert.equal(await result, true);
  assert.equal(f.calls.filter(args => args[1] === "deploy").length, 0);
  assert.equal(f.calls.find(args => args[1] === "redeploy")[4].port, 9044);
});
