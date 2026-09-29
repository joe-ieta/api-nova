'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { randomBytes, createHash, randomUUID } = require('node:crypto');

const repoRoot = path.resolve(__dirname, '..');
const apiRoot = path.join(repoRoot, 'packages', 'api-nova-api');
const serverRoot = path.join(repoRoot, 'packages', 'api-nova-server');
const tempRootInput = process.env.EXT06_TEMP || 'E:\\temp\\opencode\\ext-06';
fs.mkdirSync(tempRootInput, { recursive: true });
const tempRoot = fs.realpathSync.native(tempRootInput);
const dbPath = path.join(tempRoot, 'api_nova_ext06.db');
const logDir = path.join(tempRoot, 'logs');
const pidDir = path.join(tempRoot, 'pids');
const auditDir = path.join(tempRoot, 'audit');
const mailSinkDir = path.join(tempRoot, 'mail-sink');
const seedScriptPath = path.join(tempRoot, 'seed-publication.cjs');
const seedResultPath = path.join(tempRoot, 'seed-result.json');
const registryPath = path.join(tempRoot, 'managed-registry.json');
const apiLogPath = path.join(tempRoot, 'api.log');
const migrationLogPath = path.join(tempRoot, 'migration.log');
const seedLogPath = path.join(tempRoot, 'seed.log');
const summaryPath = path.join(tempRoot, 'evidence.json');

const API_PORT = Number(process.env.EXT06_API_PORT || 9012);
const LEGACY_MCP_PORT = Number(process.env.EXT06_MCP_PORT || 9032);
const TRUSTED_MCP_PORT = Number(process.env.EXT06_TRUSTED_MCP_PORT || 9033);
const LEGACY_ENDPOINT = '/ext06/mcp';
const TRUSTED_ENDPOINT = '/ext06/managed';
const SSE_ENDPOINT = '/ext06/sse';
const TRUSTED_ASSET_ID = 'e1e1e1e1-0001-4001-8001-000000000001';
const TRUSTED_SERVER_ID = 'e1e1e1e1-0002-4002-8002-000000000002';
const SKIP_MANAGED = process.env.EXT06_SKIP_MANAGED === '1';

const sdkRoot = path.resolve(path.dirname(require.resolve('@modelcontextprotocol/sdk/server/mcp.js')), '..', '..', '..');
const sdkVersion = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json'), 'utf8')).version;
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

const adminPassword = `Ext06!${randomBytes(18).toString('hex')}`;
const jwtSecret = randomBytes(32).toString('hex');
const upstreamSecret = `synthetic-ext06-upstream-${randomBytes(12).toString('hex')}`;
const managedRegistrySecret = `synthetic-ext06-managed-${randomBytes(12).toString('hex')}`;
const managedKeyId = 'ext06managed';
const managedSecret = randomBytes(24).toString('base64url');
const managedApiKey = `${managedKeyId}.${managedSecret}`;
const managedOtherKeyId = 'ext06managedother';
const managedOtherSecret = randomBytes(24).toString('base64url');
const managedOtherApiKey = `${managedOtherKeyId}.${managedOtherSecret}`;
const gatewayOnlySecret = randomBytes(24).toString('base64url');
const gatewayOnlyApiKey = `ext06gw.${gatewayOnlySecret}`;

const checks = [];
const failures = [];
const runtimeSecrets = [];
const issuedKeys = new Map();
function apiKeyFor(keyId) { return issuedKeys.get(keyId); }
const notCovered = [
  { item: 'linux-variant', reason: 'Windows-only execution; Ubuntu/EXT-09 matrix was not run here.' },
  { item: 'external-network', reason: 'Loopback-only; no external receivers, real upstreams, OIDC/OAuth provider or EXT-10 flows.' },
  { item: 'production-enablement', reason: 'No production enablement: Verified/canPublish stays closed, no production migrations or DI switches.' },
  { item: 'trusted-lifecycle-via-api-config', reason: 'The API trusted lifecycle reads managedMcp.handoffSources/lifecycleApproval through Nest ConfigService, which now supports the validated API_NOVA_MANAGED_MCP_CONFIG environment envelope (and still accepts injected host config). The trusted managed child is proven here through the existing SEC-E1-03 fixture channel, while the env-driven config path is covered by API unit/HTTP specs.' },
];

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]))
    : value;

const baseEnv = { ...process.env };
for (const key of Object.keys(baseEnv)) {
  if (/^(API_NOVA_|DB_|SUPER_ADMIN_|JWT_|MAIL_)/i.test(key)) delete baseEnv[key];
  if (['PORT', 'MCP_PORT', 'THROTTLE_LIMIT', 'THROTTLE_TTL', 'LOG_DIRECTORY', 'PID_DIRECTORY', 'API_BASE_URL', 'LOG_LEVEL', 'LOG_FORMAT', 'NODE_ENV', 'PROCESS_TIMEOUT', 'PROCESS_MAX_RETRIES', 'PROCESS_RESTART_DELAY'].includes(key)) delete baseEnv[key];
}
for (const key of Object.keys(baseEnv)) {
  if (key.toLowerCase().startsWith('managedmcp.')) delete baseEnv[key];
}

for (const value of [upstreamSecret, managedRegistrySecret, managedSecret, managedApiKey, managedOtherSecret, managedOtherApiKey, gatewayOnlySecret, gatewayOnlyApiKey]) runtimeSecrets.push(value);

function sanitize(value) {
  let text = String(value === undefined ? '' : value);
  for (const secret of runtimeSecrets) if (secret) text = text.split(secret).join('[redacted]');
  return text;
}

const children = [];
let upstreamState = null;
let apiChild = null;
let apiLogStream = null;
let apiToken = null;
let legacy = null;
let trusted = null;
let legacyServerId = null;
let legacyPid = null;
let trustedPid = null;
let legacyApiKey = null;
let legacyOtherKey = null;
let legacyRestrictedKey = null;
let managedHandle = null;
let managedPid = null;
let managedSpawnObservation = null;

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function assertPortFree(port, label) {
  const probe = net.createServer();
  try {
    probe.listen(port, '127.0.0.1');
    await once(probe, 'listening');
  } catch {
    throw new Error(`${label} port ${port} is already in use; refusing to interfere with another workstream`);
  } finally {
    await new Promise(resolve => probe.close(resolve));
  }
}

async function waitFor(probe, message, timeout = 30000, interval = 200) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) { lastError = error; }
    if (Date.now() > deadline) throw new Error(`${message}${lastError ? ` (${sanitize(lastError.message)})` : ''}`);
    await delay(interval);
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function unreachable(url, timeout = 500) {
  try { await fetch(url, { signal: AbortSignal.timeout(timeout) }); return false; } catch { return true; }
}

async function step(name, fn) {
  try {
    const value = await fn();
    checks.push({ name, status: 'pass' });
    console.log(`[ext-06] PASS ${name}`);
    return value;
  } catch (error) {
    const message = sanitize((error && (error.message || error)) || 'unknown failure');
    checks.push({ name, status: 'fail', error: message });
    failures.push({ name, error: message });
    console.log(`[ext-06] FAIL ${name}: ${message}`);
    throw error;
  }
}

