'use strict';
// Run with Node 24 from the repository root; consumes existing Parser/Server
// artifacts and ts-node API sources. Never builds or overwrites shared dist.
process.env.DB_TYPE = 'sqlite';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const { randomUUID, createHash } = require('node:crypto');
const { EventEmitter2 } = require('@nestjs/event-emitter');
require('ts-node').register({ transpileOnly: true, project: path.resolve(__dirname, '../../../../tsconfig.json') });
require('reflect-metadata');
require('@nestjs/common').Logger.overrideLogger([]);
const { ManagedMcpProcessService } = require('./managed-mcp-process.service.ts');
const { ManagedMcpHandoffPreparationService } = require('./managed-mcp-handoff-preparation.service.ts');
const { ProcessManagerService } = require('./process-manager.service.ts');
const { ProcessErrorHandlerService } = require('./process-error-handler.service.ts');
const { ServerLifecycleService } = require('./server-lifecycle.service.ts');
const { ServerManagerService } = require('./server-manager.service.ts');
const { ProcessHealthService } = require('./process-health.service.ts');
const { instrumentedPreparation } = require('../../../../scripts/managed-mcp-lifecycle-test-support.cjs');
const { usesTrustedMcp, assertTrustedMcp } = require('./managed-mcp-mode.ts');
const { startManagedMcpChannel } = require('./managed-mcp-channel.ts');
const wire = require('api-nova-server');
const MODE = 'trusted_ipc_v1';
const REJECTED = 'MANAGED_MCP_LIFECYCLE_REJECTED';
const CANCELLED = 'MANAGED_MCP_START_CANCELLED';
const secret = 'NP20-synthetic-secret-do-not-project';
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let n = 0; n < 1000; n++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 10)); }
  throw Error('condition did not settle');
}
function memoryRepository() {
  const writes = [];
  return { writes, create: x => x, save: async x => { writes.push(structuredClone(x)); return x; },
    update: async (_id, x) => { writes.push(structuredClone(x)); } };
}
function fixture() {
  const events = new EventEmitter2(), repository = memoryRepository(), handles = [], emissions = [];
  events.onAny((name, value) => emissions.push({ name, value }));
  const preparation = {
    reads: 0, lifecycleAutoRestart: async () => true, preflightLifecycle: async () => {},
    async startLifecycle(_runtime, _server, signal) {
      this.reads++;
      const ready = deferred(), closed = deferred();
      void ready.promise.catch(() => {});
      const handle = { pid: 70000 + this.reads, launchId: randomUUID(), state: 'handoffAccepted', autoRestart: true,
        ready: ready.promise, closed: closed.promise, accept: () => ready.resolve({}),
        exit: () => { ready.reject(Error(secret)); closed.resolve({ code: 'MANAGED_CHILD_EXITED' }); },
        close: async () => { ready.reject(Error(secret)); closed.resolve({ code: 'STOPPED' }); } };
      signal.addEventListener('abort', () => { void handle.close(); }, { once: true });
      handles.push(handle);
      return handle;
    },
  };
  const service = new ManagedMcpProcessService(preparation, events, repository);
  const started = () => emissions.filter(e => e.name === 'process.started');
  return { service, preparation, repository, events, handles, emissions, started };
}

test('mode stays off by default; unknown modes and legacy secrets fail closed', () => {
  assert.equal(usesTrustedMcp({ config: {} }), false);
  for (const mode of [null, '', 'unknown']) assert.throws(() => usesTrustedMcp({ config: { managedMcpMode: mode } }), /LIFECYCLE_REJECTED/);
  const valid = { inboundAuthMode: 'private_api_key', config: { managedMcpMode: MODE, managedByRuntimeAsset: true, runtimeAssetId: 'runtime' } };
  assertTrustedMcp(valid);
  for (const patch of [
    { authConfig: { type: 'bearer', config: { bearerToken: secret } } },
    { authConfig: { type: 'none', config: { bearerEnv: 'TOKEN' } } },
    { inboundAuthMode: 'anonymous' },
    { config: { ...valid.config, customHeaders: { Authorization: secret } } },
    { config: { ...valid.config, watch: true } },
  ]) assert.throws(() => assertTrustedMcp({ ...valid, ...patch }), new RegExp(REJECTED));
});

test('PID/ACK remain STARTING; only READY publishes RUNNING and safe detached projection', async () => {
  const f = fixture(), starting = f.service.start('server', 'runtime');
  await until(() => f.handles.length);
  assert.equal(f.service.get('server').status, 'starting');
  assert.equal(f.started().length, 0);
  assert.equal(f.repository.writes.some(x => x.status === 'running'), false);
  await assert.rejects(f.service.start('server', 'runtime'), new RegExp(REJECTED));
  f.handles[0].accept();
  const info = await starting;
  assert.equal(info.status, 'running');
  assert.equal(f.started().length, 1);
  info.config.managedLaunch.runtimeAssetId = 'tampered';
  assert.equal(f.service.get('server').config.managedLaunch.runtimeAssetId, 'runtime');
  assert.equal(JSON.stringify(f.emissions).includes(secret), false);
  assert.equal(info.process, undefined);
  assert.equal(info.config.env, undefined);
  await Promise.all([f.service.stop('server'), f.service.stop('server')]);
  assert.equal(f.service.get('server').status, 'stopped');
});

test('exit before READY is ERROR, no success or automatic bootstrap retry', async () => {
  const f = fixture(), starting = f.service.start('server', 'runtime');
  await until(() => f.handles.length);
  f.handles[0].exit();
  await assert.rejects(starting, new RegExp(REJECTED));
  assert.equal(f.service.get('server').status, 'error');
  assert.equal(f.started().length, 0);
  assert.equal(f.emissions.some(e => e.name === 'process.error'), false);
  assert.equal(JSON.stringify(f.emissions).includes(secret), false);
  await f.service.onModuleDestroy();
});

