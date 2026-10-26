'use strict';
// SEC-F1-02C3G6: per-execution live permits for the managed MCP child, online
// revocation propagation over the bounded IPC event channel, and a
// proof/capability non-serialization scan. Every scenario spawns the real built
// managed child (api-nova-server/dist/managed/entry.js) through a wrapper that
// records both IPC directions, uses loopback upstreams only and a SQL.js
// coordination store. The host-side permit authority consumes the F1-02C3G1
// capability semantics in-process; no proof material is ever serialized or sent
// over IPC. Explicit triggers only: no Registry watcher or push protocol.
process.env.DB_TYPE = 'sqlite';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const Module = require('node:module');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes, randomUUID } = require('node:crypto');

const repoRoot = path.resolve(__dirname, '..');
const apiRoot = path.join(repoRoot, 'packages', 'api-nova-api');
const serverRoot = path.join(repoRoot, 'packages', 'api-nova-server');
const parserRoot = path.join(repoRoot, 'packages', 'api-nova-parser');
const tempBase = process.env.F1_02C3G6_TEMP || path.join(path.parse(repoRoot).root, 'temp', 'opencode', 'f1-02c3g6');
fs.mkdirSync(tempBase, { recursive: true });
const tempRoot = fs.realpathSync.native(tempBase);
process.env.TEMP = tempRoot;
process.env.TMP = tempRoot;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apinova-f1-02c3g6-'));

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
assertFresh(ENTRY, path.join(serverRoot, 'src', 'tools'), 'npm run build --workspace api-nova-server');
assertFresh(require.resolve('api-nova-parser'), path.join(parserRoot, 'src'), 'npm run build --workspace api-nova-parser');

require('ts-node').register({ transpileOnly: true, project: path.resolve(apiRoot, 'tsconfig.json') });
require('reflect-metadata');
const { DataSource } = require('typeorm');
const { UpstreamCredentialRegistry, normalizeUpstreamSecurity } = require('api-nova-parser');
const { ManagedMcpHandoffPreparationService } = require(path.join(apiRoot, 'src/modules/servers/services/managed-mcp-handoff-preparation.service.ts'));
const { buildManagedEnvironment, startManagedMcpChannel } = require(path.join(apiRoot, 'src/modules/servers/services/managed-mcp-channel.ts'));
const { DataSourceManagedMcpLifecycleStore } = require(path.join(apiRoot, 'src/modules/servers/services/managed-mcp-lifecycle.store.ts'));
const { MANAGED_MCP_LIFECYCLE_APPROVAL_CONFIG_KEY, createConfigManagedLifecycleApprovalProvider } =
  require(path.join(apiRoot, 'src/modules/servers/services/managed-mcp-lifecycle-approval.ts'));
const { ManagedMcpLifecycleCoordinator, MANAGED_MCP_LIFECYCLE_REVOKED_CODE } =
  require(path.join(apiRoot, 'src/modules/servers/services/managed-mcp-lifecycle-coordinator.service.ts'));
