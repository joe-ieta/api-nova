'use strict';
// SEC-E1-04: running managed-child version change and revocation over the real
// built product entry (api-nova-server/dist/managed/entry.js). Every scenario
// spawns the compiled child, observes loopback upstreams, persisted coordination
// state and process/port cleanup. No watcher/push protocol is exercised: the
// explicit `checkRevision`/`revoke` triggers are the scope of this package.
process.env.DB_TYPE = 'sqlite';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { once } = require('node:events');
const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const apiRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(apiRoot, '..', '..');
const serverRoot = path.resolve(apiRoot, '..', 'api-nova-server');
const parserRoot = path.resolve(apiRoot, '..', 'api-nova-parser');
const tempBase = process.env.E1_04_TEMP || path.join(path.parse(repoRoot).root, 'temp', 'opencode', 'e1-04');
fs.mkdirSync(tempBase, { recursive: true });
const tempRoot = fs.realpathSync.native(tempBase);
process.env.TEMP = tempRoot;
process.env.TMP = tempRoot;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apinova-e1-04-'));

function newestSource(root) {
  let newest = 0;
  const visit = entry => {
    for (const item of fs.readdirSync(entry, { withFileTypes: true })) {
      const target = path.join(entry, item.name);
      if (item.isDirectory()) { if (item.name !== 'node_modules' && item.name !== 'dist' && item.name !== 'docs') visit(target); continue; }
      if (!item.name.endsWith('.ts') || /\.(spec|test)\.ts$/.test(item.name)) continue;
      newest = Math.max(newest, fs.statSync(target).mtimeMs);
    }
  };
  visit(root);
  return newest;
}
function assertFresh(artifact, sourcesRoot, packages) {
  if (fs.statSync(artifact).mtimeMs < newestSource(sourcesRoot)) {
    throw new Error(`stale built artifact ${artifact}; run: ${packages}`);
  }
}
const ENTRY = require.resolve('api-nova-server/dist/managed/entry.js');
assertFresh(ENTRY, path.join(serverRoot, 'src', 'managed'), 'npm run build --workspace api-nova-server');
assertFresh(require.resolve('api-nova-parser'), path.join(parserRoot, 'src'), 'npm run build --workspace api-nova-parser');

require('ts-node').register({ transpileOnly: true, project: path.resolve(__dirname, '../tsconfig.json') });
require('reflect-metadata');
const { DataSource } = require('typeorm');
const { ManagedMcpHandoffPreparationService } = require('../src/modules/servers/services/managed-mcp-handoff-preparation.service.ts');
const { startManagedMcpChannel } = require('../src/modules/servers/services/managed-mcp-channel.ts');
const { DataSourceManagedMcpLifecycleStore } = require('../src/modules/servers/services/managed-mcp-lifecycle.store.ts');
const { MANAGED_MCP_LIFECYCLE_APPROVAL_CONFIG_KEY, createConfigManagedLifecycleApprovalProvider } =
  require('../src/modules/servers/services/managed-mcp-lifecycle-approval.ts');
const { ManagedMcpLifecycleCoordinator, MANAGED_MCP_LIFECYCLE_REVOKED_CODE, MANAGED_MCP_LIFECYCLE_STATE_INVALIDATED_CODE } =
  require('../src/modules/servers/services/managed-mcp-lifecycle-coordinator.service.ts');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

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
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition not observed in time');
    await delay(25);
  }
}
function pidGone(pid) {
  try { process.kill(pid, 0); return false; } catch { return true; }
}
async function portUnreachable(url) {
  try { await fetch(url, { signal: AbortSignal.timeout(500) }); return false; } catch { return true; }
}
async function startUpstream() {
  const received = [];
  const hanging = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const entry = { path: request.url, method: request.method, headers: { ...request.headers },
        body: Buffer.concat(chunks).toString('utf8') };
      received.push(entry);
      if (request.url === '/hang') { hanging.push(entry); return; }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: server.address().port, received, hanging,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

function specDocument(upstreamPort) {
  const paths = {};
  for (const name of ['items', 'hang']) {
    paths[`/${name}`] = { get: { operationId: name, responses: { 200: { description: 'ok' } } } };
  }
  return { openapi: '3.0.3', info: { title: 'e1-04-fixture', version: '1' },
    servers: [{ url: `http://127.0.0.1:${upstreamPort}` }], paths };
}
function registryDocument({ upstreamPort, revision, secretRef }) {
  return {
    apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings',
    metadata: { revision, environment: 'test' },
    reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true },
    secretProviders: { env: { type: 'env' } },
    credentials: { parent: { type: 'bearer', secretRef } },
    sites: [{ id: 'site-one', sourceServiceAssetId: id(4), match: { scheme: 'http', host: '127.0.0.1', port: upstreamPort, basePath: '/' },
      allowedHosts: ['127.0.0.1'], credential: 'parent',
      endpoints: [{ endpointDefinitionId: id(3), credential: 'parent' }, { endpointDefinitionId: id(10), credential: 'parent' }] }],
  };
}