test('stop during READY wait cancels startup and prevents late READY resurrection', async () => {
  const f = fixture(), starting = f.service.start('server', 'runtime');
  const rejected = assert.rejects(starting, new RegExp(CANCELLED));
  await until(() => f.handles.length);
  await f.service.stop('server');
  f.handles[0].accept();
  await rejected;
  assert.equal(f.service.get('server').status, 'stopped');
  assert.equal(f.started().length, 0);
});

test('stop during preparation cancels before channel spawn; shutdown rejects new work', async () => {
  const f = fixture(), gate = deferred();
  f.preparation.startLifecycle = async (_runtime, _server, signal) => {
    await gate.promise;
    if (signal.aborted) throw Error('cancelled before spawn');
    f.preparation.reads++;
    throw Error('unexpected spawn');
  };
  const starting = f.service.start('server', 'runtime');
  const rejected = assert.rejects(starting, new RegExp(CANCELLED));
  await tick();
  const stop = f.service.stop('server');
  gate.resolve(true);
  await stop; await rejected;
  assert.equal(f.preparation.reads, 0);
  await f.service.onModuleDestroy();
  await assert.rejects(f.service.start('another', 'runtime'), new RegExp(REJECTED));
});

test('automatic restart rereads persisted off before stop; manual restart remains allowed', async () => {
  const f = fixture(), starting = f.service.start('server', 'runtime');
  await until(() => f.handles.length); f.handles[0].accept(); await starting;
  assert.equal(f.service.get('server').config.managedLaunch.autoRestart, true);
  f.preparation.lifecycleAutoRestart = async () => false;
  await assert.rejects(f.service.restart('server', true), new RegExp(REJECTED));
  assert.equal(f.handles.length, 1);
  assert.equal(f.service.get('server').status, 'running');
  const startLifecycle = f.preparation.startLifecycle.bind(f.preparation);
  f.preparation.startLifecycle = async (...args) => {
    const handle = await startLifecycle(...args);
    handle.autoRestart = false;
    return handle;
  };
  const manual = f.service.restart('server');
  await until(() => f.handles.length === 2);
  f.handles[1].accept(); await manual;
  assert.equal(f.service.get('server').config.managedLaunch.autoRestart, false);
  await f.service.stop('server');
});

test('restart preflights before stop and captures fresh launch on every attempt', async () => {
  const f = fixture(), starting = f.service.start('server', 'runtime');
  await until(() => f.handles.length); f.handles[0].accept(); await starting;
  f.preparation.preflightLifecycle = async () => { throw Error(secret); };
  await assert.rejects(f.service.restart('server'), new RegExp(REJECTED));
  assert.equal(f.service.get('server').status, 'running');
  f.preparation.preflightLifecycle = async () => {};
  const restart = f.service.restart('server');
  await until(() => f.handles.length === 2);
  assert.notEqual(f.handles[1].launchId, f.handles[0].launchId);
  f.handles[1].accept();
  assert.equal((await restart).restartCount, 1);
  assert.equal(f.preparation.reads, 2);
  await f.service.stop('server');
});

test('external stop cancels a restart paused in preflight', async () => {
  const f = fixture(), starting = f.service.start('server', 'runtime');
  await until(() => f.handles.length); f.handles[0].accept(); await starting;
  const gate = deferred();
  f.preparation.preflightLifecycle = () => gate.promise;
  const restart = f.service.restart('server');
  const rejected = assert.rejects(restart, new RegExp(CANCELLED));
  await f.service.stop('server'); gate.resolve(); await rejected;
  assert.equal(f.preparation.reads, 1);
  assert.equal(f.service.get('server').status, 'stopped');
});

test('unexpected post-READY exit emits one static error and remains ERROR', async () => {
  const f = fixture(), starting = f.service.start('server', 'runtime');
  await until(() => f.handles.length); f.handles[0].accept(); await starting;
  f.handles[0].exit();
  await until(() => f.emissions.some(e => e.name === 'process.error'));
  assert.equal(f.service.get('server').status, 'error');
  assert.equal(f.emissions.filter(e => e.name === 'process.error').length, 1);
  assert.equal(f.emissions.find(e => e.name === 'process.error').value.error.message, REJECTED);
  await f.service.stop('server');
});

test('ProcessManager routes recovery by owned trusted identity despite a legacy caller config', async () => {
  const f = fixture();
  const manager = Object.create(ProcessManagerService.prototype);
  manager.trustedProcesses = f.service;
  let starts = 0, restarts = 0;
  f.service.start = async () => { starts++; return {}; };
  f.service.owns = () => true;
  f.service.restart = async () => { restarts++; return {}; };
  await manager.startProcess({ id: 's', managedLaunch: { mode: MODE, runtimeAssetId: 'r' } });
  await manager.restartProcess('s', { scriptPath: 'server.js', env: { SECRET: secret } });
  await assert.rejects(manager.startProcess({ id: 's', scriptPath: 'server.js' }), new RegExp(REJECTED));
  assert.equal(starts, 1); assert.equal(restarts, 1);
});

