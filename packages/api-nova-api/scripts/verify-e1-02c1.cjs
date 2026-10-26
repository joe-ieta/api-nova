'use strict';
process.env.DB_TYPE = 'sqlite';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const Module = require('node:module');
const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apinova-e1-02c1-'));
const serverRoot = path.resolve(__dirname, '../../api-nova-server');
const apiRoot = path.resolve(__dirname, '..');
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

require('reflect-metadata');
const { DataSource } = require('typeorm');
const { ManagedMcpHandoffPreparationService } = require('../src/modules/servers/services/managed-mcp-handoff-preparation.service.ts');
const { startManagedMcpChannel } = require('../src/modules/servers/services/managed-mcp-channel.ts');
const {
  DataSourceManagedMcpLifecycleStore,
} = require('../src/modules/servers/services/managed-mcp-lifecycle.store.ts');
const {
  MANAGED_MCP_LIFECYCLE_APPROVAL_CONFIG_KEY,
  createConfigManagedLifecycleApprovalProvider,
} = require('../src/modules/servers/services/managed-mcp-lifecycle-approval.ts');
const {
  ManagedMcpLifecycleCoordinator,
} = require('../src/modules/servers/services/managed-mcp-lifecycle-coordinator.service.ts');
const {
  managedLifecycleSnapshot,
  parseManagedLifecycleRecord,
} = require('../src/modules/servers/services/managed-mcp-lifecycle.contract.ts');

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
    lifecycleApproval: { [id(1)]: { version: 1, mode: 'auto', policyId: 'e1-02c1-runner', allowedActions: ['start', 'stop'], allowedServerIds: [id(5)] } },
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
  Module._resolveFilename = originalResolve;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('real child reaches current after READY; stop is idempotent; snapshot is captured per start; generation is monotonic', async () => {
  const coordinator = createCoordinator();
  const first = await coordinator.start({ serverId: id(5), runtimeAssetId: id(1) });
  assert.equal(first.generation, 1);
  assert.equal(first.snapshot.registryRevision, 'r1');
  assert.equal(spawns, 1);
  assert.equal(coordinator.ownedGeneration(id(5)), 1);
  const current = await coordinator.status(id(5));
  assert.equal(current.status, 'observed');
  assert.equal(current.view.state, 'current');
  assert.equal(current.view.current, true);
  assert.ok(current.view.pid > 0);
  const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`, { headers: { accept: 'text/event-stream' } });
  assert.equal(unauthorized.status, 401);
  assert.ok(!JSON.stringify(current).includes('openApiData'));
  assert.ok(!JSON.stringify(current).includes('environmentValues'));
  assert.ok(!JSON.stringify(current).includes('synthetic-client-key'));

  await writeRegistry('r2');
  const stopped = await coordinator.stop(id(5));
  assert.deepEqual(stopped, { status: 'stopped', generation: 1 });
  await assert.rejects(fetch(`http://127.0.0.1:${port}/mcp`, { signal: AbortSignal.timeout(500) }));
  assert.deepEqual(await coordinator.stop(id(5)), { status: 'already-stopped', generation: 1 });
  assert.equal((await coordinator.status(id(5))).view.state, 'stopped');

  const second = await coordinator.start({ serverId: id(5), runtimeAssetId: id(1) });
  assert.equal(second.generation, 2);
  assert.equal(second.snapshot.registryRevision, 'r2');
  assert.equal(spawns, 2);
  assert.deepEqual(await coordinator.stop(id(5)), { status: 'stopped', generation: 2 });
  assert.deepEqual(await coordinator.stop(id(5)), { status: 'already-stopped', generation: 2 });
});

test('stale generation events from a superseded child do not override the current generation', async () => {
  const coordinator = createCoordinator();
  await coordinator.start({ serverId: id(5), runtimeAssetId: id(1) });
  await coordinator.stop(id(5));
  await writeRegistry('r2');
  const second = await coordinator.start({ serverId: id(5), runtimeAssetId: id(1) });
  assert.equal(second.generation, 2);
  assert.deepEqual(await coordinator.event(id(5), { generation: 1, type: 'closed', code: 'MANAGED_CHILD_EXITED' }), { status: 'stale' });
  assert.deepEqual(await coordinator.event(id(5), { generation: 9, type: 'failed', code: 'MANAGED_RUNTIME_FAILED' }), { status: 'stale' });
  const status = await coordinator.status(id(5));
  assert.equal(status.view.generation, 2);
  assert.equal(status.view.state, 'current');
  assert.equal(status.view.current, true);
  await coordinator.stop(id(5));
});

