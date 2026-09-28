'use strict';
// SEC-F1-02E3b: running-update pre-block, real-time authorization over event
// IPC and online revocation with zero network. Every scenario spawns the real
// built managed child (api-nova-server/dist/managed/entry.js), observes
// loopback upstreams, persisted coordination state and process/port cleanup.
// Explicit triggers only: no Registry watcher/push protocol is exercised.
process.env.DB_TYPE = 'sqlite';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const apiRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(apiRoot, '..', '..');
const serverRoot = path.resolve(apiRoot, '..', 'api-nova-server');
const parserRoot = path.resolve(apiRoot, '..', 'api-nova-parser');
const tempBase = process.env.F1_02E3B_TEMP || path.join(path.parse(repoRoot).root, 'temp', 'opencode', 'f1-02e3b');
fs.mkdirSync(tempBase, { recursive: true });
const tempRoot = fs.realpathSync.native(tempBase);
process.env.TEMP = tempRoot;
process.env.TMP = tempRoot;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apinova-f1-02e3b-'));

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
const { buildManagedEnvironment, startManagedMcpChannel } = require('../src/modules/servers/services/managed-mcp-channel.ts');
const { DataSourceManagedMcpLifecycleStore } = require('../src/modules/servers/services/managed-mcp-lifecycle.store.ts');
const { MANAGED_MCP_LIFECYCLE_APPROVAL_CONFIG_KEY, createConfigManagedLifecycleApprovalProvider } =
  require('../src/modules/servers/services/managed-mcp-lifecycle-approval.ts');
const { ManagedMcpLifecycleCoordinator, MANAGED_MCP_LIFECYCLE_REVOKED_CODE, MANAGED_MCP_LIFECYCLE_SOURCE_UPDATED_CODE } =
  require('../src/modules/servers/services/managed-mcp-lifecycle-coordinator.service.ts');
const { ManagedChildSecurityLeaseCoordinator } = require('../src/modules/servers/services/managed-child-security-lease-coordinator.ts');
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

const results = [];
const notCovered = [
  'Registry watcher/auto-push: only explicit checkRevision/isolateSourceForUpdate/authorize triggers are exercised (same boundary as SEC-E1-04).',
  'In-flight upstream request abort on revoke: F3 scope; this runner proves bounded termination, no replay and zero new network.',
  'Per-request/per-tool authorization granularity: the allow/deny decision applies to the launch until superseded; no per-call permits.',
  'Linux: Windows Node only in this runner.',
];
function check(name, condition, detail) {
  if (!condition) throw new Error('CHECK FAILED: ' + name + (detail ? ' (' + detail + ')' : ''));
  results.push(name);
}

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
  let connectionCount = 0;
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
  server.on('connection', () => { connectionCount++; });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: server.address().port, received, hanging, get connectionCount() { return connectionCount; },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

function specDocument(upstreamPort) {
  const paths = {};
  for (const name of ['items', 'hang']) {
    paths[`/${name}`] = { get: { operationId: name, responses: { 200: { description: 'ok' } } } };
  }
  return { openapi: '3.0.3', info: { title: 'f1-02e3b-fixture', version: '1' },
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
    { requestInit: { headers: { 'x-api-key': 'f1-02e3b-consumer-key' } } });
  const client = new Client({ name: 'f1-02e3b', version: '1' });
  await client.connect(transport);
  return client;
}

let db, config, preparation, store, coordinator, upstream, port, registryPath, spawns, changes, directChildren;