const { createManagedExecutionPermitProvider } = require(path.join(apiRoot, 'src/modules/servers/services/managed-execution-permit-authority.ts'));
const { createUpstreamSecurityContextAuthority } = require(path.join(apiRoot, 'src/modules/publication/security/upstream-security-context-authority.ts'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const load = (file, name) => require(path.join(apiRoot, `src/database/entities/${file}.entity.ts`))[name];
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
// Distinct 8-character prefixes per tag: the planted-value scan can safely use
// prefix matching without false positives from shared fixture path prefixes.
const unique = tag => `${tag.slice(0, 3)}-${randomBytes(12).toString('hex')}`;

const results = [];
const notCovered = [
  'In-flight upstream request abort on revoke: F3 scope (same boundary as SEC-E1-04); this runner proves bounded child termination, zero new network and no replay.',
  'Registry watcher/auto-push: only explicit start/checkRevision/authorize triggers are exercised.',
  'Linux: Windows Node only in this runner (E2-02 dual-platform matrix is separate).',
  'Challenge-receipt proof transport (F1-02C3G1 transport/orchestrator) is not re-run; the host permit authority consumes the same in-process capability authority (source/endpoint/target/method/binding epoch) and its token non-serialization is asserted directly.',
  'Production Nest wiring of the permit provider: trusted-only constructor seam, same boundary as the E3b authorize() API (no production controller/Registry source in this package).',
  'Operator-facing per-tool policy administration: permits are per trusted operation selector bound to the launch handoff.',
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
  // The child runtime keeps the established E1-03/E3b single-hop shape; the
  // G1 declaration for the host capability is supplied by the trusted row below.
  return { openapi: '3.0.3', info: { title: 'f1-02c3g6-fixture', version: '1' },
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
    { requestInit: { headers: { 'x-api-key': 'f1-02c3g6-consumer-key' } } });
  const client = new Client({ name: 'f1-02c3g6', version: '1' });
  await client.connect(transport);
  return client;
}

let db, config, preparation, store, coordinator, upstream, port, registryPath, spawns, changes, directChildren;
let hostRegistry, hostSecret, hostRowsEnabled, permitAuthorities, permitProvider, proofBindingId, proofDigest;
let ipcLogPath, selfReportPath, wrapperPath;
const childStdio = [];
const hostSecretsUsed = [];
const bindingsUsed = [];
const digestsUsed = [];
const wireRecords = [];

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
    permit: options.permit,
  });
}
const readRecord = async () => (await store.read(id(5))).record;
const start = () => coordinator.start({ serverId: id(5), runtimeAssetId: id(1) });
const checkRevision = () => coordinator.checkRevision({ serverId: id(5), runtimeAssetId: id(1) });
const authorize = (decision, permitId, sequence) => coordinator.authorize(id(5), { decision, permitId, sequence });
const permitRequest = overrides => ({ tool: 'items', method: 'GET', path: '/items', sourceServiceAssetId: id(4),
  endpointDefinitionId: id(3), ...overrides });

function hostRow(endpointDefinitionId, requestPath) {
  return { sourceServiceAssetId: id(4), endpointDefinitionId, bindingId: proofBindingId, bindingRevision: 'binding-1',
    method: 'GET', target: `http://127.0.0.1:${upstream.port}${requestPath}`,
    declaration: normalizeUpstreamSecurity({ security: [{ Key: [] }], components: { securitySchemes:
      { Key: { type: 'apiKey', in: 'header', name: 'x-g6-host' } } } }, {}) };
}