function recoveryFixture() {
  const log = memoryRepository(), events = new EventEmitter2(), calls = [];
  const info = { status: 'error', config: { id: 's', name: 's', scriptPath: '', args: [],
    managedLaunch: { mode: MODE, runtimeAssetId: 'r', autoRestart: true } } };
  const manager = { getProcessInfo: () => info, restartProcess: async (id, config) => {
    calls.push({ id, config }); info.status = 'running'; return info;
  } };
  const service = new ProcessErrorHandlerService(log, log, manager, events, { get: (_k, d) => d });
  service.config.restartDelay = 5;
  return { service, info, calls, manager, log };
}
test('automatic error recovery uses sanitized descriptor and retains bounded attempt count', async () => {
  const f = recoveryFixture();
  await f.service.handleProcessError({ processId: 's', errorType: 'process_exit', error: Error(REJECTED), timestamp: new Date() });
  await until(() => f.calls.length);
  assert.equal(f.calls[0].config.scriptPath, '');
  assert.equal(f.calls[0].config.env, undefined);
  assert.equal(f.service.getRestartAttempts('s'), 1);
  f.service.onModuleDestroy();
});
for (const stopped of [true, false]) test(`automatic recovery respects ${stopped ? 'stop/cancel' : 'persisted autoRestart off'}`, async () => {
  const f = recoveryFixture();
  if (!stopped) f.info.config.managedLaunch.autoRestart = false;
  await f.service.handleProcessError({ processId: 's', errorType: 'process_exit', error: Error(REJECTED), timestamp: new Date() });
  if (stopped) { f.service.cancelRestart('s'); f.info.status = 'stopped'; }
  await new Promise(r => setTimeout(r, 30));
  assert.equal(f.calls.length, 0);
  f.service.onModuleDestroy();
});
test('automatic failed recovery exhausts the bounded retry budget without secret config', async () => {
  const f = recoveryFixture();
  f.service.config.maxRestartAttempts = 2;
  f.manager.restartProcess = async () => { f.calls.push('failed'); throw Error(REJECTED); };
  await f.service.handleProcessError({ processId: 's', errorType: 'process_exit', error: Error(REJECTED), timestamp: new Date() });
  await until(() => f.calls.length === 2);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(f.calls.length, 2);
  assert.equal(f.service.getRestartAttempts('s'), 2);
  f.service.onModuleDestroy();
});

// Channel-only race and timeout controls: real wire validator, controlled
// ChildProcess and clock; business READY is covered below with the product entry.
function channelSandbox(abortAt) {
  const ts = require('typescript'), vm = require('node:vm'), { EventEmitter } = require('node:events');
  const controller = new AbortController(), timers = new Map(), sent = [], launches = [];
  const child = new EventEmitter();
  Object.assign(child, { pid: 999999, connected: true,
    stdout: { resume() {}, destroy() {} }, stderr: { resume() {}, destroy() {} },
    stdin: { end() {}, destroy() {} }, send(x, cb) { sent.push(x); cb?.(); },
    kill() { child.emit('exit', null, 'SIGKILL'); return true; } });
  const localRequire = name => name === 'node:child_process' ? {
    spawn(...args) { launches.push(args); if (abortAt === 'spawn') controller.abort(); return child; },
  } : name === 'api-nova-server' ? { ...wire,
    parseManagedParentMessage: x => wire.parseManagedParentMessage(JSON.parse(JSON.stringify(x))),
  } : require(name);
  localRequire.resolve = () => { if (abortAt === 'resolve') controller.abort(); return 'fixed-entry.js'; };
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, 'managed-mcp-channel.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, { require: localRequire, exports, process: { execPath: process.execPath, env: {}, platform: process.platform },
    setTimeout(fn, ms) { const t = {}; timers.set(t, { fn, ms }); return t; },
    clearTimeout(t) { timers.delete(t); } });
  const payload = { version: 1, launchId: 'launch', managedServerId: 's', runtimeAssetId: 'r', inboundAuthMode: 'private_api_key',
    candidateRevision: 'candidate', verificationRunId: 'run', behaviorFingerprint: 'a'.repeat(64),
    transport: { type: 'streamable', host: '127.0.0.1', port: 9022, endpoint: '/mcp' }, openApiData: { openapi: '3.0.3', paths: {} },
    trustedOperationBindings: [], registrySource: { configId: 'registry', path: path.resolve(__dirname, 'unused.json'),
      format: 'json', environment: 'test', expectedRevision: 'r1', expectedContentDigest: 'b'.repeat(64) } };
  return { start: () => exports.startManagedMcpChannel({ launchId: 'launch', serverId: 's', payload,
    signal: controller.signal, approvedEnvironmentNames: [], environmentValues: {} }),
    child, controller, timers, sent, launches,
    fire(ms) { for (const t of [...timers.values()]) if (t.ms === ms) t.fn(); } };
}
test('abort during entry resolution prevents spawn', async () => {
  const f = channelSandbox('resolve');
  await assert.rejects(f.start(), /MANAGED_CHANNEL_FAILED/);
  assert.equal(f.launches.length, 0); assert.equal(f.sent.length, 0);
});
test('abort between spawn and listener registration sends no handoff and cleans up', async () => {
  const f = channelSandbox('spawn'), rejected = assert.rejects(f.start(), /MANAGED_CHILD_EXITED/);
  assert.equal(f.sent.some(x => x.type === 'handoff'), false);
  f.fire(wire.MANAGED_HANDOFF_LIMITS.shutdownMs);
  await rejected;
  assert.equal(f.timers.size, 0);
  assert.equal(f.child.listenerCount('message'), 0);
});
test('ACK timeout rejects READY, closes child and clears all channel timers/listeners', async () => {
  const f = channelSandbox(), started = f.start();
  f.child.emit('message', { type: 'handoffAccepted', launchId: 'launch' });
  const handle = await started;
  assert.equal(handle.state, 'handoffAccepted');
  const rejected = assert.rejects(handle.ready, /MANAGED_HANDSHAKE_TIMEOUT/);
  f.fire(wire.MANAGED_HANDOFF_LIMITS.handshakeMs); f.fire(wire.MANAGED_HANDOFF_LIMITS.shutdownMs);
  await rejected;
  assert.equal((await handle.closed).code, 'MANAGED_HANDSHAKE_TIMEOUT');
  assert.equal(f.timers.size, 0);
  assert.equal(f.child.listenerCount('message'), 0);
});

