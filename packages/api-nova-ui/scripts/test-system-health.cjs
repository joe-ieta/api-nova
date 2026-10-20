'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const vue = require('vue');
const {createPinia, setActivePinia, defineStore} = require('pinia');

function load(relative, dependencies = {}, globals = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, relative), 'utf8');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, {compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  }}).outputText, { exports, require: name => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  }, Date, Promise, setTimeout, clearTimeout, AbortSignal, ...globals });
  return exports;
}
const ok = {status: 'ok', details: {disk: {status: 'up'}, mcp_server: {status: 'up'}}};
const down = {status: 'error', details: {disk: {status: 'up'}, mcp_server: {status: 'down'}}};
const service = load('../src/services/system-health.ts');
function store(fetchSystemHealth) {
  setActivePinia(createPinia());
  return load('../src/stores/app.ts', {
    vue, pinia: {defineStore}, '@/services/system-health': {fetchSystemHealth},
  }).useAppStore();
}

test('health requires a valid complete snapshot; 503 reports failed indicators', () => {
  assert.equal(service.parseHealthSnapshot(ok, 200).status, 'healthy');
  assert.equal(service.parseHealthSnapshot(down, 503).status, 'error');
  assert.equal(service.parseHealthSnapshot(down, 503).errorCount, 1);
  assert.equal(service.parseHealthSnapshot({success:false,error:{details:down}}, 503).status, 'error');
  assert.equal(service.parseHealthSnapshot({success:false,error:{details:down}}, 503).errorCount, 1);
  assert.equal(service.parseHealthSnapshot(ok, 503).status, 'error');
  for (const body of [null, {}, '<html>', {status:'ok',details:{}}, {status:'ok',details:{disk:null}}]) {
    assert.throws(() => service.parseHealthSnapshot(body, 200));
  }
});
test('requests the full root health path without caching and accepts Terminus 503', async () => {
  let captured;
  const health = load('../src/services/system-health.ts', {}, {fetch: async (...args) => {
    captured = args; return {status:503, json:async()=>down};
  }});
  assert.equal((await health.fetchSystemHealth()).status, 'error');
  assert.equal(captured[0], '/health');
  assert.equal(captured[1].cache, 'no-store');
  assert.ok(captured[1].signal);
});
test('HTTP authorization or server errors are unavailable, never healthy', async () => {
  for (const status of [401,403,404,500]) {
    const health = load('../src/services/system-health.ts', {}, {fetch:async()=>({status,json:async()=>ok})});
    await assert.rejects(health.fetchSystemHealth());
  }
});
test('store begins unknown, changes immediately and clears stale green on disconnect', async () => {
  let response = () => service.parseHealthSnapshot(ok, 200);
  const app = store(async () => response());
  assert.equal(app.systemHealth.status, 'unknown');
  assert.equal(app.isHealthy, false);
  assert.equal(await app.checkSystemHealth(), true);
  assert.equal(app.isHealthy, true);
  response = () => service.parseHealthSnapshot(down, 503);
  await app.checkSystemHealth();
  assert.equal(app.systemHealth.errorCount, 1);
  response = () => { throw new Error('offline'); };
  assert.equal(await app.checkSystemHealth(), false);
  assert.equal(app.systemHealth.status, 'unknown');
  assert.equal(app.isHealthy, false);
});
test('concurrent checks share one request and refresh waits for current-page loading', async () => {
  let resolveHealth, resolvePage, requests = 0, called = 0;
  const app = store(() => { requests++; return new Promise(resolve => { resolveHealth = resolve; }); });
  const check = app.checkSystemHealth();
  const refreshed = app.refreshData(() => { called++; return new Promise(resolve => { resolvePage = resolve; }); });
  await Promise.resolve();
  assert.equal(requests, 1);
  assert.equal(called, 1);
  resolveHealth(service.parseHealthSnapshot(ok,200));
  await check;
  assert.equal(app.loading, true);
  resolvePage();
  await refreshed;
  assert.equal(app.loading, false);
  assert.equal(app.notifications.length, 0);
});
test('page or health request failures propagate and loading resets after both finish', async () => {
  const app = store(async () => service.parseHealthSnapshot(ok,200));
  await assert.rejects(app.refreshData(async () => {throw new Error('page denied');}), /page denied/);
  assert.equal(app.loading, false);
  const offline = store(async () => {throw new Error('offline');});
  let called = false;
  await assert.rejects(offline.refreshData(async () => {called = true;}), /Health unavailable/);
  assert.equal(called, true);
  assert.equal(offline.loading, false);
});