async function fetchJson(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeout || 60000),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, headers: response.headers, text, json };
}

async function mcpRaw(url, options = {}) {
  const headers = { accept: options.accept || 'application/json, text/event-stream' };
  if (options.key) headers['x-api-key'] = options.key;
  if (options.sessionId) headers['mcp-session-id'] = options.sessionId;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(url, {
    method: options.method || 'POST',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeout || 10000),
  });
  const text = await response.text();
  let errorCode = null;
  try { errorCode = JSON.parse(text).error || null; } catch { errorCode = null; }
  return { status: response.status, text, errorCode };
}

function startUpstream() {
  const received = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      received.push({ method: request.method, path: request.url, headers: { ...request.headers }, body: Buffer.concat(chunks).toString('utf8') });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, marker: 'ext06-upstream' }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      server, received, port: server.address().port,
      close: () => new Promise(done => { server.closeAllConnections(); server.close(() => done()); }),
    }));
  });
}

function seedPublicationMain() {
  process.env.DB_TYPE = process.env.DB_TYPE || 'sqlite';
  const fs = require('node:fs');
  const path = require('node:path');
  const { randomUUID } = require('node:crypto');
  const { createRequire } = require('node:module');
  const apiRootPath = process.env.EXT06_API_ROOT;
  const apiRequire = createRequire(path.join(apiRootPath, 'package.json'));
  apiRequire('reflect-metadata');
  const { DataSource } = apiRequire('typeorm');
  const dist = relative => require(path.join(apiRootPath, 'dist/src', relative));
  const entities = {
    SourceServiceAsset: dist('database/entities/source-service-asset.entity.js').SourceServiceAssetEntity,
    SourceServiceInstance: dist('database/entities/source-service-instance.entity.js').SourceServiceInstanceEntity,
    RuntimeAsset: dist('database/entities/runtime-asset.entity.js').RuntimeAssetEntity,
    EndpointDefinition: dist('database/entities/endpoint-definition.entity.js').EndpointDefinitionEntity,
    RuntimeAssetEndpointBinding: dist('database/entities/runtime-asset-endpoint-binding.entity.js').RuntimeAssetEndpointBindingEntity,
    EndpointPublishBinding: dist('database/entities/endpoint-publish-binding.entity.js').EndpointPublishBindingEntity,
    EndpointTestSample: dist('database/entities/endpoint-test-sample.entity.js').EndpointTestSampleEntity,
    RuntimeUpstreamBinding: dist('database/entities/runtime-upstream-binding.entity.js').RuntimeUpstreamBindingEntity,
    RuntimeUpstreamBindingInstance: dist('database/entities/runtime-upstream-binding-instance.entity.js').RuntimeUpstreamBindingInstanceEntity,
    MCPServer: dist('database/entities/mcp-server.entity.js').MCPServerEntity,
    GatewayConsumerCredential: dist('database/entities/gateway-consumer-credential.entity.js').GatewayConsumerCredentialEntity,
  };
  const { RuntimeUpstreamBindingsService } = dist('modules/runtime-upstream-bindings/services/runtime-upstream-bindings.service.js');
  const { RuntimeGovernanceInvalidationService } = dist('modules/runtime-governance/services/runtime-governance-invalidation.service.js');
  (async () => {
    const db = new DataSource({
      type: 'sqljs',
      location: process.env.DB_SQLITE_PATH,
      autoSave: true,
      synchronize: false,
      entities: Object.values(entities),
    });
    await db.initialize();
    const repo = entity => db.getRepository(entity);
    const build = async (sourceKey, assetName, options) => {
      const source = await repo(entities.SourceServiceAsset).save({ sourceKey });
      const instance = await repo(entities.SourceServiceInstance).save({
        sourceServiceAssetId: source.id, name: 'ext06-local', environment: 'test',
        scheme: 'http', host: '127.0.0.1', port: Number(process.env.EXT06_UPSTREAM_PORT), status: 'healthy',
      });
      const asset = await repo(entities.RuntimeAsset).save({
        ...(options && options.assetId ? { id: options.assetId } : {}),
        name: assetName, type: 'mcp_server',
      });
      const endpoint = await repo(entities.EndpointDefinition).save({
        sourceServiceAssetId: source.id, method: 'GET', path: '/ping', operationId: 'ping',
        rawOperation: { responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } } } },
      });
      const membership = await repo(entities.RuntimeAssetEndpointBinding).save({
        runtimeAssetId: asset.id, endpointDefinitionId: endpoint.id, status: 'active', publicationRevision: 1, enabled: true,
      });
      await repo(entities.EndpointPublishBinding).save({
        endpointDefinitionId: endpoint.id, runtimeAssetEndpointBindingId: membership.id,
        publishStatus: 'active', publishedToMcp: true, publicationRevision: 1,
      });
      await repo(entities.EndpointTestSample).save({
        endpointDefinitionId: endpoint.id, testRunId: randomUUID(), fingerprint: 'ext06-smoke',
        responseStatusCode: 200, tags: ['smoke'], capturedAt: new Date(), requestPayload: {}, responsePayload: { ok: true },
      });
      const invalidation = new RuntimeGovernanceInvalidationService(
        repo(entities.RuntimeAsset), repo(entities.RuntimeAssetEndpointBinding),
        repo(entities.RuntimeUpstreamBinding), repo(entities.RuntimeUpstreamBindingInstance),
      );
      const bindings = new RuntimeUpstreamBindingsService(
        repo(entities.RuntimeUpstreamBinding), repo(entities.RuntimeUpstreamBindingInstance),
        repo(entities.SourceServiceInstance), db, { log: async () => {} }, invalidation,
      );
      await bindings.upsert(membership.id, {
        sourceServiceAssetId: source.id, environment: 'test', selectionMode: 'fixed_primary',
        primaryInstanceId: instance.id, status: 'active', candidates: [{ sourceServiceInstanceId: instance.id }],
      }, { actorId: 'ext06-seed' });
      if (options && options.serverId) {
        await repo(entities.MCPServer).save({
          id: options.serverId, name: assetName, version: '1.0.0', description: 'ext06 trusted managed seed',
          port: options.serverPort, transport: 'streamable', inboundAuthMode: 'private_api_key',
          status: 'stopped', openApiData: {}, tools: [], toolsCount: 0, healthy: false, autoStart: false,
          tags: ['ext06'], config: { executionMode: 'trusted_ipc_v1', runtimeAssetId: asset.id, managedByRuntimeAsset: false },
        });
      }
      return {
        runtimeAssetId: asset.id, sourceServiceAssetId: source.id, sourceServiceInstanceId: instance.id,
        endpointDefinitionId: endpoint.id, membershipId: membership.id,
      };
    };
    const legacy = await build('ext06-legacy-source', 'ext06-managed', {});
    if (process.env.EXT06_GATEWAY_ONLY_HASH) {
      await repo(entities.GatewayConsumerCredential).save({
        name: 'ext06-gateway-only-seed', keyId: 'ext06gw', secretHash: process.env.EXT06_GATEWAY_ONLY_HASH,
        status: 'active', runtimeAssetId: legacy.runtimeAssetId,
        accessPolicy: {
          version: 1, subject: 'ext06-gateway-subject', protocols: ['gateway'],
          toolScopes: ['*'], scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      });
    }
    const trusted = process.env.EXT06_SEED_TRUSTED === '1'
      ? await build('ext06-trusted-source', 'ext06-trusted', {
          assetId: process.env.EXT06_TRUSTED_ASSET_ID,
          serverId: process.env.EXT06_TRUSTED_SERVER_ID,
          serverPort: Number(process.env.EXT06_TRUSTED_PORT),
        })
      : null;
    await new Promise(resolve => setTimeout(resolve, 1100));
    fs.writeFileSync(process.env.EXT06_SEED_RESULT, JSON.stringify({ legacy, trusted }));
    await db.destroy();
  })().catch(error => { console.error(String((error && error.stack) || error)); process.exit(1); });
}