function removeFixtureDirectory(dir) {
  const target = path.resolve(dir), parent = path.resolve(os.tmpdir());
  assert.equal(path.dirname(target), parent, 'cleanup must stay in the temporary directory');
  assert.match(path.basename(target), /^apinova-np20-[A-Za-z0-9]+$/);
  fs.rmSync(target, { recursive: true, force: true });
}

async function realFixture({ nest = false, instrument } = {}) {
  const { DataSource } = require('typeorm');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apinova-np20-'));
  let db, app;
  try {
  const load = (file, name) => require('../../../database/entities/' + file + '.entity.ts')[name];
  const Asset = load('runtime-asset', 'RuntimeAssetEntity'), Member = load('runtime-asset-endpoint-binding', 'RuntimeAssetEndpointBindingEntity');
  const Endpoint = load('endpoint-definition', 'EndpointDefinitionEntity'), Source = load('source-service-asset', 'SourceServiceAssetEntity');
  const Profile = load('publication-profile', 'PublicationProfileEntity'), Publish = load('endpoint-publish-binding', 'EndpointPublishBindingEntity');
  const Server = load('mcp-server', 'MCPServerEntity'), Run = load('runtime-verification-run', 'RuntimeVerificationRunEntity');
  const Upstream = load('runtime-upstream-binding', 'RuntimeUpstreamBindingEntity');
  const { ProcessInfoEntity } = require('../entities/process-info.entity.ts');
  const { HealthCheckResultEntity } = require('../entities/health-check-result.entity.ts');
  db = new DataSource({ type: 'sqljs', synchronize: true, entities: [Asset, Member, Endpoint, Source, Profile, Publish, Server, Run, Upstream, ProcessInfoEntity, HealthCheckResultEntity] });
  await db.initialize();
  const ids = Array.from({ length: 9 }, () => randomUUID());
  const [runtime, membership, endpoint, source, serverId, runId, upstream, publish] = ids;
  const probe = net.createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  const spec = { openapi: '3.0.3', info: { title: 'np20', version: '1' }, servers: [{ url: 'http://127.0.0.1:1' }],
    paths: { '/items': { get: { operationId: 'items', responses: { '200': { description: 'OK' } } } } } };
  const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object' ?
    Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : x;
  const hash = x => createHash('sha256').update(x).digest('hex');
  const fingerprint = hash(JSON.stringify(canonical(spec)));
  await db.getRepository(Asset).save({ id: runtime, name: 'np20', type: 'mcp_server', metadata: {
    managedServerId: serverId, activeRevision: 'candidate1', lastVerificationRunId: runId, activeMcpBehaviorFingerprint: fingerprint, verificationRequired: false } });
  await db.getRepository(Source).save({ id: source, sourceKey: 'np20' });
  await db.getRepository(Endpoint).save({ id: endpoint, sourceServiceAssetId: source, method: 'GET', path: '/items', rawOperation: spec.paths['/items'].get });
  await db.getRepository(Member).save({ id: membership, runtimeAssetId: runtime, endpointDefinitionId: endpoint, enabled: true });
  await db.getRepository(Publish).save({ id: publish, endpointDefinitionId: endpoint, runtimeAssetEndpointBindingId: membership, publishedToMcp: true });
  await db.getRepository(Upstream).save({ id: upstream, runtimeAssetEndpointBindingId: membership, sourceServiceAssetId: source, environment: 'test', selectionMode: 'fixed_primary', status: 'active', revision: 1 });
  await db.getRepository(Server).save({ id: serverId, name: 'np20', inboundAuthMode: 'private_api_key', openApiData: spec, port, transport: 'streamable', config: {
    managedMcpMode: MODE, endpoint: '/mcp', runtimeAssetId: runtime, managedByRuntimeAsset: true, verifiedCandidateRevision: 'candidate1',
    verificationRunId: runId, behaviorFingerprint: fingerprint, autoRestart: false } });
  await db.getRepository(Run).save({ id: runId, runtimeAssetId: runtime, candidateRevision: 'candidate1', trigger: 'deploy', status: 'passed', activationStatus: 'activated',
    metadata: { behaviorFingerprint: fingerprint, mcpEndpointConfig: { transport: 'streamable', port, endpointPath: '/mcp' } },
    upstreamBindingRevisions: [{ runtimeMembershipId: membership, bindingId: upstream, revision: 1 }] });
  const registry = { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings',
    metadata: { revision: 'r1', environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true },
    secretProviders: { env: { type: 'env' } }, credentials: { token: { type: 'bearer', secretRef: 'env:SYNTHETIC_NP20' } },
    sites: [{ id: 'np20', sourceServiceAssetId: source, match: { scheme: 'http', host: '127.0.0.1', port: 1, basePath: '/' },
      credential: 'none', allowedHosts: ['127.0.0.1'], endpoints: [] }] };
  const registryPath = path.join(dir, 'registry.json');
  fs.writeFileSync(registryPath, JSON.stringify(registry));
  const values = { SYNTHETIC_NP20: secret, API_NOVA_RUNTIME_AUTH_MODE: 'api_key', API_NOVA_MCP_RESOURCE: 'https://np20.example/mcp',
    API_NOVA_RUNTIME_API_KEYS: JSON.stringify([{ id: 'consumer', subject: 'np20', secretHash: hash(secret),
      expiresAt: Math.floor(Date.now() / 1000) + 600, resources: ['https://np20.example/mcp'], scopes: [] }]) };
  const sources = { [runtime]: { registrySource: { configId: 'np20', path: registryPath, format: 'json', environment: 'test',
    expectedRevision: 'r1', expectedContentDigest: hash(JSON.stringify(registry)) }, approvedEnvironmentNames: Object.keys(values) } };
  values.PID_DIRECTORY = path.join(dir, 'pids'); values.LOG_DIRECTORY = path.join(dir, 'logs');
  const config = { get: (key, defaultValue) => key === 'managedMcp.handoffSources' ? sources : values[key] ?? defaultValue };
  const Preparation = instrument?.Preparation || ManagedMcpHandoffPreparationService;
  const prep = new Preparation(db, config), events = new EventEmitter2(), emissions = [];
  // Diagnose fixture inputs without changing the production fail-closed errors.
  assert.doesNotThrow(() => prep.source(runtime), 'synthetic protected source');
  await assert.doesNotReject(prep.snapshot(runtime, serverId, 'preflight'), 'synthetic ownership snapshot');
  await assert.doesNotReject(require('api-nova-parser').readStableUpstreamCredentialText(registryPath), 'synthetic stable registry file');
  assert.doesNotThrow(() => require('api-nova-parser').parseUpstreamCredentialBindings(JSON.stringify(registry), 'json'), 'synthetic registry schema');
  events.onAny((name, value) => emissions.push({ name, value }));
  const logs = memoryRepository();
  let managed, pm, health, lifecycle, recovery, manager;
  const createLifecycle = (pm, health) => new ServerLifecycleService({}, config, {}, events, pm, health,
    { recordRuntimeControlEvent: async () => {} }, { parseSpecification() { throw Error('legacy parser called'); } }, {});
  const createManager = (lifecycle, pm, health, recovery) => new ServerManagerService(
    db.getRepository(Server), logs, lifecycle, pm, health, recovery, {}, events, { createLog: async () => {} });
  if (nest) {
    const { Module } = require('@nestjs/common'), { NestFactory } = require('@nestjs/core');
    const { HttpService } = require('@nestjs/axios');
    const { ProcessResourceMonitorService } = require('./process-resource-monitor.service.ts');
    const { ProcessLogMonitorService } = require('./process-log-monitor.service.ts');
    class LifecycleTestModule {}
    // Real Nest provider lifecycle and real HTTP health checks. Database, event
    // bus and unrelated logging/observability dependencies are local fixtures.
    Module({ providers: [
      { provide: ManagedMcpProcessService, useFactory: () => new ManagedMcpProcessService(prep, events, db.getRepository(ProcessInfoEntity)) },
      { provide: ProcessManagerService, inject: [ManagedMcpProcessService], useFactory: managed =>
        new ProcessManagerService(db.getRepository(ProcessInfoEntity), logs, events, config, {},
          new ProcessResourceMonitorService(events), new ProcessLogMonitorService(events), undefined, undefined, managed) },
      { provide: ProcessHealthService, inject: [ProcessManagerService], useFactory: pm =>
        new ProcessHealthService(db.getRepository(HealthCheckResultEntity), db.getRepository(Server), pm, events, config,
          { healthCheckInterval: 25, healthCheckTimeout: 1000 }, new HttpService()) },
      { provide: ServerLifecycleService, inject: [ProcessManagerService, ProcessHealthService], useFactory: createLifecycle },
      { provide: ProcessErrorHandlerService, inject: [ProcessManagerService], useFactory: pm =>
        new ProcessErrorHandlerService(logs, db.getRepository(ProcessInfoEntity), pm, events, config) },
      { provide: ServerManagerService, inject: [ServerLifecycleService, ProcessManagerService, ProcessHealthService, ProcessErrorHandlerService],
        useFactory: createManager },
    ] })(LifecycleTestModule);
    app = await NestFactory.createApplicationContext(LifecycleTestModule, { logger: false, abortOnError: false });
    [managed, pm, health, lifecycle, recovery, manager] = [
      ManagedMcpProcessService, ProcessManagerService, ProcessHealthService, ServerLifecycleService, ProcessErrorHandlerService, ServerManagerService,
    ].map(provider => app.get(provider));
  } else {
    managed = new ManagedMcpProcessService(prep, events, db.getRepository(ProcessInfoEntity));
    pm = Object.create(ProcessManagerService.prototype);
    pm.trustedProcesses = managed; pm.processInfo = new Map();
    health = { starts: 0, startHealthCheck: async () => { health.starts++; }, stopHealthCheck() {} };
    lifecycle = createLifecycle(pm, health);
    recovery = new ProcessErrorHandlerService(logs, db.getRepository(ProcessInfoEntity), pm, events, config);
    manager = createManager(lifecycle, pm, health, recovery);
  }
  return { db, prep, managed, pm, manager, lifecycle, recovery, health, events, emissions, sources, values, registryPath, app,
    serverId, runtime, Server, ProcessInfoEntity, Upstream, upstream,
    start: () => manager.startServer(serverId, { runtimeAssetId: runtime, candidateRevision: 'candidate1' }),
    async cleanup() {
      if (app) await app.close();
      else { await recovery.onModuleDestroy(); await managed.onModuleDestroy(); }
      await instrument?.assertDrained();
      await db.destroy();
      removeFixtureDirectory(dir);
    } };
  } catch (error) {
    await app?.close();
    if (db?.isInitialized) await db.destroy();
    removeFixtureDirectory(dir);
    throw error;
  }
}