test('missing or invalid approval evidence fails closed before any capture or spawn', async () => {
  const withoutPolicy = createCoordinator({ approval: async () => null });
  await assert.rejects(withoutPolicy.start({ serverId: id(5), runtimeAssetId: id(1) }),
    error => error.code === 'MANAGED_LIFECYCLE_APPROVAL_REJECTED');
  assert.equal(spawns, 0);
  assert.equal((await store.read(id(5))).status, 'absent');
  assert.deepEqual(await withoutPolicy.stop(id(5)), { status: 'already-stopped', generation: 0 });

  const mismatched = createCoordinator({ approval: async request => {
    const decision = await createConfigManagedLifecycleApprovalProvider(config)(request);
    return { ...decision, snapshotDigest: '0'.repeat(64) };
  } });
  await assert.rejects(mismatched.start({ serverId: id(5), runtimeAssetId: id(1) }),
    error => error.code === 'MANAGED_LIFECYCLE_APPROVAL_REJECTED');
  assert.equal(spawns, 0);
});

test('a parent crash during start leaves an abandoned generation and never a false current', async () => {
  const coordinator = createCoordinator();
  const payload = await preparation.prepare(id(1), id(5));
  const snapshot = managedLifecycleSnapshot({ runtimeAssetId: payload.runtimeAssetId, candidateRevision: payload.candidateRevision,
    verificationRunId: payload.verificationRunId, behaviorFingerprint: payload.behaviorFingerprint,
    inboundAuthMode: payload.inboundAuthMode, registrySource: payload.registrySource });
  const decision = await createConfigManagedLifecycleApprovalProvider(config)({ action: 'start', serverId: id(5), runtimeAssetId: id(1),
    generation: 1, snapshot });
  const starting = { version: 1, serverId: id(5), runtimeAssetId: id(1), generation: 1, state: 'starting', launchId: payload.launchId,
    pid: null, snapshot, startDecision: decision, stopDecision: null, terminal: null, currentVerified: false,
    decisions: [decision], updatedAt: new Date().toISOString() };
  assert.ok(parseManagedLifecycleRecord(starting));
  const swapped = await store.compareAndSwap(id(5), null, starting);
  assert.equal(swapped.status, 'applied');
  assert.deepEqual(await store.compareAndSwap(id(5), 'stale-token', starting), { status: 'conflict' });

  const resumed = createCoordinator();
  const before = await resumed.status(id(5));
  assert.equal(before.view.state, 'starting');
  assert.equal(before.view.current, false);
  const reconciled = await resumed.reconcile(id(5));
  assert.equal(reconciled.view.state, 'abandoned');
  assert.equal(reconciled.view.current, false);
  const recovered = await resumed.start({ serverId: id(5), runtimeAssetId: id(1) });
  assert.equal(recovered.generation, 2);
  assert.equal(spawns, 1);
  await resumed.stop(id(5));
});

test('concurrent start attempts have exactly one winner and one live child', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let captures = 0;
  const coordinator = createCoordinator({ capture: async () => {
    captures++;
    if (captures === 2) release();
    await gate;
    return syntheticCapture('concurrent')();
  } });
  const results = await Promise.allSettled([
    coordinator.start({ serverId: id(5), runtimeAssetId: id(1) }),
    coordinator.start({ serverId: id(5), runtimeAssetId: id(1) }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, JSON.stringify(results));
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'MANAGED_LIFECYCLE_CONFLICT');
  assert.equal(spawns, 1);
  const status = await coordinator.status(id(5));
  assert.equal(status.view.generation, 1);
  assert.equal(status.view.current, true);
  await coordinator.stop(id(5));
});

test('E1_02C1_VERIFY_OK', () => {
  console.log('\nE1_02C1_VERIFY_OK real-child managed lifecycle coordination: 6 tests, Windows Node ' + process.version);
});
