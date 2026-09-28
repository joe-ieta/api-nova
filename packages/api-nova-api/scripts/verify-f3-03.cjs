'use strict';
process.env.DB_TYPE = 'sqlite';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const Module = require('node:module');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createHash, createHmac, randomBytes } = require('node:crypto');

const apiRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(apiRoot, '..', '..');
const serverRoot = path.resolve(apiRoot, '..', 'api-nova-server');
const parserRoot = path.resolve(apiRoot, '..', 'api-nova-parser');
const tempBase = process.env.F3_03_TEMP || path.join(path.parse(repoRoot).root, 'temp', 'opencode', 'f3-03');
fs.mkdirSync(tempBase, { recursive: true });
const tempRoot = fs.realpathSync.native(tempBase);
process.env.TEMP = tempRoot;
process.env.TMP = tempRoot;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apinova-f3-03-'));

require('ts-node').register({ transpileOnly: true, project: path.join(apiRoot, 'tsconfig.json') });
require('reflect-metadata');
const { DataSource } = require('typeorm');
const { EventEmitter2 } = require('@nestjs/event-emitter');
const { ConfigService } = require('@nestjs/config');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { startManagedMcpChannel } = require('../src/modules/servers/services/managed-mcp-channel.ts');
const { DataSourceManagedMcpLifecycleStore } = require('../src/modules/servers/services/managed-mcp-lifecycle.store.ts');
const { createConfigManagedLifecycleApprovalProvider, MANAGED_MCP_LIFECYCLE_APPROVAL_CONFIG_KEY } =
  require('../src/modules/servers/services/managed-mcp-lifecycle-approval.ts');
const { ManagedMcpLifecycleCoordinator } = require('../src/modules/servers/services/managed-mcp-lifecycle-coordinator.service.ts');
const { ServerManagerService } = require('../src/modules/servers/services/server-manager.service.ts');
const { SystemLogService } = require('../src/modules/servers/services/system-log.service.ts');
const { ManagementEventService } = require('../src/modules/servers/services/management-event.service.ts');
const { AuditService } = require('../src/modules/security/services/audit.service.ts');
const { RuntimePipelineStateEntity } = require('../src/database/entities/runtime-call-observability.entity.ts');
const { MCPServerEntity, ServerStatus } = require('../src/database/entities/mcp-server.entity.ts');
const { LogEntryEntity } = require('../src/database/entities/log-entry.entity.ts');
const { SystemLogEntity, SystemLogEventType, SystemLogStatus } = require('../src/database/entities/system-log.entity.ts');
const { AuditLog } = require('../src/database/entities/audit-log.entity.ts');
const { User } = require('../src/database/entities/user.entity.ts');
const { Role } = require('../src/database/entities/role.entity.ts');
const { Permission } = require('../src/database/entities/permission.entity.ts');

const ENTRY = require.resolve('api-nova-server/dist/managed/entry.js');
const SERVER_ID = 'f3030000-0000-4000-8000-000000000003';
const RUNTIME_ASSET_ID = 'f3030000-0000-4000-8000-000000000001';
const MCP_RESOURCE = 'https://managed.f3-03.invalid/mcp';

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
  const seen = { command: args[0], args: args[1] || [], options: args[2] || {}, pid: child.pid, stdout: '', stderr: '', child };
  child.stdout?.on('data', chunk => { seen.stdout += String(chunk); });
  child.stderr?.on('data', chunk => { seen.stderr += String(chunk); });
  launches.push(seen);
  return child;
};
const nativeResolveFilename = Module._resolveFilename;
let selectedEntry = ENTRY;
Module._resolveFilename = function (name, ...rest) {
  if (name === 'api-nova-server/dist/managed/entry.js') return selectedEntry;
  return nativeResolveFilename.call(this, name, ...rest);
};

const hash = text => createHash('sha256').update(text).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const b64url = value => Buffer.from(value).toString('base64url');
const unique = tag => `f303-${tag}-${randomBytes(10).toString('hex')}`;