function writeRegistry(revision, secretRef) {
  const text = JSON.stringify(registryDocument({ upstreamPort: upstream.port, revision, secretRef }));
  fs.writeFileSync(registryPath, text);
  config.sources[id(1)].registrySource.expectedRevision = revision;
  config.sources[id(1)].registrySource.expectedContentDigest = hash(text);
  return hash(text);
}
function buildCoordinator(options = {}) {
  return new ManagedMcpLifecycleCoordinator({
    store,
    capture: (runtimeAssetId, serverId) => preparation.captureForManagedLifecycle(runtimeAssetId, serverId),
    approval: createConfigManagedLifecycleApprovalProvider(config),
    channel: input => { spawns++; return startManagedMcpChannel(input); },
    onStateChange: change => changes.push(change),
    lease: options.lease,
  });
}
const readRecord = async () => (await store.read(id(5))).record;
const start = () => coordinator.start({ serverId: id(5), runtimeAssetId: id(1) });
const checkRevision = () => coordinator.checkRevision({ serverId: id(5), runtimeAssetId: id(1) });
const authorize = (decision, permitId, sequence) => coordinator.authorize(id(5), { decision, permitId, sequence });
const revokeOverEvents = (permitId, sequence) => authorize('revoke', permitId, sequence);

beforeEach(async () => {
  port = await freePort();
  upstream = await startUpstream();
  spawns = 0;
  changes = [];
  directChildren = new Set();
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
    API_NOVA_MCP_RESOURCE: 'https://managed.f1-02e3b.invalid/mcp',
    API_NOVA_RUNTIME_API_KEYS: JSON.stringify([{ id: 'client-one', subject: 'synthetic-consumer', secretHash: hash('f1-02e3b-consumer-key'),
      resources: ['https://managed.f1-02e3b.invalid/mcp'], scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 600 }]),
    UPSTREAM_SECRET: 'synthetic-r1-secret', UPSTREAM_SECOND: 'synthetic-r2-secret' };
  config = {
    sources: { [id(1)]: { registrySource: { configId: 'fixture', path: registryPath, format: 'json', environment: 'test',
      expectedRevision: 'r1', expectedContentDigest: 'a'.repeat(64) }, approvedEnvironmentNames: Object.keys(environmentValues) } },
    lifecycleApproval: { [id(1)]: { version: 1, mode: 'auto', policyId: 'f1-02e3b-runner', allowedActions: ['start', 'stop'], allowedServerIds: [id(5)] } },
    get(key) {
      if (key === 'managedMcp.handoffSources') return this.sources;
      if (key === MANAGED_MCP_LIFECYCLE_APPROVAL_CONFIG_KEY) return this.lifecycleApproval;
      return environmentValues[key];
    },
  };
  writeRegistry('r1', 'env:UPSTREAM_SECRET');
  preparation = new ManagedMcpHandoffPreparationService(db, config);
  store = new DataSourceManagedMcpLifecycleStore(db);
  coordinator = buildCoordinator({ lease: new ManagedChildSecurityLeaseCoordinator() });
});

afterEach(async () => {
  for (const child of directChildren) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  await coordinator?.onModuleDestroy().catch(() => undefined);
  if (db?.isInitialized) await db.destroy();
  await upstream?.close().catch(() => undefined);
  fs.rmSync(registryPath, { force: true });
});