function newestSource(root) {
  let newest = 0;
  const visit = entry => {
    for (const item of fs.readdirSync(entry, { withFileTypes: true })) {
      const target = path.join(entry, item.name);
      if (item.isDirectory()) { if (!['node_modules', 'dist', 'docs'].includes(item.name)) visit(target); continue; }
      if (!item.name.endsWith('.ts') || /\.(spec|test)\.ts$/.test(item.name)) continue;
      newest = Math.max(newest, fs.statSync(target).mtimeMs);
    }
  };
  visit(root);
  return newest;
}

function collectFiles(directory, results = []) {
  if (!fs.existsSync(directory)) return results;
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, item.name);
    if (item.isDirectory()) collectFiles(target, results);
    else results.push(target);
  }
  return results;
}

async function main() {
  console.log(`[ext-06] sdk=${sdkVersion} apiPort=${API_PORT} legacyMcpPort=${LEGACY_MCP_PORT} trustedMcpPort=${TRUSTED_MCP_PORT} temp=${tempRoot}`);
  fs.mkdirSync(tempRoot, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(pidDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });
  fs.mkdirSync(mailSinkDir, { recursive: true });
  for (const artifact of [dbPath, seedResultPath, apiLogPath, migrationLogPath, seedLogPath, summaryPath]) {
    if (fs.existsSync(artifact)) fs.rmSync(artifact, { force: true });
  }

  await step('sdk-pinned-1.29.0', async () => { assert.equal(sdkVersion, '1.29.0'); });
  await step('isolated-ports-free', async () => {
    await assertPortFree(API_PORT, 'API');
    await assertPortFree(LEGACY_MCP_PORT, 'legacy MCP');
    if (!SKIP_MANAGED) await assertPortFree(TRUSTED_MCP_PORT, 'trusted MCP');
  });
  await step('built-artifacts-present', async () => {
    for (const artifact of [
      path.join(apiRoot, 'dist/src/main.js'),
      path.join(serverRoot, 'dist/cli.js'),
      path.join(serverRoot, 'dist/managed/entry.js'),
    ]) assert.ok(fs.existsSync(artifact), `missing ${artifact}`);
  });

  const dbEnv = {
    ...baseEnv,
    NODE_ENV: 'test',
    JWT_SECRET: jwtSecret,
    JWT_REFRESH_SECRET: jwtSecret,
    DB_TYPE: 'sqlite',
    DB_SQLITE_PATH: dbPath,
    DB_SYNCHRONIZE: 'false',
    DB_LOGGING: 'false',
  };
  await step('migrations-on-isolated-db', async () => {
    const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
    const args = process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm run migration:run --workspace api-nova-api']
      : ['run', 'migration:run', '--workspace', 'api-nova-api'];
    const result = spawnSync(command, args, { cwd: repoRoot, env: dbEnv, encoding: 'utf8', timeout: 600000, windowsHide: true });
    fs.writeFileSync(migrationLogPath, `${result.stdout || ''}\n${result.stderr || ''}`);
    assert.equal(result.status, 0, `migration failed: ${sanitize(`${result.stdout || ''}${result.stderr || ''}`).slice(-2000)}`);
    assert.ok(fs.existsSync(dbPath), 'isolated database file was not created');
  });

  await step('loopback-upstream-ready', async () => {
    upstreamState = await startUpstream();
    assert.ok(upstreamState.port > 0);
  });

  await step('seed-publication-graph', async () => {
    fs.writeFileSync(seedScriptPath, `(${seedPublicationMain.toString()})();`);
    const result = spawnSync(process.execPath, [seedScriptPath], {
      env: {
        ...dbEnv,
        EXT06_API_ROOT: apiRoot,
        EXT06_UPSTREAM_PORT: String(upstreamState.port),
        EXT06_SEED_RESULT: seedResultPath,
        EXT06_SEED_TRUSTED: SKIP_MANAGED ? '0' : '1',
        EXT06_TRUSTED_ASSET_ID: TRUSTED_ASSET_ID,
        EXT06_TRUSTED_SERVER_ID: TRUSTED_SERVER_ID,
        EXT06_TRUSTED_PORT: String(TRUSTED_MCP_PORT),
        EXT06_GATEWAY_ONLY_HASH: createHash('sha256').update(gatewayOnlySecret).digest('hex'),
      },
      encoding: 'utf8', timeout: 120000, windowsHide: true,
    });
    fs.writeFileSync(seedLogPath, `${result.stdout || ''}\n${result.stderr || ''}`);
    assert.equal(result.status, 0, `seed failed: ${sanitize(`${result.stdout || ''}${result.stderr || ''}`).slice(-2000)}`);
    const seeded = JSON.parse(fs.readFileSync(seedResultPath, 'utf8'));
    legacy = seeded.legacy;
    trusted = seeded.trusted;
    assert.ok(legacy && legacy.runtimeAssetId && legacy.membershipId, 'legacy publication graph missing');
    if (!SKIP_MANAGED) assert.ok(trusted && trusted.runtimeAssetId, 'trusted publication graph missing');
  });

  const managedResource = `http://127.0.0.1:${TRUSTED_MCP_PORT}${TRUSTED_ENDPOINT}`;
  const managedKeys = [
    {
      id: 'ext06-managed-credential', subject: 'ext06-managed-subject',
      secretHash: createHash('sha256').update(managedSecret).digest('hex'),
      expiresAt: Math.floor(Date.now() / 1000) + 3600, resources: [managedResource], scopes: [],
    },
    {
      id: 'ext06-managed-other', subject: 'ext06-managed-other-subject',
      secretHash: createHash('sha256').update(managedOtherSecret).digest('hex'),
      expiresAt: Math.floor(Date.now() / 1000) + 3600, resources: [managedResource], scopes: [],
    },
  ];
  if (!SKIP_MANAGED) {
    const registryDocument = {
      apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings',
      metadata: { revision: 'r1', environment: 'test' },
      reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true },
      secretProviders: { env: { type: 'env' } },
      credentials: { parent: { type: 'bearer', secretRef: 'env:UPSTREAM_EXT06_MANAGED' } },
      sites: [{
        id: 'ext06-trusted-site', sourceServiceAssetId: trusted.sourceServiceAssetId,
        match: { scheme: 'http', host: '127.0.0.1', port: upstreamState.port, basePath: '/' },
        allowedHosts: ['127.0.0.1'], credential: 'parent',
        endpoints: [{ endpointDefinitionId: trusted.endpointDefinitionId, credential: 'parent' }],
      }],
    };
    fs.writeFileSync(registryPath, JSON.stringify(registryDocument));
  }

  const apiEnv = {
    ...baseEnv,
    NODE_ENV: 'test',
    PORT: String(API_PORT),
    MCP_PORT: String(LEGACY_MCP_PORT),
    DB_TYPE: 'sqlite',
    DB_SQLITE_PATH: dbPath,
    DB_SYNCHRONIZE: 'false',
    DB_LOGGING: 'false',
    JWT_SECRET: jwtSecret,
    JWT_REFRESH_SECRET: jwtSecret,
    SUPER_ADMIN_USERNAME: 'ext06-admin',
    SUPER_ADMIN_EMAIL: 'ext06-admin@example.invalid',
    SUPER_ADMIN_PASSWORD: adminPassword,
    API_NOVA_RUNTIME_CREDENTIAL_SOURCE: 'database',
    API_NOVA_RUNTIME_AUTH_MODE: 'api_key',
    API_NOVA_MCP_RESOURCE: `http://127.0.0.1:${LEGACY_MCP_PORT}${LEGACY_ENDPOINT}`,
    API_NOVA_RUNTIME_ALLOW_HTTP_LOOPBACK: 'true',
    API_NOVA_RUNTIME_REQUIRED_SCOPES: '',
    API_NOVA_MCP_TOOL_SCOPES: '{}',
    API_NOVA_AUDIT_DIR: auditDir,
    PID_DIRECTORY: pidDir,
    LOG_DIRECTORY: logDir,
    API_BASE_URL: `http://127.0.0.1:${API_PORT}`,
    MAIL_SINK_DIR: mailSinkDir,
    THROTTLE_LIMIT: '10000',
    THROTTLE_TTL: '60',
    LOG_LEVEL: 'info',
  };

  await step('real-api-listening', async () => {
    apiLogStream = fs.createWriteStream(apiLogPath, { flags: 'a' });
    apiChild = spawn(process.execPath, [path.join(apiRoot, 'dist/src/main.js')], {
      cwd: apiRoot, env: apiEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    children.push({ name: 'api', child: apiChild });
    apiChild.stdout.pipe(apiLogStream);
    apiChild.stderr.pipe(apiLogStream);
    apiChild.on('exit', code => console.log(`[ext-06] api exited with code ${code}`));
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${API_PORT}/api/health/ready`, { signal: AbortSignal.timeout(2000) });
      const text = await response.text();
      return response.status === 200 && text.includes('ready');
    }, 'API did not become ready', 120000, 500);
  });

  await step('management-login', async () => {
    const login = await fetchJson(`http://127.0.0.1:${API_PORT}/api/auth/login`, {
      method: 'POST', body: { username: 'ext06-admin', password: adminPassword },
    });
    assert.equal(login.status, 200, `login status ${login.status}`);
    apiToken = login.json?.accessToken || login.json?.data?.accessToken;
    assert.ok(apiToken, 'management access token missing');
  });

  const credentialsUrl = id => `http://127.0.0.1:${API_PORT}/api/v1/runtime-assets/${id}/runtime-access-credentials`;
  const specCallbackUrl = id => `http://127.0.0.1:${API_PORT}/api/openapi/by-runtime-asset/${id}`;

  await step('runtime-spec-callback-credential-guard', async () => {
    const anonymous = await fetchJson(specCallbackUrl(legacy.runtimeAssetId));
    assert.equal(anonymous.status, 401, `anonymous spec callback status ${anonymous.status}`);
    const bogus = await fetchJson(specCallbackUrl(legacy.runtimeAssetId), {
      headers: { 'x-api-key': 'apinova-spec-v1.bogus-signature' },
    });
    assert.equal(bogus.status, 401, `bogus spec credential status ${bogus.status}`);
    const management = await fetchJson(specCallbackUrl(legacy.runtimeAssetId), { token: apiToken });
    assert.equal(management.status, 200, `management spec callback status ${management.status}`);
    assert.ok(management.json?.paths?.['/ping'], 'management spec callback did not return the assembled spec');
    assert.ok(!JSON.stringify(management.json).includes('apinova-spec-v1.'), 'spec callback response leaked a spec credential');
  });

  await step('selected-transport-credentials-issued', async () => {
    const create = async (body) => {
      const response = await fetchJson(credentialsUrl(legacy.runtimeAssetId), { method: 'POST', token: apiToken, body });
      assert.equal(response.status, 201, `credential create status ${response.status}: ${sanitize(response.text).slice(0, 400)}`);
      assert.ok(response.json?.apiKey, 'apiKey was not returned once');
      runtimeSecrets.push(response.json.apiKey, response.json.apiKey.slice(response.json.apiKey.indexOf('.') + 1));
      return response.json;
    };
    const main = await create({ name: 'ext06-main', keyId: 'ext06main', subject: 'ext06-main-subject', protocols: ['mcp'], toolScopes: ['*'], scopes: [] });
    const other = await create({ name: 'ext06-other', keyId: 'ext06other', subject: 'ext06-other-subject', protocols: ['mcp'], toolScopes: ['*'], scopes: [] });
    const expired = await create({ name: 'ext06-expired', keyId: 'ext06expired', subject: 'ext06-expired-subject', protocols: ['mcp'], toolScopes: ['*'], scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 2 });
    const restricted = await create({ name: 'ext06-restricted', keyId: 'ext06restricted', subject: 'ext06-restricted-subject', protocols: ['mcp'], toolScopes: [], scopes: [] });
    for (const issuance of [main, other, expired, restricted]) {
      issuedKeys.set(issuance.credential.keyId, issuance.apiKey);
      assert.ok(issuance.apiKey.startsWith(`${issuance.credential.keyId}.`), 'apiKey is not keyId.secret');
      assert.ok(issuance.apiKey.length > issuance.credential.keyId.length + 10);
    }
    const rejected = await fetchJson(credentialsUrl(legacy.runtimeAssetId), {
      method: 'POST', token: apiToken,
      body: { name: 'ext06-gateway-only', keyId: 'ext06gwreject', subject: 'ext06-gateway-subject', protocols: ['gateway'], toolScopes: ['*'], scopes: [] },
    });
    assert.equal(rejected.status, 400, `MCP asset accepted a gateway-only credential: ${rejected.status}`);
    assert.equal(rejected.json?.error?.code, 'INVALID_REQUEST');
    legacyApiKey = main.apiKey;
    legacyOtherKey = other.apiKey;
    legacyRestrictedKey = restricted.apiKey;
    issuedKeys.set('ext06gw', gatewayOnlyApiKey);
    runtimeSecrets.push(gatewayOnlyApiKey, gatewayOnlySecret);
  });

  await step('legacy-publication-deploy', async () => {
    const deployed = await fetchJson(`http://127.0.0.1:${API_PORT}/api/v1/runtime-assets/${legacy.runtimeAssetId}/deploy-mcp`, {
      method: 'POST', token: apiToken,
      body: { port: LEGACY_MCP_PORT, transport: 'streamable', endpointPath: LEGACY_ENDPOINT, inboundAuthMode: 'private_api_key', autoStart: false },
    });
    assert.equal(deployed.status, 201, `deploy status ${deployed.status}: ${sanitize(deployed.text).slice(0, 600)}`);
    assert.equal(deployed.json?.verification?.run?.status, 'passed');
    assert.equal(deployed.json?.managedServer?.port, LEGACY_MCP_PORT);
    assert.equal(deployed.json?.managedServer?.transport, 'streamable');
    assert.equal(deployed.json?.managedServer?.inboundAuthMode, 'private_api_key');
    assert.equal(deployed.json?.managedServer?.endpointPreview?.consumerUrl, `http://127.0.0.1:${LEGACY_MCP_PORT}${LEGACY_ENDPOINT}`);
    legacyServerId = deployed.json.managedServer.id;
  });

  await step('legacy-publication-start', async () => {
    const started = await fetchJson(`http://127.0.0.1:${API_PORT}/api/v1/runtime-assets/${legacy.runtimeAssetId}/start`, {
      method: 'POST', token: apiToken,
    });
    assert.equal(started.status, 201, `start status ${started.status}: ${sanitize(started.text).slice(0, 600)}`);
    assert.equal(started.json?.managedServer?.status, 'running');
    assert.equal(started.json?.managedServer?.endpointPreview?.consumerUrl, `http://127.0.0.1:${LEGACY_MCP_PORT}${LEGACY_ENDPOINT}`);
    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${LEGACY_MCP_PORT}/health`, { signal: AbortSignal.timeout(1000) });
        await response.arrayBuffer();
        return response.status === 200;
      } catch { return false; }
    }, 'legacy MCP health did not become ready', 30000, 200);
    await waitFor(async () => {
      const logs = await fetchJson(`http://127.0.0.1:${API_PORT}/api/audit/logs?resource=openapi.spec_access&limit=50`, { token: apiToken });
      return logs.status === 200 && Array.isArray(logs.json?.data) &&
        logs.json.data.some(row => row.resourceId === legacy.runtimeAssetId && row.status === 'success');
    }, 'spawned runtime spec callback access was not audited', 20000, 200);
  });

  await step('legacy-child-process-and-argv', async () => {
    const processInfo = await fetchJson(`http://127.0.0.1:${API_PORT}/api/v1/servers/${legacyServerId}/process`, { token: apiToken });
    assert.equal(processInfo.status, 200, `process info status ${processInfo.status}`);
    legacyPid = processInfo.json?.pid;
    assert.ok(legacyPid > 0 && pidAlive(legacyPid), 'spawned CLI child is not alive');
    const args = processInfo.json?.config?.args || [];
    assert.ok(args[0] && args[0].endsWith(path.join('dist', 'cli.js')), `unexpected child entry ${args[0]}`);
    assert.ok(args.includes('--transport') && args.includes('streamable'));
    assert.ok(args.includes('--port') && args.includes(String(LEGACY_MCP_PORT)));
    assert.ok(args.includes('--endpoint') && args.includes(LEGACY_ENDPOINT));
    const openApiArg = args.find(value => value.startsWith('http://127.0.0.1:') && value.includes('/api/openapi/by-runtime-asset/'));
    assert.ok(openApiArg, 'child does not use the published runtime-asset spec callback');
    assert.ok(openApiArg.includes(`:${API_PORT}/`), 'spec callback does not target the API directly');
    assert.ok(!JSON.stringify(processInfo.json).includes('apinova-spec-v1.'), 'process info leaked a runtime spec credential');
    for (const secret of [legacyApiKey, legacyOtherKey, legacyRestrictedKey, managedSecret]) {
      assert.ok(!JSON.stringify(processInfo.json).includes(secret), 'process info leaked a consumer credential');
    }
  });

  const legacyUrl = `http://127.0.0.1:${LEGACY_MCP_PORT}${LEGACY_ENDPOINT}`;
  let openStreams = 0;

  await step('streamable-sdk-connect-list-call', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(legacyUrl), {
      requestInit: { headers: { 'x-api-key': legacyApiKey } },
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (((init && init.method) || 'GET') === 'GET' && response.status === 200 && String(response.headers.get('content-type') || '').includes('text/event-stream')) openStreams++;
        return response;
      },
    });
    const client = new Client({ name: 'ext06-consumer', version: '1' });
    children.push({ name: 'sdk-streamable', client, transport });
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name), ['ping']);
    const callsBefore = upstreamState.received.length;
    const result = await client.callTool({ name: 'ping', arguments: {} });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(upstreamState.received.length, callsBefore + 1);
    assert.equal(upstreamState.received.at(-1).path, '/ping');
    assert.equal(upstreamState.received.at(-1).method, 'GET');
    assert.ok(transport.sessionId, 'streamable session id missing');
    await waitFor(() => openStreams > 0, 'no server-sent event stream observed', 5000, 50);
  });

  await step('unauthorized-transport-credentials-rejected', async () => {
    await delay(3000);
    const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ext06-raw', version: '1' } } };
    const missing = await mcpRaw(legacyUrl, { body: initialize });
    assert.equal(missing.status, 401, `missing key status ${missing.status}`);
    assert.equal(missing.errorCode, 'invalid_api_key');
    const wrong = await mcpRaw(legacyUrl, { key: 'ext06wrong.not-this-secret', body: initialize });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.errorCode, 'invalid_api_key');
    const expired = await mcpRaw(legacyUrl, { key: apiKeyFor('ext06expired'), body: initialize });
    assert.equal(expired.status, 401, `expired key status ${expired.status}`);
    assert.equal(expired.errorCode, 'invalid_api_key');
    const gatewayOnly = await mcpRaw(legacyUrl, { key: apiKeyFor('ext06gw'), body: initialize });
    assert.equal(gatewayOnly.status, 403, `gateway-only key status ${gatewayOnly.status}`);
    assert.equal(gatewayOnly.errorCode, 'credential_scope_forbidden');
    await assert.rejects(
      () => new Client({ name: 'ext06-noauth', version: '1' }).connect(new StreamableHTTPClientTransport(new URL(legacyUrl))),
    );
  });

  await step('tool-scope-credential-restricted', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(legacyUrl), { requestInit: { headers: { 'x-api-key': legacyRestrictedKey } } });
    const client = new Client({ name: 'ext06-restricted', version: '1' });
    children.push({ name: 'sdk-restricted', client, transport });
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools, []);
    await assert.rejects(() => client.callTool({ name: 'ping', arguments: {} }));
    await client.close();
  });

  await step('session-identity-and-cross-subject-denial', async () => {
    const mainTransport = children.find(entry => entry.name === 'sdk-streamable');
    const sessionId = mainTransport.transport.sessionId;
    assert.ok(sessionId);
    const mainClient = mainTransport.client;
    const otherTransport = new StreamableHTTPClientTransport(new URL(legacyUrl), { requestInit: { headers: { 'x-api-key': legacyOtherKey } } });
    const otherClient = new Client({ name: 'ext06-other', version: '1' });
    children.push({ name: 'sdk-other', client: otherClient, transport: otherTransport });
    await otherClient.connect(otherTransport);
    assert.deepEqual((await otherClient.listTools()).tools.map(tool => tool.name), ['ping']);
    const otherSession = otherTransport.sessionId;
    assert.ok(otherSession && otherSession !== sessionId);
    for (const method of ['POST', 'GET', 'DELETE']) {
      const response = await mcpRaw(legacyUrl, {
        method, key: legacyOtherKey, sessionId,
        body: method === 'POST' ? { jsonrpc: '2.0', id: 77, method: 'tools/list' } : undefined,
      });
      assert.equal(response.status, 403, `cross-subject ${method} status ${response.status}`);
    }
    const noIdentity = await mcpRaw(legacyUrl, {
      method: 'POST', sessionId, body: { jsonrpc: '2.0', id: 78, method: 'tools/list' },
    });
    assert.equal(noIdentity.status, 401);
    const stillWorking = await mainClient.callTool({ name: 'ping', arguments: {} });
    assert.notEqual(stillWorking.isError, true);
    assert.ok(upstreamState.received.length > 0);
  });

  await step('revocation-denies-active-and-new-sessions', async () => {
    const otherTransport = children.find(entry => entry.name === 'sdk-other');
    const otherClient = otherTransport.client;
    const callsBefore = upstreamState.received.length;
    const listing = await fetchJson(credentialsUrl(legacy.runtimeAssetId), { token: apiToken });
    assert.equal(listing.status, 200);
    const otherCredential = listing.json?.data?.find(item => item.keyId === 'ext06other');
    assert.ok(otherCredential, 'other credential not listed');
    assert.ok(!JSON.stringify(listing.json).includes(legacyOtherKey), 'credential list leaked the full key');
    const revoked = await fetchJson(`${credentialsUrl(legacy.runtimeAssetId)}/${otherCredential.id}/revoke`, {
      method: 'POST', token: apiToken, body: { reason: 'ext06 controlled revocation' },
    });
    assert.equal(revoked.status, 201, `revoke status ${revoked.status}`);
    assert.equal(revoked.json?.status, 'revoked');
    await assert.rejects(() => otherClient.callTool({ name: 'ping', arguments: {} }));
    await assert.rejects(() => otherClient.listTools());
    assert.equal(upstreamState.received.length, callsBefore, 'revoked credential still reached the upstream');
    const reconnect = await mcpRaw(legacyUrl, {
      method: 'POST', key: legacyOtherKey, sessionId: otherTransport.transport.sessionId,
      body: { jsonrpc: '2.0', id: 79, method: 'tools/list' },
    });
    assert.equal(reconnect.status, 401, `revoked reconnect status ${reconnect.status}`);
    assert.equal(reconnect.errorCode, 'invalid_api_key');
    const mainTransport = children.find(entry => entry.name === 'sdk-streamable');
    const mainResult = await mainTransport.client.callTool({ name: 'ping', arguments: {} });
    assert.notEqual(mainResult.isError, true, 'surviving session stopped working after a peer revocation');
    assert.equal(upstreamState.received.length, callsBefore + 1);
    const configuration = await fetchJson(`${credentialsUrl(legacy.runtimeAssetId)}/configuration`, { token: apiToken });
    assert.equal(configuration.status, 200);
    for (const secret of [legacyApiKey, legacyOtherKey]) assert.ok(!configuration.text.includes(secret), 'credential configuration export leaked a full key');
  });

  await step('sse-publication-redeploy', async () => {
    const stopped = await fetchJson(`http://127.0.0.1:${API_PORT}/api/v1/runtime-assets/${legacy.runtimeAssetId}/stop`, { method: 'POST', token: apiToken });
    assert.equal(stopped.status, 201, `stop status ${stopped.status}`);
    await waitFor(() => unreachable(`http://127.0.0.1:${LEGACY_MCP_PORT}${LEGACY_ENDPOINT}`), 'legacy streamable endpoint stayed reachable after stop', 20000);
    const deployed = await fetchJson(`http://127.0.0.1:${API_PORT}/api/v1/runtime-assets/${legacy.runtimeAssetId}/deploy-mcp`, {
      method: 'POST', token: apiToken,
      body: { port: LEGACY_MCP_PORT, transport: 'sse', endpointPath: SSE_ENDPOINT, inboundAuthMode: 'private_api_key', autoStart: false },
    });
    assert.equal(deployed.status, 201, `sse deploy status ${deployed.status}: ${sanitize(deployed.text).slice(0, 600)}`);
    assert.equal(deployed.json?.managedServer?.endpointPreview?.consumerUrl, `http://127.0.0.1:${LEGACY_MCP_PORT}${SSE_ENDPOINT}`);
    assert.equal(deployed.json?.managedServer?.endpointPreview?.messagesUrl, `http://127.0.0.1:${LEGACY_MCP_PORT}${SSE_ENDPOINT}/messages`);
    const started = await fetchJson(`http://127.0.0.1:${API_PORT}/api/v1/runtime-assets/${legacy.runtimeAssetId}/start`, { method: 'POST', token: apiToken });
    assert.equal(started.status, 201, `sse start status ${started.status}: ${sanitize(started.text).slice(0, 600)}`);
    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${LEGACY_MCP_PORT}/health`, { signal: AbortSignal.timeout(1000) });
        await response.arrayBuffer();
        return response.status === 200;
      } catch { return false; }
    }, 'sse MCP health did not become ready', 30000, 200);
  });

  await step('sse-sdk-connect-list-call', async () => {
    const sseUrl = `http://127.0.0.1:${LEGACY_MCP_PORT}${SSE_ENDPOINT}`;
    const headers = { 'x-api-key': legacyApiKey };
    const transport = new SSEClientTransport(new URL(sseUrl), {
      requestInit: { headers },
      eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), ...headers } }) },
    });
    const client = new Client({ name: 'ext06-sse-consumer', version: '1' });
    children.push({ name: 'sdk-sse', client, transport });
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['ping']);
    const callsBefore = upstreamState.received.length;
    const result = await client.callTool({ name: 'ping', arguments: {} });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(upstreamState.received.length, callsBefore + 1);
    assert.equal(upstreamState.received.at(-1).path, '/ping');
    const noIdentity = await mcpRaw(sseUrl, { accept: 'text/event-stream', timeout: 5000 });
    assert.equal(noIdentity.status, 401);
  });

  await step('secret-scan-artifacts-and-logs', async () => {
    const markers = [legacyApiKey, legacyOtherKey, legacyRestrictedKey, managedApiKey, upstreamSecret, managedRegistrySecret]
      .filter(Boolean).concat(runtimeSecrets);
    const upstreamWire = JSON.stringify(upstreamState.received);
    for (const marker of markers) assert.ok(!upstreamWire.includes(marker), 'upstream evidence leaked a credential');
    const specMarker = 'apinova-spec-v1.';
    const apiLog = fs.existsSync(apiLogPath) ? fs.readFileSync(apiLogPath, 'utf8') : '';
    for (const marker of markers) assert.ok(!apiLog.includes(marker), 'API process log leaked a credential');
    assert.ok(!apiLog.includes(specMarker), 'API process log leaked a runtime spec credential');
    if (fs.existsSync(logDir)) {
      for (const file of collectFiles(logDir)) {
        const contents = fs.readFileSync(file).toString('utf8');
        for (const marker of markers) assert.ok(!contents.includes(marker), `runtime log ${path.basename(file)} leaked a credential`);
        assert.ok(!contents.includes(specMarker), `runtime log ${path.basename(file)} leaked a runtime spec credential`);
      }
    }
    const databaseBytes = fs.readFileSync(dbPath).toString('utf8');
    for (const marker of markers) assert.ok(!databaseBytes.includes(marker), 'persisted database leaked a credential');
    assert.ok(!databaseBytes.includes(specMarker), 'persisted database leaked a runtime spec credential');
    const processLogs = await fetchJson(`http://127.0.0.1:${API_PORT}/api/v1/servers/${legacyServerId}/process/logs?limit=200`, { token: apiToken, timeout: 30000 });
    assert.equal(processLogs.status, 200);
    for (const marker of [legacyApiKey, legacyOtherKey, managedApiKey]) assert.ok(!processLogs.text.includes(marker), 'process log endpoint leaked a credential');
    assert.ok(!processLogs.text.includes(specMarker), 'process log endpoint leaked a runtime spec credential');
    const persistedList = await fetchJson(credentialsUrl(legacy.runtimeAssetId), { token: apiToken });
    for (const marker of [legacyApiKey, legacyOtherKey]) assert.ok(!persistedList.text.includes(marker), 'persisted credential list leaked a full key');
  });

  if (!SKIP_MANAGED) {
    await step('trusted-asset-deploy-through-api', async () => {
      const deployed = await fetchJson(`http://127.0.0.1:${API_PORT}/api/v1/runtime-assets/${TRUSTED_ASSET_ID}/deploy-mcp`, {
        method: 'POST', token: apiToken,
        body: { port: TRUSTED_MCP_PORT, transport: 'streamable', endpointPath: TRUSTED_ENDPOINT, inboundAuthMode: 'private_api_key', autoStart: false },
      });
      assert.equal(deployed.status, 201, `trusted deploy status ${deployed.status}: ${sanitize(deployed.text).slice(0, 600)}`);
      assert.equal(deployed.json?.verification?.run?.status, 'passed');
      assert.equal(deployed.json?.managedServer?.id, TRUSTED_SERVER_ID);
      assert.equal(deployed.json?.managedServer?.port, TRUSTED_MCP_PORT);
      assert.equal(deployed.json?.managedServer?.endpointPreview?.consumerUrl, `http://127.0.0.1:${TRUSTED_MCP_PORT}${TRUSTED_ENDPOINT}`);
    });

    await step('trusted-managed-channel-ready', async () => {
      const { startManagedMcpChannel } = require(path.join(apiRoot, 'dist/src/modules/servers/services/managed-mcp-channel.js'));
      const specResponse = await fetchJson(`http://127.0.0.1:${API_PORT}/api/openapi/by-runtime-asset/${TRUSTED_ASSET_ID}`, { token: apiToken });
      assert.equal(specResponse.status, 200, `assembled spec status ${specResponse.status}`);
      assert.ok(specResponse.json?.paths?.['/ping'], 'assembled spec has no /ping tool');
      const spec = specResponse.json;
      const registryText = fs.readFileSync(registryPath, 'utf8');
      const payload = {
        version: 1, launchId: `ext06-managed-${randomUUID()}`, managedServerId: TRUSTED_SERVER_ID, runtimeAssetId: TRUSTED_ASSET_ID,
        inboundAuthMode: 'private_api_key', candidateRevision: 'ext06-managed-candidate', verificationRunId: 'ext06-managed-run',
        behaviorFingerprint: createHash('sha256').update(JSON.stringify(canonical(spec))).digest('hex'),
        transport: { type: 'streamable', host: '127.0.0.1', port: TRUSTED_MCP_PORT, endpoint: TRUSTED_ENDPOINT },
        openApiData: spec,
        trustedOperationBindings: [{
          method: 'GET', path: '/ping',
          endpointDefinitionId: trusted.endpointDefinitionId, sourceServiceAssetId: trusted.sourceServiceAssetId,
        }],
        registrySource: {
          configId: 'ext06-registry', path: registryPath, format: 'json', environment: 'test',
          expectedRevision: 'r1', expectedContentDigest: createHash('sha256').update(registryText, 'utf8').digest('hex'),
        },
      };
      const childProcesses = require('node:child_process');
      const nativeSpawn = childProcesses.spawn;
      childProcesses.spawn = function (...args) {
        const child = nativeSpawn(...args);
        managedSpawnObservation = { command: args[0], args: args[1], options: args[2] || {}, pid: child.pid };
        return child;
      };
      try {
        managedHandle = await startManagedMcpChannel({
          launchId: payload.launchId, serverId: TRUSTED_SERVER_ID, payload,
          approvedEnvironmentNames: ['API_NOVA_RUNTIME_AUTH_MODE', 'API_NOVA_RUNTIME_API_KEYS', 'API_NOVA_MCP_RESOURCE',
            'API_NOVA_RUNTIME_ALLOW_HTTP_LOOPBACK', 'UPSTREAM_EXT06_MANAGED', 'API_NOVA_AUDIT_DIR'],
          environmentValues: {
            API_NOVA_RUNTIME_AUTH_MODE: 'api_key',
            API_NOVA_RUNTIME_API_KEYS: JSON.stringify(managedKeys),
            API_NOVA_MCP_RESOURCE: managedResource,
            API_NOVA_RUNTIME_ALLOW_HTTP_LOOPBACK: 'true',
            UPSTREAM_EXT06_MANAGED: managedRegistrySecret,
            API_NOVA_AUDIT_DIR: auditDir,
          },
        });
      } finally {
        childProcesses.spawn = nativeSpawn;
      }
      const revisions = await managedHandle.ready;
      managedPid = managedHandle.pid;
      assert.equal(managedHandle.state, 'runtimeReady');
      assert.equal(revisions.authMode, 'api_key');
      assert.equal(revisions.credentialMode, 'single-hop');
      assert.equal(managedSpawnObservation.command, process.execPath);
      assert.ok(String(managedSpawnObservation.args[0]).replace(/\//g, '\\').endsWith(path.join('dist', 'managed', 'entry.js')));
      assert.equal(managedSpawnObservation.options.shell, false);
      assert.deepEqual(Array.from(managedSpawnObservation.options.stdio), ['pipe', 'pipe', 'pipe', 'ipc']);
      assert.ok(!JSON.stringify(managedSpawnObservation.args).includes(managedSecret));
      assert.equal(managedSpawnObservation.options.env.UPSTREAM_EXT06_MANAGED, managedRegistrySecret);
      assert.equal(managedSpawnObservation.options.env.API_NOVA_RUNTIME_API_KEYS, JSON.stringify(managedKeys));
      assert.ok(!JSON.stringify(managedSpawnObservation.options.env.API_NOVA_RUNTIME_API_KEYS).includes(managedSecret));
      const noIdentity = await mcpRaw(`http://127.0.0.1:${TRUSTED_MCP_PORT}${TRUSTED_ENDPOINT}`, {
        body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ext06-managed-raw', version: '1' } } },
      });
      assert.equal(noIdentity.status, 401, `trusted endpoint missing key status ${noIdentity.status}`);
      assert.equal(noIdentity.errorCode, 'invalid_api_key');
    });

    await step('trusted-managed-sdk-connect-list-call', async () => {
      const managedUrl = `http://127.0.0.1:${TRUSTED_MCP_PORT}${TRUSTED_ENDPOINT}`;
      const transport = new StreamableHTTPClientTransport(new URL(managedUrl), { requestInit: { headers: { 'x-api-key': managedSecret } } });
      const client = new Client({ name: 'ext06-managed-consumer', version: '1' });
      children.push({ name: 'sdk-managed', client, transport });
      await client.connect(transport);
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['ping']);
      const callsBefore = upstreamState.received.length;
      const result = await client.callTool({ name: 'ping', arguments: {} });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.equal(upstreamState.received.length, callsBefore + 1);
      const last = upstreamState.received.at(-1);
      assert.equal(last.path, '/ping');
      assert.equal(last.headers.authorization, `Bearer ${managedRegistrySecret}`);
      const cross = await mcpRaw(managedUrl, {
        method: 'POST', key: managedOtherSecret, sessionId: transport.sessionId,
        body: { jsonrpc: '2.0', id: 80, method: 'tools/list' },
      });
      assert.equal(cross.status, 403, `managed cross-subject status ${cross.status}`);
      const stillWorking = await client.listTools();
      assert.equal(stillWorking.tools.length, 1);
    });

    await step('trusted-managed-stop-cleanup', async () => {
      await managedHandle.close();
      const closed = await managedHandle.closed;
      assert.deepEqual(closed, { code: 'STOPPED' });
      await waitFor(() => !pidAlive(managedPid), 'managed child process did not exit', 10000, 100);
      assert.ok(await unreachable(`http://127.0.0.1:${TRUSTED_MCP_PORT}${TRUSTED_ENDPOINT}`), 'managed endpoint stayed reachable after close');
      await fetchJson(`http://127.0.0.1:${API_PORT}/api/v1/runtime-assets/${TRUSTED_ASSET_ID}/stop`, { method: 'POST', token: apiToken, timeout: 20000 }).catch(() => null);
    });
  } else {
    notCovered.push({ item: 'trusted-managed-fixture-channel', reason: 'Skipped by EXT06_SKIP_MANAGED=1; trusted managed child evidence remains with SEC-E1-03/SEC-E1-04.' });
  }
}