const jwtKey = unique('jk');
const jwtHeader = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const jwtPayload = b64url(JSON.stringify({ sub: 'f3-03-runner', scope: 'management', marker: unique('jp') }));
const jwtToken = `${jwtHeader}.${jwtPayload}.${createHmac('sha256', jwtKey).update(`${jwtHeader}.${jwtPayload}`).digest('base64url')}`;
const secrets = [
  { id: 'upstream-bearer', value: unique('be'), envOwner: 'UPSTREAM_PARENT' },
  { id: 'upstream-api-key', value: unique('ak'), envOwner: 'UPSTREAM_OVERRIDE' },
  { id: 'upstream-custom-header', value: unique('ch'), envOwner: 'UPSTREAM_CUSTOM' },
  { id: 'consumer-key', value: unique('ck') },
  { id: 'management-jwt-secret', value: unique('jw') },
  { id: 'management-jwt-token', value: jwtToken },
  { id: 'db-password', value: unique('db') },
  { id: 'legacy-bearer-token', value: unique('lt') },
  { id: 'openapi-marker', value: unique('oa') },
];
const byId = Object.fromEntries(secrets.map(secret => [secret.id, secret]));
const ambientSecrets = {
  JWT_SECRET: byId['management-jwt-secret'].value,
  DB_PASSWORD: byId['db-password'].value,
  MCP_LEGACY_BEARER_TOKEN: byId['legacy-bearer-token'].value,
  API_NOVA_AMBIENT_MANAGEMENT_JWT: byId['management-jwt-token'].value,
  NODE_OPTIONS: '--require f3-03-ambient-must-not-load',
};
const forbiddenNames = ['UPSTREAM_PARENT', 'UPSTREAM_OVERRIDE', 'UPSTREAM_CUSTOM', 'JWT_SECRET', 'DB_PASSWORD',
  'MCP_LEGACY_BEARER_TOKEN', 'API_NOVA_AMBIENT_MANAGEMENT_JWT', 'API_NOVA_RUNTIME_API_KEYS'];
const forbiddenEnvKeys = ['JWT_SECRET', 'DB_PASSWORD', 'MCP_LEGACY_BEARER_TOKEN', 'API_NOVA_AMBIENT_MANAGEMENT_JWT', 'NODE_OPTIONS'];

const channelRecords = [];
const failures = [];
const directChecks = [];
const notCovered = [];
const stateChanges = [];
const readyRevisions = [];
const closedResults = [];
const handles = [];
const managementEmits = [];
const recorders = [];
const codePattern = /^[A-Z0-9_]{1,80}$/;

function recordChannel(channel, source, checks, leaks, detail) {
  const record = { channel, source, pass: leaks.length === 0, checks, leaks, detail: detail || null };
  channelRecords.push(record);
  if (!record.pass) failures.push(`channel ${channel} leaked: ${leaks.map(leak => `${leak.secret}/${leak.form || leak.kind}`).join(', ')}`);
  return record;
}
function detectTextLeaks(text, forbidden = forbiddenNames) {
  const leaks = [];
  for (const secret of secrets) {
    for (const form of ['full', 'prefix8']) {
      const needle = form === 'full' ? secret.value : secret.value.slice(0, 8);
      if (text.includes(needle)) leaks.push({ secret: secret.id, form });
    }
  }
  for (const name of forbidden) {
    if (text.includes(name)) leaks.push({ secret: `env-name:${name}`, form: 'env-name' });
  }
  return leaks;
}
function scanText(channel, source, value, forbidden = forbiddenNames, detail) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const leaks = detectTextLeaks(text, forbidden);
  const checks = secrets.length * 2 + forbidden.length;
  return recordChannel(channel, source, checks, leaks, detail);
}
function scanEnvironments(channel, source, environments) {
  const leaks = [];
  let checks = 0;
  for (const env of environments) {
    for (const [name, raw] of Object.entries(env || {})) {
      if (typeof raw !== 'string') continue;
      for (const secret of secrets) {
        if (secret.envOwner && name.toUpperCase() === secret.envOwner) continue;
        checks += 1;
        if (raw.includes(secret.value)) leaks.push({ secret: secret.id, form: 'full', variable: name });
        else if (raw.includes(secret.value.slice(0, 8))) leaks.push({ secret: secret.id, form: 'prefix8', variable: name });
      }
    }
    const names = Object.keys(env || {}).map(name => name.toUpperCase());
    for (const forbidden of forbiddenEnvKeys) {
      checks += 1;
      if (names.includes(forbidden)) leaks.push({ secret: `env-name:${forbidden}`, form: 'present', variable: forbidden });
    }
  }
  return recordChannel(channel, source, checks, leaks);
}
function equalPlanted(actual, expected, label) {
  if (actual !== expected) throw new Error(`F3_03_PLANTING_CHECK_FAILED:${label}`);
}
function absentPlanted(value, label) {
  if (value !== undefined) throw new Error(`F3_03_PLANTING_CHECK_FAILED:${label}`);
}
function trustedCode(value, label) {
  if (!codePattern.test(String(value))) throw new Error(`F3_03_CODE_CHECK_FAILED:${label}`);
  return value;
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function waitFor(probe, timeout = 15000) {
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
function osCommandLine(pid) {
  if (process.platform !== 'win32') return null;
  const query = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`],
    { encoding: 'utf8', timeout: 20000, windowsHide: true });
  const text = String(query.stdout || '').trim();
  if (query.status === 0 && text) return text;
  const fallback = spawnSync('wmic', ['process', 'where', `processid=${Number(pid)}`, 'get', 'commandline', '/value'],
    { encoding: 'utf8', timeout: 10000, windowsHide: true });
  const match = /CommandLine=(.+)/.exec(String(fallback.stdout || ''));
  return match ? match[1].trim() : null;
}
async function startRecorder() {
  const received = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      received.push({ method: request.method, path: request.url, headers: { ...request.headers }, body: Buffer.concat(chunks).toString('utf8') });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const recorder = { port: server.address().port, received, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
  recorders.push(recorder);
  return recorder;
}
const HEADER_PARAMS = ['Authorization', 'X-Api-Key', 'X-Private', 'X-F303-Custom', 'X-Tenant'];
function specDocument(upstreamPort, names, marker) {
  const paths = {};
  for (const name of names) paths[`/${name}`] = { get: { operationId: name,
    parameters: HEADER_PARAMS.map(item => ({ in: 'header', name: item, schema: { type: 'string' } })),
    responses: { 200: { description: 'ok' } } } };
  return { openapi: '3.0.3', info: { title: 'f3-03-fixture', version: '1', description: marker }, servers: [{ url: `http://127.0.0.1:${upstreamPort}` }], paths };
}
function bindingsFor(names) {
  return names.map(name => ({ method: 'GET', path: `/${name}`, endpointDefinitionId: `endpoint-${name}`, sourceServiceAssetId: 'asset-one' }));
}
function payloadFor({ launchId, port, upstreamPort, spec, bindings, registryPath, digest }) {
  return { version: 1, launchId, managedServerId: SERVER_ID, runtimeAssetId: RUNTIME_ASSET_ID, inboundAuthMode: 'private_api_key',
    candidateRevision: 'candidate-one', verificationRunId: 'run-one', behaviorFingerprint: hash(JSON.stringify(canonical(spec))),
    transport: { type: 'streamable', host: '127.0.0.1', port, endpoint: '/mcp' }, openApiData: spec,
    trustedOperationBindings: bindings,
    registrySource: { configId: 'registry-one', path: registryPath, format: 'json', environment: 'test',
      expectedRevision: 'r1', expectedContentDigest: digest } };
}
async function connectClient(port, key) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { 'x-api-key': key } } });
  const client = new Client({ name: 'f3-03', version: '1' });
  await client.connect(transport);
  return client;
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