after(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

process.on('exit', () => {
  for (const name of results) console.log('  PASS ' + name);
  if (process.exitCode === undefined || process.exitCode === 0) {
    console.log('\nF1_02E3B_VERIFY_OK running-update pre-block, event-IPC authorization and zero-network revocation: '
      + results.length + ' checks, Windows Node ' + process.version + ' (real dist artifact)');
    console.log('notCovered: ' + JSON.stringify(notCovered));
  } else {
    console.error('F1_02E3B_VERIFY_FAILED running-update pre-block, event-IPC authorization and zero-network revocation');
  }
});

test('security-relevant source update is pre-blocked: the child is verified stopped with a persisted terminal before the mutation, then re-prepared as a new generation', { timeout: 60000 }, async () => {
  const first = await start();
  check('generation 1 is current', first.generation === 1);
  const client = await connectClient(port);
  try { await client.callTool({ name: 'items', arguments: {} }); } finally { await client.close(); }
  check('running child serves r1', upstream.received.length === 1 && upstream.received[0].headers.authorization === 'Bearer synthetic-r1-secret');

  const unrelated = await coordinator.isolateSourceForUpdate(id(99));
  check('unrelated source is a no-op barrier', unrelated.status === 'clear' && unrelated.isolatedGenerations.length === 0);
  const stillRunning = await connectClient(port);
  try { await stillRunning.callTool({ name: 'items', arguments: {} }); } finally { await stillRunning.close(); }
  check('child keeps serving after an unrelated source barrier', upstream.received.length === 2 && !pidGone(first.pid));

  const beforeMutation = fs.readFileSync(registryPath, 'utf8');
  const barrier = await coordinator.isolateSourceForUpdate(id(4));
  check('affected source reports the isolated generation', barrier.status === 'clear' && JSON.stringify(barrier.isolatedGenerations) === '[1]');
  check('child process is gone before the mutation is applied', await pidGone(first.pid), 'pid ' + first.pid);
  check('listener is unreachable before the mutation is applied', await waitFor(() => portUnreachable(`http://127.0.0.1:${port}/mcp`)));
  const isolated = await readRecord();
  check('persisted terminal security_revoked with the source-update code before mutation',
    isolated.state === 'stopped' && isolated.currentVerified === false &&
    isolated.terminal.reason === 'security_revoked' && isolated.terminal.code === MANAGED_MCP_LIFECYCLE_SOURCE_UPDATED_CODE);
  check('no in-place mutation: registry file unchanged until the barrier completed', fs.readFileSync(registryPath, 'utf8') === beforeMutation);
  check('no stale current generation after isolation', coordinator.ownedGeneration(id(5)) === null);

  const digest = writeRegistry('r2', 'env:UPSTREAM_SECOND');
  const second = await start();
  check('re-prepared as generation 2 with the new revision', second.generation === 2 && second.snapshot.registryRevision === 'r2' &&
    second.snapshot.registryContentDigest === digest);
  const secondClient = await connectClient(port);
  try { await secondClient.callTool({ name: 'items', arguments: {} }); } finally { await secondClient.close(); }
  check('new generation serves only the r2 secret', upstream.received.length === 3 &&
    upstream.received[2].headers.authorization === 'Bearer synthetic-r2-secret' &&
    !JSON.stringify(upstream.received.slice(2)).includes('synthetic-r1-secret'));
  check('two children were spawned: one per prepared generation', spawns === 2);
  const current = await readRecord();
  check('persisted record is current for generation 2', current.state === 'current' && current.generation === 2 && current.currentVerified === true);
  await coordinator.stop(id(5));
});

test('real-time authorization over event IPC delivers allow/deny/revoke, is idempotent for duplicates and fails closed on conflicting reuse', { timeout: 60000 }, async () => {
  await start();
  const allowed = await authorize('allow', 'permit-allow', 1);
  check('allow decision is applied by the real child', allowed.status === 'applied' && allowed.decision === 'allow');
  const client = await connectClient(port);
  try {
    const result = await client.callTool({ name: 'items', arguments: {} });
    check('allowed call executes upstream', result.isError !== true && upstream.received.length === 1);
    const denied = await authorize('deny', 'permit-deny', 2);
    check('deny decision is applied by the real child', denied.status === 'applied' && denied.decision === 'deny');
    const blocked = await client.callTool({ name: 'items', arguments: {} });
    check('denied call fails closed with the fixed denial code without upstream traffic',
      blocked.isError === true && JSON.stringify(blocked).includes('MANAGED_TOOL_EXECUTION_DENIED') && upstream.received.length === 1);
    const duplicate = await authorize('deny', 'permit-deny', 2);
    check('verbatim duplicate delivery is idempotent', duplicate.status === 'duplicate');
    const blockedAgain = await client.callTool({ name: 'items', arguments: {} });
    check('duplicate delivery does not weaken the deny decision',
      blockedAgain.isError === true && upstream.received.length === 1);
    const conflicting = await authorize('allow', 'permit-deny', 2);
    check('conflicting reuse of a sequence is rejected without touching the child', conflicting.status === 'rejected');
    const stillDenied = await client.callTool({ name: 'items', arguments: {} });
    check('conflicting reuse leaves the deny decision in force', stillDenied.isError === true && upstream.received.length === 1);
    const revoked = await revokeOverEvents('permit-revoke', 3);
    check('revoke decision terminates with a security terminal',
      revoked.status === 'revoked' && revoked.code === MANAGED_MCP_LIFECYCLE_REVOKED_CODE);
    await waitFor(() => portUnreachable(`http://127.0.0.1:${port}/mcp`));
    const record = await readRecord();
    check('revocation is persisted as security_revoked', record.state === 'stopped' && record.terminal.reason === 'security_revoked' &&
      record.terminal.code === MANAGED_MCP_LIFECYCLE_REVOKED_CODE);
    const late = await authorize('allow', 'permit-late', 4);
    check('authorization after revocation is rejected (no stale execution)', late.status === 'rejected');
    check('no upstream request was added by deny/duplicate/reject paths', upstream.received.length === 1);
  } finally { await client.close().catch(() => undefined); }
});

test('malformed, duplicate and conflicting authorization events terminate the real child fail closed at the wire', { timeout: 60000 }, async () => {
  const captured = await preparation.captureForManagedLifecycle(id(1), id(5));
  const launch = async () => {
    const child = spawn(process.execPath, [ENTRY],
      { env: buildManagedEnvironment(captured.approvedEnvironmentNames, captured.environmentValues), shell: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    directChildren.add(child);
    const replies = []; let output = '';
    child.on('message', value => replies.push(value));
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const exited = new Promise(resolve => child.once('exit', code => resolve({ code, replies, output })));
    child.send({ type: 'handoff', version: 1, launchId: captured.payload.launchId, payload: captured.payload }, () => undefined);
    await waitFor(() => replies.some(message => message.type === 'runtimeReady' || message.type === 'failed'), 20000);
    return { child, replies, exited };
  };

  const malformed = await launch();
  malformed.child.send({ type: 'authorization', version: 1, launchId: captured.payload.launchId, sequence: 1,
    permitId: 'permit-1', decision: 'allow', secret: 'synthetic-extra-field' }, () => undefined);
  const malformedResult = await malformed.exited;
  check('malformed authorization event exits non-zero with a fixed code',
    malformedResult.code === 1 && malformedResult.replies.some(message => message.type === 'failed' && message.code === 'INVALID_MANAGED_HANDOFF'));
  check('malformed event leaks no raw payload/diagnostics', malformedResult.output === '' &&
    !JSON.stringify(malformedResult.replies).includes('synthetic-extra-field'));
  check('malformed event leaves no listener', await portUnreachable(`http://127.0.0.1:${port}/mcp`));

  const conflicting = await launch();
  const send = event => conflicting.child.send({ type: 'authorization', version: 1, launchId: captured.payload.launchId, ...event }, () => undefined);
  send({ sequence: 1, permitId: 'permit-1', decision: 'allow' });
  await waitFor(() => conflicting.replies.some(message => message.type === 'authorizationAck' && message.sequence === 1));
  send({ sequence: 1, permitId: 'permit-1', decision: 'allow' });
  await waitFor(() => conflicting.replies.filter(message => message.type === 'authorizationAck' && message.sequence === 1).length === 2);
  check('duplicate event is acknowledged idempotently without state change',
    conflicting.replies.filter(message => message.type === 'authorizationAck' && message.sequence === 1).map(message => message.status).join(',') === 'applied,duplicate');
  send({ sequence: 2, permitId: 'permit-2', decision: 'deny' });
  await waitFor(() => conflicting.replies.some(message => message.type === 'authorizationAck' && message.sequence === 2 && message.status === 'applied'));
  send({ sequence: 1, permitId: 'permit-1', decision: 'deny' });
  const conflictingResult = await conflicting.exited;
  check('conflicting replay fails closed with a fixed code',
    conflictingResult.code === 1 && conflictingResult.replies.some(message => message.type === 'failed' && message.code === 'INVALID_MANAGED_HANDOFF'));
  check('conflicting replay leaves no listener', await portUnreachable(`http://127.0.0.1:${port}/mcp`));
});

test('online revocation during a hanging call terminates within bounds with zero network on the revocation path and no replay', { timeout: 60000 }, async () => {
  const started = await start();
  const allowed = await authorize('allow', 'permit-allow', 1);
  check('allow decision is applied before the hanging call', allowed.status === 'applied');
  const client = await connectClient(port);
  const hangCall = client.callTool({ name: 'hang', arguments: {} }).catch(() => undefined);
  await waitFor(() => upstream.hanging.length === 1);
  check('one upstream request is in flight', upstream.received.length === 1 && upstream.hanging.length === 1);

  const outbound = { http: 0, https: 0, dns: 0 };
  const targets = [[http, 'request', 'http'], [https, 'request', 'https'], [dns, 'lookup', 'dns'],
    [dns.promises, 'resolve4', 'dns'], [dns.promises, 'resolve6', 'dns']];
  const originals = targets.map(([owner, key]) => owner[key]);
  const connections = upstream.connectionCount;
  const received = upstream.received.length;
  const hanging = upstream.hanging.length;
  let revoked, elapsed;
  try {
    targets.forEach(([owner, key, bucket]) => { owner[key] = () => { outbound[bucket]++; throw new Error('unexpected fixture outbound'); }; });
    const began = Date.now();
    revoked = await revokeOverEvents('permit-revoke', 2);
    await waitFor(() => pidGone(started.pid), 9000);
    elapsed = Date.now() - began;
  } finally {
    targets.forEach(([owner, key], index) => { owner[key] = originals[index]; });
  }
  check('revocation returns a revoked security result', revoked.status === 'revoked' && revoked.code === MANAGED_MCP_LIFECYCLE_REVOKED_CODE);
  check('termination is bounded', elapsed < 9000, elapsed + 'ms');
  check('revocation path performs zero HTTP/HTTPS/DNS calls', outbound.http === 0 && outbound.https === 0 && outbound.dns === 0, JSON.stringify(outbound));
  check('revocation path opens zero new upstream connections and sends zero new requests',
    upstream.connectionCount === connections && upstream.received.length === received && upstream.hanging.length === hanging);
  check('listener is unreachable after revocation', await waitFor(() => portUnreachable(`http://127.0.0.1:${port}/mcp`)));
  await delay(500);
  check('the in-flight request is not replayed after termination', upstream.hanging.length === hanging);
  const record = await readRecord();
  check('persisted revocation terminal is security_revoked and verified', record.state === 'stopped' &&
    record.terminal.reason === 'security_revoked' && record.terminal.verifiedByParent === true &&
    record.terminal.code === MANAGED_MCP_LIFECYCLE_REVOKED_CODE);
  check('no owned generation remains after revocation', coordinator.ownedGeneration(id(5)) === null);
  await client.close().catch(() => undefined);
  await hangCall;
});

test('default-off: without the trusted lease the barrier reports unenforced while the explicit revision route still stops/re-prepares', { timeout: 60000 }, async () => {
  coordinator = buildCoordinator();
  const first = await start();
  check('generation 1 is current with the lease default-off', first.generation === 1);
  const barrier = await coordinator.isolateSourceForUpdate(id(4));
  check('barrier is unenforced without the opt-in lease', barrier.status === 'unenforced');
  check('default-off keeps the running child alive', !pidGone(first.pid));
  const client = await connectClient(port);
  try { await client.callTool({ name: 'items', arguments: {} }); } finally { await client.close(); }
  check('default-off child still serves the old revision', upstream.received.length === 1 && upstream.received[0].headers.authorization === 'Bearer synthetic-r1-secret');
  writeRegistry('r2', 'env:UPSTREAM_SECOND');
  const checked = await checkRevision();
  check('explicit revision route routes through stop/re-prepare/restart', checked.status === 'restarted' && checked.previousGeneration === 1 && checked.generation === 2);
  check('old generation is terminated by the routed update', await pidGone(first.pid));
  const secondClient = await connectClient(port);
  try { await secondClient.callTool({ name: 'items', arguments: {} }); } finally { await secondClient.close(); }
  check('restarted generation serves the new revision', upstream.received.length === 2 && upstream.received[1].headers.authorization === 'Bearer synthetic-r2-secret');
  await coordinator.stop(id(5));
});
