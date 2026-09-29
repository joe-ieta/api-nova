// SEC-EXT-07 raw-environment verification runner (Windows, loopback only).
// Failed Gateway/MCP candidates must keep the last working version active and serving.
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');

const repository = path.resolve(__dirname, '..');
const apiDir = path.join(repository, 'packages', 'api-nova-api');
const serverDir = path.join(repository, 'packages', 'api-nova-server');
const apiEntry = process.env.EXT07_API_ENTRY
  ? path.resolve(process.env.EXT07_API_ENTRY)
  : path.join(apiDir, 'dist', 'src', 'main.js');
const childEntry = path.join(serverDir, 'dist', 'cli.js');
const fixturePath = path.join(repository, 'examples', 'minimal-openapi.json');

const workDirInput = process.env.EXT07_WORK_DIR || 'E:\\temp\\opencode\\ext-07';
fs.mkdirSync(workDirInput, { recursive: true });
// Canonicalize exactly like EXT-06: the upstream credential file loader compares
// fs.realpath(path) with the configured path, and Windows canonicalizes "temp" -> "Temp".
const workDir = fs.realpathSync.native(workDirInput);
const logsDir = path.join(workDir, 'logs');
const evidenceDir = path.join(workDir, 'evidence');
const runtimeLogsDir = path.join(workDir, 'runtime-logs');
const pidDir = path.join(workDir, 'pids');
const auditDir = path.join(workDir, 'audit');
const dbPath = path.join(workDir, 'api_nova_ext07.db');
const registryPath = path.join(workDir, 'upstream-credential-registry.json');
const evidencePath = path.join(evidenceDir, 'ext-07-evidence.json');
const runLogPath = path.join(workDir, 'verify-run.log');
const migrationLogPath = path.join(logsDir, 'migration.log');

const apiPort = Number(process.env.EXT07_API_PORT || 9013);
const mcpPort = Number(process.env.EXT07_MCP_PORT || 9034);
const apiBase = `http://127.0.0.1:${apiPort}`;
const GATEWAY_PREFIX = 'ext07gw';
const MCP_ENDPOINT = '/ext07-mcp';
const UPSTREAM_ENVIRONMENT = 'ext07';

const sdkRoot = path.resolve(path.dirname(require.resolve('@modelcontextprotocol/sdk/server/mcp.js')), '..', '..', '..');
const sdkVersion = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json'), 'utf8')).version;
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const adminUsername = process.env.EXT07_ADMIN_USERNAME || `ext07admin${randomBytes(4).toString('hex')}`;
const adminPassword = process.env.EXT07_ADMIN_PASSWORD || `Ext07!${randomBytes(18).toString('hex')}`;
const jwtSecret = randomBytes(32).toString('hex');
const mcpKeyId = `ext07mcp${randomBytes(3).toString('hex')}`;
let mcpApiKey = null;

const notCovered = [
  'external or non-loopback upstreams, real identity providers and production credentials: not exercised',
  'Linux and PostgreSQL lanes: not exercised on this Windows run',
  'browser/UI interaction and production UI builds: not exercised',
  'Gateway consumer credential enforcement: the gateway route is anonymous+external so the real candidate replay can execute without consumer credentials; authenticated consumer access is proven on the MCP path with a database-issued API key',
  'MCP child spec callback: the assembled spec endpoint is management-JWT guarded in the built dist, so the spawned child fetched it through a loopback JWT-injecting proxy shim (same pattern as EXT-06; product behavior unchanged)',
  'cross-process/global publication locking and concurrent operators: not exercised',
  'dist handling: the runner never builds and never modifies packages/**; it records the exact API entry in evidence.artifact (in-repo dist or an EXT07_API_ENTRY override) and the working tree contains uncommitted changes from a concurrent workstream',
  'full /health may report 503 for host disk thresholds on this machine; /api/health/ready=ready is the gating readiness signal',
];

const baseEnv = { ...process.env };
for (const key of Object.keys(baseEnv)) {
  if (/^(API_NOVA_|DB_|SUPER_ADMIN_|JWT_|MAIL_)/i.test(key)) delete baseEnv[key];
  if (['PORT', 'MCP_PORT', 'MCP_SERVER_PORT', 'THROTTLE_LIMIT', 'THROTTLE_TTL', 'LOG_DIRECTORY', 'PID_DIRECTORY', 'API_BASE_URL', 'LOG_LEVEL', 'LOG_FORMAT', 'NODE_ENV', 'PROCESS_TIMEOUT', 'PROCESS_MAX_RETRIES', 'PROCESS_RESTART_DELAY'].includes(key)) delete baseEnv[key];
}

const steps = [];
const failures = [];
const secrets = [adminPassword, jwtSecret];
let token = null;
let upstreamState = null;
let proxyState = null;
let currentApi = null;
let apiGeneration = 0;
let finished = false;
let consoleLog = '';
const evidence = {
  marker: 'EXT_07_EVIDENCE_V1',
  workPackage: 'SEC-EXT-07',
  startedAt: new Date().toISOString(),
  environment: { platform: process.platform, release: os.release(), arch: process.arch, node: process.version, sdkVersion },
  ports: { api: apiPort, mcp: mcpPort, managedChild: null },
  database: { path: dbPath, mode: 'sqlite (sql.js)', isolated: true },
  upstream: { environment: UPSTREAM_ENVIRONMENT, loopbackOnly: true },
  notCovered,
  notes: [],
  steps,
};

