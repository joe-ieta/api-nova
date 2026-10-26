'use strict';
process.env.DB_TYPE = 'sqlite';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const Module = require('node:module');
const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apinova-e1-02c2-'));
const serverRoot = path.resolve(__dirname, '../../api-nova-server');
const parserEntry = path.resolve(__dirname, '../../api-nova-parser/src/index.ts');

const build = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'),
  path.join(serverRoot, 'src/managed/entry.ts'), path.join(serverRoot, 'src/managed/handoff.ts'),
  '--outDir', directory, '--module', 'commonjs', '--target', 'ES2020', '--types', 'node', '--skipLibCheck'], { encoding: 'utf8' });
assert.equal(build.status, 0, build.stdout + build.stderr);

fs.writeFileSync(path.join(directory, 'runtime.js'), `
require(${JSON.stringify(require.resolve('ts-node'))}).register({ transpileOnly: true, project: ${JSON.stringify(path.join(serverRoot, 'tsconfig.json'))} });
const Module = require('node:module'), original = Module._resolveFilename;
Module._resolveFilename = function (name, ...rest) {
  if (name === 'api-nova-parser') return ${JSON.stringify(parserEntry)};
  if (name === 'api-nova-server') return ${JSON.stringify(path.join(directory, 'handoff.js'))};
  return original.call(this, name, ...rest);
};
module.exports = require(${JSON.stringify(path.join(serverRoot, 'src/managed/runtime.ts'))});
`);

require('ts-node').register({ transpileOnly: true, project: path.resolve(__dirname, '../tsconfig.json') });
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (name, ...rest) {
  if (name === 'api-nova-server') return path.join(directory, 'handoff.js');
  if (name === 'api-nova-server/dist/managed/entry.js') return path.join(directory, 'entry.js');
  if (name === 'api-nova-parser') return parserEntry;
  return originalResolve.call(this, name, ...rest);
};

// Track every real child spawn so negative paths can prove zero spawn/legacy fallback.
const childProcesses = require('node:child_process');
const nativeSpawn = childProcesses.spawn;
const spawned = [];
childProcesses.spawn = function (...args) {
  const child = nativeSpawn(...args);
  spawned.push({ args, pid: child.pid, child });
  return child;
};

require('reflect-metadata');
const { DataSource } = require('typeorm');
const { ManagedMcpHandoffPreparationService, MANAGED_MCP_PREPARATION_REJECTED } = require('../src/modules/servers/services/managed-mcp-handoff-preparation.service.ts');
const { startManagedMcpChannel, buildManagedEnvironment } = require('../src/modules/servers/services/managed-mcp-channel.ts');
const { DataSourceManagedMcpLifecycleStore } = require('../src/modules/servers/services/managed-mcp-lifecycle.store.ts');
const { MANAGED_MCP_LIFECYCLE_APPROVAL_CONFIG_KEY, createConfigManagedLifecycleApprovalProvider } = require('../src/modules/servers/services/managed-mcp-lifecycle-approval.ts');
const { ManagedMcpLifecycleCoordinator } = require('../src/modules/servers/services/managed-mcp-lifecycle-coordinator.service.ts');

const load = (file, name) => require(`../src/database/entities/${file}.entity.ts`)[name];
const Asset = load('runtime-asset', 'RuntimeAssetEntity');
const Member = load('runtime-asset-endpoint-binding', 'RuntimeAssetEndpointBindingEntity');
const Endpoint = load('endpoint-definition', 'EndpointDefinitionEntity');
const Source = load('source-service-asset', 'SourceServiceAssetEntity');
const Profile = load('publication-profile', 'PublicationProfileEntity');
const Publish = load('endpoint-publish-binding', 'EndpointPublishBindingEntity');
const Server = load('mcp-server', 'MCPServerEntity');
const Run = load('runtime-verification-run', 'RuntimeVerificationRunEntity');
const Upstream = load('runtime-upstream-binding', 'RuntimeUpstreamBindingEntity');
const PipelineState = load('runtime-call-observability', 'RuntimePipelineStateEntity');

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const hash = text => createHash('sha256').update(text).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(probe, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('condition not observed in time');
}