test('real persisted lifecycle -> product IPC child -> READY -> RUNNING -> fresh restart -> stop', { timeout: 30000 }, async () => {
  const f = await realFixture();
  const launches = [];
  const original = f.prep.startLifecycle.bind(f.prep);
  f.prep.startLifecycle = async (...args) => { const handle = await original(...args); launches.push(handle); return handle; };
  try {
    await f.start();
    const first = f.pm.getProcessInfo(f.serverId);
    assert.equal(first.status, 'running');
    assert.equal(f.health.starts, 1);
    assert.equal((await f.db.getRepository(f.Server).findOneByOrFail({ id: f.serverId })).status, 'running');
    assert.equal(launches[0].state, 'runtimeReady');
    assert.equal((await fetch(`http://127.0.0.1:${(await f.db.getRepository(f.Server).findOneByOrFail({ id: f.serverId })).port}/mcp`)).status, 401);
    await f.pm.restartProcess(f.serverId, { id: f.serverId, scriptPath: 'server.js', env: { SECRET: secret } });
    assert.notEqual(launches[0].launchId, launches[1].launchId);
    assert.notEqual(first.pid, f.pm.getProcessInfo(f.serverId).pid);
    assert.equal(f.health.starts, 2);
    assert.throws(() => process.kill(first.pid, 0));
    assert.equal(JSON.stringify(f.emissions).includes(secret), false);
    assert.equal(JSON.stringify(f.pm.getProcessInfo(f.serverId)).includes('registrySource'), false);
    await f.manager.stopServer(f.serverId);
    assert.equal(f.pm.getProcessInfo(f.serverId).status, 'stopped');
    assert.equal((await f.db.getRepository(f.ProcessInfoEntity).findOneByOrFail({ serverId: f.serverId })).status, 'stopped');
    assert.throws(() => process.kill(launches[1].pid, 0));
  } finally { await f.cleanup(); }
});