function stripAnsi(value) {
  return String(value ?? '').replace(/\u001b\[[0-9;]*m/g, '');
}
function redact(value) {
  let text = stripAnsi(value);
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[redacted]');
  }
  return text;
}
function recordConsole(line) {
  const sanitized = `[ext-07] ${redact(line)}`;
  console.log(sanitized);
  consoleLog += `${sanitized}\n`;
}
function log(message) {
  recordConsole(message);
}
function record(id, description, ok, details = {}) {
  const entry = { id, description, ok, at: new Date().toISOString(), ...details };
  steps.push(entry);
  recordConsole(`${ok ? 'PASS' : 'FAIL'} ${id}${entry.httpStatus !== undefined ? ` http=${entry.httpStatus}` : ''}${entry.detail ? ` :: ${entry.detail}` : ''}`);
  if (!ok && !entry.informational) failures.push({ id, detail: entry.detail || 'failed' });
  return entry;
}
async function step(id, description, fn) {
  try {
    const details = (await fn()) || {};
    record(id, description, true, details);
    return details;
  } catch (error) {
    record(id, description, false, { detail: sanitizedError(error) });
    throw error;
  }
}
function requireCheck(condition, message) {
  if (!condition) throw new Error(message);
}
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function sanitizedError(error) {
  const status = error && error.status !== undefined ? `status=${error.status} ` : '';
  const message = error && error.message ? error.message : String(error);
  let causeText = '';
  let cause = error && error.cause;
  for (let depth = 0; cause && depth < 3; depth += 1) {
    const part = cause.code || cause.message || String(cause);
    causeText += ` cause=${part}`;
    cause = cause.cause;
  }
  return redact(`${status}${message}${causeText}`).slice(0, 700);
}
function responseSummary(response) {
  const body = response.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    if (body.success === false && body.error) {
      const details = body.error.details || {};
      return { envelopeCode: body.error.code, code: details.code, message: redact(JSON.stringify(body.error.message ?? body.error)).slice(0, 300) };
    }
    if (body.code || body.error) {
      const code = body.code || (body.error && body.error.code);
      const message = body.message || (body.error && body.error.message) || body.error;
      return { code, message: redact(JSON.stringify(message)).slice(0, 300) };
    }
    return Object.fromEntries(Object.keys(body).slice(0, 12).map(key => [key, Array.isArray(body[key]) ? `[array ${body[key].length}]` : typeof body[key]]));
  }
  return { bodyType: typeof body };
}
/** API HttpException envelope: { success:false, error:{ code, message, details:{ code, verification } } }. */
function failureDetail(response) {
  const error = response.body && response.body.error;
  const details = (error && error.details) || {};
  return { envelope: Boolean(response.body && response.body.success === false), code: details.code, verification: details.verification, message: error && error.message };
}
async function fetchJson(url, options = {}, timeoutMs = 30000) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(`request to ${url} failed: ${error && error.message ? error.message : error}`);
  }
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}
async function callApi(method, requestPath, body, extraHeaders = {}, timeoutMs = 30000) {
  const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders };
  const init = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return fetchJson(`${apiBase}/api${requestPath}`, init, timeoutMs);
}
function assertHttp(response, expected, label) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  requireCheck(allowed.includes(response.status), `${label} returned HTTP ${response.status} (expected ${allowed.join('/')}): ${JSON.stringify(responseSummary(response))}`);
}
function waitForExit(child, timeoutMs) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}
function stopTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}
function portFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', error => resolve(error.code !== 'EADDRINUSE'));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}
async function unreachable(url, timeout = 500) {
  try { await fetch(url, { signal: AbortSignal.timeout(timeout) }); return false; } catch { return true; }
}
async function pickFreePortInRange(min, max) {
  for (let port = min; port <= max; port += 1) {
    if (await portFree(port)) return port;
  }
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function waitFor(label, predicate, timeoutMs = 60000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(`${label} did not become available within ${timeoutMs}ms${lastError ? ` (last error: ${lastError.message})` : ''}`);
}
function readTail(file, maxLines) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    return redact(lines.slice(-maxLines).join('\n')).slice(0, 4000);
  } catch {
    return '';
  }
}
function currentToken() {
  return token;
}
function startUpstream(fixture) {
  const state = {
    failureMode: false,
    received: [],
    server: null,
    port: 0,
    close: null,
  };
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      state.received.push({ method: request.method, path: request.url, at: new Date().toISOString() });
      response.setHeader('content-type', 'application/json');
      if (request.url === '/openapi.json') {
        response.statusCode = 200;
        response.end(JSON.stringify(fixture));
        return;
      }
      if (state.failureMode) {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: 'ext07-injected-upstream-failure' }));
        return;
      }
      response.statusCode = 200;
      response.end(JSON.stringify({ pong: true, marker: 'ext07-loopback-upstream' }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      state.server = server;
      state.port = server.address().port;
      state.close = () => new Promise(done => { server.closeAllConnections(); server.close(() => done()); });
      resolve(state);
    });
  });
}
function startSpecProxy() {
  const specRequests = [];
  const server = http.createServer((request, response) => {
    const isSpec = String(request.url || '').startsWith('/api/openapi/');
    const headers = { ...request.headers };
    if (isSpec) {
      const bearer = currentToken();
      specRequests.push({ method: request.method, path: request.url, injected: Boolean(bearer), childAuthorization: headers.authorization || null });
      if (bearer) headers.authorization = `Bearer ${bearer}`;
    }
    delete headers.host;
    const forwarded = http.request({
      hostname: '127.0.0.1',
      port: apiPort,
      path: request.url,
      method: request.method,
      headers: { ...headers, host: `127.0.0.1:${apiPort}` },
    }, upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    forwarded.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(forwarded);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      specRequests,
      port: server.address().port,
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise(done => { server.closeAllConnections(); server.close(() => done()); }),
    }));
  });
}
function runMigration() {
  const env = {
    ...baseEnv,
    NODE_ENV: 'test',
    JWT_SECRET: jwtSecret,
    JWT_REFRESH_SECRET: jwtSecret,
    DB_TYPE: 'sqlite',
    DB_SQLITE_PATH: dbPath,
    DB_SYNCHRONIZE: 'false',
    DB_LOGGING: 'false',
  };
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run migration:run --workspace api-nova-api'], {
    cwd: repository,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300000,
    maxBuffer: 64 * 1024 * 1024,
  });
  fs.writeFileSync(migrationLogPath, redact(`${result.stdout || ''}\n${result.stderr || ''}`));
  return { status: result.status, logPath: migrationLogPath };
}
function buildApiEnv() {
  return {
    ...baseEnv,
    NODE_ENV: 'test',
    PORT: String(apiPort),
    MCP_PORT: String(mcpPort),
    MCP_SERVER_PORT: String(mcpPort),
    DB_TYPE: 'sqlite',
    DB_SQLITE_PATH: dbPath,
    DB_SYNCHRONIZE: 'false',
    DB_LOGGING: 'false',
    JWT_SECRET: jwtSecret,
    JWT_REFRESH_SECRET: jwtSecret,
    SUPER_ADMIN_USERNAME: adminUsername,
    SUPER_ADMIN_EMAIL: `${adminUsername}@example.invalid`,
    SUPER_ADMIN_PASSWORD: adminPassword,
    API_NOVA_RUNTIME_CREDENTIAL_SOURCE: 'database',
    API_NOVA_RUNTIME_AUTH_MODE: 'api_key',
    API_NOVA_MCP_RESOURCE: `http://127.0.0.1:${evidence.ports.managedChild}${MCP_ENDPOINT}`,
    API_NOVA_RUNTIME_ALLOW_HTTP_LOOPBACK: 'true',
    API_NOVA_RUNTIME_REQUIRED_SCOPES: '',
    API_NOVA_MCP_TOOL_SCOPES: '{}',
    API_NOVA_UPSTREAM_CREDENTIAL_FILE: registryPath,
    API_NOVA_UPSTREAM_CREDENTIAL_FORMAT: 'json',
    API_NOVA_UPSTREAM_CREDENTIAL_ENVIRONMENT: UPSTREAM_ENVIRONMENT,
    API_NOVA_UPSTREAM_CREDENTIAL_RELOAD_MODE: 'manual',
    API_NOVA_AUDIT_DIR: auditDir,
    PID_DIRECTORY: pidDir,
    LOG_DIRECTORY: runtimeLogsDir,
    API_BASE_URL: proxyState.url,
    THROTTLE_LIMIT: '10000',
    THROTTLE_TTL: '60',
    LOG_LEVEL: 'info',
  };
}
function startApiProcess() {
  apiGeneration += 1;
  const tag = `run${apiGeneration}`;
  const stdoutPath = path.join(logsDir, `api-${tag}-stdout.log`);
  const stderrPath = path.join(logsDir, `api-${tag}-stderr.log`);
  const child = spawn(process.execPath, [apiEntry], {
    cwd: apiDir,
    env: buildApiEnv(),
    stdio: ['ignore', fs.openSync(stdoutPath, 'w'), fs.openSync(stderrPath, 'w')],
    windowsHide: true,
  });
  currentApi = { child, stdoutPath, stderrPath, tag };
  return currentApi;
}
async function stopApiProcess() {
  if (!currentApi) return;
  const child = currentApi.child;
  stopTree(child);
  await waitForExit(child, 10000);
  if (child.exitCode === null) child.kill('SIGKILL');
  await waitFor('API port release', async () => {
    try {
      await fetch(`${apiBase}/api/health/ready`, { signal: AbortSignal.timeout(800) });
      return false;
    } catch { return true; }
  }, 20000, 300).catch(() => undefined);
  currentApi = null;
}
async function login() {
  const loginResponse = await fetchJson(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: adminUsername, password: adminPassword }),
  });
  assertHttp(loginResponse, 200, 'super admin login');
  token = loginResponse.body && loginResponse.body.accessToken;
  requireCheck(Boolean(token), 'login response did not contain an access token');
  secrets.push(token);
  return loginResponse;
}
async function readAsset(assetId) {
  const response = await callApi('GET', `/v1/runtime-assets/${assetId}`);
  assertHttp(response, 200, 'runtime asset detail');
  return response.body;
}
async function withMcpClient(apiKey, fn, timeoutMs = 20000) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${evidence.ports.managedChild}${MCP_ENDPOINT}`), {
    requestInit: { headers: { 'x-api-key': apiKey } },
  });
  const client = new Client({ name: 'ext07-consumer', version: '1' });
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await Promise.race([client.close().catch(() => undefined), delay(3000)]);
  }
}
function registryDocument(revision, sites) {
  return {
    apiVersion: 'security.apinova.io/v1',
    kind: 'UpstreamCredentialBindings',
    metadata: { revision, environment: UPSTREAM_ENVIRONMENT },
    reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true },
    secretProviders: {},
    credentials: {},
    sites,
  };
}

async function main() {
  evidence.startedAt = new Date().toISOString();
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.mkdirSync(runtimeLogsDir, { recursive: true });
  fs.mkdirSync(pidDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });
  for (const artifact of [dbPath, registryPath, evidencePath, runLogPath, migrationLogPath]) {
    if (fs.existsSync(artifact)) fs.rmSync(artifact, { force: true });
  }
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8', windowsHide: true }).stdout.trim();
  evidence.environment.commit = commit;
  log(`repository=${repository} commit=${commit.slice(0, 12)} workDir=${workDir} sdk=${sdkVersion}`);

  evidence.ports.managedChild = await pickFreePortInRange(9035, 9099);

  await step('preflight', 'built entries, fixture and isolated ports are available', async () => {
    requireCheck(fs.existsSync(apiEntry), `built API entry missing: ${apiEntry}; build api-nova-api first (no rebuild is attempted here)`);
    requireCheck(fs.existsSync(childEntry), `built MCP child entry missing: ${childEntry}; build api-nova-server first`);
    requireCheck(fs.existsSync(fixturePath), `fixture missing: ${fixturePath}`);
    for (const port of [apiPort, mcpPort, evidence.ports.managedChild]) {
      requireCheck(await portFree(port), `port ${port} is already in use; EXT-07 requires isolated ports ${apiPort}/${mcpPort}/${evidence.ports.managedChild}`);
    }
    const mainStat = fs.statSync(apiEntry);
    const defaultApiEntry = path.join(apiDir, 'dist', 'src', 'main.js');
    const apiEntryOverride = apiEntry !== defaultApiEntry;
    const newestSource = (() => {
      let newest = 0;
      const visit = entry => {
        for (const item of fs.readdirSync(entry, { withFileTypes: true })) {
          const target = path.join(entry, item.name);
          if (item.isDirectory()) { if (!['node_modules', 'dist', 'docs'].includes(item.name)) visit(target); continue; }
          if (!item.name.endsWith('.ts') || /\.(spec|test)\.ts$/.test(item.name)) continue;
          newest = Math.max(newest, fs.statSync(target).mtimeMs);
        }
      };
      visit(path.join(apiDir, 'src'));
      return newest;
    })();
    evidence.artifact = {
      apiEntry,
      apiEntryOverride,
      apiEntryBytes: mainStat.size,
      apiEntryMtime: mainStat.mtime.toISOString(),
      childEntry,
      distStale: apiEntryOverride ? null : mainStat.mtimeMs < newestSource,
    };
    if (apiEntryOverride) {
      evidence.notes.push('EXT07_API_ENTRY pointed at an isolated build of commit ' + commit.slice(0, 12) + ' because the in-repo packages/api-nova-api/dist had been replaced by a concurrent, in-flight workstream build that failed to boot (RuntimeSpecAccessService dependency resolution); packages/** was not modified and the repo dist was not rebuilt');
    } else if (evidence.artifact.distStale) {
      evidence.notes.push('packages/api-nova-api/dist/src/main.js is older than the newest source edit (concurrent workstream); the existing build was used without rebuilding, as scoped');
    }
    return { detail: `ports ${apiPort}/${mcpPort}/${evidence.ports.managedChild} free; apiEntryOverride=${apiEntryOverride}; distStale=${evidence.artifact.distStale}; commit ${commit.slice(0, 12)}` };
  });

  await step('migration', 'npm run migration:run --workspace api-nova-api against the isolated SQLite database', async () => {
    const migration = runMigration();
    requireCheck(migration.status === 0, `migration:run failed with exit ${migration.status}; tail: ${readTail(migration.logPath, 20)}`);
    requireCheck(fs.existsSync(dbPath), 'isolated database file was not created');
    return { detail: `exit=0 log=${migration.logPath}` };
  });

  upstreamState = await startUpstream(JSON.parse(fs.readFileSync(fixturePath, 'utf8')));
  evidence.upstream.url = `http://127.0.0.1:${upstreamState.port}`;
  log(`loopback upstream fixture at ${evidence.upstream.url}`);

  fs.writeFileSync(registryPath, JSON.stringify(registryDocument('ext07-bootstrap', []), null, 2));
  proxyState = await startSpecProxy();
  evidence.ports.specProxy = proxyState.port;
  log(`spec callback proxy at ${proxyState.url}`);

  let api = startApiProcess();
  await step('api.start', 'API process starts and reports /api/health/ready=ready on the isolated port', async () => {
    await waitFor('API readiness', async () => {
      const ready = await fetchJson(`${apiBase}/api/health/ready`, {}, 5000);
      return ready.status === 200 && ready.body && ready.body.status === 'ready';
    }, 90000);
    return { httpStatus: 200, detail: `pid=${api.child.pid} port=${apiPort} log=${api.stdoutPath}` };
  });

  await step('api.health.full', 'raw full /health response captured (informational; host disk threshold)', async () => {
    const fullHealth = await fetchJson(`${apiBase}/health`, {}, 10000);
    const details = fullHealth.body && fullHealth.body.error && fullHealth.body.error.details && fullHealth.body.error.details.details
      ? fullHealth.body.error.details.details : {};
    const failedChecks = Object.fromEntries(Object.entries(details)
      .filter(([, value]) => value && typeof value === 'object' && value.status === 'down')
      .map(([name, value]) => [name, String(value.message || 'down')]));
    evidence.startup = {
      api: {
        pid: api.child.pid,
        stdout: api.stdoutPath,
        stderr: api.stderrPath,
        readyStatus: 200,
        fullHealthStatus: fullHealth.status,
        fullHealthFailedChecks: failedChecks,
      },
    };
    return { httpStatus: fullHealth.status, informational: true, detail: `failedChecks=${JSON.stringify(failedChecks)}; readiness gate is /api/health/ready` };
  });

  let loginResponse;
  await step('auth.login', 'seeded super admin authenticates through the real login endpoint', async () => {
    loginResponse = await login();
    const roleNames = (loginResponse.body.user && loginResponse.body.user.roles ? loginResponse.body.user.roles : [])
      .map(role => role && role.name).filter(Boolean);
    evidence.login = { endpoint: '/api/auth/login', status: loginResponse.status, subject: 'synthetic_super_admin', roleNames };
    return { httpStatus: loginResponse.status, detail: `roles=${roleNames.join(',')}` };
  });

  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  fixture.servers = [{ url: evidence.upstream.url }];
  upstreamState.fixture = fixture;

  await step('import.upload', 'multipart OpenAPI import parses endpoints and MCP tools', async () => {
    const form = new FormData();
    form.append('file', new Blob([JSON.stringify(fixture, null, 2)], { type: 'application/json' }), 'minimal-openapi.json');
    const upload = await fetchJson(`${apiBase}/api/openapi/upload`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form }, 30000);
    assertHttp(upload, 200, 'OpenAPI upload import');
    const endpointCount = upload.body && upload.body.endpoints ? upload.body.endpoints.length : 0;
    const toolCount = upload.body && upload.body.tools ? upload.body.tools.length : 0;
    requireCheck(endpointCount > 0 && toolCount > 0, 'uploaded OpenAPI document produced no endpoints/tools');
    return { httpStatus: upload.status, detail: `endpoints=${endpointCount} tools=${toolCount}` };
  });

  await step('import.parse_url', 'OpenAPI import from a loopback URL parses endpoints', async () => {
    const parseUrl = await fetchJson(`${apiBase}/api/openapi/parse-url?url=${encodeURIComponent(`${evidence.upstream.url}/openapi.json`)}`, { headers: { authorization: `Bearer ${token}` } }, 30000);
    assertHttp(parseUrl, 200, 'OpenAPI parse from loopback URL');
    const endpointCount = parseUrl.body && parseUrl.body.endpoints ? parseUrl.body.endpoints.length : 0;
    requireCheck(endpointCount > 0, 'URL parse produced no endpoints');
    return { httpStatus: parseUrl.status, detail: `endpoints=${endpointCount}` };
  });

  const runSuffix = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  let document;
  await step('import.document', 'documents import persists the spec and converts it into asset endpoints', async () => {
    document = await callApi('POST', '/documents', {
      name: `ext07-loopback-${runSuffix}`,
      description: 'SEC-EXT-07 isolated failed-candidate retention verification',
      content: JSON.stringify(fixture),
      status: 'valid',
      version: '1.0.0',
      metadata: { importSource: 'url', originalUrl: `${evidence.upstream.url}/openapi.json` },
    });
    assertHttp(document, 201, 'document create (interactive import)');
    requireCheck(document.body && document.body.id, 'document create returned no id');
    return { httpStatus: document.status, detail: `documentId=${document.body.id} endpointCount=${document.body.endpointCount}` };
  });

  let endpoint;
  let sourceServiceAssetId;
  let instanceId;
  await step('convert.endpoints', 'import is converted into a persisted endpoint definition rooted at the loopback source asset', async () => {
    const allEndpoints = await callApi('GET', '/v1/assets/endpoints');
    assertHttp(allEndpoints, 200, 'endpoint catalog list');
    endpoint = (allEndpoints.body.data || []).find(item => item.metadata && item.metadata.documentId === document.body.id);
    requireCheck(Boolean(endpoint), 'imported endpoint definition not found in the catalog');
    const detail = await callApi('GET', `/v1/assets/endpoints/${endpoint.id}`);
    assertHttp(detail, 200, 'endpoint detail');
    sourceServiceAssetId = detail.body.sourceServiceAsset && detail.body.sourceServiceAsset.id;
    requireCheck(Boolean(sourceServiceAssetId), 'endpoint detail has no source service asset');
    return { httpStatus: allEndpoints.status, detail: `endpoint=${endpoint.method} ${endpoint.path} id=${endpoint.id} source=${detail.body.sourceServiceAsset.sourceKey}` };
  });

  await step('governance.instance_probe', 'loopback source service instance is created and probes healthy', async () => {
    const instance = await callApi('POST', `/v1/assets/source-services/${sourceServiceAssetId}/instances`, {
      name: `ext07-loopback-${runSuffix}`,
      environment: UPSTREAM_ENVIRONMENT,
      scheme: 'http',
      host: '127.0.0.1',
      port: upstreamState.port,
      basePath: '/',
      enabled: true,
      isDefault: true,
      priority: 10,
    });
    assertHttp(instance, 201, 'source service instance create');
    requireCheck(instance.body && instance.body.id, 'source service instance create returned no id');
    instanceId = instance.body.id;
    const probe = await callApi('POST', `/v1/assets/source-services/${sourceServiceAssetId}/instances/${instanceId}/probe`, {});
    assertHttp(probe, [200, 201], 'source service instance probe');
    requireCheck(probe.body.probe && probe.body.probe.status === 'healthy', `instance probe not healthy: ${JSON.stringify(probe.body.probe)}`);
    return { httpStatus: probe.status, detail: `instanceId=${instanceId} httpStatus=${probe.body.probe.httpStatus}` };
  });

  await step('governance.probe', 'endpoint probe against the loopback upstream verifies and enables publication', async () => {
    const probe = await callApi('POST', `/v1/assets/endpoints/${endpoint.id}/probe`, {});
    assertHttp(probe, [200, 201], 'endpoint probe');
    requireCheck(probe.body.endpoint && probe.body.endpoint.status === 'verified' && probe.body.endpoint.publishEnabled === true,
      `endpoint probe did not verify the endpoint: status=${probe.body.endpoint && probe.body.endpoint.status} publishEnabled=${probe.body.endpoint && probe.body.endpoint.publishEnabled}`);
    return { httpStatus: probe.status, detail: `probeStatus=${probe.body.probe.status} endpointStatus=${probe.body.endpoint.status}` };
  });

  await step('governance.test', 'endpoint functional test executes against the loopback upstream and records a real sample', async () => {
    const test = await callApi('POST', `/v1/assets/endpoints/${endpoint.id}/test`, {});
    assertHttp(test, [200, 201], 'endpoint functional test');
    requireCheck(test.body.test && test.body.test.passed === true, `endpoint test not passed: ${JSON.stringify(test.body.test)}`);
    return { httpStatus: test.status, detail: `httpStatus=${test.body.test.httpStatus} durationMs=${test.body.test.durationMs}` };
  });

  let sampleId;
  await step('governance.sample', 'captured test sample is tagged as the smoke sample used by candidate verification', async () => {
    const samples = await callApi('GET', `/v1/endpoint-testing/endpoints/${endpoint.id}/test-samples`);
    assertHttp(samples, 200, 'test sample list');
    const sample = (samples.body.data || [])[0];
    requireCheck(Boolean(sample), 'endpoint test did not record a sample');
    sampleId = sample.id;
    const tagged = await callApi('PATCH', `/v1/endpoint-testing/test-samples/${sample.id}`, { tags: ['smoke'] });
    assertHttp(tagged, 200, 'test sample smoke tag');
    requireCheck(Array.isArray(tagged.body.tags) && tagged.body.tags.includes('smoke'), 'smoke tag was not stored on the sample');
    return { httpStatus: tagged.status, detail: `sampleId=${sampleId} tags=${tagged.body.tags.join(',')}` };
  });

  await step('governance.readiness', 'endpoint is governance-ready (verified, publishEnabled, probe healthy, test passed)', async () => {
    const readiness = await callApi('GET', `/v1/assets/endpoints/${endpoint.id}/readiness`);
    assertHttp(readiness, 200, 'endpoint readiness');
    requireCheck(readiness.body.ready === true, `endpoint readiness is not ready: ${JSON.stringify(readiness.body.reasons)}`);
    return { httpStatus: readiness.status, detail: `checks=${JSON.stringify(readiness.body.checks)}` };
  });

  await step('governance.candidates', 'governance-ready endpoint appears as a publication candidate', async () => {
    const candidates = await callApi('GET', '/v1/publication/endpoints/candidates');
    assertHttp(candidates, 200, 'publication candidate list');
    const candidate = (candidates.body.data || []).find(item => item.endpointDefinition && item.endpointDefinition.id === endpoint.id);
    requireCheck(Boolean(candidate) && candidate.readiness && candidate.readiness.ready === true, 'governance-ready endpoint is not listed as a publication candidate');
    return { httpStatus: candidates.status, detail: `total=${candidates.body.total}` };
  });

  // ---------------------------------------------------------------------------
  // Gateway runtime asset: valid candidate, failing candidate, fixed retry.
  // ---------------------------------------------------------------------------
  let gatewayAssetId;
  let gatewayMembershipId;
  let gatewayBindingId;
  let gatewayRouteId;
  const gatewayAssetName = `ext07-gateway-${runSuffix}`;
  await step('gateway.runtime_asset', 'gateway runtime asset draft is created with a service prefix', async () => {
    const runtimeAsset = await callApi('POST', '/v1/publication/endpoints/runtime-assets', {
      type: 'gateway_service',
      name: gatewayAssetName,
      displayName: 'EXT-07 gateway runtime asset',
      servicePrefix: GATEWAY_PREFIX,
    });
    assertHttp(runtimeAsset, 201, 'gateway runtime asset create');
    gatewayAssetId = runtimeAsset.body.runtimeAsset && runtimeAsset.body.runtimeAsset.id;
    requireCheck(Boolean(gatewayAssetId), 'gateway runtime asset create returned no id');
    return { httpStatus: runtimeAsset.status, detail: `runtimeAssetId=${gatewayAssetId} servicePrefix=${GATEWAY_PREFIX}` };
  });

  await step('gateway.membership', 'ready endpoint is added as a gateway runtime membership', async () => {
    const membershipResponse = await callApi('POST', `/v1/publication/endpoints/runtime-assets/${gatewayAssetId}/memberships`, {
      endpointDefinitionIds: [endpoint.id],
    });
    assertHttp(membershipResponse, 201, 'gateway membership add');
    const membership = membershipResponse.body.createdMemberships && membershipResponse.body.createdMemberships[0];
    requireCheck(Boolean(membership && membership.id), 'gateway membership create returned no id');
    gatewayMembershipId = membership.id;
    return { httpStatus: membershipResponse.status, detail: `membershipId=${gatewayMembershipId}` };
  });

  await step('gateway.registry_reload', 'real upstream credential registry (registry-sourced header policy) is activated through the admin reload API', async () => {
    const status = await callApi('GET', '/security/upstream-credentials/status');
    assertHttp(status, 200, 'upstream credential registry status');
    requireCheck(status.body.configured === true, `credential registry is not configured: ${JSON.stringify(status.body)}`);
    requireCheck(Number.isSafeInteger(status.body.generation) && status.body.generation >= 1, `unexpected registry generation: ${JSON.stringify(status.body)}`);
    const before = status.body.generation;
    const site = {
      id: 'ext07-site',
      sourceServiceAssetId,
      match: { scheme: 'http', host: '127.0.0.1', port: upstreamState.port, basePath: '/' },
      allowedHosts: ['127.0.0.1'],
      credential: 'none',
      headerPolicy: { version: 1, requestHeaders: [], responseHeaders: [] },
      endpoints: [{ endpointDefinitionId: endpoint.id }],
    };
    fs.writeFileSync(registryPath, JSON.stringify(registryDocument('ext07-real-site', [site]), null, 2));
    const reload = await callApi('POST', '/security/upstream-credentials/reload', {
      expectedGeneration: before,
      reason: 'ext07 real loopback site for gateway candidate verification',
    });
    assertHttp(reload, 200, 'upstream credential registry reload');
    requireCheck(reload.body.generation === before + 1, `registry generation did not advance: ${before} -> ${reload.body.generation}`);
    evidence.registry = { generation: reload.body.generation, revision: reload.body.revision, environment: reload.body.environment };
    return { httpStatus: reload.status, detail: `generation ${before} -> ${reload.body.generation} environment=${reload.body.environment}` };
  });

  await step('gateway.route', 'gateway route is configured with a registry-sourced header policy and anonymous external auth', async () => {
    const route = await callApi('PUT', `/v1/publication/endpoints/runtime-memberships/${gatewayMembershipId}/gateway-route`, {
      routePath: '/ping',
      routeMethod: 'GET',
      upstreamPath: '/ping',
      upstreamMethod: 'GET',
      routeVisibility: 'external',
      authPolicyRef: 'anonymous:ext07',
      upstreamConfig: { headerPolicyMigration: { version: 1, mode: 'v1', source: 'registry' } },
    });
    assertHttp(route, 200, 'gateway route configure');
    gatewayRouteId = route.body.routeBinding && route.body.routeBinding.id;
    requireCheck(Boolean(gatewayRouteId), 'gateway route configure returned no route binding id');
    return { httpStatus: route.status, detail: `routeBindingId=${gatewayRouteId} routePath=${route.body.routeBinding.routePath}` };
  });

  await step('gateway.profile', 'gateway publication profile is reviewed', async () => {
    const profile = await callApi('PUT', `/v1/publication/endpoints/runtime-memberships/${gatewayMembershipId}/profile`, {
      intentName: 'ext07GwPing',
      descriptionForLlm: 'SEC-EXT-07 loopback gateway ping intent',
      status: 'reviewed',
    });
    assertHttp(profile, 200, 'gateway publication profile upsert');
    requireCheck(profile.body.profile && profile.body.profile.status === 'reviewed', 'gateway profile is not reviewed');
    return { httpStatus: profile.status, detail: `profileId=${profile.body.profile.id}` };
  });

  let gatewayPublishRevision;
  await step('gateway.publish', 'gateway membership publishes to HTTP and the asset becomes active', async () => {
    const publish = await callApi('POST', `/v1/publication/endpoints/runtime-memberships/${gatewayMembershipId}/publish`, {
      publishToHttp: true,
      autoStart: false,
    });
    assertHttp(publish, 201, 'gateway publication publish');
    requireCheck(publish.body.publishBinding && publish.body.publishBinding.publishStatus === 'active', 'gateway publish binding is not active');
    requireCheck(publish.body.publishBinding.publishedToHttp === true, 'gateway publish did not target HTTP');
    requireCheck(publish.body.runtimeAsset && publish.body.runtimeAsset.status === 'active', 'gateway runtime asset did not become active');
    gatewayPublishRevision = publish.body.publishBinding.publicationRevision;
    return { httpStatus: publish.status, detail: `publishStatus=${publish.body.publishBinding.publishStatus} publicationRevision=${gatewayPublishRevision}` };
  });

  await step('gateway.binding', 'gateway membership receives an active fixed-primary upstream binding (revision 1)', async () => {
    const binding = await callApi('PUT', `/v1/runtime-memberships/${gatewayMembershipId}/upstream-binding`, {
      sourceServiceAssetId,
      environment: UPSTREAM_ENVIRONMENT,
      selectionMode: 'fixed_primary',
      primaryInstanceId: instanceId,
      status: 'active',
      candidates: [{ sourceServiceInstanceId: instanceId }],
    });
    assertHttp(binding, 200, 'gateway upstream binding upsert');
    requireCheck(binding.body.binding && binding.body.binding.status === 'active', 'gateway upstream binding is not active');
    requireCheck(binding.body.binding.revision === 1, `unexpected initial gateway binding revision ${binding.body.binding.revision}`);
    gatewayBindingId = binding.body.binding.id;
    await delay(1100);
    return { httpStatus: binding.status, detail: `bindingId=${gatewayBindingId} revision=${binding.body.binding.revision} (settled 1.1s for SQLite second-precision timestamps)` };
  });

  let gatewayRevision1;
  await step('gateway.deploy', 'valid gateway candidate verifies against the loopback upstream and activates', async () => {
    const deploy = await callApi('POST', `/v1/runtime-assets/${gatewayAssetId}/deploy-gateway`, { publishedOnly: true });
    assertHttp(deploy, 201, 'gateway candidate deployment');
    const run = deploy.body.verification && deploy.body.verification.run;
    requireCheck(run && run.status === 'passed', `gateway candidate verification did not pass: ${JSON.stringify(deploy.body.verification)}`);
    requireCheck(run.activationStatus === 'activated', `gateway candidate was not activated: ${run.activationStatus}`);
    gatewayRevision1 = run.candidateRevision;
    const asset = await readAsset(gatewayAssetId);
    requireCheck(asset.asset.metadata.activeRevision === gatewayRevision1, `gateway activeRevision mismatch after deploy: ${asset.asset.metadata.activeRevision}`);
    requireCheck(asset.asset.metadata.verificationRequired === false, 'gateway asset still requires verification after activation');
    return { httpStatus: deploy.status, detail: `candidateRevision=${String(gatewayRevision1).slice(0, 12)} activeRevision=${String(asset.asset.metadata.activeRevision).slice(0, 12)} routeCount=${run.passedCount}` };
  });

  let gatewayFingerprint1;
  await step('gateway.serve', 'the activated gateway version serves a real HTTP request through the gateway ingress', async () => {
    const asset = await readAsset(gatewayAssetId);
    gatewayFingerprint1 = asset.asset.metadata.activeGatewaySnapshotFingerprint;
    const callsBefore = upstreamState.received.length;
    const response = await fetchJson(`${apiBase}/api/v1/gateway/${GATEWAY_PREFIX}/ping`, {}, 15000);
    assertHttp(response, 200, 'gateway published route');
    requireCheck(response.body && response.body.pong === true, `gateway route body mismatch: ${JSON.stringify(response.body)}`);
    requireCheck(upstreamState.received.length === callsBefore + 1, 'gateway route did not forward exactly one upstream request');
    requireCheck(upstreamState.received.at(-1).path === '/ping', `gateway forwarded unexpected upstream path ${upstreamState.received.at(-1).path}`);
    return { httpStatus: response.status, detail: `body=${JSON.stringify(response.body)} upstreamPath=/ping fingerprint=${String(gatewayFingerprint1).slice(0, 12)}` };
  });

  let gatewayBindingRevision2;
  await step('gateway.invalidate', 'gateway binding is re-written (revision 2) and governance marks re-verification required', async () => {
    const binding = await callApi('PUT', `/v1/runtime-memberships/${gatewayMembershipId}/upstream-binding`, {
      sourceServiceAssetId,
      environment: UPSTREAM_ENVIRONMENT,
      selectionMode: 'fixed_primary',
      primaryInstanceId: instanceId,
      status: 'active',
      candidates: [{ sourceServiceInstanceId: instanceId }],
    });
    assertHttp(binding, 200, 'gateway upstream binding re-upsert');
    requireCheck(binding.body.binding.revision === 2, `expected gateway binding revision 2, got ${binding.body.binding.revision}`);
    gatewayBindingRevision2 = binding.body.binding.revision;
    const asset = await readAsset(gatewayAssetId);
    requireCheck(asset.asset.metadata.verificationRequired === true, 'gateway invalidation did not set verificationRequired');
    requireCheck(asset.asset.metadata.activeRevision === gatewayRevision1, 'gateway activeRevision changed during invalidation');
    await delay(1100);
    return { httpStatus: binding.status, detail: `bindingRevision=${gatewayBindingRevision2} verificationRequired=true activeRevision=${String(asset.asset.metadata.activeRevision).slice(0, 12)}` };
  });

  let gatewayFailedCandidateRevision;
  await step('gateway.candidate_failure', 'failing gateway candidate (upstream 500) is rejected and does not activate', async () => {
    upstreamState.failureMode = true;
    const deploy = await callApi('POST', `/v1/runtime-assets/${gatewayAssetId}/deploy-gateway`, { publishedOnly: true });
    const failure = failureDetail(deploy);
    requireCheck(deploy.status === 409, `failing gateway candidate returned HTTP ${deploy.status} (expected 409): ${JSON.stringify(responseSummary(deploy))}`);
    requireCheck(failure.envelope && failure.code === 'RUNTIME_VERIFICATION_FAILED', `unexpected failing-candidate code ${failure.code}: ${JSON.stringify(responseSummary(deploy))}`);
    const run = failure.verification && failure.verification.run;
    requireCheck(run && run.status === 'failed', `failing gateway run status is ${run && run.status}`);
    requireCheck(run.activationStatus === 'retained_previous', `failing gateway run activationStatus is ${run.activationStatus}`);
    requireCheck(run.previousActiveRevision === gatewayRevision1, 'failing gateway run does not point at the previous active revision');
    requireCheck(run.failedCount >= 1, `failing gateway run failedCount=${run.failedCount}`);
    requireCheck(run.candidateRevision !== gatewayRevision1, 'failing gateway candidate revision equals the active revision');
    gatewayFailedCandidateRevision = run.candidateRevision;
    const asset = await readAsset(gatewayAssetId);
    requireCheck(asset.asset.metadata.activeRevision === gatewayRevision1, `gateway activeRevision changed after failure: ${asset.asset.metadata.activeRevision}`);
    requireCheck(asset.asset.metadata.activeGatewaySnapshotFingerprint === gatewayFingerprint1, 'gateway active snapshot fingerprint changed after failure');
    return { httpStatus: deploy.status, detail: `candidateRevision=${String(gatewayFailedCandidateRevision).slice(0, 12)} status=failed activationStatus=retained_previous previousActiveRevision=${String(gatewayRevision1).slice(0, 12)}` };
  });

  await step('gateway.previous_serves_during_failure', 'the previous gateway version is still routed while the injected upstream failure is active', async () => {
    const callsBefore = upstreamState.received.length;
    const response = await fetchJson(`${apiBase}/api/v1/gateway/${GATEWAY_PREFIX}/ping`, {}, 15000);
    requireCheck([500, 502, 503].includes(response.status), `expected upstream failure passthrough, got HTTP ${response.status}`);
    requireCheck(upstreamState.received.length === callsBefore + 1, 'previous gateway route did not forward exactly one upstream request during failure');
    return { httpStatus: response.status, detail: `previous active revision ${String(gatewayRevision1).slice(0, 12)} still routed to the upstream and returned the injected failure` };
  });

  await step('gateway.previous_recovers', 'after the upstream recovers, the previous version serves again without any redeploy', async () => {
    upstreamState.failureMode = false;
    const callsBefore = upstreamState.received.length;
    const response = await fetchJson(`${apiBase}/api/v1/gateway/${GATEWAY_PREFIX}/ping`, {}, 15000);
    assertHttp(response, 200, 'gateway route after upstream recovery');
    requireCheck(response.body && response.body.pong === true, `gateway recovery body mismatch: ${JSON.stringify(response.body)}`);
    requireCheck(upstreamState.received.length === callsBefore + 1, 'gateway recovery request did not reach the upstream exactly once');
    const asset = await readAsset(gatewayAssetId);
    requireCheck(asset.asset.metadata.activeRevision === gatewayRevision1, 'gateway activeRevision changed before the retry');
    return { httpStatus: response.status, detail: `previous revision ${String(gatewayRevision1).slice(0, 12)} served after recovery with no redeploy; verificationRequired=${asset.asset.metadata.verificationRequired}` };
  });

  let gatewayRevision2;
  await step('gateway.retry', 'fixed gateway candidate retry passes and switches the active revision', async () => {
    const deploy = await callApi('POST', `/v1/runtime-assets/${gatewayAssetId}/deploy-gateway`, { publishedOnly: true });
    assertHttp(deploy, 201, 'gateway candidate retry');
    const run = deploy.body.verification && deploy.body.verification.run;
    requireCheck(run && run.status === 'passed', `gateway retry verification did not pass: ${JSON.stringify(deploy.body.verification)}`);
    requireCheck(run.candidateRevision === gatewayFailedCandidateRevision, 'gateway retry did not reuse the failed candidate revision');
    requireCheck(run.activationStatus === 'activated', `gateway retry was not activated: ${run.activationStatus}`);
    gatewayRevision2 = run.candidateRevision;
    const asset = await readAsset(gatewayAssetId);
    requireCheck(asset.asset.metadata.activeRevision === gatewayRevision2, 'gateway activeRevision did not switch on retry');
    requireCheck(asset.asset.metadata.verificationRequired === false, 'gateway verificationRequired not cleared after retry');
    return { httpStatus: deploy.status, detail: `candidateRevision=${String(gatewayRevision2).slice(0, 12)} activationStatus=activated activeRevision switched` };
  });

  await step('gateway.serve_after_retry', 'the retried gateway revision serves a real HTTP request', async () => {
    const callsBefore = upstreamState.received.length;
    const response = await fetchJson(`${apiBase}/api/v1/gateway/${GATEWAY_PREFIX}/ping`, {}, 15000);
    assertHttp(response, 200, 'gateway route after retry');
    requireCheck(response.body && response.body.pong === true, `gateway retried route body mismatch: ${JSON.stringify(response.body)}`);
    requireCheck(upstreamState.received.length === callsBefore + 1, 'gateway retried route did not forward exactly one upstream request');
    const asset = await readAsset(gatewayAssetId);
    requireCheck(asset.asset.metadata.activeRevision === gatewayRevision2, 'gateway activeRevision changed after retry serving check');
    return { httpStatus: response.status, detail: `activeRevision=${String(gatewayRevision2).slice(0, 12)} fingerprint=${String(asset.asset.metadata.activeGatewaySnapshotFingerprint).slice(0, 12)}` };
  });

  // ---------------------------------------------------------------------------
  // MCP runtime asset: valid candidate, failing candidate, fixed retry.
  // ---------------------------------------------------------------------------
  let mcpAssetId;
  let mcpMembershipId;
  let mcpBindingId;
  const mcpAssetName = `ext07-mcp-${runSuffix}`;
  await step('mcp.runtime_asset', 'MCP runtime asset draft is created through the real endpoint', async () => {
    const runtimeAsset = await callApi('POST', '/v1/publication/endpoints/runtime-assets', {
      type: 'mcp_server',
      name: mcpAssetName,
      displayName: 'EXT-07 MCP runtime asset',
    });
    assertHttp(runtimeAsset, 201, 'MCP runtime asset create');
    mcpAssetId = runtimeAsset.body.runtimeAsset && runtimeAsset.body.runtimeAsset.id;
    requireCheck(Boolean(mcpAssetId), 'MCP runtime asset create returned no id');
    return { httpStatus: runtimeAsset.status, detail: `runtimeAssetId=${mcpAssetId}` };
  });

  await step('mcp.membership', 'ready endpoint is added as an MCP runtime membership', async () => {
    const membershipResponse = await callApi('POST', `/v1/publication/endpoints/runtime-assets/${mcpAssetId}/memberships`, {
      endpointDefinitionIds: [endpoint.id],
    });
    assertHttp(membershipResponse, 201, 'MCP membership add');
    const membership = membershipResponse.body.createdMemberships && membershipResponse.body.createdMemberships[0];
    requireCheck(Boolean(membership && membership.id), 'MCP membership create returned no id');
    mcpMembershipId = membership.id;
    return { httpStatus: membershipResponse.status, detail: `membershipId=${mcpMembershipId}` };
  });

  await step('mcp.profile', 'MCP publication profile is reviewed', async () => {
    const profile = await callApi('PUT', `/v1/publication/endpoints/runtime-memberships/${mcpMembershipId}/profile`, {
      intentName: 'ext07McpPing',
      descriptionForLlm: 'SEC-EXT-07 loopback MCP ping intent',
      status: 'reviewed',
    });
    assertHttp(profile, 200, 'MCP publication profile upsert');
    requireCheck(profile.body.profile && profile.body.profile.status === 'reviewed', 'MCP profile is not reviewed');
    return { httpStatus: profile.status, detail: `profileId=${profile.body.profile.id}` };
  });

  await step('mcp.binding', 'MCP membership receives an active fixed-primary upstream binding (revision 1)', async () => {
    const binding = await callApi('PUT', `/v1/runtime-memberships/${mcpMembershipId}/upstream-binding`, {
      sourceServiceAssetId,
      environment: UPSTREAM_ENVIRONMENT,
      selectionMode: 'fixed_primary',
      primaryInstanceId: instanceId,
      status: 'active',
      candidates: [{ sourceServiceInstanceId: instanceId }],
    });
    assertHttp(binding, 200, 'MCP upstream binding upsert');
    requireCheck(binding.body.binding && binding.body.binding.status === 'active', 'MCP upstream binding is not active');
    requireCheck(binding.body.binding.revision === 1, `unexpected initial MCP binding revision ${binding.body.binding.revision}`);
    mcpBindingId = binding.body.binding.id;
    await delay(1100);
    return { httpStatus: binding.status, detail: `bindingId=${mcpBindingId} revision=${binding.body.binding.revision}` };
  });

  let mcpPublishRevision;
  await step('mcp.publish', 'MCP membership publishes to MCP and the runtime asset becomes active', async () => {
    const publish = await callApi('POST', `/v1/publication/endpoints/runtime-memberships/${mcpMembershipId}/publish`, {
      publishToMcp: true,
      autoStart: false,
    });
    assertHttp(publish, 201, 'MCP publication publish');
    requireCheck(publish.body.publishBinding && publish.body.publishBinding.publishStatus === 'active', 'MCP publish binding is not active');
    requireCheck(publish.body.publishBinding.publishedToMcp === true, 'MCP publish did not target MCP');
    requireCheck(publish.body.runtimeAsset && publish.body.runtimeAsset.status === 'active', 'MCP runtime asset did not become active');
    mcpPublishRevision = publish.body.publishBinding.publicationRevision;
    return { httpStatus: publish.status, detail: `publishStatus=active publicationRevision=${mcpPublishRevision}` };
  });

  await step('mcp.credential', 'synthetic MCP consumer credential is issued through the runtime asset endpoint', async () => {
    const issued = await callApi('POST', `/v1/runtime-assets/${mcpAssetId}/runtime-access-credentials`, {
      name: 'ext07-mcp-consumer',
      keyId: mcpKeyId,
      subject: 'ext07-mcp-subject',
      protocols: ['mcp'],
      toolScopes: ['*'],
      scopes: [],
    });
    assertHttp(issued, 201, 'MCP credential create');
    mcpApiKey = issued.body.apiKey;
    requireCheck(typeof mcpApiKey === 'string' && mcpApiKey.startsWith(`${mcpKeyId}.`), 'MCP credential apiKey was not returned once in keyId.secret form');
    secrets.push(mcpApiKey);
    return { httpStatus: issued.status, detail: `keyId=${mcpKeyId} credentialId=${issued.body.credential.id}` };
  });

  let mcpManagedServerId;
  await step('mcp.preview', 'MCP endpoint preview resolves the loopback consumer URL', async () => {
    const preview = await callApi('POST', `/v1/runtime-assets/${mcpAssetId}/mcp-endpoint-preview`, {
      transport: 'streamable',
      port: evidence.ports.managedChild,
      endpointPath: MCP_ENDPOINT,
      inboundAuthMode: 'private_api_key',
    });
    assertHttp(preview, 201, 'MCP endpoint preview');
    requireCheck(preview.body.consumerUrl === `http://127.0.0.1:${evidence.ports.managedChild}${MCP_ENDPOINT}`, `unexpected preview consumerUrl ${preview.body.consumerUrl}`);
    return { httpStatus: preview.status, detail: `consumerUrl=${preview.body.consumerUrl} portMode=${preview.body.portMode}` };
  });

  let mcpRevision1;
  await step('mcp.deploy', 'valid MCP candidate verifies against the loopback upstream and activates', async () => {
    const deploy = await callApi('POST', `/v1/runtime-assets/${mcpAssetId}/deploy-mcp`, {
      port: evidence.ports.managedChild,
      transport: 'streamable',
      endpointPath: MCP_ENDPOINT,
      inboundAuthMode: 'private_api_key',
      autoStart: false,
    }, {}, 60000);
    assertHttp(deploy, 201, 'MCP candidate deployment');
    const run = deploy.body.verification && deploy.body.verification.run;
    requireCheck(run && run.status === 'passed', `MCP candidate verification did not pass: ${JSON.stringify(deploy.body.verification)}`);
    const activation = deploy.body.verification && deploy.body.verification.activation;
    requireCheck(activation && activation.run && activation.run.activationStatus === 'activated', `MCP candidate was not activated: ${JSON.stringify({ run: run && run.activationStatus, activation: activation && activation.run && activation.run.activationStatus })}`);
    mcpRevision1 = run.candidateRevision;
    mcpManagedServerId = deploy.body.managedServer && deploy.body.managedServer.id;
    requireCheck(Boolean(mcpManagedServerId), 'MCP deploy did not create a managed server record');
    const asset = await readAsset(mcpAssetId);
    requireCheck(asset.asset.metadata.activeRevision === mcpRevision1, `MCP activeRevision mismatch after deploy: ${asset.asset.metadata.activeRevision}`);
    requireCheck(asset.asset.metadata.verificationRequired === false, 'MCP asset still requires verification after activation');
    return { httpStatus: deploy.status, detail: `candidateRevision=${String(mcpRevision1).slice(0, 12)} managedServerId=${mcpManagedServerId} toolsCount=${deploy.body.toolsCount}` };
  });

  async function startMcpServer(label) {
    const start = await callApi('POST', `/v1/runtime-assets/${mcpAssetId}/start`, {}, {}, 60000);
    assertHttp(start, 201, label);
    requireCheck(start.body.managedServer && start.body.managedServer.status === 'running', `${label}: managed server status is ${start.body.managedServer && start.body.managedServer.status}`);
    await waitFor(`${label}: MCP child health`, async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${evidence.ports.managedChild}/health`, { signal: AbortSignal.timeout(1500) });
        await response.arrayBuffer();
        return response.status === 200;
      } catch { return false; }
    }, 45000, 300);
    await waitFor(`${label}: authenticated spec callback`, async () => proxyState.specRequests.some(request => request.injected), 20000, 200);
    return start;
  }

  let mcpToolName;
  await step('mcp.start', 'managed MCP child starts and fetches the published spec through the authenticated callback', async () => {
    const start = await startMcpServer('MCP start');
    const specRequest = proxyState.specRequests.find(request => request.injected);
    requireCheck(specRequest.childAuthorization === null, 'MCP child unexpectedly sent its own management authorization');
    return { httpStatus: start.status, detail: `managedServerId=${start.body.managedServer.id} status=running port=${evidence.ports.managedChild} specCallback=${specRequest.path}` };
  });

  await step('mcp.serve', 'the activated MCP version serves a real authenticated SDK list/call', async () => {
    const result = await withMcpClient(mcpApiKey, async client => {
      const listed = await client.listTools();
      requireCheck(Array.isArray(listed.tools) && listed.tools.length > 0, 'MCP listTools returned no tools');
      mcpToolName = listed.tools[0].name;
      const callsBefore = upstreamState.received.length;
      const call = await client.callTool({ name: mcpToolName, arguments: {} });
      requireCheck(call.isError !== true, `MCP tool call failed: ${JSON.stringify(call).slice(0, 300)}`);
      return { toolNames: listed.tools.map(tool => tool.name), callsBefore };
    });
    requireCheck(upstreamState.received.length === result.callsBefore + 1, 'MCP tool call did not reach the upstream exactly once');
    requireCheck(upstreamState.received.at(-1).path === '/ping', `MCP tool call reached unexpected upstream path ${upstreamState.received.at(-1).path}`);
    return { detail: `tools=${result.toolNames.join(',')} called=${mcpToolName} upstreamPath=/ping` };
  });

  let mcpBindingRevision2;
  await step('mcp.invalidate', 'MCP binding is re-written (revision 2) and governance marks re-verification required', async () => {
    const binding = await callApi('PUT', `/v1/runtime-memberships/${mcpMembershipId}/upstream-binding`, {
      sourceServiceAssetId,
      environment: UPSTREAM_ENVIRONMENT,
      selectionMode: 'fixed_primary',
      primaryInstanceId: instanceId,
      status: 'active',
      candidates: [{ sourceServiceInstanceId: instanceId }],
    });
    assertHttp(binding, 200, 'MCP upstream binding re-upsert');
    requireCheck(binding.body.binding.revision === 2, `expected MCP binding revision 2, got ${binding.body.binding.revision}`);
    mcpBindingRevision2 = binding.body.binding.revision;
    const asset = await readAsset(mcpAssetId);
    requireCheck(asset.asset.metadata.verificationRequired === true, 'MCP invalidation did not set verificationRequired');
    requireCheck(asset.asset.metadata.activeRevision === mcpRevision1, 'MCP activeRevision changed during invalidation');
    await delay(1100);
    return { httpStatus: binding.status, detail: `bindingRevision=${mcpBindingRevision2} verificationRequired=true activeRevision=${String(asset.asset.metadata.activeRevision).slice(0, 12)}` };
  });

  let mcpFailedCandidateRevision;
  await step('mcp.candidate_failure', 'failing MCP candidate (upstream 500) is rejected and does not activate', async () => {
    upstreamState.failureMode = true;
    const deploy = await callApi('POST', `/v1/runtime-assets/${mcpAssetId}/deploy-mcp`, {
      targetServerId: mcpManagedServerId,
      port: evidence.ports.managedChild,
      transport: 'streamable',
      endpointPath: MCP_ENDPOINT,
      inboundAuthMode: 'private_api_key',
      autoStart: false,
    }, {}, 60000);
    const failure = failureDetail(deploy);
    requireCheck(deploy.status === 409, `failing MCP candidate returned HTTP ${deploy.status} (expected 409): ${JSON.stringify(responseSummary(deploy))}`);
    requireCheck(failure.envelope && failure.code === 'RUNTIME_VERIFICATION_FAILED', `unexpected failing-candidate code ${failure.code}: ${JSON.stringify(responseSummary(deploy))}`);
    const run = failure.verification && failure.verification.run;
    requireCheck(run && run.status === 'failed', `failing MCP run status is ${run && run.status}`);
    requireCheck(run.activationStatus === 'retained_previous', `failing MCP run activationStatus is ${run.activationStatus}`);
    requireCheck(run.previousActiveRevision === mcpRevision1, 'failing MCP run does not point at the previous active revision');
    requireCheck(run.failedCount >= 1, `failing MCP run failedCount=${run.failedCount}`);
    requireCheck(run.candidateRevision !== mcpRevision1, 'failing MCP candidate revision equals the active revision');
    mcpFailedCandidateRevision = run.candidateRevision;
    const asset = await readAsset(mcpAssetId);
    requireCheck(asset.asset.metadata.activeRevision === mcpRevision1, `MCP activeRevision changed after failure: ${asset.asset.metadata.activeRevision}`);
    requireCheck(asset.asset.metadata.managedServerId === mcpManagedServerId, 'MCP managed server binding changed after failure');
    requireCheck(asset.managedServer && asset.managedServer.id === mcpManagedServerId && asset.managedServer.port === evidence.ports.managedChild, 'MCP managed server record was partially modified by the failing candidate');
    return { httpStatus: deploy.status, detail: `candidateRevision=${String(mcpFailedCandidateRevision).slice(0, 12)} status=failed activationStatus=retained_previous previousActiveRevision=${String(mcpRevision1).slice(0, 12)} managedServerId=${mcpManagedServerId}` };
  });

  await step('mcp.previous_serves_during_failure', 'the previous MCP version is still running and answers authenticated requests during the injected failure', async () => {
    const callsBefore = upstreamState.received.length;
    let failureObserved = false;
    let detail = '';
    try {
      const result = await withMcpClient(mcpApiKey, client => client.callTool({ name: mcpToolName, arguments: {} }), 25000);
      failureObserved = Boolean(result && result.isError === true);
      detail = `callTool isError=${result && result.isError}`;
    } catch (error) {
      failureObserved = true;
      detail = `callTool rejected: ${sanitizedError(error)}`;
    }
    requireCheck(failureObserved, 'previous MCP version unexpectedly reported success while the upstream was failing');
    requireCheck(upstreamState.received.length === callsBefore + 1, 'previous MCP version did not reach the upstream exactly once during failure');
    const asset = await readAsset(mcpAssetId);
    requireCheck(asset.asset.metadata.activeRevision === mcpRevision1, 'MCP activeRevision changed during the previous-version check');
    return { detail: `${detail}; previous revision ${String(mcpRevision1).slice(0, 12)} still running` };
  });

  await step('mcp.previous_recovers', 'after the upstream recovers, the previous MCP version serves again without any redeploy', async () => {
    upstreamState.failureMode = false;
    const callsBefore = upstreamState.received.length;
    const call = await withMcpClient(mcpApiKey, client => client.callTool({ name: mcpToolName, arguments: {} }), 25000);
    requireCheck(call.isError !== true, `previous MCP version did not recover: ${JSON.stringify(call).slice(0, 300)}`);
    requireCheck(upstreamState.received.length === callsBefore + 1, 'MCP recovery call did not reach the upstream exactly once');
    const asset = await readAsset(mcpAssetId);
    requireCheck(asset.asset.metadata.activeRevision === mcpRevision1, 'MCP activeRevision changed before the retry');
    return { detail: `previous revision ${String(mcpRevision1).slice(0, 12)} served after recovery with no redeploy; verificationRequired=${asset.asset.metadata.verificationRequired}` };
  });

  let mcpRevision2;
  await step('mcp.retry', 'fixed MCP candidate retry (redeploy) passes and switches the active revision', async () => {
    const redeploy = await callApi('POST', `/v1/runtime-assets/${mcpAssetId}/redeploy`, {
      targetServerId: mcpManagedServerId,
      port: evidence.ports.managedChild,
      transport: 'streamable',
      endpointPath: MCP_ENDPOINT,
      inboundAuthMode: 'private_api_key',
    }, {}, 90000);
    assertHttp(redeploy, 201, 'MCP candidate redeploy');
    const run = redeploy.body.verification && redeploy.body.verification.run;
    requireCheck(run && run.status === 'passed', `MCP retry verification did not pass: ${JSON.stringify(redeploy.body.verification)}`);
    requireCheck(run.candidateRevision === mcpFailedCandidateRevision, 'MCP retry did not reuse the failed candidate revision');
    const activation = redeploy.body.verification && redeploy.body.verification.activation;
    requireCheck(activation && activation.run && activation.run.activationStatus === 'activated', `MCP retry was not activated: ${JSON.stringify({ run: run && run.activationStatus, activation: activation && activation.run && activation.run.activationStatus })}`);
    mcpRevision2 = run.candidateRevision;
    await waitFor('MCP child health after redeploy', async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${evidence.ports.managedChild}/health`, { signal: AbortSignal.timeout(1500) });
        await response.arrayBuffer();
        return response.status === 200;
      } catch { return false; }
    }, 45000, 300);
    const asset = await readAsset(mcpAssetId);
    requireCheck(asset.asset.metadata.activeRevision === mcpRevision2, 'MCP activeRevision did not switch on retry');
    requireCheck(asset.asset.metadata.verificationRequired === false, 'MCP verificationRequired not cleared after retry');
    return { httpStatus: redeploy.status, detail: `candidateRevision=${String(mcpRevision2).slice(0, 12)} activationStatus=activated managedServerStatus=${redeploy.body.managedServer && redeploy.body.managedServer.status}` };
  });

  await step('mcp.serve_after_retry', 'the retried MCP revision serves a real authenticated SDK call', async () => {
    const result = await withMcpClient(mcpApiKey, async client => {
      const listed = await client.listTools();
      requireCheck(listed.tools.length > 0, 'MCP listTools returned no tools after retry');
      const callsBefore = upstreamState.received.length;
      const call = await client.callTool({ name: listed.tools[0].name, arguments: {} });
      requireCheck(call.isError !== true, `MCP tool call failed after retry: ${JSON.stringify(call).slice(0, 300)}`);
      return { callsBefore };
    });
    requireCheck(upstreamState.received.length === result.callsBefore + 1, 'MCP retried call did not reach the upstream exactly once');
    const asset = await readAsset(mcpAssetId);
    requireCheck(asset.asset.metadata.activeRevision === mcpRevision2, 'MCP activeRevision changed after retry serving check');
    return { detail: `activeRevision=${String(mcpRevision2).slice(0, 12)} tool=${mcpToolName} upstreamPath=/ping` };
  });

  evidence.identity = {
    documentId: document.body.id,
    endpointDefinitionId: endpoint.id,
    sourceServiceAssetId,
    sourceServiceInstanceId: instanceId,
    testSampleId: sampleId,
    gateway: {
      runtimeAssetId: gatewayAssetId,
      runtimeAssetName: gatewayAssetName,
      membershipId: gatewayMembershipId,
      upstreamBindingId: gatewayBindingId,
      routeBindingId: gatewayRouteId,
      publishRevision: gatewayPublishRevision,
      activeRevision1: gatewayRevision1,
      failedCandidateRevision: gatewayFailedCandidateRevision,
      activeRevision2: gatewayRevision2,
    },
    mcp: {
      runtimeAssetId: mcpAssetId,
      runtimeAssetName: mcpAssetName,
      membershipId: mcpMembershipId,
      upstreamBindingId: mcpBindingId,
      publishRevision: mcpPublishRevision,
      managedServerId: mcpManagedServerId,
      credentialKeyId: mcpKeyId,
      toolName: mcpToolName,
      activeRevision1: mcpRevision1,
      failedCandidateRevision: mcpFailedCandidateRevision,
      activeRevision2: mcpRevision2,
    },
  };

  // ---------------------------------------------------------------------------
  // API restart / readback consistency on the isolated database.
  // ---------------------------------------------------------------------------
  await step('restart.stop_api', 'API is stopped; the managed MCP child and the gateway in-memory registry are gone', async () => {
    await stopApiProcess();
    await waitFor('managed MCP child stop', async () => {
      try {
        await fetch(`http://127.0.0.1:${evidence.ports.managedChild}/health`, { signal: AbortSignal.timeout(1000) });
        return false;
      } catch { return true; }
    }, 20000, 300);
    return { detail: `api port ${apiPort} and managed child port ${evidence.ports.managedChild} are unreachable` };
  });

  await step('restart.start_api', 'API restarts against the same isolated database and re-authenticates', async () => {
    api = startApiProcess();
    await waitFor('API readiness after restart', async () => {
      const ready = await fetchJson(`${apiBase}/api/health/ready`, {}, 5000);
      return ready.status === 200 && ready.body && ready.body.status === 'ready';
    }, 90000);
    loginResponse = await login();
    return { httpStatus: 200, detail: `pid=${api.child.pid} log=${api.stdoutPath} reauthenticated=true` };
  });

  await step('restart.readback', 'active revisions and verification flags survive the API restart', async () => {
    const gatewayAsset = await readAsset(gatewayAssetId);
    const mcpAsset = await readAsset(mcpAssetId);
    requireCheck(gatewayAsset.asset.metadata.activeRevision === gatewayRevision2, `gateway activeRevision lost after restart: ${gatewayAsset.asset.metadata.activeRevision}`);
    requireCheck(gatewayAsset.asset.metadata.verificationRequired === false, 'gateway verificationRequired set after restart');
    requireCheck(mcpAsset.asset.metadata.activeRevision === mcpRevision2, `MCP activeRevision lost after restart: ${mcpAsset.asset.metadata.activeRevision}`);
    requireCheck(mcpAsset.asset.metadata.verificationRequired === false, 'MCP verificationRequired set after restart');
    requireCheck(mcpAsset.asset.metadata.managedServerId === mcpManagedServerId, 'MCP managedServerId lost after restart');
    return { detail: `gateway activeRevision=${String(gatewayRevision2).slice(0, 12)}; MCP activeRevision=${String(mcpRevision2).slice(0, 12)}` };
  });

  await step('restart.gateway_serve', 'gateway snapshot is restored from the isolated database and serves after restart', async () => {
    const callsBefore = upstreamState.received.length;
    const response = await fetchJson(`${apiBase}/api/v1/gateway/${GATEWAY_PREFIX}/ping`, {}, 15000);
    assertHttp(response, 200, 'gateway route after API restart');
    requireCheck(response.body && response.body.pong === true, `gateway post-restart body mismatch: ${JSON.stringify(response.body)}`);
    requireCheck(upstreamState.received.length === callsBefore + 1, 'gateway post-restart route did not forward exactly one upstream request');
    return { httpStatus: response.status, detail: 'persisted gateway snapshot reloaded and served the retried revision' };
  });

  await step('restart.mcp_start', 'managed MCP child is started again through the verified runtime-asset flow', async () => {
    const start = await startMcpServer('MCP restart start');
    const asset = await readAsset(mcpAssetId);
    requireCheck(asset.asset.metadata.activeRevision === mcpRevision2, 'MCP activeRevision changed during post-restart start');
    return { httpStatus: start.status, detail: `managedServerId=${start.body.managedServer.id} status=running activeRevision=${String(mcpRevision2).slice(0, 12)}` };
  });

  await step('restart.mcp_serve', 'the retried MCP revision serves a real authenticated SDK call after restart', async () => {
    const result = await withMcpClient(mcpApiKey, async client => {
      const listed = await client.listTools();
      requireCheck(listed.tools.length > 0, 'MCP listTools returned no tools after restart');
      const callsBefore = upstreamState.received.length;
      const call = await client.callTool({ name: listed.tools[0].name, arguments: {} });
      requireCheck(call.isError !== true, `MCP tool call failed after restart: ${JSON.stringify(call).slice(0, 300)}`);
      return { callsBefore };
    });
    requireCheck(upstreamState.received.length === result.callsBefore + 1, 'MCP post-restart call did not reach the upstream exactly once');
    return { detail: `tool=${mcpToolName} served after restart on activeRevision=${String(mcpRevision2).slice(0, 12)}` };
  });

  evidence.finishedAt = new Date().toISOString();
}