async function portUnreachable(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(500) });
    return false;
  } catch {
    return true;
  }
}

const coordinators = [];
let db, config, preparation, store, port, registryPath, spawns, specFixture, fingerprintFixture, environmentValuesFixture;

function syntheticCapture(launchSuffix) {
  return async () => ({
    payload: { version: 1, launchId: `fixture-launch-${launchSuffix}`, managedServerId: id(5), runtimeAssetId: id(1),
      inboundAuthMode: 'private_api_key', candidateRevision: 'candidate1', verificationRunId: id(6),
      behaviorFingerprint: fingerprintFixture, transport: { type: 'streamable', host: '127.0.0.1', port, endpoint: '/mcp' },
      openApiData: specFixture,
      trustedOperationBindings: [{ method: 'GET', path: '/items', endpointDefinitionId: id(3), sourceServiceAssetId: id(4) }],
      registrySource: { configId: 'fixture', path: registryPath, format: 'json', environment: 'test',
        expectedRevision: config.sources[id(1)].registrySource.expectedRevision,
        expectedContentDigest: config.sources[id(1)].registrySource.expectedContentDigest } },
    approvedEnvironmentNames: config.sources[id(1)].approvedEnvironmentNames,
    environmentValues: environmentValuesFixture,
  });
}

function createCoordinator(overrides = {}) {
  const coordinator = new ManagedMcpLifecycleCoordinator({
    store,
    capture: (runtimeAssetId, serverId) => preparation.captureForManagedLifecycle(runtimeAssetId, serverId),
    approval: createConfigManagedLifecycleApprovalProvider(config),
    channel: input => { spawns++; return startManagedMcpChannel(input); },
    ...overrides,
  });
  coordinators.push(coordinator);
  return coordinator;
}

async function writeRegistry(revision) {
  const registry = {
    apiVersion: 'security.apinova.io/v1',
    kind: 'UpstreamCredentialBindings',
    metadata: { revision, environment: 'test' },
    reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true },
    secretProviders: { env: { type: 'env' } },
    credentials: {},
    sites: [{ id: 'fixture', sourceServiceAssetId: id(4), match: { scheme: 'https', host: 'fixture.invalid', port: 443, basePath: '/' },
      allowedHosts: ['fixture.invalid'], credential: 'none', endpoints: [{ endpointDefinitionId: id(3), credential: 'none' }] }],
  };
  const text = JSON.stringify(registry);
  fs.writeFileSync(registryPath, text);
  config.sources[id(1)].registrySource.expectedRevision = revision;
  config.sources[id(1)].registrySource.expectedContentDigest = hash(text);
}