async function connectClient(port) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { 'x-api-key': 'e1-04-consumer-key' } } });
  const client = new Client({ name: 'e1-04', version: '1' });
  await client.connect(transport);
  return client;
}

let db, config, preparation, store, coordinator, upstream, port, registryPath, spawns, changes;

function writeRegistry(revision, secretRef) {
  const text = JSON.stringify(registryDocument({ upstreamPort: upstream.port, revision, secretRef }));
  fs.writeFileSync(registryPath, text);
  config.sources[id(1)].registrySource.expectedRevision = revision;
  config.sources[id(1)].registrySource.expectedContentDigest = hash(text);
  return hash(text);
}
const readRecord = async () => (await store.read(id(5))).record;
const checkRevision = () => coordinator.checkRevision({ serverId: id(5), runtimeAssetId: id(1) });
const revoke = () => coordinator.revoke(id(5));

beforeEach(async () => {
  port = await freePort();
  upstream = await startUpstream();
  spawns = 0;
  changes = [];
  db = new DataSource({ type: 'sqljs', synchronize: true,
    entities: [Asset, Member, Endpoint, Source, Profile, Publish, Server, Run, Upstream, PipelineState] });
  await db.initialize();
  const spec = specDocument(upstream.port);
  const fingerprint = hash(JSON.stringify(canonical(spec)));
  await db.getRepository(Asset).save({ id: id(1), name: 'fixture', type: 'mcp_server', metadata: { managedServerId: id(5),
    activeRevision: 'candidate1', lastVerificationRunId: id(6), activeMcpBehaviorFingerprint: fingerprint, verificationRequired: false } });
  await db.getRepository(Source).save({ id: id(4), sourceKey: 'fixture' });
  await db.getRepository(Endpoint).save({ id: id(3), sourceServiceAssetId: id(4), method: 'GET', path: '/items', rawOperation: spec.paths['/items'].get });
  await db.getRepository(Endpoint).save({ id: id(10), sourceServiceAssetId: id(4), method: 'GET', path: '/hang', rawOperation: spec.paths['/hang'].get });
  await db.getRepository(Member).save({ id: id(2), runtimeAssetId: id(1), endpointDefinitionId: id(3), enabled: true });
  await db.getRepository(Member).save({ id: id(11), runtimeAssetId: id(1), endpointDefinitionId: id(10), enabled: true });
  await db.getRepository(Publish).save({ id: id(8), endpointDefinitionId: id(3), runtimeAssetEndpointBindingId: id(2), publishedToMcp: true });
  await db.getRepository(Publish).save({ id: id(12), endpointDefinitionId: id(10), runtimeAssetEndpointBindingId: id(11), publishedToMcp: true });
  await db.getRepository(Upstream).save({ id: id(7), runtimeAssetEndpointBindingId: id(2), sourceServiceAssetId: id(4), environment: 'test',
    selectionMode: 'fixed_primary', status: 'active', revision: 1 });
  await db.getRepository(Upstream).save({ id: id(13), runtimeAssetEndpointBindingId: id(11), sourceServiceAssetId: id(4), environment: 'test',
    selectionMode: 'fixed_primary', status: 'active', revision: 1 });
  await db.getRepository(Server).save({ id: id(5), name: 'fixture', inboundAuthMode: 'private_api_key', openApiData: spec, port,
    transport: 'streamable', config: { endpoint: '/mcp', runtimeAssetId: id(1), managedByRuntimeAsset: true, verifiedCandidateRevision: 'candidate1',
      verificationRunId: id(6), behaviorFingerprint: fingerprint, executionMode: 'trusted_ipc_v1' } });
  await db.getRepository(Run).save({ id: id(6), runtimeAssetId: id(1), candidateRevision: 'candidate1', trigger: 'deploy', status: 'passed',
    activationStatus: 'activated', metadata: { behaviorFingerprint: fingerprint, mcpEndpointConfig: { transport: 'streamable', port, endpointPath: '/mcp' } },
    upstreamBindingRevisions: [{ runtimeMembershipId: id(2), bindingId: id(7), revision: 1 },
      { runtimeMembershipId: id(11), bindingId: id(13), revision: 1 }] });

  registryPath = path.join(directory, `registry-${port}.json`);
  const environmentValues = { API_NOVA_RUNTIME_AUTH_MODE: 'api_key',
    API_NOVA_MCP_RESOURCE: 'https://managed.e1-04.invalid/mcp',
    API_NOVA_RUNTIME_API_KEYS: JSON.stringify([{ id: 'client-one', subject: 'synthetic-consumer', secretHash: hash('e1-04-consumer-key'),
      resources: ['https://managed.e1-04.invalid/mcp'], scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 600 }]),
    UPSTREAM_SECRET: 'synthetic-r1-secret', UPSTREAM_SECOND: 'synthetic-r2-secret' };
  config = {
    sources: { [id(1)]: { registrySource: { configId: 'fixture', path: registryPath, format: 'json', environment: 'test',
      expectedRevision: 'r1', expectedContentDigest: 'a'.repeat(64) }, approvedEnvironmentNames: Object.keys(environmentValues) } },
    lifecycleApproval: { [id(1)]: { version: 1, mode: 'auto', policyId: 'e1-04-runner', allowedActions: ['start', 'stop'], allowedServerIds: [id(5)] } },
    get(key) {
      if (key === 'managedMcp.handoffSources') return this.sources;
      if (key === MANAGED_MCP_LIFECYCLE_APPROVAL_CONFIG_KEY) return this.lifecycleApproval;
      return environmentValues[key];
    },
  };
  writeRegistry('r1', 'env:UPSTREAM_SECRET');
  preparation = new ManagedMcpHandoffPreparationService(db, config);
  store = new DataSourceManagedMcpLifecycleStore(db);
  coordinator = new ManagedMcpLifecycleCoordinator({
    store,
    capture: (runtimeAssetId, serverId) => preparation.captureForManagedLifecycle(runtimeAssetId, serverId),
    approval: createConfigManagedLifecycleApprovalProvider(config),
    channel: input => { spawns++; return startManagedMcpChannel(input); },
    onStateChange: change => changes.push(change),
  });
});