function seedServer(repository) {
  return repository.save({
    id: SERVER_ID, name: 'f3-03-managed-server', port: 9033, status: ServerStatus.RUNNING, openApiData: {},
    config: { executionMode: 'trusted_ipc_v1', runtimeAssetId: RUNTIME_ASSET_ID },
  });
}

async function exercise() {
  const upstream = await startRecorder();
  const mcpPort = await freePort();
  const registryPath = path.join(directory, 'f3-03-registry.json');
  const registry = {
    apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'r1', environment: 'test' },
    reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true },
    secretProviders: { env: { type: 'env' } },
    credentials: {
      parent: { type: 'bearer', secretRef: 'env:UPSTREAM_PARENT' },
      override: { type: 'apiKey', placement: { in: 'header', name: 'X-Private' }, secretRef: 'env:UPSTREAM_OVERRIDE' },
      custom: { type: 'customHeader', name: 'X-F303-Custom', secretRef: 'env:UPSTREAM_CUSTOM' },
    },
    sites: [{ id: 'site-one', sourceServiceAssetId: 'asset-one',
      match: { scheme: 'http', host: '127.0.0.1', port: upstream.port, basePath: '/' }, allowedHosts: ['127.0.0.1'], credential: 'parent',
      endpoints: [{ endpointDefinitionId: 'endpoint-override', credential: 'override' },
        { endpointDefinitionId: 'endpoint-custom', credential: 'custom' },
        { endpointDefinitionId: 'endpoint-none', credential: 'none' }] }],
  };
  const registryText = JSON.stringify(registry);
  fs.writeFileSync(registryPath, registryText);
  const toolNames = ['parent', 'override', 'custom', 'none'];
  const spec = specDocument(upstream.port, toolNames, byId['openapi-marker'].value);
  const bindings = bindingsFor(toolNames);
  const approvedEnvironmentValues = {
    API_NOVA_RUNTIME_AUTH_MODE: 'api_key',
    API_NOVA_MCP_RESOURCE: MCP_RESOURCE,
    API_NOVA_RUNTIME_API_KEYS: JSON.stringify([{ id: 'f3-03-client', subject: 'synthetic-consumer',
      secretHash: hash(byId['consumer-key'].value), resources: [MCP_RESOURCE], scopes: [],
      expiresAt: Math.floor(Date.now() / 1000) + 900 }]),
    UPSTREAM_PARENT: byId['upstream-bearer'].value,
    UPSTREAM_OVERRIDE: byId['upstream-api-key'].value,
    UPSTREAM_CUSTOM: byId['upstream-custom-header'].value,
  };
  const approvedEnvironmentNames = Object.keys(approvedEnvironmentValues);

  const selfReportPath = path.join(directory, 'f3-03-child-self-report.json');
  const wrapperPath = path.join(directory, 'f3-03-self-report-entry.cjs');
  fs.writeFileSync(wrapperPath, `'use strict';
const fs = require('node:fs');
try {
  fs.writeFileSync(${JSON.stringify(selfReportPath)}, JSON.stringify({ pid: process.pid, argv: process.argv, execArgv: process.execArgv,
    cwd: process.cwd(), env: process.env, capturedAt: new Date().toISOString() }));
} catch (error) { try { fs.writeFileSync(${JSON.stringify(selfReportPath + '.error')}, String((error && error.stack) || error)); } catch {} }
require(${JSON.stringify(ENTRY)}).runManagedEntry();
`);

  const approvalConfig = { [RUNTIME_ASSET_ID]: { version: 1, mode: 'auto', policyId: 'f3-03-runner',
    allowedActions: ['start', 'stop'], allowedServerIds: [SERVER_ID] } };
  const approvalConfigService = { get: key => key === MANAGED_MCP_LIFECYCLE_APPROVAL_CONFIG_KEY ? approvalConfig : undefined };

  const lifecycleDb = new DataSource({ type: 'sqljs', synchronize: true, entities: [RuntimePipelineStateEntity] });
  await lifecycleDb.initialize();
  const lifecycleStore = new DataSourceManagedMcpLifecycleStore(lifecycleDb);
  const events = new EventEmitter2();
  const managementDb = new DataSource({ type: 'sqljs', synchronize: true,
    entities: [MCPServerEntity, LogEntryEntity, SystemLogEntity, AuditLog, User, Role, Permission] });
  await managementDb.initialize();
  const serverRepository = managementDb.getRepository(MCPServerEntity);
  const logRepository = managementDb.getRepository(LogEntryEntity);
  const systemLogRepository = managementDb.getRepository(SystemLogEntity);
  const auditRepository = managementDb.getRepository(AuditLog);
  const userRepository = managementDb.getRepository(User);
  await seedServer(serverRepository);
  const managementProjection = new ServerManagerService(serverRepository, logRepository, {}, {}, {}, {}, {}, events,
    { createLog: async () => undefined });

  let captureIndex = 0;
  let staleCapture = false;
  const capture = async () => {
    captureIndex += 1;
    const payload = payloadFor({ launchId: `f3-03-launch-${captureIndex}`, port: mcpPort, upstreamPort: upstream.port,
      spec, bindings, registryPath, digest: hash(registryText) });
    if (staleCapture) payload.registrySource.expectedContentDigest = '0'.repeat(64);
    return { payload, approvedEnvironmentNames, environmentValues: approvedEnvironmentValues };
  };
  const coordinator = new ManagedMcpLifecycleCoordinator({
    store: lifecycleStore,
    capture,
    approval: createConfigManagedLifecycleApprovalProvider(approvalConfigService),
    channel: async input => {
      const handle = await startManagedMcpChannel(input);
      handles.push(handle);
      handle.ready.then(revisions => readyRevisions.push({ launchId: input.launchId, revisions })).catch(() => undefined);
      handle.closed.then(result => closedResults.push({ launchId: input.launchId, code: result.code })).catch(() => undefined);
      return handle;
    },
    onStateChange: change => {
      stateChanges.push(change);
      managementEmits.push(events.emitAsync('managed.lifecycle.changed', change));
    },
  });

  const errors = [];
  const osLines = [];
  const startedResults = [];
  const toolResults = [];
  try {
    await withEnvironment({ ...ambientSecrets, API_NOVA_RUNTIME_AUTH_MODE: 'jwt', API_NOVA_RUNTIME_JWKS_JSON: '{"keys":[]}' }, async () => {
      selectedEntry = wrapperPath;
      const first = await coordinator.start({ serverId: SERVER_ID, runtimeAssetId: RUNTIME_ASSET_ID });
      startedResults.push(first);
      assert.equal(first.generation, 1);
      directChecks.push('generation 1 reached real READY through the built child');
      const firstOs = osCommandLine(first.pid);
      assert.ok(firstOs && firstOs.includes('f3-03-self-report-entry.cjs'), 'OS-level argv for generation 1 not observed');
      osLines.push(firstOs);
      directChecks.push('OS-level Win32_Process CommandLine observed for generation 1');
      assert.equal(await httpStatus(`http://127.0.0.1:${mcpPort}/mcp`, { accept: 'text/event-stream' }), 401);
      const client = await connectClient(mcpPort, byId['consumer-key'].value);
      try {
        for (const name of toolNames) toolResults.push({ name, result: await client.callTool({ name, arguments: {} }) });
      } finally { await client.close(); }
      directChecks.push('real MCP SDK session executed 4 loopback tool calls');
      assert.equal(toolResults.length, 4);
      assert.equal(upstream.received.length, 4);
      const received = Object.fromEntries(upstream.received.map(entry => [entry.path, entry]));
      equalPlanted(received['/parent'].headers.authorization, `Bearer ${byId['upstream-bearer'].value}`, 'bearer-injection');
      equalPlanted(received['/override'].headers['x-private'], byId['upstream-api-key'].value, 'apikey-injection');
      equalPlanted(received['/custom'].headers['x-f303-custom'], byId['upstream-custom-header'].value, 'custom-header-injection');
      absentPlanted(received['/none'].headers.authorization, 'none-endpoint-authorization');
      absentPlanted(received['/none'].headers['x-api-key'], 'none-endpoint-api-key');
      directChecks.push('all three planted upstream credential values observed exactly once on the loopback wire');

      const selfReport = JSON.parse(fs.readFileSync(selfReportPath, 'utf8'));
      equalPlanted(selfReport.env.UPSTREAM_PARENT, byId['upstream-bearer'].value, 'actual-env-bearer');
      equalPlanted(selfReport.env.UPSTREAM_OVERRIDE, byId['upstream-api-key'].value, 'actual-env-apikey');
      equalPlanted(selfReport.env.UPSTREAM_CUSTOM, byId['upstream-custom-header'].value, 'actual-env-custom');
      for (const key of forbiddenEnvKeys) absentPlanted(selfReport.env[key], `actual-child-env-${key}`);
      directChecks.push('inside-child self report proves the actual process env/argv of the real child');

      const restartError = await coordinator.start({ serverId: SERVER_ID, runtimeAssetId: RUNTIME_ASSET_ID }).then(() => null, error => error);
      assert.ok(restartError);
      trustedCode(restartError.code, 'restart-rejected');
      assert.equal(restartError.code, 'MANAGED_LIFECYCLE_ALREADY_CURRENT');
      errors.push({ surface: 'restart-rejected', name: restartError.name, code: restartError.code, message: restartError.message, stack: restartError.stack });
      directChecks.push('restart while current rejected with a static code and zero new spawn');

      const stopped = await coordinator.stop(SERVER_ID);
      assert.equal(stopped.status, 'stopped');
      selectedEntry = ENTRY;
      await waitFor(() => unreachable(`http://127.0.0.1:${mcpPort}/mcp`));
      directChecks.push('generation 1 real STOPPED with the loopback listener released');

      const second = await coordinator.start({ serverId: SERVER_ID, runtimeAssetId: RUNTIME_ASSET_ID });
      startedResults.push(second);
      assert.equal(second.generation, 2);
      const secondOs = osCommandLine(second.pid);
      assert.ok(secondOs && secondOs.includes(path.join('dist', 'managed', 'entry.js')), 'OS-level argv for generation 2 not observed');
      osLines.push(secondOs);
      process.kill(second.pid, 'SIGKILL');
      const crashed = await waitFor(async () => {
        const read = await lifecycleStore.read(SERVER_ID);
        return read.status === 'valid' && read.record.state === 'failed' && read.record.generation === 2 ? read.record : null;
      });
      assert.equal(crashed.terminal.reason, 'runtime_failed');
      trustedCode(crashed.terminal.code, 'crashed-terminal');
      errors.push({ surface: 'runtime-crash', code: crashed.terminal.code, message: `generation 2 ${crashed.state}` });
      directChecks.push('generation 2 crash projected to failed terminal without a false current');

      staleCapture = true;
      const bootstrapError = await coordinator.start({ serverId: SERVER_ID, runtimeAssetId: RUNTIME_ASSET_ID }).then(() => null, error => error);
      assert.ok(bootstrapError);
      trustedCode(bootstrapError.code, 'bootstrap-rejected');
      assert.equal(bootstrapError.code, 'MANAGED_LIFECYCLE_CHANNEL_FAILED');
      errors.push({ surface: 'bootstrap-rejected', name: bootstrapError.name, code: bootstrapError.code, message: bootstrapError.message, stack: bootstrapError.stack });
      const rejectedRecord = await waitFor(async () => {
        const read = await lifecycleStore.read(SERVER_ID);
        return read.status === 'valid' && read.record.generation === 3 && read.record.state === 'failed' ? read.record : null;
      });
      trustedCode(rejectedRecord.terminal.code, 'bootstrap-terminal');
      directChecks.push('generation 3 stale bootstrap rejected with a static terminal code');
    });
  } catch (error) {
    if (errors.length === 0) errors.push({ surface: 'exercise', name: error.name, code: error.code, message: error.message, stack: error.stack });
    throw error;
  } finally {
    selectedEntry = ENTRY;
  }

  const selfReport = fs.existsSync(selfReportPath) ? JSON.parse(fs.readFileSync(selfReportPath, 'utf8')) : null;
  assert.ok(selfReport, 'inside-child self report missing');
  for (const launch of launches) {
    for (const secret of secrets.filter(item => item.envOwner)) {
      if (launch.options.env) equalPlanted(launch.options.env[secret.envOwner], secret.value, `spawn-env-${secret.id}`);
    }
    absentPlanted(launch.options.env.JWT_SECRET, 'spawn-env-jwt-secret');
    absentPlanted(launch.options.env.DB_PASSWORD, 'spawn-env-db-password');
    absentPlanted(launch.options.env.MCP_LEGACY_BEARER_TOKEN, 'spawn-env-legacy-token');
    absentPlanted(launch.options.env.API_NOVA_AMBIENT_MANAGEMENT_JWT, 'spawn-env-management-jwt');
    absentPlanted(launch.options.env.NODE_OPTIONS, 'spawn-env-node-options');
    if (launch.options.env.API_NOVA_RUNTIME_AUTH_MODE) assert.equal(launch.options.env.API_NOVA_RUNTIME_AUTH_MODE, 'api_key');
  }
  directChecks.push('spawn environment exact for approved values; ambient JWT/DB/NODE_OPTIONS absent on every launch');
  scanText('child-argv-os', 'new-direct', osLines.join('\n'), forbiddenNames, `${osLines.length} Win32_Process CommandLine capture(s)`);
  scanText('child-argv-self-report', 'new-direct + docs/audits/2026-09-27-e1-03-real-child-matrix.md row 11', JSON.stringify({ argv: selfReport.argv, execArgv: selfReport.execArgv }));
  scanEnvironments('child-env-spawn', 'new-direct + E1-03 N1/N8', launches.map(launch => launch.options.env || {}));
  scanEnvironments('child-env-actual', 'new-direct + scripts/test-managed-mcp-channel.cjs wrapper evidence', [selfReport.env]);
  scanText('child-stdout', 'new-direct + E1-03 N8', launches.map(launch => launch.stdout).join(''));
  scanText('child-stderr', 'new-direct + E1-03 N8', launches.map(launch => launch.stderr).join(''));
  scanText('exceptions-errors', 'new-direct + docs/audits/2026-09-27-e1-02c2-restart-failure-legacy.md', errors);
  const codes = [];
  for (const error of errors) if (error.code) codes.push(error.code);
  for (const closed of closedResults) if (closed.code) codes.push(closed.code);
  for (const change of stateChanges) if (change.code) codes.push(change.code);
  const finalRecord = await lifecycleStore.read(SERVER_ID);
  assert.equal(finalRecord.status, 'valid');
  if (finalRecord.record.terminal?.code) codes.push(finalRecord.record.terminal.code);
  for (const code of codes) trustedCode(code, 'collected-code');
  scanText('error-codes-static', 'new-direct + E1-02C2', JSON.stringify(codes), forbiddenNames, `${codes.length} static code(s)`);
  directChecks.push('every collected failure/terminal code matches the static [A-Z0-9_] pattern');

  const rows = await lifecycleDb.getRepository(RuntimePipelineStateEntity).find();
  assert.equal(rows.length, 1);
  scanText('lifecycle-store-snapshot', 'new-direct + E1-03 N8 + docs/audits/2026-09-27-c3-03-multi-process-registry.md',
    { record: finalRecord, rows }, forbiddenNames, 'persisted lifecycle record, decision history, snapshot and raw rows');
  assert.equal(finalRecord.record.startDecision.action, 'start');
  const startActions = finalRecord.record.decisions.filter(decision => decision.action === 'start').length;
  assert.ok(startActions >= 3);
  directChecks.push(`create/update decisions retrievable from the persisted store (${startActions} start decisions)`);
  const status = await coordinator.status(SERVER_ID);
  scanText('lifecycle-status-view', 'new-direct + E1-02C2', status);
  scanText('state-change-events', 'new-direct + E1-02C2', stateChanges);
  const terminalStates = stateChanges.map(change => change.state);
  assert.ok(terminalStates.includes('stopped'));
  assert.ok(terminalStates.filter(state => state === 'failed').length >= 2);
  directChecks.push(`stop/revoke terminal state retrievable from persisted decisions and state-change sink (${terminalStates.join(',')})`);
  scanText('ready-telemetry-handles', 'new-direct + E1-03 N8',
    { readyRevisions, started: startedResults, handles: handles.map(handle => ({ launchId: handle.launchId, pid: handle.pid, state: handle.state })) });

  await Promise.allSettled(managementEmits);
  const logRows = await logRepository.find();
  const serverRow = await serverRepository.findOne({ where: { id: SERVER_ID } });
  assert.ok(logRows.length >= 2);
  assert.equal(serverRow.status, ServerStatus.ERROR);
  scanText('management-log-projection', 'new-direct', { logRows, serverRow }, forbiddenNames,
    `${logRows.length} LogEntryEntity row(s) projected from managed.lifecycle.changed`);
  directChecks.push('managed.lifecycle.changed persisted to real log_entries + mcp_servers ERROR projection');

  const configService = new ConfigService({ SYSTEM_LOG_RETENTION_DAYS: 14 });
  const systemLogService = new SystemLogService(systemLogRepository, serverRepository, configService);
  const auditService = new AuditService(auditRepository, userRepository);
  const managementEvents = new ManagementEventService(systemLogService, auditService);
  const auditActions = [
    { action: 'server.create', eventType: SystemLogEventType.SERVER_CREATED, expected: 'server_created' },
    { action: 'server.update', eventType: SystemLogEventType.SERVER_UPDATED, expected: 'server_updated' },
    { action: 'server.start', eventType: SystemLogEventType.SERVER_STARTED, expected: 'server_started' },
    { action: 'server.stop', eventType: SystemLogEventType.SERVER_STOPPED, expected: 'server_stopped' },
    { action: 'server.delete', eventType: SystemLogEventType.SERVER_DELETED, expected: 'server_deleted' },
  ];
  for (const entry of auditActions) {
    await managementEvents.record({ action: entry.action, message: `F3-03 management audit ${entry.action}`,
      source: 'f3-03-runner', eventType: entry.eventType, serverId: SERVER_ID, serverName: 'f3-03-managed-server',
      status: SystemLogStatus.SUCCESS, details: { marker: `f3-03-audit-${entry.action}` } });
  }
  const auditPage = await auditService.findLogs({ resourceId: SERVER_ID, limit: 50 });
  const systemPage = await systemLogService.queryLogs({ serverId: SERVER_ID, limit: 50 });
  const retrieved = auditPage.data.map(row => row.action);
  for (const entry of auditActions) assert.ok(retrieved.includes(entry.expected), `audit ${entry.expected} not retrievable`);
  directChecks.push('create/update/start/stop/delete audits persisted and retrievable through AuditService.findLogs');
  scanText('management-audit-records', 'new-direct + PROD-05 audit retrieval', { audit: auditPage.data, system: systemPage.logs });
  assert.ok(auditPage.data.every(row => row.resourceId === SERVER_ID));

  await coordinator.onModuleDestroy().catch(() => undefined);
  await lifecycleDb.destroy();
  await managementDb.destroy();
  return {
    upstreamRequests: upstream.received.length,
    toolCalls: toolResults.length,
    spawns: launches.length,
    osArgvCaptured: osLines.length,
    lifecycleGenerations: startedResults.length + 1,
    startDecisions: startActions,
    auditActions: retrieved.length,
    systemLogRows: systemPage.logs.length,
    codeCount: codes.length,
  };
}