test('persisted source/revision drift rejects restart before stopping a healthy child', { timeout: 30000 }, async () => {
  const f = await realFixture();
  try {
    await f.start();
    const before = f.pm.getProcessInfo(f.serverId);
    await f.db.getRepository(f.Upstream).update(f.upstream, { revision: 2 });
    await assert.rejects(f.pm.restartProcess(f.serverId, before.config), new RegExp(REJECTED));
    assert.equal(f.pm.getProcessInfo(f.serverId).pid, before.pid);
    assert.equal(f.pm.getProcessInfo(f.serverId).status, 'running');
  } finally { await f.cleanup(); }
});

test('real child crash automatically recaptures a fresh generation and resumes health checks', { timeout: 30000 }, async () => {
  const f = await realFixture(), launches = [];
  const original = f.prep.startLifecycle.bind(f.prep);
  f.prep.startLifecycle = async (...args) => { const handle = await original(...args); launches.push(handle); return handle; };
  try {
    const server = await f.db.getRepository(f.Server).findOneByOrFail({ id: f.serverId });
    await f.db.getRepository(f.Server).update(f.serverId, { config: { ...server.config, autoRestart: true } });
    f.recovery.config.restartDelay = 5;
    await f.start();
    const first = f.pm.getProcessInfo(f.serverId);
    // Only terminate the exact child created and owned by this fixture.
    assert.equal(first.pid, launches[0].pid);
    process.kill(first.pid, 'SIGKILL');
    await until(() => f.emissions.some(e => e.name === 'process.restart_success'));
    const restarted = f.pm.getProcessInfo(f.serverId);
    assert.equal(restarted.status, 'running');
    assert.notEqual(restarted.pid, first.pid);
    assert.notEqual(launches[0].launchId, launches[1].launchId);
    assert.equal(f.health.starts, 2);
    assert.equal(f.recovery.getRestartAttempts(f.serverId), 1);
    assert.equal((await f.db.getRepository(f.Server).findOneByOrFail({ id: f.serverId })).status, 'running');
    assert.equal(JSON.stringify(f.emissions).includes(secret), false);
  } finally { await f.cleanup(); }
});

test('product stop during persisted preparation cancels start without a child or late RUNNING', async () => {
  const f = await realFixture(), gate = deferred(), entered = deferred();
  const original = f.prep.preflightLifecycle.bind(f.prep);
  f.prep.preflightLifecycle = async (...args) => { entered.resolve(); await gate.promise; return original(...args); };
  try {
    const starting = f.start(), rejected = assert.rejects(starting, new RegExp(CANCELLED));
    await entered.promise;
    await f.manager.stopServer(f.serverId);
    gate.resolve();
    await rejected;
    assert.equal(f.pm.getProcessInfo(f.serverId), undefined);
    assert.equal((await f.db.getRepository(f.Server).findOneByOrFail({ id: f.serverId })).status, 'stopped');
    assert.equal(f.health.starts, 0);
    assert.equal(f.emissions.some(e => e.name === 'process.started'), false);
  } finally { gate.resolve(); await f.cleanup(); }
});

test('persisted trusted mode refuses secrets and never invokes legacy ProcessManager', async () => {
  const f = await realFixture();
  try {
    await f.db.getRepository(f.Server).update(f.serverId, { authConfig: { type: 'bearer', config: { bearerToken: secret } } });
    await assert.rejects(f.start(), /LIFECYCLE_REJECTED|PREPARATION_REJECTED/);
    assert.equal(f.pm.getProcessInfo(f.serverId), undefined);
    assert.equal(f.health.starts, 0);
    assert.equal(JSON.stringify(f.emissions).includes(secret), false);
  } finally { await f.cleanup(); }
});

test('real child bootstrap failure leaves ERROR and emits no started event or health check', { timeout: 30000 }, async () => {
  const f = await realFixture();
  try {
    f.values.API_NOVA_RUNTIME_API_KEYS = '[]';
    await assert.rejects(f.start(), new RegExp(REJECTED));
    assert.equal(f.pm.getProcessInfo(f.serverId).status, 'error');
    assert.equal((await f.db.getRepository(f.Server).findOneByOrFail({ id: f.serverId })).status, 'error');
    assert.equal(f.health.starts, 0);
    assert.equal(f.emissions.some(e => e.name === 'process.started'), false);
  } finally { await f.cleanup(); }
});