async function finalize(ok) {
  if (finished) return;
  finished = true;
  const apiLogSnapshot = currentApi ? { stdout: currentApi.stdoutPath, stderr: currentApi.stderrPath } : null;
  if (token) {
    for (const assetId of [evidence.identity && evidence.identity.mcp && evidence.identity.mcp.runtimeAssetId].filter(Boolean)) {
      try { await callApi('POST', `/v1/runtime-assets/${assetId}/stop`, {}, {}, 20000); } catch { /* best effort */ }
    }
  }
  await stopApiProcess();
  if (proxyState) await proxyState.close().catch(() => undefined);
  if (upstreamState) await upstreamState.close().catch(() => undefined);
  evidence.ok = ok;
  evidence.finishedAt = evidence.finishedAt || new Date().toISOString();
  evidence.failures = failures;
  evidence.upstreamHits = upstreamState ? upstreamState.received.length : 0;
  evidence.apiLogs = apiLogSnapshot ? { ...apiLogSnapshot, tail: readTail(apiLogSnapshot.stdout, 12) } : null;
  evidence.portsReleased = {
    api: await unreachable(`${apiBase}/api/health/ready`, 1000),
    mcp: await unreachable(`http://127.0.0.1:${mcpPort}/health`, 1000),
    managedChild: await unreachable(`http://127.0.0.1:${evidence.ports.managedChild}/health`, 1000),
  };
  try {
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    fs.writeFileSync(runLogPath, consoleLog);
  } catch (error) {
    console.error(`[ext-07] failed to write evidence: ${redact(error.message)}`);
  }
  if (ok) {
    console.log(`EXT_07_VERIFY_OK ${JSON.stringify({ workPackage: 'SEC-EXT-07', steps: steps.map(item => ({ id: item.id, ok: item.ok, informational: item.informational || false })), notCovered, evidence: evidencePath, ports: { api: apiPort, mcp: mcpPort, managedChild: evidence.ports.managedChild } })}`);
  } else {
    console.error(`EXT_07_VERIFY_FAILED ${JSON.stringify({ workPackage: 'SEC-EXT-07', failures, evidence: evidencePath })}`);
    process.exitCode = 1;
  }
}

main().then(() => finalize(true), error => {
  console.error(`[ext-07] ${sanitizedError(error)}`);
  if (!steps.some(item => item.ok === false)) {
    record('chain', 'unexpected failure outside a recorded step', false, { detail: sanitizedError(error) });
  }
  return finalize(false);
});