beforeEach(async () => {
  port = await freePort();
  upstream = await startUpstream();
  wireRecords.push(upstream.received);
  spawns = 0;
  changes = [];
  directChildren = new Set();
  permitAuthorities = [];
  proofBindingId = unique('binding');
  proofDigest = null;
  hostRowsEnabled = true;
  hostSecret = unique('host-secret');
  hostSecretsUsed.push(hostSecret);
  bindingsUsed.push(proofBindingId);
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
    API_NOVA_MCP_RESOURCE: 'https://managed.f1-02c3g6.invalid/mcp',
    API_NOVA_RUNTIME_API_KEYS: JSON.stringify([{ id: 'client-one', subject: 'synthetic-consumer', secretHash: hash('f1-02c3g6-consumer-key'),
      resources: ['https://managed.f1-02c3g6.invalid/mcp'], scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 600 }]),
    UPSTREAM_SECRET: 'synthetic-g6-child-secret-r1', UPSTREAM_SECOND: 'synthetic-g6-child-secret-r2' };
  config = {
    sources: { [id(1)]: { registrySource: { configId: 'fixture', path: registryPath, format: 'json', environment: 'test',
      expectedRevision: 'r1', expectedContentDigest: 'a'.repeat(64) }, approvedEnvironmentNames: Object.keys(environmentValues) } },
    lifecycleApproval: { [id(1)]: { version: 1, mode: 'auto', policyId: 'f1-02c3g6-runner', allowedActions: ['start', 'stop'], allowedServerIds: [id(5)] } },
    get(key) {
      if (key === 'managedMcp.handoffSources') return this.sources;
      if (key === MANAGED_MCP_LIFECYCLE_APPROVAL_CONFIG_KEY) return this.lifecycleApproval;
      return environmentValues[key];
    },
  };
  writeRegistry('r1', 'env:UPSTREAM_SECRET');
  preparation = new ManagedMcpHandoffPreparationService(db, config);
  store = new DataSourceManagedMcpLifecycleStore(db);

  // Host-side G1 capability source: a real Registry snapshot and a trusted row
  // repository. The resolved host credential material never leaves this process.
  hostRegistry = new UpstreamCredentialRegistry({ environment: 'test',
    providerFactory: description => ({ type: description.type, resolve: async () => hostSecret }) });
  await hostRegistry.reload({ apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings',
    metadata: { revision: 'host-r1', environment: 'test' },
    reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true },
    secretProviders: { env: { type: 'env' } },
    credentials: { host: { type: 'apiKey', placement: { in: 'header', name: 'x-g6-host' }, secretRef: 'env:HOST_SECRET' } },
    sites: [{ id: 'host-site', sourceServiceAssetId: id(4), match: { scheme: 'http', host: '127.0.0.1', port: upstream.port, basePath: '/' },
      allowedHosts: ['127.0.0.1'], credential: 'host',
      endpoints: [{ endpointDefinitionId: id(3), credential: 'host' }, { endpointDefinitionId: id(10), credential: 'host' }] }] });
  const repository = { read: async ({ endpointDefinitionId }) => {
    if (!hostRowsEnabled) return undefined;
    if (endpointDefinitionId === id(3)) return hostRow(id(3), '/items');
    if (endpointDefinitionId === id(10)) return hostRow(id(10), '/hang');
    return undefined;
  } };
  const baseProvider = createManagedExecutionPermitProvider({ repository, captureSnapshot: () => hostRegistry.captureSnapshot() });
  permitProvider = context => {
    const authority = baseProvider(context);
    permitAuthorities.push({ context, authority });
    return authority;
  };
  coordinator = buildCoordinator({ permit: permitProvider });
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

// IPC capture wrapper: the real child entry is loaded through a generated
// wrapper that records every inbound/outbound IPC message and the child's own
// argv/env. This is the actual wire, not a host-side simulation.
ipcLogPath = path.join(directory, 'ipc.jsonl');
selfReportPath = path.join(directory, 'child-report.jsonl');
wrapperPath = path.join(directory, 'f1-02c3g6-entry.cjs');
fs.writeFileSync(wrapperPath, `'use strict';
const fs = require('node:fs');
const record = (file, value) => { try { fs.appendFileSync(file, JSON.stringify(value) + '\\n'); } catch {} };
const clone = value => { try { return JSON.parse(JSON.stringify(value)); } catch { return null; } };
try { record(${JSON.stringify(selfReportPath)}, { pid: process.pid, argv: process.argv, execArgv: process.execArgv, cwd: process.cwd(), env: process.env }); } catch {}
process.on('message', message => record(${JSON.stringify(ipcLogPath)}, { direction: 'in', pid: process.pid, message: clone(message) }));
const originalSend = process.send ? process.send.bind(process) : undefined;
if (originalSend) process.send = function (message, ...rest) { record(${JSON.stringify(ipcLogPath)}, { direction: 'out', pid: process.pid, message: clone(message) }); return originalSend(message, ...rest); };
require(${JSON.stringify(ENTRY)}).runManagedEntry();
`);
const nativeResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'api-nova-server/dist/managed/entry.js') return wrapperPath;
  return nativeResolveFilename.call(this, request, ...rest);
};