test('autoRestart disabled after preflight is refused by fresh capture before another child', { timeout: 30000 }, async () => {
  const f = await realFixture();
  try {
    const server = await f.db.getRepository(f.Server).findOneByOrFail({ id: f.serverId });
    await f.db.getRepository(f.Server).update(f.serverId, { config: { ...server.config, autoRestart: true } });
    await f.start();
    const before = f.pm.getProcessInfo(f.serverId), preflight = f.prep.preflightLifecycle.bind(f.prep);
    f.prep.preflightLifecycle = async (...args) => {
      await preflight(...args);
      await f.db.getRepository(f.Server).update(f.serverId, { config: { ...server.config, autoRestart: false } });
    };
    await assert.rejects(f.pm.restartProcess(f.serverId, before.config, true), new RegExp(REJECTED));
    assert.equal(f.pm.getProcessInfo(f.serverId).status, 'error');
    assert.equal(f.pm.getProcessInfo(f.serverId).pid, 0);
    assert.equal(f.emissions.filter(e => e.name === 'process.started').length, 1);
    assert.throws(() => process.kill(before.pid, 0));
  } finally { await f.cleanup(); }
});

async function assertTerminal(f, instrument, status) {
  assert.equal(f.pm.getProcessInfo(f.serverId)?.status, status);
  assert.equal((await f.db.getRepository(f.Server).findOneByOrFail({ id: f.serverId })).status, status);
  assert.equal((await f.db.getRepository(f.ProcessInfoEntity).findOneByOrFail({ serverId: f.serverId })).status, status);
  assert.equal(f.health.healthCheckIntervals.size, 0);
  assert.equal(f.health.pendingHealthStarts.size, 0);
  assert.equal(f.health.activeHealthChecks.size, 0);
  assert.equal(f.recovery.restartTimers.size, 0);
  assert.equal(f.recovery.activeRecoveries.size, 0);
  assert.equal(f.managed.restarts.size, 0);
  assert.equal(f.managed.restartCompletions.size, 0);
  assert.equal(f.manager.trustedStarts.size, 0);
  assert.equal(f.manager.trustedStartCompletions.size, 0);
  assert.equal(f.manager.startingServers.size, 0);
  assert.equal(f.managed.launches.get(f.serverId)?.handle, undefined);
  assert.equal(f.managed.launches.get(f.serverId)?.detachSignal, undefined);
  assert.equal(JSON.stringify(f.emissions).includes(secret), false);
  await instrument.assertDrained();
}

test('real Nest close drains running product child, HTTP health intervals and process listeners', { timeout: 30000 }, async () => {
  const instrument = instrumentedPreparation(), f = await realFixture({ nest: true, instrument });
  try {
    await f.start();
    assert.equal(f.health.healthCheckIntervals.size, 1, 'real periodic health checks installed');
    await until(() => f.emissions.filter(e => e.name === 'process.health_check').length >= 2);
    assert.equal(f.emissions.some(e => e.name === 'process.health_check' && e.value.data.healthy), true);
    await f.app.close();
    await assertTerminal(f, instrument, 'stopped');
    for (const name of ['process.started', 'process.stopped', 'process.error', 'process.restart_success',
      'process.health_check_failed', 'process.resource_update']) assert.equal(f.events.listenerCount(name), 0);
    const count = f.emissions.length;
    await new Promise(r => setTimeout(r, 100));
    assert.equal(f.emissions.length, count, 'no late health/recovery events after close');
    await assert.rejects(f.start(), new RegExp(REJECTED));
  } finally { await f.cleanup(); }
});

test('real Nest close cancels a queued post-crash restart instead of launching after teardown', { timeout: 30000 }, async () => {
  const instrument = instrumentedPreparation(), f = await realFixture({ nest: true, instrument });
  try {
    const server = await f.db.getRepository(f.Server).findOneByOrFail({ id: f.serverId });
    await f.db.getRepository(f.Server).update(f.serverId, { config: { ...server.config, autoRestart: true } });
    f.recovery.config.restartDelay = 5000;
    await f.start();
    assert.equal(f.pm.getProcessInfo(f.serverId).pid, instrument.children[0].pid);
    instrument.children[0].kill('SIGKILL');
    await until(() => f.recovery.restartTimers.size === 1);
    await f.app.close();
    await assertTerminal(f, instrument, 'stopped');
    assert.equal(f.recovery.restartAttempts.size, 0);
    assert.equal(instrument.children.length, 1);
    assert.equal(f.emissions.some(e => e.name === 'process.restart_success'), false);
  } finally { await f.cleanup(); }
});

test('real Nest close cancels pending persisted preflight and waits for its terminal projection', { timeout: 30000 }, async () => {
  const instrument = instrumentedPreparation(), f = await realFixture({ nest: true, instrument });
  const gate = deferred(), entered = deferred(), original = f.prep.preflightLifecycle.bind(f.prep);
  f.prep.preflightLifecycle = async (...args) => { entered.resolve(); await gate.promise; return original(...args); };
  try {
    const rejected = assert.rejects(f.start(), new RegExp(CANCELLED));
    await entered.promise;
    const closing = f.app.close();
    await until(() => f.manager.shuttingDown);
    gate.resolve();
    await closing; await rejected;
    assert.equal((await f.db.getRepository(f.Server).findOneByOrFail({ id: f.serverId })).status, 'stopped');
    assert.equal(instrument.children.length, 0);
    assert.equal(f.manager.trustedStarts.size, 0);
    assert.equal(f.manager.trustedStartCompletions.size, 0);
    assert.equal(f.health.healthCheckIntervals.size, 0);
    assert.equal(f.emissions.some(e => e.name === 'process.started'), false);
  } finally { gate.resolve(); await f.cleanup(); }
});