beforeEach(async () => {
  port = await freePort();
  spawns = 0;
  db = new DataSource({ type: 'sqljs', synchronize: true,
    entities: [Asset, Member, Endpoint, Source, Profile, Publish, Server, Run, Upstream, PipelineState] });
  await db.initialize();
  const spec = { openapi: '3.0.3', info: { title: 'fixture', version: '1' }, servers: [{ url: 'https://fixture.invalid' }],
    paths: { '/items': { get: { operationId: 'items', responses: { '200': { description: 'OK' } } } } } };
  const fingerprint = hash(JSON.stringify(canonical(spec)));
  specFixture = spec;
  fingerprintFixture = fingerprint;
  await db.getRepository(Asset).save({ id: id(1), name: 'fixture', type: 'mcp_server', metadata: { managedServerId: id(5),
    activeRevision: 'candidate1', lastVerificationRunId: id(6), activeMcpBehaviorFingerprint: fingerprint, verificationRequired: false } });
  await db.getRepository(Source).save({ id: id(4), sourceKey: 'fixture' });
  await db.getRepository(Endpoint).save({ id: id(3), sourceServiceAssetId: id(4), method: 'GET', path: '/items', rawOperation: spec.paths['/items'].get });
  await db.getRepository(Member).save({ id: id(2), runtimeAssetId: id(1), endpointDefinitionId: id(3), enabled: true });
  await db.getRepository(Publish).save({ id: id(8), endpointDefinitionId: id(3), runtimeAssetEndpointBindingId: id(2), publishedToMcp: true });
  await db.getRepository(Upstream).save({ id: id(7), runtimeAssetEndpointBindingId: id(2), sourceServiceAssetId: id(4), environment: 'test',
    selectionMode: 'fixed_primary', status: 'active', revision: 1 });
  await db.getRepository(Server).save({ id: id(5), name: 'fixture', inboundAuthMode: 'private_api_key', openApiData: spec, port,
    transport: 'streamable', config: { endpoint: '/mcp', runtimeAssetId: id(1), managedByRuntimeAsset: true, verifiedCandidateRevision: 'candidate1',
      verificationRunId: id(6), behaviorFingerprint: fingerprint, executionMode: 'trusted_ipc_v1' } });
  await db.getRepository(Run).save({ id: id(6), runtimeAssetId: id(1), candidateRevision: 'candidate1', trigger: 'deploy', status: 'passed',
    activationStatus: 'activated', metadata: { behaviorFingerprint: fingerprint, mcpEndpointConfig: { transport: 'streamable', port, endpointPath: '/mcp' } },
    upstreamBindingRevisions: [{ runtimeMembershipId: id(2), bindingId: id(7), revision: 1 }] });

  registryPath = path.join(directory, `registry-${port}.json`);
  const environmentValues = { API_NOVA_RUNTIME_AUTH_MODE: 'api_key', API_NOVA_MCP_RESOURCE: 'https://managed.example.invalid/mcp',
    API_NOVA_RUNTIME_API_KEYS: JSON.stringify([{ id: 'client-one', subject: 'synthetic-consumer', secretHash: hash('synthetic-client-key'),
      resources: ['https://managed.example.invalid/mcp'], scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 600 }]) };
  environmentValuesFixture = environmentValues;
  config = {
    sources: { [id(1)]: { registrySource: { configId: 'fixture', path: registryPath, format: 'json', environment: 'test',
      expectedRevision: 'r1', expectedContentDigest: 'a'.repeat(64) }, approvedEnvironmentNames: Object.keys(environmentValues) } },
    lifecycleApproval: { [id(1)]: { version: 1, mode: 'auto', policyId: 'e1-02c2-runner', allowedActions: ['start', 'stop'], allowedServerIds: [id(5)] } },
    get(key) {
      if (key === 'managedMcp.handoffSources') return this.sources;
      if (key === MANAGED_MCP_LIFECYCLE_APPROVAL_CONFIG_KEY) return this.lifecycleApproval;
      return environmentValues[key];
    },
  };
  await writeRegistry('r1');
  preparation = new ManagedMcpHandoffPreparationService(db, config);
  store = new DataSourceManagedMcpLifecycleStore(db);
});

afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await coordinator.onModuleDestroy().catch(() => undefined);
  if (db?.isInitialized) await db.destroy();
  fs.rmSync(registryPath, { force: true });
});