async function launchDirectChild() {
  const captured = await preparation.captureForManagedLifecycle(id(1), id(5));
  const child = spawn(process.execPath, [wrapperPath],
    { env: buildManagedEnvironment(captured.approvedEnvironmentNames, captured.environmentValues), shell: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  directChildren.add(child);
  const replies = [];
  child.on('message', value => replies.push(value));
  child.stdout.on('data', chunk => childStdio.push(chunk.toString()));
  child.stderr.on('data', chunk => childStdio.push(chunk.toString()));
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  child.send({ type: 'handoff', version: 1, launchId: captured.payload.launchId, payload: captured.payload }, () => undefined);
  await waitFor(() => replies.some(message => message.type === 'runtimeReady' || message.type === 'failed'), 20000);
  return { child, replies, exited, payload: captured.payload };
}
const sendParentMessage = (child, message) => new Promise(resolve => child.send(message, resolve));

const planted = {
  hostSecret: () => hostSecret,
  childSecret: () => config.get('UPSTREAM_SECRET'),
  bindingId: () => proofBindingId,
  digest: () => proofDigest,
};
function detectLeaks(text, values) {
  const leaks = [];
  for (const value of values) {
    if (!value) continue;
    if (text.includes(value)) leaks.push(value);
    else if (value.length >= 8 && text.includes(value.slice(0, 8))) leaks.push(value.slice(0, 8));
  }
  return leaks;
}

process.on('exit', () => {
  for (const name of results) console.log('  PASS ' + name);
  if ((process.exitCode === undefined || process.exitCode === 0) && results.length > 0) {
    console.log('\nF1_02C3G6_VERIFY_OK managed per-execution permits, online revocation and proof non-serialization: '
      + results.length + ' checks, Windows Node ' + process.version + ' (real dist artifact)');
    console.log('notCovered: ' + JSON.stringify(notCovered));
  } else {
    console.error('F1_02C3G6_VERIFY_FAILED managed per-execution permits, online revocation and proof non-serialization');
    process.exitCode = 1;
  }
});

if (process.env.F1_02C3G6_INJECT_FAILURE === '1') {
  test('injected failure gate', () => { assert.fail('injected failure'); });
}

test('per-execution live permit allow/deny: each call re-checks the host G1 capability and deny stops it with zero upstream', { timeout: 90000 }, async () => {
  const started = await start();
  check('generation 1 is current with the trusted per-call permit provider', started.generation === 1 && permitAuthorities.length === 1);
  const authority = permitAuthorities[0].authority;
  check('authority is bound to the launch trusted operation selectors', authority.report().selectorCount === 2 && authority.launchId === started.launchId);
  const client = await connectClient(port);
  try {
    let callCount = 0;
    const allowed = await client.callTool({ name: 'items', arguments: {} });
    callCount++;
    check('first execution is allowed by a live host decision', allowed.isError !== true && upstream.received.length === 1);
    check('exactly one permit request was consumed for one execution', authority.report().allows === 1 && authority.report().denies === 0);

    hostSecret = unique('rotated-host-secret');
    const denied = await client.callTool({ name: 'items', arguments: {} });
    callCount++;
    check('credential rotation denies the next execution with the fixed error',
      denied.isError === true && JSON.stringify(denied).includes('MANAGED_TOOL_EXECUTION_DENIED') && upstream.received.length === 1);
    check('denial happened at the live permit boundary, not from cached policy', authority.report().denies === 1);

    hostSecret = unique('restored-host-secret');
    const allowedAgain = await client.callTool({ name: 'items', arguments: {} });
    callCount++;
    check('a live re-issued capability allows again after the source is consistent', allowedAgain.isError !== true && upstream.received.length === 2);

    hostRowsEnabled = false;
    const deniedByRow = await client.callTool({ name: 'items', arguments: {} });
    callCount++;
    check('removed DB binding row denies the execution with zero upstream', deniedByRow.isError === true && upstream.received.length === 2);

    hostRowsEnabled = true;
    const restored = await client.callTool({ name: 'items', arguments: {} });
    callCount++;
    check('restored DB row requires and obtains a fresh live capability', restored.isError !== true && upstream.received.length === 3);
    check('every execution performed one live permit check',
      authority.report().allows + authority.report().denies === callCount, JSON.stringify(authority.report()));
    const report = JSON.stringify(authority.report());
    check('authority report carries no proof/capability/credential material',
      !report.includes(hostSecret) && !report.includes(proofBindingId) && !report.includes('token') && !report.includes('proof'));
  } finally { await client.close().catch(() => undefined); }
  await coordinator.stop(id(5));
  check('stopping the launch revokes the per-launch permit authority',
    permitAuthorities[0].authority.report().revoked === true && permitAuthorities[0].authority.report().livePermits.length === 0);
});

test('online revocation during a hanging call terminates within bounds with zero network and no replay (per-call permits enabled)', { timeout: 90000 }, async () => {
  const started = await start();
  check('per-call permits are enabled for the hanging-call scenario', permitAuthorities.length === 1 && permitAuthorities[0].authority.report().selectorCount === 2);
  const client = await connectClient(port);
  const hangCall = client.callTool({ name: 'hang', arguments: {} }).catch(() => undefined);
  await waitFor(() => upstream.hanging.length === 1);
  check('the hanging call passed the live permit check before upstream work', upstream.received.length === 1 && upstream.hanging.length === 1);

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
    revoked = await authorize('revoke', 'permit-revoke-g6', 1);
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
  check('revocation persists the verified security_revoked terminal', record.state === 'stopped' &&
    record.terminal.reason === 'security_revoked' && record.terminal.verifiedByParent === true &&
    record.terminal.code === MANAGED_MCP_LIFECYCLE_REVOKED_CODE);
  check('no owned generation remains and the permit authority is revoked',
    coordinator.ownedGeneration(id(5)) === null && permitAuthorities[0].authority.report().revoked === true);
  const late = await authorize('allow', 'permit-late-g6', 2);
  check('authorization after revocation is rejected (no stale execution)', late.status === 'rejected');
  await client.close().catch(() => undefined);
  await hangCall;
});

test('duplicate and conflicting permit-mode/authorization events are idempotent or fail closed on the real child', { timeout: 90000 }, async () => {
  const duplicate = await launchDirectChild();
  check('direct child reached READY before permit mode', duplicate.replies.some(message => message.type === 'runtimeReady'));
  await sendParentMessage(duplicate.child, { type: 'permitMode', version: 1, launchId: duplicate.payload.launchId, sequence: 1, permitId: 'permit-direct' });
  await waitFor(() => duplicate.replies.some(message => message.type === 'permitModeAck' && message.sequence === 1));
  check('permit mode is acknowledged as applied', duplicate.replies.find(message => message.type === 'permitModeAck' && message.sequence === 1).status === 'applied');
  await sendParentMessage(duplicate.child, { type: 'permitMode', version: 1, launchId: duplicate.payload.launchId, sequence: 1, permitId: 'permit-direct' });
  await waitFor(() => duplicate.replies.filter(message => message.type === 'permitModeAck' && message.sequence === 1).length === 2);
  check('verbatim duplicate permit mode is idempotently acknowledged',
    duplicate.replies.filter(message => message.type === 'permitModeAck' && message.sequence === 1).map(message => message.status).join(',') === 'applied,duplicate');
  await sendParentMessage(duplicate.child, { type: 'authorization', version: 1, launchId: duplicate.payload.launchId, sequence: 1, permitId: 'permit-allow', decision: 'allow' });
  await waitFor(() => duplicate.replies.some(message => message.type === 'authorizationAck' && message.sequence === 1));
  await sendParentMessage(duplicate.child, { type: 'authorization', version: 1, launchId: duplicate.payload.launchId, sequence: 1, permitId: 'permit-allow', decision: 'allow' });
  await waitFor(() => duplicate.replies.filter(message => message.type === 'authorizationAck' && message.sequence === 1).length === 2);
  check('verbatim duplicate authorization event is idempotent',
    duplicate.replies.filter(message => message.type === 'authorizationAck' && message.sequence === 1).map(message => message.status).join(',') === 'applied,duplicate');
  duplicate.child.kill('SIGKILL');

  const conflictingMode = await launchDirectChild();
  await sendParentMessage(conflictingMode.child, { type: 'permitMode', version: 1, launchId: conflictingMode.payload.launchId, sequence: 1, permitId: 'permit-a' });
  await waitFor(() => conflictingMode.replies.some(message => message.type === 'permitModeAck'));
  await sendParentMessage(conflictingMode.child, { type: 'permitMode', version: 1, launchId: conflictingMode.payload.launchId, sequence: 1, permitId: 'permit-b' });
  const conflictingModeCode = await conflictingMode.exited;
  check('conflicting permit-mode replay terminates fail closed with a fixed code',
    conflictingModeCode === 1 && conflictingMode.replies.some(message => message.type === 'failed' && message.code === 'INVALID_MANAGED_HANDOFF'));
  check('conflicting permit-mode replay leaves no listener', await portUnreachable(`http://127.0.0.1:${port}/mcp`));

  const conflictingAuth = await launchDirectChild();
  await sendParentMessage(conflictingAuth.child, { type: 'authorization', version: 1, launchId: conflictingAuth.payload.launchId, sequence: 1, permitId: 'permit-allow', decision: 'allow' });
  await waitFor(() => conflictingAuth.replies.some(message => message.type === 'authorizationAck'));
  await sendParentMessage(conflictingAuth.child, { type: 'authorization', version: 1, launchId: conflictingAuth.payload.launchId, sequence: 1, permitId: 'permit-allow', decision: 'deny' });
  const conflictingAuthCode = await conflictingAuth.exited;
  check('conflicting authorization replay terminates fail closed with a fixed code',
    conflictingAuthCode === 1 && conflictingAuth.replies.some(message => message.type === 'failed' && message.code === 'INVALID_MANAGED_HANDOFF'));

  const malformed = await launchDirectChild();
  await sendParentMessage(malformed.child, { type: 'permitDecision', version: 1, launchId: malformed.payload.launchId, requestId: 'permit-request-x', permitId: 'permit-direct', decision: 'allow', extraField: 'extra-field-marker' });
  const malformedCode = await malformed.exited;
  check('malformed permit decision terminates fail closed without echoing the payload',
    malformedCode === 1 && malformed.replies.some(message => message.type === 'failed' && message.code === 'INVALID_MANAGED_HANDOFF') &&
    !JSON.stringify(malformed.replies).includes('extra-field-marker'));
});

test('per-call allow executes and a replayed or unsolicited permit decision fails the launch closed without a second upstream call', { timeout: 90000 }, async () => {
  const launched = await launchDirectChild();
  await sendParentMessage(launched.child, { type: 'permitMode', version: 1, launchId: launched.payload.launchId, sequence: 1, permitId: 'permit-replay' });
  await waitFor(() => launched.replies.some(message => message.type === 'permitModeAck'));
  const client = await connectClient(port);
  const call = client.callTool({ name: 'items', arguments: {} });
  const request = await waitFor(() => launched.replies.find(message => message.type === 'permitRequest'));
  check('the child requested a live permit for the exact trusted selector',
    request.method === 'GET' && request.path === '/items' && request.sourceServiceAssetId === id(4) && request.endpointDefinitionId === id(3) && request.tool === 'items');
  await sendParentMessage(launched.child, { type: 'permitDecision', version: 1, launchId: launched.payload.launchId,
    requestId: request.requestId, permitId: 'permit-replay', decision: 'allow' });
  const result = await call;
  check('the allowed execution reached the loopback upstream exactly once', result.isError !== true && upstream.received.length === 1);
  await sendParentMessage(launched.child, { type: 'permitDecision', version: 1, launchId: launched.payload.launchId,
    requestId: request.requestId, permitId: 'permit-replay', decision: 'allow' });
  const exitCode = await launched.exited;
  check('a replayed permit decision for a settled request fails the launch closed',
    exitCode === 1 && launched.replies.some(message => message.type === 'failed' && message.code === 'INVALID_MANAGED_HANDOFF'));
  check('the replayed decision did not trigger a second upstream call', upstream.received.length === 1);
  await client.close().catch(() => undefined);
});

test('restart/reprepare requires a fresh per-launch permit and never reuses the revoked authority', { timeout: 90000 }, async () => {
  const first = await start();
  const firstAuthority = permitAuthorities[0].authority;
  let client = await connectClient(port);
  try { await client.callTool({ name: 'items', arguments: {} }); } finally { await client.close(); }
  check('generation 1 served through its live permit', upstream.received.length === 1 && firstAuthority.report().allows === 1);
  writeRegistry('r2', 'env:UPSTREAM_SECOND');
  const checked = await checkRevision();
  check('the revision route re-prepared a new generation', checked.status === 'restarted' && checked.previousGeneration === first.generation && checked.generation === first.generation + 1);
  check('the old launch permit authority is revoked and cannot authorize again',
    firstAuthority.report().revoked === true &&
    JSON.stringify(await firstAuthority.authorize(permitRequest())) === JSON.stringify({ decision: 'deny' }));
  check('a fresh authority was created for the new generation', permitAuthorities.length === 2 &&
    permitAuthorities[1].authority.permitId !== firstAuthority.permitId && permitAuthorities[1].context.generation === checked.generation);
  client = await connectClient(port);
  try {
    const result = await client.callTool({ name: 'items', arguments: {} });
    check('the restarted generation required and obtained its own fresh live permit', result.isError !== true &&
      permitAuthorities[1].authority.report().allows === 1 && upstream.received.length === 2);
  } finally { await client.close(); }
  check('the restarted generation served only the r2 credential', JSON.stringify(upstream.received.slice(1)).includes('synthetic-g6-child-secret-r2') &&
    !JSON.stringify(upstream.received.slice(1)).includes('synthetic-g6-child-secret-r1'));
  await coordinator.stop(id(5));
});

test('default-off: without the trusted permit provider the child keeps the E3b behavior and sends no permit-mode traffic', { timeout: 90000 }, async () => {
  const before = fs.existsSync(ipcLogPath) ? fs.readFileSync(ipcLogPath, 'utf8').split('\n').filter(Boolean).length : 0;
  coordinator = buildCoordinator();
  const started = await start();
  check('generation 1 is current without the permit provider', started.generation === 1 && permitAuthorities.length === 0);
  const client = await connectClient(port);
  try { await client.callTool({ name: 'items', arguments: {} }); } finally { await client.close(); }
  check('default-off child still serves normally', upstream.received.length === 1);
  const after = fs.readFileSync(ipcLogPath, 'utf8').split('\n').filter(Boolean).length;
  const launched = fs.readFileSync(ipcLogPath, 'utf8').split('\n').filter(Boolean).slice(before)
    .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  check('no permit-mode or permit-request message crossed IPC for the default-off launch',
    launched.every(entry => entry.message && !['permitMode', 'permitDecision', 'permitRequest'].includes(entry.message.type)));
  await coordinator.stop(id(5));
});

test('proof/capability material never crosses IPC, persistence, logs, argv or env: planted-value scan', { timeout: 90000 }, async () => {
  const contextAuthority = createUpstreamSecurityContextAuthority({
    read: async ({ endpointDefinitionId }) => (endpointDefinitionId === id(3) && hostRowsEnabled ? hostRow(id(3), '/items') : undefined),
  }, () => hostRegistry.captureSnapshot());
  const token = await contextAuthority.issue({ sourceServiceAssetId: id(4), endpointDefinitionId: id(3) });
  proofDigest = contextAuthority.inspect(token).contextDigest;
  digestsUsed.push(proofDigest);
  check('host capability token serializes to an empty object', JSON.stringify(token) === '{}');
  check('a serialized or cloned capability can never be revived',
    (() => { try { contextAuthority.inspect(JSON.parse(JSON.stringify(token))); return false; } catch { return true; } })() &&
    (() => { try { contextAuthority.inspect(structuredClone(token)); return false; } catch { return true; } })());
  contextAuthority.revoke(token);

  const record = await readRecord().catch(() => null);
  const rows = await db.getRepository(PipelineState).find();
  const ipc = fs.existsSync(ipcLogPath) ? fs.readFileSync(ipcLogPath, 'utf8') : '';
  const selfReports = fs.existsSync(selfReportPath) ? fs.readFileSync(selfReportPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const childSecrets = [config.get('UPSTREAM_SECRET'), config.get('UPSTREAM_SECOND')];
  const proofValues = [
    planted.hostSecret(), planted.childSecret(), planted.bindingId(), planted.digest(),
    ...hostSecretsUsed, ...bindingsUsed, ...digestsUsed,
  ];

  const ipcLeaks = detectLeaks(ipc, proofValues);
  check('IPC messages contain none of the planted proof/capability/credential values', ipcLeaks.length === 0, JSON.stringify(ipcLeaks));
  const persistedLeaks = detectLeaks(JSON.stringify({ record, rows, changes }), proofValues);
  check('persisted lifecycle rows and state changes contain no planted proof/capability/credential values', persistedLeaks.length === 0, JSON.stringify(persistedLeaks));
  const stdioLeaks = detectLeaks(childStdio.join(''), proofValues);
  check('child stdout/stderr contain no planted proof/capability/credential values', stdioLeaks.length === 0, JSON.stringify(stdioLeaks));

  let envLeak = null;
  for (const report of selfReports) {
    for (const [name, raw] of Object.entries(report.env || {})) {
      if (typeof raw !== 'string' || name === 'UPSTREAM_SECRET') continue;
      if (raw.includes(planted.hostSecret()) || raw.includes(proofBindingId)) { envLeak = name; break; }
    }
  }
  check('child argv/env expose only the approved child credential, never host/proof material',
    envLeak === null && selfReports.length > 0 && selfReports.every(report => report.argv.every(arg => !arg.includes(proofBindingId))));
  const wireText = JSON.stringify(wireRecords);
  const wireLeaks = detectLeaks(wireText, [...hostSecretsUsed, ...bindingsUsed, ...digestsUsed]);
  check('the loopback upstream wire observed no host credential, binding id or context digest',
    wireLeaks.length === 0 && wireText.includes(childSecrets[0]), JSON.stringify(wireLeaks));
  check('the trusted binding id and context digest appear in no recorded IPC message',
    proofBindingId.length > 0 && Boolean(proofDigest) && !ipc.includes(proofBindingId) && !ipc.includes(proofDigest));

  const forbiddenKey = /proof|token|capabil|credential|secret|header|cookie/i;
  const violations = [];
  const walkKeys = (value, trail) => {
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
      // `nonSecretRevisions` is the established E3b non-secret telemetry shape
      // (revision identities plus authMode/credentialMode enums, no material).
      if (forbiddenKey.test(key) && !/^nonsecretrevisions$/i.test(key) && !/^credentialmode$/i.test(key)) violations.push(`${trail}.${key}`);
      walkKeys(value[key], `${trail}.${key}`);
    }
  };
  for (const entry of ipc.split('\n').filter(Boolean)) {
    try { const parsed = JSON.parse(entry); if (parsed.message) walkKeys(parsed.message, parsed.message.type || 'message'); } catch { /* raw line not JSON */ }
  }
  check('no IPC message carries a proof/token/capability/credential/header field name', violations.length === 0, JSON.stringify(violations.slice(0, 5)));

  const status = await coordinator.status(id(5)).catch(() => null);
  check('the published status view exposes no planted material', !JSON.stringify(status).includes(planted.hostSecret()));
});
