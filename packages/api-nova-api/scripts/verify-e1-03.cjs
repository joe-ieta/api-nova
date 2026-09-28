'use strict';
// SEC-E1-03: real managed-child execution closure over the built product entry.
// Aggregates the existing real-child suites and executes new matrix scenarios
// (rows 1-13 of docs/guides/managed-mcp-credential-handoff-plan.md section 7)
// against packages/api-nova-server/dist/managed/entry.js. No transform mocks:
// every scenario below spawns the compiled child and observes loopback upstreams,
// real IPC, persistence projections and process cleanup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');

const apiRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(apiRoot, '..', '..');
const serverRoot = path.resolve(apiRoot, '..', 'api-nova-server');
const parserRoot = path.resolve(apiRoot, '..', 'api-nova-parser');
const tempBase = process.env.E1_03_TEMP || path.join(path.parse(repoRoot).root, 'temp', 'opencode', 'e1-03');
fs.mkdirSync(tempBase, { recursive: true });
const tempRoot = fs.realpathSync.native(tempBase);
process.env.TEMP = tempRoot;
process.env.TMP = tempRoot;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apinova-e1-03-'));

require('ts-node').register({ transpileOnly: true, project: path.join(apiRoot, 'tsconfig.json') });
require('reflect-metadata');
const { DataSource } = require('typeorm');
const { startManagedMcpChannel } = require('../src/modules/servers/services/managed-mcp-channel.ts');
const { DataSourceManagedMcpLifecycleStore } = require('../src/modules/servers/services/managed-mcp-lifecycle.store.ts');
const { createConfigManagedLifecycleApprovalProvider, MANAGED_MCP_LIFECYCLE_APPROVAL_CONFIG_KEY } =
  require('../src/modules/servers/services/managed-mcp-lifecycle-approval.ts');
const { ManagedMcpLifecycleCoordinator } = require('../src/modules/servers/services/managed-mcp-lifecycle-coordinator.service.ts');
const { RuntimePipelineStateEntity } = require('../src/database/entities/runtime-call-observability.entity.ts');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const ENTRY = require.resolve('api-nova-server/dist/managed/entry.js');

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
assertFresh(ENTRY, path.join(serverRoot, 'src', 'managed'), 'npm run build --workspace api-nova-server');
assertFresh(require.resolve('api-nova-parser'), path.join(parserRoot, 'src'), 'npm run build --workspace api-nova-parser');

const childProcesses = require('node:child_process');
const nativeSpawn = childProcesses.spawn;
const launches = [];
childProcesses.spawn = function (...args) {
  const child = nativeSpawn(...args);
  const seen = { command: args[0], args: args[1], options: args[2] || {}, pid: child.pid, stdout: '', stderr: '', child };
  child.stdout?.on('data', chunk => { seen.stdout += String(chunk); });
  child.stderr?.on('data', chunk => { seen.stderr += String(chunk); });
  launches.push(seen);
  return child;
};

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
    await delay(50);
  }
}
async function unreachable(url) {
  try { await fetch(url, { signal: AbortSignal.timeout(500) }); return false; } catch { return true; }
}
function pidGone(pid) {
  try { process.kill(pid, 0); return false; } catch { return true; }
}
async function httpStatus(url, headers = {}) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
    await response.arrayBuffer();
    return response.status;
  } catch { return null; }
}

const recorders = [];
async function startRecorder() {
  const received = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      received.push({ method: request.method, path: request.url, headers: { ...request.headers }, body: Buffer.concat(chunks).toString('utf8') });
      if (request.url === '/redirect') { response.writeHead(302, { location: '/redirect-target' }); response.end(); }
      else { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true })); }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const recorder = { port: server.address().port, received, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
  recorders.push(recorder);
  return recorder;
}