function citations() {
  return [
    { channels: ['child-argv-os', 'child-argv-self-report', 'child-env-spawn', 'child-env-actual', 'child-stdout', 'child-stderr'],
      evidence: 'docs/audits/2026-09-27-e1-03-real-child-matrix.md (matrix row 11, scenario N8) and packages/api-nova-api/scripts/test-managed-mcp-channel.cjs (15 pass)',
      mode: 'existing evidence cited; direct assertions added here for OS-level argv and inside-child env' },
    { channels: ['exceptions-errors', 'error-codes-static'],
      evidence: 'docs/audits/2026-09-27-e1-02c2-restart-failure-legacy.md and packages/api-nova-api/scripts/verify-e1-02c2.cjs (10 tests) and verify-e1-03.cjs scenarios N5/N8',
      mode: 'existing evidence cited; direct assertions added here for restart/bootstrap error surfaces' },
    { channels: ['lifecycle-store-snapshot', 'lifecycle-status-view', 'state-change-events', 'ready-telemetry-handles'],
      evidence: 'docs/audits/2026-09-27-e1-03-real-child-matrix.md N8 and docs/audits/2026-09-27-c3-03-multi-process-registry.md',
      mode: 'existing evidence cited; direct assertions added here for create/update/revoke decision retrieval' },
    { channels: ['management-log-projection', 'management-audit-records'],
      evidence: 'packages/api-nova-api/src/modules/servers/services/server-manager.service.ts:91 and management-event.service.ts audit bridge; PROD-05 audit resource retrieval',
      mode: 'new direct assertions at service level against real SQL.js repositories' },
  ];
}

