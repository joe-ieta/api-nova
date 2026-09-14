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
const api = load("services/observability-policies.ts");
const policy = (revision = 1, eventDays = 14, payloadDays = 7) => ({
  id: "global-event-retention", revision, policyEtag: '"obs.' + "a".repeat(32) + "." + revision + '"',
  retention: { eventDays, payloadDays }, effectiveAt: null,
});
const caps = (scopeMode = "all", state = "enabled") => ({
  features: [{ name: "policyManagement", scopeMode, state }],
});
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, request = async resource => resource === "capabilities" ? caps() : { items: [policy()] }) {
  const auth = reactive({ accessToken: "token-a", currentUser: { id: "user-a" } });
  const calls = [];
  const source = load("stores/observability-policies.ts", {
    "./auth": { useAuthStore: () => auth },
    "@/services/observability-policies": { ...api, policyRequest: (...args) => { calls.push(args); return request(...args); } },
  });
  setActivePinia(createPinia()); const store = source.useObservabilityPoliciesStore();
  t.after(() => store.deactivate());
  return { store, auth, calls };
}
function draft(store) { store.eventDays = 30; store.payloadDays = 10; store.reason = "approved retention change"; }

test("adapter sends exact strong If-Match and reason, supports both fields, and never requests cleanup", async t => {
  const before = global.fetch; t.after(() => { global.fetch = before; });
  let captured;
  global.fetch = async (url, options) => { captured = { url, options }; return {
    ok: true, json: async () => ({ status: "success", data: policy(2) }) }; };
  const mutation = { etag: policy().policyEtag, eventDays: 30, payloadDays: 10, reason: "reviewed" };
  await api.policyRequest("policies/global-event-retention", "captured-token", new AbortController().signal, mutation);
  assert.equal(captured.url, "/api/monitoring/observability/policies/global-event-retention");
  assert.equal(captured.options.method, "PATCH"); assert.equal(captured.options.headers["If-Match"], mutation.etag);
  assert.equal(captured.options.headers.Authorization, "Bearer captured-token");
  assert.deepEqual(JSON.parse(captured.options.body), { retention: { eventDays: 30, payloadDays: 10 }, reason: "reviewed" });
  global.fetch = async () => ({ ok: false, status: 412, json: async () => ({}) });
  await assert.rejects(api.policyRequest("policies/global-event-retention", "token", new AbortController().signal, mutation),
    e => e.code === "PRECONDITION_FAILED");
});

test("real Pinia reads authoritative capabilities, saves both values and replaces revision", async t => {
  const f = fixture(t, async (resource, token, signal, mutation) => mutation ? policy(2, mutation.eventDays, mutation.payloadDays) :
    resource === "capabilities" ? caps() : { items: [policy()] });
  await f.store.load();
  assert.equal(f.store.canEdit, true); assert.equal(f.store.canSave, false);
  draft(f.store); assert.equal(f.store.canSave, true); await f.store.save();
  assert.equal(f.store.policy.revision, 2); assert.equal(f.store.eventDays, 30); assert.equal(f.store.payloadDays, 10);
  assert.equal(f.store.reason, ""); assert.equal(f.store.message, "saved");
  const mutations = f.calls.filter(args => args[3]); assert.equal(mutations.length, 1);
  assert.equal(mutations[0][3].etag, policy().policyEtag);
});

test("scoped/disabled capabilities are read only even with a policy; forbidden reload clears old state", async t => {
  for (const capability of [caps("scoped"), caps("none"), caps("all", "restricted"), { features: [] }]) {
    const f = fixture(t, async resource => resource === "capabilities" ? capability : { items: [policy()] });
    await f.store.load(); draft(f.store); assert.equal(f.store.canEdit, false); await f.store.save();
    assert.equal(f.calls.some(args => args[3]), false);
  }
  let forbidden = false;
  const f = fixture(t, async resource => {
    if (forbidden) throw { code: "FORBIDDEN" };
    return resource === "capabilities" ? caps() : { items: [policy()] };
  });
  await f.store.load(); forbidden = true; await f.store.load();
  assert.equal(f.store.policy, null); assert.equal(f.store.canEdit, false); assert.equal(f.store.message, "forbidden");
});

test("invalid days and empty/control-character reasons never dispatch a mutation", async t => {
  const f = fixture(t); await f.store.load();
  for (const days of [0, 366, 1.5, undefined]) {
    draft(f.store); f.store.eventDays = days; await f.store.save();
    assert.equal(f.store.message, "invalid");
  }
  for (const reason of ["", " ", "bad\nreason", "a".repeat(501)]) {
    draft(f.store); f.store.reason = reason; await f.store.save();
  }
  assert.equal(f.calls.some(args => args[3]), false);
});