afterEach(async () => {
  await coordinator?.onModuleDestroy().catch(() => undefined);
  if (db?.isInitialized) await db.destroy();
  await upstream?.close().catch(() => undefined);
  fs.rmSync(registryPath, { force: true });
});

after(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

process.on('exit', () => {
  if (process.exitCode === undefined || process.exitCode === 0) {
    console.log('\nE1_04_VERIFY_OK managed child running-version/revocation: 5 tests, Windows Node ' + process.version + ' (real dist artifact)');
  } else {
    console.error('E1_04_VERIFY_FAILED managed child running-version/revocation');
  }
});

test('changed Registry revision while current terminates the old child and makes a new generation with the new revision/digest current', { timeout: 60000 }, async () => {
  const first = await coordinator.start({ serverId: id(5), runtimeAssetId: id(1) });
  assert.equal(first.generation, 1);
  assert.equal(first.snapshot.registryRevision, 'r1');
  const firstClient = await connectClient(port);
  try {
    const result = await firstClient.callTool({ name: 'items', arguments: {} });
    assert.notEqual(result.isError, true);
  } finally { await firstClient.close(); }
  assert.equal(upstream.received.length, 1);
  assert.equal(upstream.received[0].headers.authorization, 'Bearer synthetic-r1-secret');

  const r2Digest = writeRegistry('r2', 'env:UPSTREAM_SECOND');
  const checked = await checkRevision();
  assert.equal(checked.status, 'restarted');
  assert.equal(checked.previousGeneration, 1);
  assert.equal(checked.generation, 2);
  assert.deepEqual({ revision: checked.snapshot.registryRevision, digest: checked.snapshot.registryContentDigest },
    { revision: 'r2', digest: r2Digest });

  const record = await readRecord();
  assert.equal(record.state, 'current');
  assert.equal(record.generation, 2);
  assert.equal(record.currentVerified, true);
  assert.equal(record.snapshot.registryRevision, 'r2');
  assert.equal(record.snapshot.registryContentDigest, r2Digest);
  assert.ok(Number.isSafeInteger(record.pid) && record.pid > 0);
  assert.equal(record.startDecision.generation, 2);
  assert.equal(await pidGone(first.pid), true, 'old generation must be terminated');
  assert.equal(coordinator.ownedGeneration(id(5)), 2);

  const secondClient = await connectClient(port);
  try {
    await secondClient.callTool({ name: 'items', arguments: {} });
  } finally { await secondClient.close(); }
  assert.equal(upstream.received.length, 2);
  assert.equal(upstream.received[1].headers.authorization, 'Bearer synthetic-r2-secret');
  assert.ok(!JSON.stringify(upstream.received.slice(1)).includes('synthetic-r1-secret'), 'no stale secret after restart');

  const repeated = await checkRevision();
  assert.equal(repeated.status, 'unchanged');
  assert.equal(repeated.generation, 2);
  assert.equal(repeated.snapshotDigest, checked.snapshotDigest);
  assert.equal(spawns, 2);
  assert.deepEqual(await coordinator.stop(id(5)), { status: 'stopped', generation: 2 });
  assert.ok(await waitFor(() => portUnreachable(`http://127.0.0.1:${port}/mcp`)));
});

test('revoked security state terminates the running child with a persisted terminal and refuses to restart stale', { timeout: 60000 }, async () => {
  const started = await coordinator.start({ serverId: id(5), runtimeAssetId: id(1) });
  const client = await connectClient(port);
  try { await client.callTool({ name: 'items', arguments: {} }); } finally { await client.close(); }
  assert.equal(upstream.received.length, 1);

  await db.getRepository(Upstream).update(id(7), { status: 'blocked' });
  const revoked = await revoke();
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.generation, 1);
  assert.equal(revoked.code, MANAGED_MCP_LIFECYCLE_REVOKED_CODE);
  assert.ok(changes.some(change => change.state === 'stopped' && change.reason === 'security_revoked' &&
    change.code === MANAGED_MCP_LIFECYCLE_REVOKED_CODE), 'revocation terminal must be observable through the state sink');

  const record = await readRecord();
  assert.equal(record.state, 'stopped');
  assert.equal(record.currentVerified, false);
  assert.equal(record.terminal.reason, 'security_revoked');
  assert.equal(record.terminal.verifiedByParent, true);
  assert.equal(record.terminal.code, MANAGED_MCP_LIFECYCLE_REVOKED_CODE);
  assert.equal(await pidGone(started.pid), true, 'revoked child must exit');
  assert.ok(await waitFor(() => portUnreachable(`http://127.0.0.1:${port}/mcp`)));

  const failure = await coordinator.start({ serverId: id(5), runtimeAssetId: id(1) }).then(() => null, error => error);
  assert.equal(failure?.code, 'MANAGED_LIFECYCLE_CAPTURE_FAILED');
  assert.equal(spawns, 1, 'no child may spawn into a revoked security state');
  assert.ok(await portUnreachable(`http://127.0.0.1:${port}/mcp`));

  const observed = await checkRevision();
  assert.equal(observed.status, 'not-current');
  assert.equal(observed.state, 'stopped');
  const again = await revoke();
  assert.equal(again.status, 'already-stopped');
  assert.equal(await pidGone(started.pid), true);
});