const HEADER_PARAMS = ['Authorization', 'X-Api-Key', 'X-Private', 'X-Tenant'];
function specDocument(upstreamPort, names) {
  const paths = {};
  for (const name of names) paths[`/${name}`] = { get: { operationId: name,
    parameters: HEADER_PARAMS.map(item => ({ in: 'header', name: item, schema: { type: 'string' } })),
    responses: { 200: { description: 'ok' } } } };
  return { openapi: '3.0.3', info: { title: 'e1-03-fixture', version: '1' }, servers: [{ url: `http://127.0.0.1:${upstreamPort}` }], paths };
}
function bindingsFor(names) {
  return names.map(name => ({ method: 'GET', path: `/${name}`, endpointDefinitionId: `endpoint-${name}`, sourceServiceAssetId: 'asset-one' }));
}
function registryDocument({ upstreamPort, revision, overrideHeader = 'X-Private', environment = 'test', siteCredential = 'parent', extraCredentials = {} }) {
  return {
    apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings',
    metadata: { revision, environment },
    reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true },
    secretProviders: { env: { type: 'env' } },
    credentials: { parent: { type: 'bearer', secretRef: 'env:UPSTREAM_PARENT' },
      override: { type: 'apiKey', placement: { in: 'header', name: overrideHeader }, secretRef: 'env:UPSTREAM_OVERRIDE' },
      ...extraCredentials },
    sites: [{ id: 'site-one', sourceServiceAssetId: 'asset-one',
      match: { scheme: 'http', host: '127.0.0.1', port: upstreamPort, basePath: '/' }, allowedHosts: ['127.0.0.1'],
      credential: siteCredential,
      endpoints: [{ endpointDefinitionId: 'endpoint-override', credential: 'override' }, { endpointDefinitionId: 'endpoint-none', credential: 'none' }] }],
  };
}
function runtimeEnvironment(extra = {}) {
  return {
    API_NOVA_RUNTIME_AUTH_MODE: 'api_key',
    API_NOVA_MCP_RESOURCE: 'https://managed.e1-03.invalid/mcp',
    API_NOVA_RUNTIME_API_KEYS: JSON.stringify([{ id: 'client-one', subject: 'synthetic-consumer',
      secretHash: hash('e1-03-consumer-key'), resources: ['https://managed.e1-03.invalid/mcp'], scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 600 }]),
    UPSTREAM_OVERRIDE: 'synthetic-unused-override',
    ...extra,
  };
}
function payloadFor({ launchId, serverId, runtimeAssetId, port, upstreamPort, spec, bindings, registryPath, revision, digest }) {
  return { version: 1, launchId, managedServerId: serverId, runtimeAssetId, inboundAuthMode: 'private_api_key',
    candidateRevision: 'candidate-one', verificationRunId: 'run-one', behaviorFingerprint: hash(JSON.stringify(canonical(spec))),
    transport: { type: 'streamable', host: '127.0.0.1', port, endpoint: '/mcp' }, openApiData: spec,
    trustedOperationBindings: bindings,
    registrySource: { configId: 'registry-one', path: registryPath, format: 'json', environment: 'test',
      expectedRevision: revision, expectedContentDigest: digest } };
}
function channelInput(payload, environmentValues) {
  return { launchId: payload.launchId, serverId: payload.managedServerId, payload,
    approvedEnvironmentNames: Object.keys(environmentValues), environmentValues };
}
async function connectClient(port, key, extraHeaders = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { 'x-api-key': key, ...extraHeaders } } });
  const client = new Client({ name: 'e1-03', version: '1' });
  await client.connect(transport);
  return client;
}
async function stopHandle(handle) {
  await handle.close();
  const closed = await handle.closed;
  await waitFor(() => pidGone(handle.pid));
  return closed;
}
const SYSTEM_ENV = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'TZ'];
function systemEnvironment() {
  const env = {};
  for (const name of Object.keys(process.env)) if (SYSTEM_ENV.includes(name.toUpperCase())) env[name] = process.env[name];
  return env;
}
async function directChild(messages, { ipc = true, disconnect = false } = {}) {
  const stdio = ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'];
  const child = spawn(process.execPath, [ENTRY], { env: systemEnvironment(), shell: false, detached: false, stdio });
  const replies = [];
  let stdout = '', stderr = '';
  child.on('message', value => replies.push(value));
  child.stdout?.on('data', chunk => { stdout += String(chunk); });
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  const closed = once(child, 'close');
  for (const message of messages) { try { child.send(message, () => undefined); } catch { /* closed */ } }
  if (disconnect) child.disconnect();
  const timeout = delay(15000).then(() => { child.kill('SIGKILL'); throw new Error('direct child timeout'); });
  const [code] = await Promise.race([closed, timeout]);
  return { code, replies, stdout, stderr, child };
}
async function withEnvironment(patch, fn) {
  const saved = new Map();
  for (const [name, value] of Object.entries(patch)) {
    saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  try { return await fn(); }
  finally { for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
}
async function captureOutput(fn) {
  const writes = [];
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => { writes.push(String(chunk)); return stdoutWrite(chunk, ...rest); };
  process.stderr.write = (chunk, ...rest) => { writes.push(String(chunk)); return stderrWrite(chunk, ...rest); };
  try { const result = await fn(); return { result, writes }; }
  finally { process.stdout.write = stdoutWrite; process.stderr.write = stderrWrite; }
}

const suiteResults = [];
const scenarioResults = [];
const failures = [];
const notCovered = [];
const rowNew = new Map(Array.from({ length: 13 }, (_, index) => [index + 1, []]));
const rowExisting = {
  1: ['test-managed-runtime.cjs', 'verify-e1-02c1.cjs', 'test-managed-mcp-handoff-preparation.cjs'],
  2: ['test-managed-runtime.cjs'],
  3: ['test-managed-runtime.cjs', 'test-managed-mcp-channel.cjs', 'test-managed-mcp-handoff-preparation.cjs'],
  4: ['verify-e1-02c2.cjs', 'test-managed-runtime.cjs', 'test-managed-mcp-handoff-preparation.cjs'],
  5: ['test-managed-mcp-handoff-preparation.cjs'],
  6: ['test-managed-mcp-channel.cjs', 'verify-e1-02c2.cjs'],
  7: [],
  8: ['test-managed-runtime.cjs'],
  9: ['verify-e1-02c2.cjs', 'test-managed-mcp-channel.cjs'],
  10: ['verify-e1-02c2.cjs'],
  11: ['test-managed-mcp-channel.cjs', 'verify-e1-02c2.cjs'],
  12: ['test-managed-runtime.cjs', 'test-managed-mcp-channel.cjs'],
  13: ['test-managed-runtime.cjs', 'test-managed-mcp-channel.cjs', 'verify-e1-02c1.cjs', 'verify-e1-02c2.cjs'],
};

function runSuite(label, scriptPath, cwd, marker) {
  const started = Date.now();
  const environment = { ...process.env, TEMP: tempRoot, TMP: tempRoot, DB_TYPE: 'sqlite', FORCE_COLOR: '0' };
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', scriptPath],
    { cwd, env: environment, encoding: 'utf8', timeout: 900000, maxBuffer: 128 * 1024 * 1024 });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const counter = name => {
    const match = output.match(new RegExp(`^# ${name} (\\d+)$`, 'm'));
    return match ? Number(match[1]) : null;
  };
  const tests = counter('tests'), passed = counter('pass'), failed = counter('fail');
  const markerSeen = marker ? output.includes(marker) : null;
  const status = result.status === 0 && failed === 0 && (marker ? markerSeen : true) ? 'passed' : 'failed';
  const record = { label, script: path.relative(repoRoot, scriptPath).replace(/\\/g, '/'), tests, passed, failed, marker: marker || null,
    markerSeen, status, ms: Date.now() - started, error: result.error ? String(result.error.message) : null };
  suiteResults.push(record);
  if (status === 'failed') failures.push(`suite ${label}: tests=${tests} pass=${passed} fail=${failed} exit=${result.status} marker=${markerSeen}\n${output.slice(-4000)}`);
  return record;
}

async function scenario(id, title, rows, fn) {
  const started = Date.now();
  try {
    const evidence = await fn();
    scenarioResults.push({ id, title, rows, status: 'passed', evidence, checks: evidence.length, ms: Date.now() - started });
    for (const row of rows) rowNew.get(row).push(id);
  } catch (error) {
    scenarioResults.push({ id, title, rows, status: 'failed', evidence: [], checks: 0, ms: Date.now() - started,
      error: String((error && error.stack) || error) });
    failures.push(`scenario ${id}: ${(error && error.message) || error}`);
  }
}

async function newSuiteScenarios() {
  await scenario('N1', 'built artifact uses only the current Registry credential; None has no fallback under parent pollution; consumer and forged values never reach upstream; 302 target is not requested', [1, 2, 3, 8], async () => {
    const evidence = [];
    const upstream = await startRecorder();
    const registryPath = path.join(directory, `n1-registry-${upstream.port}.json`);
    const registryText = JSON.stringify(registryDocument({ upstreamPort: upstream.port, revision: 'r1' }));
    fs.writeFileSync(registryPath, registryText);
    const spec = specDocument(upstream.port, ['inherit', 'override', 'none', 'redirect']);
    const payload = payloadFor({ launchId: 'e1-03-n1-launch', serverId: 'e1-03-n1-server', runtimeAssetId: 'e1-03-n1-asset',
      port: await freePort(), upstreamPort: upstream.port, spec, bindings: bindingsFor(['inherit', 'override', 'none', 'redirect']),
      registryPath, revision: 'r1', digest: hash(registryText) });
    const environmentValues = runtimeEnvironment({ UPSTREAM_PARENT: 'synthetic-parent-secret', UPSTREAM_OVERRIDE: 'synthetic-override-secret' });
    const pollution = { UPSTREAM_PARENT: 'ambient-must-not-win', UPSTREAM_OVERRIDE: 'ambient-must-not-win',
      JWT_SECRET: 'synthetic-management-jwt-secret', HTTP_PROXY: 'http://user:pass@127.0.0.1:1',
      MCP_LEGACY_BEARER_TOKEN: 'synthetic-legacy-token', API_NOVA_RUNTIME_API_KEYS: 'legacy-invalid-envelope' };
    const axios = require('axios');
    const previousAuthorization = axios.defaults.headers.common.Authorization;
    axios.defaults.headers.common.Authorization = 'Bearer synthetic-axios-polluted';
    try {
      await withEnvironment(pollution, async () => {
        const handle = await startManagedMcpChannel(channelInput(payload, environmentValues));
        try {
          const revisions = await handle.ready;
          assert.equal(revisions.authMode, 'api_key');
          assert.equal(revisions.credentialMode, 'single-hop');
          evidence.push('real READY from built artifact');
          const spawned = launches.at(-1);
          assert.deepEqual(spawned.args, [ENTRY]);
          assert.equal(spawned.options.shell, false);
          assert.deepEqual(Array.from(spawned.options.stdio), ['pipe', 'pipe', 'pipe', 'ipc']);
          for (const name of ['JWT_SECRET', 'HTTP_PROXY', 'MCP_LEGACY_BEARER_TOKEN']) {
            assert.equal(spawned.options.env[name], undefined, `ambient ${name} must not be inherited`);
          }
          assert.equal(spawned.options.env.API_NOVA_RUNTIME_API_KEYS, environmentValues.API_NOVA_RUNTIME_API_KEYS);
          assert.notEqual(spawned.options.env.API_NOVA_RUNTIME_API_KEYS, pollution.API_NOVA_RUNTIME_API_KEYS);
          assert.equal(spawned.options.env.UPSTREAM_PARENT, 'synthetic-parent-secret');
          evidence.push('spawn env exact replacement');
          assert.equal(await httpStatus(`http://127.0.0.1:${payload.transport.port}/mcp`, { accept: 'text/event-stream' }), 401);
          evidence.push('401 without consumer identity');
          const client = await connectClient(payload.transport.port, 'e1-03-consumer-key');
          try {
            const list = await client.listTools();
            assert.equal(list.tools.length, 4);
            const forged = { Authorization: 'consumer-secret', 'X-Api-Key': 'consumer-forged-key', 'X-Private': 'consumer-private', 'X-Tenant': 'tenant-approved' };
            for (const name of ['inherit', 'override', 'none', 'redirect']) {
              const result = await client.callTool({ name, arguments: forged });
              assert.equal(result.isError === true, name === 'redirect', `${name}: ${JSON.stringify(result)}`);
            }
          } finally { await client.close(); }
          evidence.push('real tool calls through SDK session');
          assert.equal(upstream.received.length, 4);
          const recorded = Object.fromEntries(upstream.received.map(entry => [entry.path, entry.headers]));
          assert.equal(recorded['/inherit'].authorization, 'Bearer synthetic-parent-secret');
          assert.equal(recorded['/override']['x-private'], 'synthetic-override-secret');
          assert.equal(recorded['/override'].authorization, undefined);
          assert.equal(recorded['/none'].authorization, undefined);
          assert.equal(recorded['/none']['x-private'], undefined);
          assert.equal(recorded['/none']['x-api-key'], undefined);
          for (const entry of upstream.received) {
            assert.equal(entry.headers['x-tenant'], 'tenant-approved');
            const wire = JSON.stringify(entry);
            for (const marker of ['consumer-', 'ambient-must-not-win', 'synthetic-axios-polluted', 'synthetic-legacy-token']) {
              assert.ok(!wire.includes(marker), `upstream received ${marker}`);
            }
          }
          assert.ok(!upstream.received.some(entry => entry.path === '/redirect-target'));
          evidence.push('inherit/override/None policy + no 302 replay + no consumer values');
          const closed = await stopHandle(handle);
          assert.deepEqual(closed, { code: 'STOPPED' });
          assert.ok(await waitFor(() => unreachable(`http://127.0.0.1:${payload.transport.port}/mcp`)));
          evidence.push('stop exits and releases the port');
        } catch (error) { await handle.close().catch(() => undefined); throw error; }
      });
    } finally {
      if (previousAuthorization === undefined) delete axios.defaults.headers.common.Authorization;
      else axios.defaults.headers.common.Authorization = previousAuthorization;
    }
    await upstream.close();
    return evidence;
  });

  await scenario('N2', 'built child rejects forged consumer identity, duplicate and cross-asset bindings before READY with zero upstream requests', [3], async () => {
    const evidence = [];
    const upstream = await startRecorder();
    const registryPath = path.join(directory, `n2-registry-${upstream.port}.json`);
    const registryText = JSON.stringify(registryDocument({ upstreamPort: upstream.port, revision: 'r1' }));
    fs.writeFileSync(registryPath, registryText);
    const spec = specDocument(upstream.port, ['inherit', 'other']);
    const baseBindings = bindingsFor(['inherit']);
    const base = () => payloadFor({ launchId: 'e1-03-n2-launch', serverId: 'e1-03-n2-server', runtimeAssetId: 'e1-03-n2-asset',
      port: 9107, upstreamPort: upstream.port, spec, bindings: baseBindings, registryPath, revision: 'r1', digest: hash(registryText) });

    const duplicate = base();
    duplicate.trustedOperationBindings = [{ ...baseBindings[0] }, { ...baseBindings[0] }];
    const duplicateResult = await directChild([{ type: 'handoff', version: 1, launchId: duplicate.launchId, payload: duplicate }]);
    assert.equal(duplicateResult.code, 1);
    assert.equal(duplicateResult.replies[0]?.code, 'INVALID_MANAGED_HANDOFF');
    assert.ok(!duplicateResult.replies.some(message => message.type === 'handoffAccepted' || message.type === 'runtimeReady'));
    evidence.push('real child rejects duplicate bindings before ACK');

    const crossAsset = base();
    crossAsset.trustedOperationBindings = [...baseBindings,
      { method: 'GET', path: '/other', endpointDefinitionId: 'endpoint-other', sourceServiceAssetId: 'asset-elsewhere' }];
    const crossResult = await directChild([{ type: 'handoff', version: 1, launchId: crossAsset.launchId, payload: crossAsset }]);
    assert.equal(crossResult.code, 1);
    assert.equal(crossResult.replies[0]?.type, 'handoffAccepted');
    assert.equal(crossResult.replies.at(-1)?.code, 'MANAGED_RUNTIME_FAILED');
    evidence.push('real child fails closed on cross-asset binding after ACK, before READY');

    const missing = base();
    missing.trustedOperationBindings = [...baseBindings,
      { method: 'GET', path: '/other', endpointDefinitionId: 'endpoint-unbound', sourceServiceAssetId: 'asset-one' }];
    const missingResult = await directChild([{ type: 'handoff', version: 1, launchId: missing.launchId, payload: missing }]);
    assert.equal(missingResult.code, 1);
    assert.equal(missingResult.replies[0]?.type, 'handoffAccepted');
    assert.equal(missingResult.replies.at(-1)?.code, 'MANAGED_RUNTIME_FAILED');
    evidence.push('real child fails closed on unbound endpoint after ACK');

    assert.equal(upstream.received.length, 0);
    assert.equal(await httpStatus('http://127.0.0.1:9107/mcp', { accept: 'text/event-stream' }), null);
    for (const result of [duplicateResult, crossResult, missingResult]) {
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
    }
    evidence.push('zero upstream requests, no listener, no raw diagnostics');
    await upstream.close();
    return evidence;
  });

  await scenario('N3', 'Registry content changed after preparation is rejected; a fresh preparation binds only the new verified revision', [4], async () => {
    const evidence = [];
    const upstream = await startRecorder();
    const registryPath = path.join(directory, `n3-registry-${upstream.port}.json`);
    const firstText = JSON.stringify(registryDocument({ upstreamPort: upstream.port, revision: 'r1' }));
    fs.writeFileSync(registryPath, firstText);
    const spec = specDocument(upstream.port, ['inherit']);
    const port = await freePort();
    const stale = payloadFor({ launchId: 'e1-03-n3-stale', serverId: 'e1-03-n3-server', runtimeAssetId: 'e1-03-n3-asset',
      port, upstreamPort: upstream.port, spec, bindings: bindingsFor(['inherit']), registryPath, revision: 'r1', digest: hash(firstText) });

    const secondDocument = registryDocument({ upstreamPort: upstream.port, revision: 'r2' });
    secondDocument.credentials.parent.secretRef = 'env:UPSTREAM_SECOND';
    const secondText = JSON.stringify(secondDocument);
    fs.writeFileSync(registryPath, secondText);

    const staleHandle = await startManagedMcpChannel(channelInput(stale, runtimeEnvironment({ UPSTREAM_PARENT: 'synthetic-first-secret' })));
    await assert.rejects(staleHandle.ready, error => error.code === 'MANAGED_RUNTIME_FAILED');
    assert.deepEqual(await staleHandle.closed, { code: 'MANAGED_RUNTIME_FAILED' });
    await waitFor(() => pidGone(staleHandle.pid));
    assert.equal(upstream.received.length, 0);
    assert.ok(await unreachable(`http://127.0.0.1:${port}/mcp`));
    evidence.push('stale prepared package rejected with zero upstream and no listener');

    const fresh = payloadFor({ launchId: 'e1-03-n3-fresh', serverId: 'e1-03-n3-server', runtimeAssetId: 'e1-03-n3-asset',
      port, upstreamPort: upstream.port, spec, bindings: bindingsFor(['inherit']), registryPath, revision: 'r2', digest: hash(secondText) });
    const freshHandle = await startManagedMcpChannel(channelInput(fresh, runtimeEnvironment({ UPSTREAM_SECOND: 'synthetic-second-secret' })));
    try {
      const revisions = await freshHandle.ready;
      assert.equal(revisions.registryRevision, 'r2');
      assert.equal(revisions.registryContentDigest, hash(secondText));
      const client = await connectClient(port, 'e1-03-consumer-key');
      try { await client.callTool({ name: 'inherit', arguments: {} }); } finally { await client.close(); }
      assert.equal(upstream.received.length, 1);
      assert.equal(upstream.received[0].headers.authorization, 'Bearer synthetic-second-secret');
      evidence.push('fresh preparation verifies and uses the moved-on revision only');
    } finally { await stopHandle(freshHandle); }
    await upstream.close();
    return evidence;
  });

  await scenario('N4', 'OpenAPI mutated after fingerprinting is rejected by the built child before READY', [5], async () => {
    const evidence = [];
    const upstream = await startRecorder();
    const registryPath = path.join(directory, `n4-registry-${upstream.port}.json`);
    const registryText = JSON.stringify(registryDocument({ upstreamPort: upstream.port, revision: 'r1' }));
    fs.writeFileSync(registryPath, registryText);
    const spec = specDocument(upstream.port, ['inherit']);
    const port = await freePort();
    const payload = payloadFor({ launchId: 'e1-03-n4-launch', serverId: 'e1-03-n4-server', runtimeAssetId: 'e1-03-n4-asset',
      port, upstreamPort: upstream.port, spec, bindings: bindingsFor(['inherit']), registryPath, revision: 'r1', digest: hash(registryText) });
    payload.openApiData = JSON.parse(JSON.stringify(spec));
    payload.openApiData.info.title = 'mutated-after-fingerprint';
    const handle = await startManagedMcpChannel(channelInput(payload, runtimeEnvironment({ UPSTREAM_PARENT: 'synthetic-parent-secret' })));
    await assert.rejects(handle.ready, error => error.code === 'MANAGED_RUNTIME_FAILED');
    assert.deepEqual(await handle.closed, { code: 'MANAGED_RUNTIME_FAILED' });
    await waitFor(() => pidGone(handle.pid));
    assert.equal(upstream.received.length, 0);
    assert.ok(await unreachable(`http://127.0.0.1:${port}/mcp`));
    evidence.push('candidate fingerprint mismatch: no READY, zero upstream, no listener');
    await upstream.close();
    return evidence;
  });

  await scenario('N5', 'fixed failure envelope and cleanup: no IPC, wrong version/launchId, duplicate handoff, over-limit package', [6], async () => {
    const evidence = [];
    const upstream = await startRecorder();
    const noIpc = await directChild([], { ipc: false });
    assert.equal(noIpc.code, 1);
    assert.equal(noIpc.stderr, 'MANAGED_IPC_REQUIRED\n');
    assert.equal(noIpc.stdout, '');
    evidence.push('no IPC: fixed stderr and exit 1');
    const wrongVersion = await directChild([{ type: 'handoff', version: 2, launchId: 'e1-03-n5', payload: {} }]);
    assert.equal(wrongVersion.code, 1);
    assert.equal(wrongVersion.replies[0]?.code, 'INVALID_MANAGED_HANDOFF');
    assert.equal(wrongVersion.stdout, '');
    const wrongLaunch = await directChild([{ type: 'handoff', version: 1, launchId: 'wrong-launch', payload: {} }]);
    assert.equal(wrongLaunch.code, 1);
    assert.equal(wrongLaunch.replies[0]?.code, 'INVALID_MANAGED_HANDOFF');
    evidence.push('wrong version/launchId: fixed failure before ACK');

    const registryPath = path.join(directory, `n5-registry-${upstream.port}.json`);
    const registryText = JSON.stringify(registryDocument({ upstreamPort: upstream.port, revision: 'r1' }));
    fs.writeFileSync(registryPath, registryText);
    const spec = specDocument(upstream.port, ['inherit']);
    const payload = payloadFor({ launchId: 'e1-03-n5-launch', serverId: 'e1-03-n5-server', runtimeAssetId: 'e1-03-n5-asset',
      port: 9108, upstreamPort: upstream.port, spec, bindings: bindingsFor(['inherit']), registryPath, revision: 'r1', digest: hash(registryText) });
    const message = { type: 'handoff', version: 1, launchId: payload.launchId, payload };
    const duplicate = await directChild([message, message]);
    assert.equal(duplicate.code, 1);
    assert.equal(duplicate.replies[0]?.type, 'handoffAccepted');
    assert.equal(duplicate.replies.at(-1)?.code, 'INVALID_MANAGED_HANDOFF');
    evidence.push('duplicate handoff fails closed after ACK');

    const oversized = JSON.parse(JSON.stringify(payload));
    oversized.openApiData = { blob: 'x'.repeat(8 * 1024 * 1024) };
    const oversizedResult = await directChild([{ type: 'handoff', version: 1, launchId: oversized.launchId, payload: oversized }]);
    assert.equal(oversizedResult.code, 1);
    assert.equal(oversizedResult.replies[0]?.code, 'INVALID_MANAGED_HANDOFF');
    const tooManyBindings = JSON.parse(JSON.stringify(payload));
    tooManyBindings.trustedOperationBindings = new Array(10001).fill({ method: 'GET', path: '/inherit', endpointDefinitionId: 'endpoint-inherit', sourceServiceAssetId: 'asset-one' });
    const bindingsResult = await directChild([{ type: 'handoff', version: 1, launchId: tooManyBindings.launchId, payload: tooManyBindings }]);
    assert.equal(bindingsResult.code, 1);
    assert.equal(bindingsResult.replies[0]?.code, 'INVALID_MANAGED_HANDOFF');
    evidence.push('over-limit bytes and bindings fail with the fixed code');

    assert.equal(upstream.received.length, 0);
    assert.equal(await httpStatus('http://127.0.0.1:9108/mcp', { accept: 'text/event-stream' }), null);
    const spawned = launches.at(-1);
    assert.deepEqual(spawned.args, [ENTRY]);
    assert.ok(!JSON.stringify(spawned.args).includes('openapi'));
    evidence.push('no default swagger/remote fallback and no leftover listener');
    await upstream.close();
    return evidence;
  });

  await scenario('N6', 'two runtimes with the same OpenAPI keep independent Registry closures; parallel sessions on one runtime share only its own closure', [7], async () => {
    const evidence = [];
    const upstream = await startRecorder();
    const spec = specDocument(upstream.port, ['inherit']);
    const bindings = bindingsFor(['inherit']);

    const registryA = registryDocument({ upstreamPort: upstream.port, revision: 'r1', siteCredential: 'parent' });
    const textA = JSON.stringify(registryA);
    const registryB = registryDocument({ upstreamPort: upstream.port, revision: 'r1', siteCredential: 'override', overrideHeader: 'X-Private' });
    const textB = JSON.stringify(registryB);
    const pathA = path.join(directory, `n6-registry-a-${upstream.port}.json`);
    const pathB = path.join(directory, `n6-registry-b-${upstream.port}.json`);
    fs.writeFileSync(pathA, textA);
    fs.writeFileSync(pathB, textB);
    assert.equal(hash(JSON.stringify(canonical(spec))), hash(JSON.stringify(canonical(spec))));
    assert.notEqual(hash(textA), hash(textB));

    const payloadA = payloadFor({ launchId: 'e1-03-n6-a', serverId: 'e1-03-n6-server-a', runtimeAssetId: 'e1-03-n6-asset-a',
      port: await freePort(), upstreamPort: upstream.port, spec, bindings, registryPath: pathA, revision: 'r1', digest: hash(textA) });
    const payloadB = payloadFor({ launchId: 'e1-03-n6-b', serverId: 'e1-03-n6-server-b', runtimeAssetId: 'e1-03-n6-asset-b',
      port: await freePort(), upstreamPort: upstream.port, spec, bindings, registryPath: pathB, revision: 'r1', digest: hash(textB) });
    const envA = runtimeEnvironment({ UPSTREAM_PARENT: 'synthetic-runtime-a-secret', UPSTREAM_OVERRIDE: 'synthetic-unused-secret' });
    const envB = runtimeEnvironment({ UPSTREAM_PARENT: 'synthetic-runtime-b-unused', UPSTREAM_OVERRIDE: 'synthetic-runtime-b-secret' });

    const handleA = await startManagedMcpChannel(channelInput(payloadA, envA));
    const handleB = await startManagedMcpChannel(channelInput(payloadB, envB));
    try {
      const [readyA, readyB] = await Promise.all([handleA.ready, handleB.ready]);
      assert.equal(readyA.registryContentDigest, hash(textA));
      assert.equal(readyB.registryContentDigest, hash(textB));
      evidence.push('both real children READY with their own Registry digest at the same revision label');
      const clientsA = await Promise.all([connectClient(payloadA.transport.port, 'e1-03-consumer-key'), connectClient(payloadA.transport.port, 'e1-03-consumer-key')]);
      const clientB = await connectClient(payloadB.transport.port, 'e1-03-consumer-key');
      try {
        await clientsA[0].callTool({ name: 'inherit', arguments: {} });
        await clientsA[1].callTool({ name: 'inherit', arguments: {} });
        await clientB.callTool({ name: 'inherit', arguments: {} });
      } finally { await Promise.all([...clientsA, clientB].map(client => client.close())); }
      evidence.push('multi-session calls on runtime A and a single session on runtime B');
      assert.equal(upstream.received.length, 3);
      assert.equal(upstream.received[0].headers.authorization, 'Bearer synthetic-runtime-a-secret');
      assert.equal(upstream.received[1].headers.authorization, 'Bearer synthetic-runtime-a-secret');
      assert.equal(upstream.received[0].headers['x-private'], undefined);
      assert.equal(upstream.received[1].headers['x-private'], undefined);
      assert.equal(upstream.received[2].headers['x-private'], 'synthetic-runtime-b-secret');
      assert.equal(upstream.received[2].headers.authorization, undefined);
      const wire = JSON.stringify(upstream.received.slice(0, 2));
      assert.ok(!wire.includes('synthetic-runtime-b-secret'));
      assert.ok(!JSON.stringify(upstream.received[2]).includes('synthetic-runtime-a-secret'));
      evidence.push('each runtime uses only its own binding/Registry closure, no cross-prepared reuse');
    } finally {
      await Promise.allSettled([stopHandle(handleA), stopHandle(handleB)]);
    }
    await upstream.close();
    return evidence;
  });

  await scenario('N7', 'built artifact Windows evidence: direct node spawn, exact IPC flags, parent disconnect cleanup, real argv', [10, 11, 13], async () => {
    const evidence = [];
    assert.equal(process.platform, 'win32');
    const upstream = await startRecorder();
    const registryPath = path.join(directory, `n7-registry-${upstream.port}.json`);
    const registryText = JSON.stringify(registryDocument({ upstreamPort: upstream.port, revision: 'r1' }));
    fs.writeFileSync(registryPath, registryText);
    const spec = specDocument(upstream.port, ['inherit']);
    const payload = payloadFor({ launchId: 'e1-03-n7-launch', serverId: 'e1-03-n7-server', runtimeAssetId: 'e1-03-n7-asset',
      port: await freePort(), upstreamPort: upstream.port, spec, bindings: bindingsFor(['inherit']), registryPath, revision: 'r1', digest: hash(registryText) });
    const environmentValues = runtimeEnvironment({ UPSTREAM_PARENT: 'synthetic-parent-secret' });
    const handle = await startManagedMcpChannel(channelInput(payload, environmentValues));
    await handle.ready;
    const spawned = launches.at(-1);
    assert.equal(spawned.command, process.execPath);
    assert.deepEqual(spawned.args, [ENTRY]);
    assert.ok(!JSON.stringify(spawned.args).includes('secret'));
    assert.equal(spawned.options.shell, false);
    assert.equal(spawned.options.detached, false);
    assert.deepEqual(Array.from(spawned.options.stdio), ['pipe', 'pipe', 'pipe', 'ipc']);
    assert.equal(spawned.options.env.UPSTREAM_PARENT, 'synthetic-parent-secret');
    assert.equal(spawned.options.env.NODE_OPTIONS, undefined);
    evidence.push(`direct spawn on ${process.platform} ${process.version} with exact IPC flags and secret-free argv`);
    spawned.child.disconnect();
    const closed = await handle.closed;
    assert.deepEqual(closed, { code: 'MANAGED_CHANNEL_FAILED' });
    await waitFor(() => pidGone(handle.pid));
    assert.equal(spawned.stdout, '');
    assert.equal(spawned.stderr, '');
    assert.ok(await waitFor(() => unreachable(`http://127.0.0.1:${payload.transport.port}/mcp`)));
    evidence.push('parent disconnect stops the child and releases the port');
    await upstream.close();
    return evidence;
  });

  await scenario('N8', 'product lifecycle persistence scan and bootstrap failure: no secret in store/status/logs/errors; failure leaves no current and no process', [9, 11], async () => {
    const evidence = [];
    const upstream = await startRecorder();
    const registryPath = path.join(directory, `n8-registry-${upstream.port}.json`);
    const registryText = JSON.stringify(registryDocument({ upstreamPort: upstream.port, revision: 'r1' }));
    fs.writeFileSync(registryPath, registryText);
    const spec = specDocument(upstream.port, ['inherit']);
    const specWithMarker = JSON.parse(JSON.stringify(spec));
    specWithMarker.info.description = 'e1-03-openapi-marker';
    const serverId = 'e1-03-lifecycle-server';
    const runtimeAssetId = 'e1-03-lifecycle-asset';
    const port = await freePort();
    const payload = payloadFor({ launchId: 'e1-03-n8-launch', serverId, runtimeAssetId, port, upstreamPort: upstream.port,
      spec: specWithMarker, bindings: bindingsFor(['inherit']), registryPath, revision: 'r1', digest: hash(registryText) });
    payload.behaviorFingerprint = hash(JSON.stringify(canonical(specWithMarker)));
    const environmentValues = runtimeEnvironment({ UPSTREAM_PARENT: 'E1-03-SYNTHETIC-UPSTREAM-SECRET' });
    const db = new DataSource({ type: 'sqljs', synchronize: true, entities: [RuntimePipelineStateEntity] });
    await db.initialize();
    const store = new DataSourceManagedMcpLifecycleStore(db);
    const config = { get(key) {
      if (key === MANAGED_MCP_LIFECYCLE_APPROVAL_CONFIG_KEY) return { [runtimeAssetId]: { version: 1, mode: 'auto', policyId: 'e1-03-runner',
        allowedActions: ['start', 'stop'], allowedServerIds: [serverId] } };
      return undefined;
    } };
    let captured = { payload, approvedEnvironmentNames: Object.keys(environmentValues), environmentValues };
    const stateChanges = [];
    const coordinator = new ManagedMcpLifecycleCoordinator({ store, capture: async () => captured,
      approval: createConfigManagedLifecycleApprovalProvider(config),
      channel: input => startManagedMcpChannel(input), onStateChange: change => stateChanges.push(change) });
    const secrets = ['E1-03-SYNTHETIC-UPSTREAM-SECRET', 'e1-03-consumer-key', 'synthetic-legacy-token', 'e1-03-openapi-marker'];
    const scan = (label, value) => {
      const wire = typeof value === 'string' ? value : JSON.stringify(value);
      for (const secret of secrets) assert.ok(!wire.includes(secret), `${label} leaked ${secret}`);
    };
    let failureError;
    const capturedRun = await captureOutput(async () => {
      const started = await coordinator.start({ serverId, runtimeAssetId });
      assert.equal(started.generation, 1);
      assert.equal((await coordinator.status(serverId)).view.state, 'current');
      assert.equal(await httpStatus(`http://127.0.0.1:${port}/mcp`, { accept: 'text/event-stream' }), 401);
      const retainedPid = started.pid;
      await assert.rejects(coordinator.start({ serverId, runtimeAssetId }), error => error.code === 'MANAGED_LIFECYCLE_ALREADY_CURRENT');
      assert.equal(pidGone(retainedPid), false);
      assert.equal(await httpStatus(`http://127.0.0.1:${port}/mcp`, { accept: 'text/event-stream' }), 401);
      evidence.push('rejected switch retains the existing verified instance');
      const stopped = await coordinator.stop(serverId);
      assert.equal(stopped.status, 'stopped');
      await waitFor(() => unreachable(`http://127.0.0.1:${port}/mcp`));
      captured = { payload: { ...payload, launchId: 'e1-03-n8-second', registrySource: { ...payload.registrySource, expectedContentDigest: '0'.repeat(64) } },
        approvedEnvironmentNames: Object.keys(environmentValues), environmentValues };
      try { await coordinator.start({ serverId, runtimeAssetId }); }
      catch (error) { failureError = error; }
      assert.equal(failureError?.code, 'MANAGED_LIFECYCLE_CHANNEL_FAILED');
    });
    assert.ok(failureError);
    const status = await coordinator.status(serverId);
    assert.equal(status.view.state, 'failed');
    assert.equal(status.view.current, false);
    const record = await store.read(serverId);
    assert.equal(record.record.state, 'failed');
    assert.equal(record.record.snapshot.registryRevision, 'r1');
    scan('store record', record);
    scan('lifecycle status', status);
    scan('state changes', stateChanges);
    scan('parent output', capturedRun.writes.join(''));
    scan('failure error', String(failureError.stack || failureError));
    for (const launched of launches) {
      scan('child argv', launched.args);
      scan('child stdout', launched.stdout);
      scan('child stderr', launched.stderr);
      for (const secret of ['synthetic-legacy-token', 'e1-03-openapi-marker', 'e1-03-consumer-key']) {
        assert.ok(!JSON.stringify(launched.options.env).includes(secret), `child env leaked ${secret}`);
      }
    }
    const rows = await db.getRepository(RuntimePipelineStateEntity).find();
    assert.equal(rows.length, 1);
    scan('raw persisted rows', rows);
    assert.equal(await httpStatus(`http://127.0.0.1:${port}/mcp`, { accept: 'text/event-stream' }), null);
    evidence.push('argv/env/stdout/stderr/store/status/error audit scan clean after planted secrets');
    evidence.push('bootstrap failure leaves no current and no live process');
    assert.equal(rows[0].value.openApiData, undefined);
    evidence.push('managed lifecycle projection never persists openApiData');
    await coordinator.onModuleDestroy().catch(() => undefined);
    await db.destroy();
    await upstream.close();
    return evidence;
  });

  await scenario('N9', 'inbound auth environment trimming: ambient JWT/management values are not inherited; no identity rejected; per-request tool authorization intact', [3, 12], async () => {
    const evidence = [];
    const upstream = await startRecorder();
    const registryPath = path.join(directory, `n9-registry-${upstream.port}.json`);
    const registryText = JSON.stringify(registryDocument({ upstreamPort: upstream.port, revision: 'r1' }));
    fs.writeFileSync(registryPath, registryText);
    const spec = specDocument(upstream.port, ['inherit', 'none']);
    const payload = payloadFor({ launchId: 'e1-03-n9-launch', serverId: 'e1-03-n9-server', runtimeAssetId: 'e1-03-n9-asset',
      port: await freePort(), upstreamPort: upstream.port, spec, bindings: bindingsFor(['inherit', 'none']), registryPath, revision: 'r1', digest: hash(registryText) });
    const environmentValues = runtimeEnvironment({ UPSTREAM_PARENT: 'synthetic-parent-secret',
      API_NOVA_MCP_TOOL_SCOPES: JSON.stringify({ none: ['e1-03:special'] }) });
    const pollution = { API_NOVA_RUNTIME_AUTH_MODE: 'jwt', API_NOVA_RUNTIME_JWKS_JSON: '{"keys":[{"kty":"oct","k":"synthetic"}]}',
      JWT_SECRET: 'ambient-management-jwt', NODE_OPTIONS: '--require synthetic-ambient', API_NOVA_MCP_TOOL_SCOPES: '{"inherit":["ambient"]}' };
    await withEnvironment(pollution, async () => {
      const handle = await startManagedMcpChannel(channelInput(payload, environmentValues));
      try {
        const revisions = await handle.ready;
        assert.equal(revisions.authMode, 'api_key');
        const spawned = launches.at(-1);
        assert.equal(spawned.options.env.API_NOVA_RUNTIME_AUTH_MODE, 'api_key');
        assert.equal(spawned.options.env.API_NOVA_RUNTIME_JWKS_JSON, undefined);
        assert.equal(spawned.options.env.JWT_SECRET, undefined);
        assert.equal(spawned.options.env.NODE_OPTIONS, undefined);
        assert.equal(spawned.options.env.API_NOVA_MCP_TOOL_SCOPES, environmentValues.API_NOVA_MCP_TOOL_SCOPES);
        evidence.push('approved inbound env replaces ambient JWT/management values');
        const mcpUrl = `http://127.0.0.1:${payload.transport.port}/mcp`;
        assert.equal(await httpStatus(mcpUrl, { accept: 'text/event-stream' }), 401);
        assert.equal(await httpStatus(mcpUrl, { 'x-api-key': 'wrong-key', accept: 'application/json, text/event-stream' }), 401);
        const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e1-03', version: '1' } } });
        const accepted = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-api-key': 'e1-03-consumer-key' }, body: initialize, signal: AbortSignal.timeout(3000) });
        await accepted.arrayBuffer();
        assert.equal(accepted.status, 200);
        evidence.push('missing/wrong identity rejected and the API key accepted per request');
        const client = await connectClient(payload.transport.port, 'e1-03-consumer-key');
        try {
          const list = await client.listTools();
          assert.ok(!list.tools.some(tool => tool.name === 'none'));
          assert.ok(list.tools.some(tool => tool.name === 'inherit'));
          let denied = false;
          try { const result = await client.callTool({ name: 'none', arguments: {} }); denied = result.isError === true; }
          catch { denied = true; }
          assert.equal(denied, true);
          await client.callTool({ name: 'inherit', arguments: {} });
        } finally { await client.close(); }
        evidence.push('tool list/execution scopes rechecked per request for the session');
        assert.equal(upstream.received.length, 1);
        assert.equal(upstream.received[0].headers.authorization, 'Bearer synthetic-parent-secret');
      } finally { await stopHandle(handle); }
    });
    await upstream.close();
    return evidence;
  });
}

async function linuxScenario() {
  await scenario('N10', 'Linux bounded container: direct node spawn + IPC + READY/auth + exit cleanup on the built artifact', [13], async () => {
    const probe = spawnSync('docker', ['image', 'inspect', '--format', '{{.Os}}', 'node:24-alpine'],
      { encoding: 'utf8', timeout: 20000 });
    if (process.env.E1_03_SKIP_DOCKER === '1' || probe.status !== 0 || String(probe.stdout).trim() !== 'linux') {
      notCovered.push({ row: 13, item: 'linux-container', reason: 'local node:24-alpine image or Linux Docker engine unavailable' });
      return ['linux attempt skipped'];
    }
    const harnessDir = path.join(tempRoot, 'linux-check');
    fs.mkdirSync(harnessDir, { recursive: true });
    const harnessPath = path.join(harnessDir, 'verify.cjs');
    fs.writeFileSync(harnessPath, `'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const ENTRY = '/repo/packages/api-nova-server/dist/managed/entry.js';
const hash = text => createHash('sha256').update(text).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
const checks = [];
async function freePort() { const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function unreachable(url) { try { await fetch(url, { signal: AbortSignal.timeout(500) }); return false; } catch { return true; } }
async function main() {
  {
    const child = spawn(process.execPath, [ENTRY], { env: { PATH: process.env.PATH, HOME: '/work' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const [code] = await once(child, 'close');
    assert.equal(code, 1); assert.equal(output, 'MANAGED_IPC_REQUIRED\\n'); checks.push('no-IPC fixed exit');
  }
  {
    const child = spawn(process.execPath, [ENTRY], { env: { PATH: process.env.PATH, HOME: '/work' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const replies = []; child.on('message', value => replies.push(value));
    child.send({ type: 'handoff', version: 2, launchId: 'linux', payload: {} }, () => undefined);
    const [code] = await once(child, 'close');
    assert.equal(code, 1); assert.equal(replies[0] && replies[0].code, 'INVALID_MANAGED_HANDOFF'); checks.push('wrong-version fixed exit');
  }
  const received = [];
  const upstream = http.createServer((request, response) => { received.push(request.url); response.setHeader('content-type', 'application/json'); response.end('{"ok":true}'); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamPort = upstream.address().port;
  const registryPath = '/work/registry-linux.json';
  const registry = { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'r1', environment: 'test' },
    reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { env: { type: 'env' } },
    credentials: { parent: { type: 'bearer', secretRef: 'env:UPSTREAM_PARENT' } },
    sites: [{ id: 'site-one', sourceServiceAssetId: 'asset-one', match: { scheme: 'http', host: '127.0.0.1', port: upstreamPort, basePath: '/' },
      allowedHosts: ['127.0.0.1'], credential: 'parent', endpoints: [{ endpointDefinitionId: 'endpoint-inherit', credential: 'none' }] }] };
  const registryText = JSON.stringify(registry);
  fs.writeFileSync(registryPath, registryText);
  const spec = { openapi: '3.0.3', info: { title: 'linux', version: '1' }, servers: [{ url: 'http://127.0.0.1:' + upstreamPort }],
    paths: { '/inherit': { get: { operationId: 'inherit', responses: { 200: { description: 'ok' } } } } } };
  const port = await freePort();
  const payload = { version: 1, launchId: 'e1-03-linux-launch', managedServerId: 'e1-03-linux-server', runtimeAssetId: 'e1-03-linux-asset',
    inboundAuthMode: 'private_api_key', candidateRevision: 'candidate-one', verificationRunId: 'run-one',
    behaviorFingerprint: hash(JSON.stringify(canonical(spec))), transport: { type: 'streamable', host: '127.0.0.1', port, endpoint: '/mcp' },
    openApiData: spec, trustedOperationBindings: [{ method: 'GET', path: '/inherit', endpointDefinitionId: 'endpoint-inherit', sourceServiceAssetId: 'asset-one' }],
    registrySource: { configId: 'registry-one', path: registryPath, format: 'json', environment: 'test', expectedRevision: 'r1', expectedContentDigest: hash(registryText) } };
  const environment = { PATH: process.env.PATH, HOME: '/work', NODE_PATH: process.env.NODE_PATH,
    API_NOVA_RUNTIME_AUTH_MODE: 'api_key', API_NOVA_MCP_RESOURCE: 'https://managed.e1-03.invalid/mcp',
    API_NOVA_RUNTIME_API_KEYS: JSON.stringify([{ id: 'linux-key', subject: 'linux-consumer', secretHash: hash('e1-03-consumer-key'),
      resources: ['https://managed.e1-03.invalid/mcp'], scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 300 }]),
    UPSTREAM_PARENT: 'synthetic-linux-secret' };
  const child = spawn(process.execPath, [ENTRY], { env: environment, shell: false, detached: false, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('linux READY timeout')), 25000);
    child.on('message', message => {
      if (message && message.type === 'runtimeReady') { clearTimeout(timer); resolve(message); }
      if (message && message.type === 'failed') { clearTimeout(timer); reject(new Error('linux child failed: ' + message.code)); }
    });
    child.on('close', code => { clearTimeout(timer); reject(new Error('linux child closed early: ' + code)); });
  });
  child.send({ type: 'handoff', version: 1, launchId: payload.launchId, payload }, () => undefined);
  const readyMessage = await ready;
  assert.equal(readyMessage.nonSecretRevisions.authMode, 'api_key');
  assert.equal(await (async () => { try { const response = await fetch('http://127.0.0.1:' + port + '/mcp', { headers: { accept: 'text/event-stream' }, signal: AbortSignal.timeout(2000) }); await response.arrayBuffer(); return response.status; } catch { return 0; } })(), 401);
  const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'linux', version: '1' } } });
  const response = await fetch('http://127.0.0.1:' + port + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-api-key': 'e1-03-consumer-key' }, body: initialize, signal: AbortSignal.timeout(3000) });
  await response.arrayBuffer();
  assert.equal(response.status, 200);
  checks.push('READY + inbound auth on loopback');
  child.send({ type: 'stop', launchId: payload.launchId }, () => undefined);
  const [exitCode] = await Promise.race([once(child, 'close'), new Promise((_, reject) => setTimeout(() => { child.kill('SIGKILL'); reject(new Error('linux stop timeout')); }, 10000))]);
  assert.equal(exitCode, 0);
  assert.ok(await unreachable('http://127.0.0.1:' + port + '/mcp'));
  checks.push('stop exits and releases the port');
  upstream.closeAllConnections(); upstream.close();
  console.log('E1_03_LINUX_OK ' + checks.length + ' checks');
}
main().catch(error => { console.error(error && error.stack || error); process.exit(1); });
`);
    const repoPosix = repoRoot.replace(/\\/g, '/');
    const harnessPosix = harnessDir.replace(/\\/g, '/');
    const args = ['run', '--rm', '--pull=never', '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '512m', '--cpus', '1',
      '--user', '0:0', '--env', 'HOME=/work', '--env', 'NODE_PATH=/repo/packages:/repo/node_modules',
      '--tmpfs', '/work:rw,nosuid,nodev,noexec,mode=700,size=64m',
      '--mount', `type=bind,source=${repoPosix},target=/repo,readonly`,
      '--mount', `type=bind,source=${harnessPosix},target=/check,readonly`,
      '--workdir', '/check', '--entrypoint', 'node', 'node:24-alpine', '/check/verify.cjs'];
    const run = spawnSync('docker', args, { encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
    const output = `${run.stdout || ''}\n${run.stderr || ''}`;
    if (run.status === 0 && output.includes('E1_03_LINUX_OK')) {
      const checks = Number((output.match(/E1_03_LINUX_OK (\d+)/) || [])[1] || 0);
      return [`linux container: direct spawn+IPC+READY+auth+cleanup (${checks} checks, node:24-alpine)`];
    }
    if (run.error || run.status === null) {
      notCovered.push({ row: 13, item: 'linux-container', reason: `bounded docker attempt did not complete: ${run.error ? run.error.message : 'timeout'}` });
      return ['linux attempt inconclusive'];
    }
    throw new Error(`linux container harness failed (exit ${run.status}):\n${output.slice(-4000)}`);
  });
}

function rowReport() {
  const rows = {};
  for (let row = 1; row <= 13; row++) {
    const existing = rowExisting[row];
    const added = rowNew.get(row);
    rows[row] = { status: existing.length || added.length ? 'covered' : 'notCovered', existing, new: added };
  }
  return rows;
}

async function cleanup() {
  childProcesses.spawn = nativeSpawn;
  for (const recorder of recorders) await recorder.close().catch(() => undefined);
  for (const launched of launches) { if (!pidGone(launched.pid)) { try { launched.child.kill('SIGKILL'); } catch { /* already gone */ } } }
  await delay(200);
  const target = path.resolve(directory);
  if (path.dirname(target) === path.resolve(os.tmpdir()) && path.basename(target).startsWith('apinova-e1-03-')) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

async function main() {
  if (process.env.E1_03_NEW_ONLY !== '1') {
    runSuite('channel-15', path.join(apiRoot, 'scripts', 'test-managed-mcp-channel.cjs'), apiRoot, null);
    runSuite('preparation-32', path.join(apiRoot, 'scripts', 'test-managed-mcp-handoff-preparation.cjs'), apiRoot, null);
    runSuite('managed-runtime-14', path.join(serverRoot, 'scripts', 'test-managed-runtime.cjs'), serverRoot, null);
    runSuite('e1-02c1-6', path.join(apiRoot, 'scripts', 'verify-e1-02c1.cjs'), apiRoot, 'E1_02C1_VERIFY_OK');
    runSuite('e1-02c2-10', path.join(apiRoot, 'scripts', 'verify-e1-02c2.cjs'), apiRoot, 'E1_02C2_VERIFY_OK');
  }
  if (process.env.E1_03_SUITES_ONLY !== '1') {
    await newSuiteScenarios();
    await linuxScenario();
  }
  notCovered.push({ row: 9, item: 'real 30s handshake timeout', reason: 'bounded runtime: the real child bootstrap failure path is executed; the 30s handshake timer is exercised by the existing channel sandbox test' });
  notCovered.push({ row: 12, item: 'managed JWT/anonymous inbound mode', reason: 'managed runtime intentionally supports only private_api_key; ambient JWT is trimmed (N9) and legacy CLI JWT behavior is covered by test-mcp-inbound-process-auth.cjs (not aggregate-run here)' });
  notCovered.push({ row: 11, item: 'ProcessInfo rows', reason: 'trusted_ipc_v1 bypasses ProcessManager so no ProcessInfo row exists to scan; managed lifecycle store/status/argv/env/stdout/stderr/error channels are scanned instead' });
  notCovered.push({ row: 13, item: 'File Provider permission evidence', reason: 'the matrix defers Windows ACL vs Linux permission evidence to the separate File Provider track (SEC-C2-01/C2-02); this runner verifies direct spawn/IPC/exit cleanup only' });

  const counts = {
    existingSuites: suiteResults.length,
    existingTests: suiteResults.reduce((sum, suite) => sum + (suite.tests || 0), 0),
    existingPassed: suiteResults.reduce((sum, suite) => sum + (suite.passed || 0), 0),
    existingFailed: suiteResults.reduce((sum, suite) => sum + (suite.failed || 0), 0),
    newScenarios: scenarioResults.length,
    newChecks: scenarioResults.reduce((sum, item) => sum + item.checks, 0),
  };
  const rows = rowReport();
  const report = { marker: failures.length ? 'E1_03_VERIFY_FAILED' : 'E1_03_VERIFY_OK',
    platform: process.platform, node: process.version, entry: path.relative(repoRoot, ENTRY).replace(/\\/g, '/'),
    tempRoot, counts, rows,     suites: suiteResults, scenarios: scenarioResults.map(({ id, title, rows: scenarioRows, status, checks, ms, evidence, error }) =>
      ({ id, title, rows: scenarioRows, status, checks, ms, evidence, error: error || null })),
    notCovered, failures };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) {
    console.log('\nE1_03_VERIFY_FAILED ' + failures.length + ' failing groups');
    process.exitCode = 1;
  } else {
    console.log('\nE1_03_VERIFY_OK built-artifact managed child matrix rows 1-13, existing ' + counts.existingPassed + '/' + counts.existingTests +
      ' suite tests, new ' + counts.newScenarios + ' scenarios/' + counts.newChecks + ' checks, ' + process.platform + ' Node ' + process.version);
  }
}

main().then(cleanup).catch(error => { console.error(error && error.stack || error); return cleanup().then(() => { process.exitCode = 1; }); });