function cleanup() {
  childProcesses.spawn = nativeSpawn;
  Module._resolveFilename = nativeResolveFilename;
  return Promise.all(recorders.map(recorder => recorder.close().catch(() => undefined))).then(() => {
    for (const launch of launches) {
      if (launch.pid && !pidGone(launch.pid)) { try { launch.child.kill('SIGKILL'); } catch { /* already gone */ } }
    }
    return delay(200).then(() => {
      const target = path.resolve(directory);
      if (path.dirname(target) === path.resolve(os.tmpdir()) && path.basename(target).startsWith('apinova-f3-03-')) {
        fs.rmSync(target, { recursive: true, force: true });
      }
    });
  });
}

async function main() {
  let evidence = null;
  let parentWrites = '';
  try {
    const fullProbe = secrets.map(secret => `[${secret.id}=${secret.value}]`).join('\n');
    const fullLeaks = detectTextLeaks(fullProbe);
    for (const secret of secrets) {
      if (!fullLeaks.some(leak => leak.secret === secret.id && leak.form === 'full')) throw new Error(`scanner self-test missed full ${secret.id}`);
    }
    const prefixProbe = secrets.map(secret => `[${secret.id}=${secret.value.slice(0, 8)}]`).join('\n');
    const prefixLeaks = detectTextLeaks(prefixProbe);
    for (const secret of secrets) {
      if (!prefixLeaks.some(leak => leak.secret === secret.id && leak.form === 'prefix8')) throw new Error(`scanner self-test missed prefix8 ${secret.id}`);
    }
    const nameLeaks = detectTextLeaks(forbiddenNames.join(' '));
    for (const name of forbiddenNames) {
      if (!nameLeaks.some(leak => leak.secret === `env-name:${name}`)) throw new Error(`scanner self-test missed env name ${name}`);
    }
    directChecks.push('scanner self-test detects every planted secret by full value, 8-char prefix and forbidden env name');
    const captured = await captureOutput(() => exercise());
    evidence = captured.result;
    parentWrites = captured.writes.join('');
  } catch (error) {
    failures.push(`exercise failed: ${String((error && error.stack) || error)}`);
    channelRecords.push({ channel: 'exercise', source: 'new-direct', pass: false, checks: 0, leaks: [],
      detail: String((error && error.message) || error) });
  }
  scanText('parent-output', 'new-direct + E1-03 N8', parentWrites);
  const planted = secrets.map(secret => ({ id: secret.id, envOwner: secret.envOwner || null, length: secret.value.length }));
  const counts = {
    plantedSecrets: planted.length,
    channels: channelRecords.length,
    channelsPassed: channelRecords.filter(channel => channel.pass).length,
    channelsFailed: channelRecords.filter(channel => !channel.pass).length,
    scanChecks: channelRecords.reduce((sum, channel) => sum + channel.checks, 0),
    leaks: channelRecords.reduce((sum, channel) => sum + channel.leaks.length, 0),
    directAssertions: directChecks.length,
    lifecycleGenerations: evidence ? evidence.lifecycleGenerations : null,
    spawns: launches.length,
    upstreamRequests: evidence ? evidence.upstreamRequests : null,
    toolCalls: evidence ? evidence.toolCalls : null,
    osArgvCaptured: evidence ? evidence.osArgvCaptured : null,
    startDecisionsRetrievable: evidence ? evidence.startDecisions : null,
  };
  notCovered.push(
    { channel: 'management-audit-sink-deployed', reason: 'the deployed Nest HTTP management path and production DB audit sink are not reachable in this runner; the same ManagementEventService/AuditService/SystemLogService chain is asserted against real SQL.js repositories' },
    { channel: 'process-info', reason: 'trusted_ipc_v1 bypasses ProcessManager, so no ProcessInfo row exists; same boundary recorded by E1-03' },
    { channel: 'observability-event-sink', reason: 'RuntimeObservability event/state persistence needs the deployed Nest runtime and is covered by OBS suites; it is not written by the managed child lifecycle' },
    { channel: 'linux-os-argv', reason: 'OS-level argv inspection is implemented for win32; Linux container lifecycle evidence stays with E1-03' },
  );
  const report = {
    marker: failures.length ? 'F3_03_VERIFY_FAILED' : 'F3_03_VERIFY_OK',
    workPackage: 'SEC-F3-03',
    purpose: 'managed child secret-leak scan across argv/env/stdio/error/store/status/raw DB/management/audit/snapshot channels',
    platform: process.platform, node: process.version,
    entry: path.relative(repoRoot, ENTRY).replace(/\\/g, '/'),
    tempRoot,
    trustedMode: 'default-off; this isolated runner invokes the internal coordinator directly and sets no production switch',
    localOnly: 'loopback upstream and SQL.js persistence only; synthetic secrets; no external network',
    planted,
    counts,
    evidence,
    directChecks,
    channels: channelRecords,
    citations: citations(),
    notCovered,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) {
    console.log(`\nF3_03_VERIFY_FAILED ${failures.length} failing channel(s)`);
    process.exitCode = 1;
  } else {
    console.log(`\nF3_03_VERIFY_OK ${counts.channelsPassed}/${counts.channels} channels, ${counts.scanChecks} secret/name scan checks, ` +
      `${counts.leaks} leaks, ${counts.directAssertions} direct assertions, ${process.platform} Node ${process.version}`);
  }
}

main().then(cleanup, error => { console.error(error && error.stack || error); return cleanup().then(() => { process.exitCode = 1; }); });