test('checkRevision terminates rather than running an unverifiable generation when the trusted snapshot is invalidated', { timeout: 60000 }, async () => {
  const started = await coordinator.start({ serverId: id(5), runtimeAssetId: id(1) });
  const asset = await db.getRepository(Asset).findOneByOrFail({ id: id(1) });
  await db.getRepository(Asset).update(id(1), { metadata: { ...asset.metadata, verificationRequired: true } });

  const checked = await checkRevision();
  assert.equal(checked.status, 'terminated');
  assert.equal(checked.generation, 1);
  assert.equal(checked.code, MANAGED_MCP_LIFECYCLE_STATE_INVALIDATED_CODE);
  assert.ok(changes.some(change => change.reason === 'security_revoked'));

  const record = await readRecord();
  assert.equal(record.state, 'stopped');
  assert.equal(record.terminal.reason, 'security_revoked');
  assert.equal(record.terminal.code, MANAGED_MCP_LIFECYCLE_STATE_INVALIDATED_CODE);
  assert.equal(await pidGone(started.pid), true);
  assert.ok(await waitFor(() => portUnreachable(`http://127.0.0.1:${port}/mcp`)));

  const failure = await coordinator.start({ serverId: id(5), runtimeAssetId: id(1) }).then(() => null, error => error);
  assert.equal(failure?.code, 'MANAGED_LIFECYCLE_CAPTURE_FAILED');
  assert.equal(spawns, 1);
});