async function run() {
  let fatal = null;
  try {
    await main();
  } catch (error) {
    fatal = sanitize((error && (error.stack || error.message)) || error);
    console.error(`[ext-06] aborted: ${fatal.split('\n').slice(0, 4).join(' | ')}`);
  } finally {
    try {
      if (apiToken) {
        for (const runtimeAssetId of [legacy && legacy.runtimeAssetId, !SKIP_MANAGED ? TRUSTED_ASSET_ID : null].filter(Boolean)) {
          await fetchJson(`http://127.0.0.1:${API_PORT}/api/v1/runtime-assets/${runtimeAssetId}/stop`, { method: 'POST', token: apiToken, timeout: 20000 }).catch(() => null);
        }
      }
    } catch { /* best effort */ }
    for (const entry of [...children].reverse()) {
      if (entry.client) { try { await entry.client.close(); } catch { /* best effort */ } }
    }
    if (managedHandle) { try { await managedHandle.close(); } catch { /* best effort */ } }
    if (apiChild && apiChild.exitCode === null) {
      const exited = once(apiChild, 'exit');
      try { apiChild.kill('SIGTERM'); } catch { /* best effort */ }
      await Promise.race([exited, delay(8000)]);
      if (apiChild.exitCode === null) { try { apiChild.kill('SIGKILL'); } catch { /* best effort */ } }
    }
    if (apiLogStream) { try { apiLogStream.end(); } catch { /* best effort */ } }
    for (const pid of [legacyPid, trustedPid, managedPid]) {
      if (pid && pidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* best effort */ } }
    }
    if (upstreamState) { try { await upstreamState.close(); } catch { /* best effort */ } }
    await delay(500);
  }

  const summary = {
    runner: 'verify-ext-06',
    sdkVersion,
    apiPort: API_PORT,
    legacyMcpPort: LEGACY_MCP_PORT,
    trustedMcpPort: TRUSTED_MCP_PORT,
    database: dbPath,
    logs: { api: apiLogPath, migration: migrationLogPath, seed: seedLogPath },
    checks,
    failures,
    notCovered,
    distStale: (() => { try { return fs.statSync(path.join(apiRoot, 'dist/src/main.js')).mtimeMs < newestSource(path.join(apiRoot, 'src')); } catch { return null; } })(),
    portsReleased: {
      api: await unreachable(`http://127.0.0.1:${API_PORT}/health`, 300),
      legacyMcp: await unreachable(`http://127.0.0.1:${LEGACY_MCP_PORT}/health`, 300),
      trustedMcp: await unreachable(`http://127.0.0.1:${TRUSTED_MCP_PORT}/health`, 300),
    },
    passed: failures.length === 0 && fatal === null,
    fatal: fatal ? fatal.split('\n').slice(0, 6).join(' | ') : null,
  };
  try { fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2)); } catch { /* best effort */ }

  if (summary.passed) {
    console.log('EXT_06_VERIFY_OK');
  } else {
    console.log('EXT_06_VERIFY_FAILED');
  }
  console.log(JSON.stringify({ marker: summary.passed ? 'EXT_06_VERIFY_OK' : 'EXT_06_VERIFY_FAILED', checks: checks.length, failed: failures.length, notCovered: notCovered.map(item => item.item), summary: summaryPath }, null, 2));
  process.exitCode = summary.passed ? 0 : 1;
}

void run();