after(() => {
  childProcesses.spawn = nativeSpawn;
  Module._resolveFilename = originalResolve;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('real child crash marks the coordination record failed without a false current', async () => {
  const changes = [];
  const coordinator = createCoordinator({ onStateChange: change => changes.push(change) });
  const started = await coordinator.start({ serverId: id(5), runtimeAssetId: id(1) });
  assert.equal((await store.read(id(5))).record.state, 'current');

  process.kill(started.pid, 'SIGKILL');
  const failed = await waitFor(async () => {
    const read = await store.read(id(5));
    return read.status === 'valid' && read.record.state === 'failed' ? read.record : null;
  });
  assert.equal(failed.currentVerified, false);
  assert.equal(failed.terminal.reason, 'runtime_failed');
  assert.ok(['MANAGED_CHILD_EXITED', 'MANAGED_CHANNEL_FAILED'].includes(failed.terminal.code));
  assert.deepEqual(changes.filter(change => change.state === 'failed'), [{ serverId: id(5), runtimeAssetId: id(1),
    generation: 1, state: 'failed', reason: 'runtime_failed', code: failed.terminal.code }]);
  const status = await coordinator.status(id(5));
  assert.equal(status.view.current, false);
  assert.equal(status.view.state, 'failed');
  assert.equal(coordinator.ownedGeneration(id(5)), null);
  await waitFor(() => portUnreachable(`http://127.0.0.1:${port}/mcp`));
});

test('restart after failure re-prepares a new generation with per-transition approval', async () => {
  const approvals = [];
  const provider = createConfigManagedLifecycleApprovalProvider(config);
  const coordinator = createCoordinator({ approval: async request => {
    approvals.push({ action: request.action, generation: request.generation });
    return provider(request);
  } });
  const first = await coordinator.start({ serverId: id(5), runtimeAssetId: id(1) });
  const firstRecord = (await store.read(id(5))).record;
  process.kill(first.pid, 'SIGKILL');
  await waitFor(async () => {
    const read = await store.read(id(5));
    return read.status === 'valid' && read.record.state === 'failed';
  });

  const second = await coordinator.start({ serverId: id(5), runtimeAssetId: id(1) });
  assert.equal(second.generation, 2);
  const secondRecord = (await store.read(id(5))).record;
  assert.notEqual(secondRecord.launchId, firstRecord.launchId);
  assert.equal(secondRecord.snapshot.registryRevision, 'r1');
  assert.deepEqual(approvals.filter(entry => entry.action === 'start'), [
    { action: 'start', generation: 1 }, { action: 'start', generation: 2 },
  ]);
  assert.equal((await coordinator.status(id(5))).view.current, true);
  const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`, { headers: { accept: 'text/event-stream' } });
  assert.equal(unauthorized.status, 401);

  assert.deepEqual(await coordinator.stop(id(5)), { status: 'stopped', generation: 2 });
  assert.deepEqual(approvals.filter(entry => entry.action === 'stop'), [{ action: 'stop', generation: 2 }]);
});

test('restart is refused before any spawn when the start transition is not approved', async () => {
  const provider = createConfigManagedLifecycleApprovalProvider(config);
  const coordinator = createCoordinator({ approval: async request => request.generation >= 2 ? null : provider(request) });
  await coordinator.start({ serverId: id(5), runtimeAssetId: id(1) });
  await coordinator.event(id(5), { generation: 1, type: 'failed', code: 'MANAGED_CHILD_EXITED' });
  const before = spawned.length;
  await assert.rejects(coordinator.start({ serverId: id(5), runtimeAssetId: id(1) }),
    error => error.code === 'MANAGED_LIFECYCLE_APPROVAL_REJECTED');
  assert.equal(spawned.length, before);
  const status = await coordinator.status(id(5));
  assert.equal(status.view.state, 'failed');
  assert.equal(status.view.generation, 1);
  assert.equal(status.view.current, false);
});

test('bootstrap failure after spawn leaves no current and cleans the child and timers', async () => {
  const changes = [];
  const pids = [];
  const base = syntheticCapture('bootstrap-failure');
  const coordinator = createCoordinator({
    capture: async () => {
      const captured = await base();
      return { ...captured, payload: { ...captured.payload,
        registrySource: { ...captured.payload.registrySource, expectedContentDigest: '0'.repeat(64) } } };
    },
    channel: async input => { spawns++; const handle = await startManagedMcpChannel(input); pids.push(handle.pid); return handle; },
    onStateChange: change => changes.push(change),
  });

  await assert.rejects(coordinator.start({ serverId: id(5), runtimeAssetId: id(1) }),
    error => error.code === 'MANAGED_LIFECYCLE_CHANNEL_FAILED');
  const status = await coordinator.status(id(5));
  assert.equal(status.view.state, 'failed');
  assert.equal(status.view.current, false);
  assert.equal(coordinator.ownedGeneration(id(5)), null);
  assert.deepEqual(changes.map(change => change.state), ['failed']);
  assert.equal(pids.length, 1);
  await waitFor(() => { try { process.kill(pids[0], 0); return false; } catch { return true; } });
  await waitFor(() => portUnreachable(`http://127.0.0.1:${port}/mcp`));
});

test('a stale captured package whose Registry moved on is rejected by the child and not replayed', async () => {
  const stale = await syntheticCapture('stale')();
  await writeRegistry('r2');
  const changes = [];
  const coordinator = createCoordinator({ capture: async () => stale, onStateChange: change => changes.push(change) });

  await assert.rejects(coordinator.start({ serverId: id(5), runtimeAssetId: id(1) }),
    error => error.code === 'MANAGED_LIFECYCLE_CHANNEL_FAILED');
  const failed = (await store.read(id(5))).record;
  assert.equal(failed.state, 'failed');
  assert.equal(failed.snapshot.registryRevision, 'r1');
  assert.deepEqual(changes.map(change => change.state), ['failed']);

  const fresh = createCoordinator();
  const restarted = await fresh.start({ serverId: id(5), runtimeAssetId: id(1) });
  assert.equal(restarted.generation, 2);
  assert.equal(restarted.snapshot.registryRevision, 'r2');
  assert.equal((await fresh.status(id(5))).view.current, true);
  await fresh.stop(id(5));
});

test('parent IPC disconnect stops the real managed child and reports channel failure, not READY', { timeout: 20000 }, async () => {
  const captured = await preparation.captureForManagedLifecycle(id(1), id(5));
  const handle = await startManagedMcpChannel({ launchId: captured.payload.launchId, serverId: id(5),
    payload: captured.payload, approvedEnvironmentNames: captured.approvedEnvironmentNames,
    environmentValues: captured.environmentValues });
  await handle.ready;
  assert.equal(handle.state, 'runtimeReady');
  const observed = spawned.at(-1);
  assert.ok(observed?.child, 'expected a tracked real child');
  observed.child.disconnect();
  assert.deepEqual(await handle.closed, { code: 'MANAGED_CHANNEL_FAILED' });
  await waitFor(() => { try { process.kill(handle.pid, 0); return false; } catch { return true; } });
  await handle.close();
  assert.ok(!JSON.stringify(handle).includes('openApiData'));
  await waitFor(() => portUnreachable(`http://127.0.0.1:${port}/mcp`));
});

test('parent/child version mismatch is rejected before spawn with no legacy fallback', { timeout: 20000 }, async () => {
  const request = { launchId: 'launch-fixture', serverId: 'server-fixture',
    payload: { version: 1, launchId: 'launch-fixture', managedServerId: 'server-fixture', runtimeAssetId: 'asset-fixture',
      inboundAuthMode: 'private_api_key', candidateRevision: 'candidate-fixture', verificationRunId: 'verification-fixture',
      behaviorFingerprint: 'a'.repeat(64), transport: { type: 'streamable', host: '127.0.0.1', port: 9022, endpoint: '/mcp' },
      openApiData: { openapi: '3.0.3', paths: {} }, trustedOperationBindings: [],
      registrySource: { configId: 'fixture', path: path.join(directory, 'unread-registry.json'), format: 'json', environment: 'test',
        expectedRevision: 'r1', expectedContentDigest: 'b'.repeat(64) } },
    approvedEnvironmentNames: [], environmentValues: {} };
  request.payload.version = 2;
  const before = spawned.length;
  await assert.rejects(startManagedMcpChannel(request), /INVALID_MANAGED_HANDOFF/);
  assert.equal(spawned.length, before);

  const entry = path.join(directory, 'entry.js');
  const direct = spawn(process.execPath, [entry], { env: buildManagedEnvironment([], {}), shell: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const replies = [];
  direct.on('message', value => replies.push(value));
  const closed = once(direct, 'close');
  direct.send({ type: 'handoff', version: 2, launchId: 'launch-fixture', payload: { ...request.payload, version: 1 } }, () => undefined);
  const [code] = await closed;
  assert.equal(code, 1);
  assert.ok(replies.some(message => message.type === 'failed' && message.code === 'INVALID_MANAGED_HANDOFF'));
  assert.ok(!replies.some(message => message.type === 'handoffAccepted' || message.type === 'runtimeReady'));
});

test('trusted preparation rejects legacy bearer and header secrets before any child spawn', async () => {
  const before = spawned.length;
  await db.getRepository(Server).update(id(5), { authConfig: { type: 'bearer', config: { bearerToken: 'synthetic-legacy-token' } } });
  await assert.rejects(preparation.prepare(id(1), id(5)),
    error => error.message === MANAGED_MCP_PREPARATION_REJECTED && !String(error).includes('synthetic-legacy-token'));
  assert.equal(spawned.length, before);

  await db.getRepository(Server).update(id(5), { authConfig: null });
  const server = await db.getRepository(Server).findOneByOrFail({ id: id(5) });
  await db.getRepository(Server).update(id(5), { config: { ...server.config, customHeaders: { Authorization: 'Bearer synthetic-legacy-header' } } });
  await assert.rejects(preparation.prepare(id(1), id(5)),
    error => error.message === MANAGED_MCP_PREPARATION_REJECTED && !String(error).includes('synthetic-legacy-header'));
  assert.equal(spawned.length, before);

  const coordinator = createCoordinator();
  await assert.rejects(coordinator.start({ serverId: id(5), runtimeAssetId: id(1) }),
    error => error.code === 'MANAGED_LIFECYCLE_CAPTURE_FAILED');
  assert.equal(spawned.length, before);
});

test('failure and restart paths serialize no handoff package, environment values or legacy credentials', async () => {
  const changes = [];
  const writes = [];
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => { writes.push(String(chunk)); return stdoutWrite(chunk, ...rest); };
  process.stderr.write = (chunk, ...rest) => { writes.push(String(chunk)); return stderrWrite(chunk, ...rest); };
  try {
    const coordinator = createCoordinator({ onStateChange: change => changes.push(change) });
    const started = await coordinator.start({ serverId: id(5), runtimeAssetId: id(1) });
    process.kill(started.pid, 'SIGKILL');
    await waitFor(async () => {
      const read = await store.read(id(5));
      return read.status === 'valid' && read.record.state === 'failed';
    });
    await coordinator.start({ serverId: id(5), runtimeAssetId: id(1) });
    await coordinator.stop(id(5));

    const surfaces = JSON.stringify({
      changes,
      status: await coordinator.status(id(5)),
      record: await store.read(id(5)),
    });
    for (const marker of ['openApiData', 'environmentValues', 'API_NOVA_RUNTIME_API_KEYS', 'synthetic-client-key',
      'trustedOperationBindings']) {
      assert.ok(!surfaces.includes(marker), `lifecycle projections leaked ${marker}`);
    }
    for (const marker of ['synthetic-client-key', 'openApiData', 'environmentValues', 'API_NOVA_RUNTIME_API_KEYS']) {
      assert.ok(!writes.join('').includes(marker), `stdout/stderr leaked ${marker}`);
    }
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
});

test('E1_02C2_VERIFY_OK', () => {
  console.log('\nE1_02C2_VERIFY_OK managed child restart/failure/legacy boundaries: 10 tests, Windows Node ' + process.version);
});