test('a running tool call is terminated within bounds on revision change without secret/body replay', { timeout: 60000 }, async () => {
  const started = await coordinator.start({ serverId: id(5), runtimeAssetId: id(1) });
  const client = await connectClient(port);
  const hangCall = client.callTool({ name: 'hang', arguments: {} }).catch(() => undefined);
  await waitFor(() => upstream.hanging.length === 1);
  assert.equal(upstream.received.length, 1);

  writeRegistry('r2', 'env:UPSTREAM_SECOND');
  const began = Date.now();
  const pending = checkRevision();
  await waitFor(() => pidGone(started.pid), 9000);
  const terminationMs = Date.now() - began;
  assert.ok(terminationMs < 9000, `termination took ${terminationMs}ms`);
  const checked = await pending;
  assert.equal(checked.status, 'restarted');
  assert.equal(checked.generation, 2);
  await client.close().catch(() => undefined);
  await hangCall;

  assert.equal(upstream.hanging.length, 1, 'the in-flight request must not be replayed');
  await delay(500);
  assert.equal(upstream.hanging.length, 1);

  const secondClient = await connectClient(port);
  try {
    await secondClient.callTool({ name: 'items', arguments: {} });
  } finally { await secondClient.close(); }
  assert.equal(upstream.received.length, 2);
  assert.equal(upstream.received[1].headers.authorization, 'Bearer synthetic-r2-secret');
  assert.ok(!JSON.stringify(upstream.received.slice(1)).includes('synthetic-r1-secret'));
  assert.equal((await readRecord()).generation, 2);
  assert.deepEqual(await coordinator.stop(id(5)), { status: 'stopped', generation: 2 });
});

test('repeated and concurrent revision/revoke signals are idempotent', { timeout: 60000 }, async () => {
  const first = await coordinator.start({ serverId: id(5), runtimeAssetId: id(1) });
  writeRegistry('r2', 'env:UPSTREAM_SECOND');

  const checks = await Promise.all([checkRevision(), checkRevision()]);
  assert.deepEqual(checks.map(result => result.status).sort(), ['restarted', 'unchanged']);
  assert.equal(spawns, 2);
  assert.equal(await pidGone(first.pid), true);
  let record = await readRecord();
  assert.equal(record.state, 'current');
  assert.equal(record.generation, 2);
  assert.equal(record.snapshot.registryRevision, 'r2');

  const revokes = await Promise.all([revoke(), revoke()]);
  assert.deepEqual(revokes.map(result => result.status).sort(), ['already-stopped', 'revoked']);
  const again = await revoke();
  assert.equal(again.status, 'already-stopped');
  assert.equal(spawns, 2, 'no extra spawn from repeated revoke');
  record = await readRecord();
  assert.equal(record.state, 'stopped');
  assert.equal(record.terminal.reason, 'security_revoked');
  assert.ok(await waitFor(() => portUnreachable(`http://127.0.0.1:${port}/mcp`)));
});