test("412 reloads current values, discards stale draft and never replays PATCH", async t => {
  let version = 1;
  const f = fixture(t, async (resource, token, signal, mutation) => {
    if (mutation) { version = 2; throw { code: "PRECONDITION_FAILED" }; }
    return resource === "capabilities" ? caps() : { items: [policy(version, version === 2 ? 90 : 14)] };
  });
  await f.store.load(); draft(f.store); await f.store.save();
  assert.equal(f.calls.filter(args => args[3]).length, 1);
  assert.equal(f.store.policy.revision, 2); assert.equal(f.store.eventDays, 90);
  assert.equal(f.store.reason, ""); assert.equal(f.store.message, "conflict");
  assert.equal(f.store.saving, false); assert.equal(f.store.canSave, false);
});

test("uncertain save does not retry or claim rollback and requires explicit reread", async t => {
  const f = fixture(t, async (resource, token, signal, mutation) => {
    if (mutation) throw new Error("network failed after possible commit");
    return resource === "capabilities" ? caps() : { items: [policy()] };
  });
  await f.store.load(); draft(f.store); await f.store.save();
  assert.equal(f.store.message, "unavailable"); assert.equal(f.store.policy, null);
  assert.equal(f.calls.length, 3); assert.equal(f.calls.filter(args => args[3]).length, 1);
  assert.equal(f.store.canEdit, false);
});

test("changing account clears draft and prevents pending old reads from restoring it", async t => {
  const old = deferred();
  const f = fixture(t, async (resource, token) => resource === "capabilities" ? caps() :
    token === "token-a" ? old.promise : { items: [policy(3)] });
  const oldRead = f.store.load();
  f.store.reason = "private old reason";
  f.auth.accessToken = "token-b"; await tick();
  assert.equal(f.store.reason, ""); assert.equal(f.store.policy.revision, 3);
  old.resolve({ items: [policy(1)] }); await oldRead;
  assert.equal(f.store.policy.revision, 3);
  f.auth.accessToken = null;
  assert.equal(f.store.policy, null); assert.equal(f.store.canEdit, false);
});

test("an older save finishing after reload cannot clear a newer saving flag or overwrite it", async t => {
  const old = deferred(), next = deferred(); let mutations = 0;
  const f = fixture(t, async (resource, token, signal, mutation) => mutation ?
    (++mutations === 1 ? old.promise : next.promise) :
    resource === "capabilities" ? caps() : { items: [policy(mutations + 1)] });
  await f.store.load(); draft(f.store); const oldSave = f.store.save();
  await f.store.load(); draft(f.store); const newSave = f.store.save();
  assert.equal(f.store.saving, true);
  old.resolve(policy(2)); await oldSave;
  assert.equal(f.store.saving, true);
  next.resolve(policy(3)); await newSave;
  assert.equal(f.store.saving, false); assert.equal(f.store.policy.revision, 3);
});

test("component deactivation cancels reads and prevents account changes from fetching off-page", async t => {
  const waiting = deferred();
  const f = fixture(t, async resource => resource === "capabilities" ? caps() : waiting.promise);
  const read = f.store.load(); f.store.deactivate();
  f.auth.accessToken = "token-b";
  waiting.resolve({ items: [policy()] }); await read;
  assert.equal(f.calls.length, 2); assert.equal(f.store.policy, null); assert.equal(f.store.loading, false);
});

test("late conflict recovery cannot overwrite a newer save success message", async t => {
  const oldRecovery = deferred(); let mutations = 0, reads = 0;
  const f = fixture(t, async (resource, token, signal, mutation) => {
    if (mutation) {
      if (++mutations === 1) throw { code: "PRECONDITION_FAILED" };
      return policy(4);
    }
    if (resource === "capabilities") return caps();
    return ++reads === 2 ? oldRecovery.promise : { items: [policy(reads)] };
  });
  await f.store.load(); draft(f.store);
  const conflicted = f.store.save(); await tick();
  await f.store.load(); draft(f.store); await f.store.save();
  assert.equal(f.store.message, "saved"); assert.equal(f.store.policy.revision, 4);
  oldRecovery.resolve({ items: [policy(2)] }); await conflicted;
  assert.equal(f.store.message, "saved"); assert.equal(f.store.policy.revision, 4);
});