test('real Nest close drains an in-flight automatic restart preflight with no replacement child', { timeout: 30000 }, async () => {
  const instrument = instrumentedPreparation(), f = await realFixture({ nest: true, instrument });
  const gate = deferred(), entered = deferred();
  try {
    const server = await f.db.getRepository(f.Server).findOneByOrFail({ id: f.serverId });
    await f.db.getRepository(f.Server).update(f.serverId, { config: { ...server.config, autoRestart: true } });
    f.recovery.config.restartDelay = 5;
    await f.start();
    const original = f.prep.preflightLifecycle.bind(f.prep);
    f.prep.preflightLifecycle = async (...args) => { entered.resolve(); await gate.promise; return original(...args); };
    instrument.children[0].kill('SIGKILL');
    await entered.promise;
    assert.equal(f.recovery.activeRecoveries.size, 1);
    const closing = f.app.close();
    await until(() => f.managed.shuttingDown && f.recovery.shuttingDown);
    gate.resolve();
    await closing;
    await assertTerminal(f, instrument, 'stopped');
    assert.equal(instrument.children.length, 1);
    assert.equal(f.emissions.some(e => e.name === 'process.restart_success'), false);
  } finally { gate.resolve(); await f.cleanup(); }
});

for (const shutdown of [true, false]) test(`real ${shutdown ? 'Nest shutdown' : 'product stop'} during a pending initial HTTP health response creates no late timer`, { timeout: 30000 }, async () => {
  const instrument = instrumentedPreparation(), f = await realFixture({ nest: true, instrument });
  const http = require('node:http'), incoming = deferred();
  const slow = http.createServer((_req, res) => incoming.resolve(res));
  await new Promise(r => slow.listen(0, '127.0.0.1', r));
  const get = f.health.httpService.get.bind(f.health.httpService);
  // Only this test's dependency instance redirects health traffic to a real,
  // controlled slow HTTP peer; the product child and its READY are unmodified.
  f.health.httpService.get = (_url, config) => get(`http://127.0.0.1:${slow.address().port}/health`, config);
  let response;
  try {
    const rejected = assert.rejects(f.start(), new RegExp(CANCELLED));
    response = await incoming.promise;
    assert.equal(f.health.pendingHealthStarts.size, 1);
    const closing = shutdown ? f.app.close() : f.manager.stopServer(f.serverId);
    await until(() => shutdown ? f.health.isShuttingDown && f.manager.shuttingDown : f.health.pendingHealthStarts.size === 0);
    response.end('OK');
    await closing; await rejected;
    await assertTerminal(f, instrument, 'stopped');
    if (!shutdown) await f.app.close();
    const count = f.emissions.length;
    await f.health.startHealthCheck(f.serverId);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(f.health.healthCheckIntervals.size, 0);
    assert.equal(f.emissions.length, count);
  } finally {
    response?.end();
    slow.closeAllConnections();
    await new Promise(r => slow.close(r));
    await f.cleanup();
  }
});

test('real handshake deadline and force-kill produce ERROR without READY or hidden retry', { timeout: 50000 }, async () => {
  const instrument = instrumentedPreparation({ unresponsive: true }), f = await realFixture({ nest: true, instrument });
  let ignoredStop = '';
  try {
    const before = Date.now(), rejected = assert.rejects(f.start(), new RegExp(REJECTED));
    await until(() => instrument.children.length === 1);
    instrument.children[0].stdout.on('data', chunk => { ignoredStop += chunk.toString(); });
    await until(() => f.managed.launches.get(f.serverId)?.handle);
    assert.equal(f.pm.getProcessInfo(f.serverId).status, 'starting', 'real ACK must not publish RUNNING');
    await rejected;
    assert.ok(Date.now() - before >= instrument.limits.handshakeMs + instrument.limits.shutdownMs - 100);
    assert.match(ignoredStop, /NP20_STOP_IGNORED/);
    assert.deepEqual(instrument.kills, [{ pid: instrument.children[0].pid, signal: 'SIGKILL' }]);
    assert.equal(instrument.stopMessages.length, 1);
    assert.equal(f.emissions.some(e => e.name === 'process.started'), false);
    assert.equal(f.emissions.some(e => e.name === 'process.restart_success'), false);
    await assertTerminal(f, instrument, 'error');
    await f.manager.stopServer(f.serverId);
    await assertTerminal(f, instrument, 'stopped');
  } finally { await f.cleanup(); }
});

test('explicit product stop during real ACK wait wins after the unresponsive child is force-killed', { timeout: 20000 }, async () => {
  const instrument = instrumentedPreparation({ unresponsive: true }), f = await realFixture({ nest: true, instrument });
  try {
    const rejected = assert.rejects(f.start(), new RegExp(CANCELLED));
    await until(() => f.managed.launches.get(f.serverId)?.handle);
    const before = Date.now();
    await f.manager.stopServer(f.serverId); await rejected;
    assert.ok(Date.now() - before >= instrument.limits.shutdownMs - 100);
    assert.deepEqual(instrument.kills, [{ pid: instrument.children[0].pid, signal: 'SIGKILL' }]);
    await assertTerminal(f, instrument, 'stopped');
    assert.equal(f.emissions.some(e => e.name === 'process.started'), false);
    assert.equal(f.emissions.some(e => e.name === 'process.error'), false);
  } finally { await f.cleanup(); }
});
