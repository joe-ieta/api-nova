// SEC-EXT-08 raw-environment verification runner (Windows, loopback only).
'use strict';
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const repository = path.resolve(__dirname, '..');
const apiDir = path.join(repository, 'packages/api-nova-api');
const apiEntry = path.join(apiDir, 'dist', 'src', 'main.js');
const fixturePath = path.join(repository, 'examples', 'minimal-openapi.json');
const workDir = process.env.EXT08_WORK_DIR || 'E:\\temp\\opencode\\ext-08';
const logsDir = path.join(workDir, 'logs');
const evidenceDir = path.join(workDir, 'evidence');
const evidencePath = path.join(evidenceDir, 'ext-08-evidence.json');
const dbPath = path.join(workDir, 'api_nova_ext08.db');
const apiPort = Number(process.env.EXT08_API_PORT || 9011);
const uiPort = Number(process.env.EXT08_UI_PORT || 5181);
const apiBase = `http://127.0.0.1:${apiPort}`;
const uiBase = `http://127.0.0.1:${uiPort}`;
const notCovered = [
  'real browser clicks/screenshots: not performed; the same flows were exercised over HTTP through the Vite dev proxy',
  'managed MCP child process start and a real MCP client session (EXT-06): not performed; deploy-mcp activated a candidate with autoStart=false',
  'external/non-loopback upstreams, production identity providers and real credentials: out of scope',
  'Linux and PostgreSQL runtime lanes: not exercised',
  'Vite dev server only: no production UI build/preview/package artifact was started',
  'full /health reported 503 for the host disk threshold; /api/health/ready=ready is the gating readiness signal (see evidence.startup.fullHealth)',
];

const steps = [];
const failures = [];
const secrets = [];
const children = [];
const evidence = {
  marker: 'EXT_08_EVIDENCE_V1',
  workPackage: 'SEC-EXT-08',
  startedAt: new Date().toISOString(),
  environment: { platform: process.platform, release: os.release(), arch: process.arch, node: process.version },
  ports: { api: apiPort, ui: uiPort },
  database: { path: dbPath, mode: 'sqlite (sql.js)', isolated: true },
  notCovered,
  notes: [],
  steps,
};
let token;
let upstream;
let finished = false;

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
function log(message) {
  console.log(`[ext-08] ${redact(message)}`);
}
function record(id, description, ok, details = {}) {
  const entry = { id, description, ok, at: new Date().toISOString(), ...details };
  steps.push(entry);
  log(`${ok ? 'PASS' : 'FAIL'} ${id}${entry.httpStatus !== undefined ? ` http=${entry.httpStatus}` : ''}${entry.detail ? ` :: ${entry.detail}` : ''}`);
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
function parseEnvText(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    out[match[1]] = value;
  }
  return out;
}
function sanitizedError(error) {
  const status = error && error.status !== undefined ? `status=${error.status} ` : '';
  const message = error && error.message ? error.message : String(error);
  return redact(`${status}${message}`).slice(0, 500);
}
function responseSummary(response) {
  const body = response.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    if (body.success === false && body.error) {
      return { code: body.error.code, message: redact(JSON.stringify(body.error.message ?? body.error)).slice(0, 300) };
    }
    return Object.fromEntries(Object.keys(body).slice(0, 12).map(key => [key, Array.isArray(body[key]) ? `[array ${body[key].length}]` : typeof body[key]]));
  }
  return { bodyType: typeof body };
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
async function callApi(method, requestPath, body, extraHeaders = {}) {
  const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders };
  const init = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return fetchJson(`${uiBase}/api${requestPath}`, init);
}
function assertHttp(response, expected, label) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  requireCheck(allowed.includes(response.status), `${label} returned HTTP ${response.status} (expected ${allowed.join('/')}): ${JSON.stringify(responseSummary(response))}`);
}
function waitForExit(child, timeoutMs) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
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
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
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
function startApiProcess() {
  const stdoutPath = path.join(logsDir, 'api-stdout.log');
  const stderrPath = path.join(logsDir, 'api-stderr.log');
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(apiPort),
    MCP_PORT: String(apiPort + 100),
    MCP_SERVER_PORT: String(apiPort + 100),
    DB_TYPE: 'sqlite',
    DB_SQLITE_PATH: dbPath,
    DB_LOGGING: 'false',
    LOG_DIRECTORY: path.join(workDir, 'runtime-logs'),
    PID_DIRECTORY: path.join(workDir, 'pids'),
    API_NOVA_AUDIT_DIR: path.join(workDir, 'audit'),
  };
  const child = spawn(process.execPath, [apiEntry], {
    cwd: apiDir,
    env,
    stdio: ['ignore', fs.openSync(stdoutPath, 'w'), fs.openSync(stderrPath, 'w')],
    windowsHide: true,
  });
  return { child, stdoutPath, stderrPath };
}
function startUiProcess() {
  const stdoutPath = path.join(logsDir, 'ui-stdout.log');
  const stderrPath = path.join(logsDir, 'ui-stderr.log');
  const env = { ...process.env, VITE_PROXY_TARGET: apiBase };
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm run dev --workspace api-nova-ui -- --port ${uiPort} --strictPort`], {
    cwd: repository,
    env,
    stdio: ['ignore', fs.openSync(stdoutPath, 'w'), fs.openSync(stderrPath, 'w')],
    windowsHide: true,
  });
  return { child, stdoutPath, stderrPath };
}
function runMigration() {
  const logPath = path.join(logsDir, 'migration-run.log');
  const env = { ...process.env, NODE_ENV: 'development', DB_TYPE: 'sqlite', DB_SQLITE_PATH: dbPath };
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run migration:run --workspace api-nova-api'], {
    cwd: repository,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300000,
    maxBuffer: 64 * 1024 * 1024,
  });
  fs.writeFileSync(logPath, stripAnsi(`${result.stdout || ''}\n${result.stderr || ''}`));
  return { status: result.status, logPath };
}
function startUpstream(fixture) {
  const server = http.createServer((request, response) => {
    if (request.url === '/openapi.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify(fixture));
    }
    if (request.url === '/ping') {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ pong: true }));
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ service: 'ext-08-loopback-upstream' }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8', windowsHide: true }).stdout.trim();
  evidence.environment.commit = commit;
  log(`repository=${repository} commit=${commit.slice(0, 12)} workDir=${workDir}`);

  await step('preflight', 'built API entry, fixture, .env and isolated ports are available', async () => {
    requireCheck(fs.existsSync(apiEntry), `built API entry missing: ${apiEntry}; build api-nova-api first (no rebuild is attempted here)`);
    requireCheck(fs.existsSync(fixturePath), `fixture missing: ${fixturePath}`);
    requireCheck(fs.existsSync(path.join(apiDir, '.env')), 'packages/api-nova-api/.env is required for JWT/seed configuration');
    for (const port of [apiPort, uiPort]) {
      requireCheck(await portFree(port), `port ${port} is already in use; EXT-08 requires the isolated ports ${apiPort}/${uiPort}`);
    }
    evidence.artifact = {
      apiEntry,
      apiEntryBytes: fs.statSync(apiEntry).size,
      apiEntryMtime: fs.statSync(apiEntry).mtime.toISOString(),
      uiDevServer: 'vite dev (packages/api-nova-ui, no production build)',
    };
    return { detail: `ports ${apiPort}/${uiPort} free; commit ${commit.slice(0, 12)}` };
  });

  let migration;
  await step('migration', 'npm run migration:run --workspace api-nova-api against the isolated SQLite database', async () => {
    migration = runMigration();
    requireCheck(migration.status === 0, `migration:run failed with exit ${migration.status}; tail: ${readTail(migration.logPath, 20)}`);
    evidence.database.migrationLog = migration.logPath;
    return { detail: `exit=0 log=${migration.logPath}` };
  });

  const api = startApiProcess();
  children.push(api.child);
  let ui;
  await step('api.start', 'API process starts and reports /api/health/ready=ready on the isolated port', async () => {
    await waitFor('API readiness', async () => {
      const ready = await fetchJson(`${apiBase}/api/health/ready`, {}, 5000);
      return ready.status === 200 && ready.body && ready.body.status === 'ready';
    }, 90000);
    return { httpStatus: 200, detail: `pid=${api.child.pid} port=${apiPort} log=${api.stdoutPath}` };
  });

  await step('api.health.full', 'raw full /health response captured (informationally; host disk threshold) and startup log captured', async () => {
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
        startupLogEvidence: readTail(api.stdoutPath, 6),
      },
    };
    return { httpStatus: fullHealth.status, informational: true, detail: `failedChecks=${JSON.stringify(failedChecks)}; readiness gate is /api/health/ready` };
  });

  await step('ui.start', 'Vite dev server starts on the isolated UI port and serves index html', async () => {
    ui = startUiProcess();
    children.push(ui.child);
    await waitFor('UI dev server', async () => {
      const root = await fetchJson(`${uiBase}/`, {}, 5000);
      return root.status === 200 && typeof root.body === 'string' && root.body.includes('id="app"');
    }, 60000);
    evidence.startup.ui = { pid: ui.child.pid, stdout: ui.stdoutPath, stderr: ui.stderrPath, proxyTarget: apiBase, rootStatus: 200 };
    return { httpStatus: 200, detail: `pid=${ui.child.pid} port=${uiPort} proxy=${apiBase}` };
  });

  await step('ui.proxy', '/api on the UI dev server proxies to the isolated API port', async () => {
    const proxyReady = await fetchJson(`${uiBase}/api/health/ready`, {}, 10000);
    assertHttp(proxyReady, 200, 'UI /api proxy to the isolated API');
    return { httpStatus: proxyReady.status, detail: proxyReady.body && proxyReady.body.status };
  });

  await step('ui.spa_routes', 'key SPA routes return HTTP 200 index html from the dev server', async () => {
    const routes = ['/', '/login', '/registration/batch', '/registration/manual', '/testing', '/governance', '/publication', '/runtime-assets', '/config', '/monitoring', '/logs'];
    const informationalRoutes = new Set(['/monitoring']);
    const results = [];
    for (const route of routes) {
      const response = await fetchJson(`${uiBase}${route}`, {}, 15000);
      const html = typeof response.body === 'string' ? response.body : '';
      results.push({ route, status: response.status, ok: response.status === 200 && html.includes('id="app"'), informational: informationalRoutes.has(route) });
    }
    evidence.spaRoutes = results;
    const failed = results.filter(item => !item.ok && !item.informational);
    const informationalFailed = results.filter(item => !item.ok && item.informational);
    if (informationalFailed.length > 0) {
      evidence.notes.push(`SPA route(s) ${informationalFailed.map(item => item.route).join(',')} returned HTTP ${informationalFailed.map(item => item.status).join(',')} from the Vite dev server because the pre-existing /monitoring proxy rule forwards to the API, which has no root /monitoring route; excluded from the gate (environment/dev-proxy behavior, not changed by SEC-EXT-08)`);
    }
    requireCheck(failed.length === 0, `SPA routes failed: ${JSON.stringify(failed)}`);
    return { detail: `${results.length - results.filter(item => !item.ok).length}/${results.length} routes ok${informationalFailed.length ? `; informational: ${informationalFailed.map(item => item.route).join(',')}` : ''}` };
  });

  await step('auth.login', 'seeded super admin authenticates through the real login endpoint', async () => {
    const env = parseEnvText(fs.readFileSync(path.join(apiDir, '.env'), 'utf8'));
    const adminLogin = env.SUPER_ADMIN_USERNAME || env.SUPER_ADMIN_EMAIL;
    const adminPassword = env.SUPER_ADMIN_PASSWORD;
    requireCheck(Boolean(adminLogin && adminPassword), 'SUPER_ADMIN_USERNAME/EMAIL/PASSWORD missing from packages/api-nova-api/.env');
    secrets.push(adminPassword);
    const login = await fetchJson(`${uiBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: adminLogin, password: adminPassword }),
    });
    assertHttp(login, 200, 'super admin login through the UI proxy');
    token = login.body && login.body.accessToken;
    requireCheck(Boolean(token), 'login response did not contain an access token');
    secrets.push(token);
    const roleNames = (login.body.user && login.body.user.roles ? login.body.user.roles : [])
      .map(role => role && role.name).filter(Boolean);
    evidence.login = { endpoint: '/api/auth/login via the UI proxy', status: login.status, subject: 'seeded_super_admin', roleNames };
    return { httpStatus: login.status, detail: `roles=${roleNames.join(',')}` };
  });

  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  upstream = await startUpstream(fixture);
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const upstreamPort = upstream.address().port;
  fixture.servers = [{ url: upstreamUrl }];
  evidence.upstream = { url: upstreamUrl, loopbackOnly: true, fixture: 'examples/minimal-openapi.json', rewrite: 'servers[0].url replaced with the ephemeral loopback fixture origin' };
  log(`loopback upstream fixture at ${upstreamUrl}`);

  await step('import.upload', 'multipart OpenAPI import parses endpoints and MCP tools', async () => {
    const form = new FormData();
    form.append('file', new Blob([JSON.stringify(fixture, null, 2)], { type: 'application/json' }), 'minimal-openapi.json');
    const upload = await fetchJson(`${uiBase}/api/openapi/upload`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form }, 30000);
    assertHttp(upload, 200, 'OpenAPI upload import');
    const endpointCount = upload.body && upload.body.endpoints ? upload.body.endpoints.length : 0;
    const toolCount = upload.body && upload.body.tools ? upload.body.tools.length : 0;
    requireCheck(endpointCount > 0 && toolCount > 0, 'uploaded OpenAPI document produced no endpoints/tools');
    return { httpStatus: upload.status, detail: `endpoints=${endpointCount} tools=${toolCount}` };
  });

  await step('import.parse_url', 'OpenAPI import from a loopback URL parses endpoints', async () => {
    const parseUrl = await fetchJson(`${uiBase}/api/openapi/parse-url?url=${encodeURIComponent(`${upstreamUrl}/openapi.json`)}`, { headers: { authorization: `Bearer ${token}` } }, 30000);
    assertHttp(parseUrl, 200, 'OpenAPI parse from loopback URL');
    const endpointCount = parseUrl.body && parseUrl.body.endpoints ? parseUrl.body.endpoints.length : 0;
    requireCheck(endpointCount > 0, 'URL parse produced no endpoints');
    return { httpStatus: parseUrl.status, detail: `endpoints=${endpointCount}` };
  });

  const runSuffix = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const documentName = `ext08-loopback-${runSuffix}`;
  let document;
  await step('import.document', 'real documents import endpoint persists the spec and converts it into asset endpoints', async () => {
    document = await callApi('POST', '/documents', {
      name: documentName,
      description: 'SEC-EXT-08 isolated interactive import',
      content: JSON.stringify(fixture),
      status: 'valid',
      version: '1.0.0',
      metadata: { importSource: 'url', originalUrl: `${upstreamUrl}/openapi.json` },
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
      name: `ext08-loopback-${runSuffix}`,
      environment: 'ext08',
      scheme: 'http',
      host: '127.0.0.1',
      port: upstreamPort,
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
    return { httpStatus: probe.status, detail: `probeStatus=${probe.body.probe.status} endpointStatus=${probe.body.endpoint.status} publishEnabled=${probe.body.endpoint.publishEnabled}` };
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

  await step('publication.candidates', 'governance-ready endpoint appears as a publication candidate', async () => {
    const candidates = await callApi('GET', '/v1/publication/endpoints/candidates');
    assertHttp(candidates, 200, 'publication candidate list');
    const candidate = (candidates.body.data || []).find(item => item.endpointDefinition && item.endpointDefinition.id === endpoint.id);
    requireCheck(Boolean(candidate) && candidate.readiness && candidate.readiness.ready === true, 'governance-ready endpoint is not listed as a publication candidate');
    return { httpStatus: candidates.status, detail: `total=${candidates.body.total}` };
  });

  let runtimeAssetId;
  const runtimeAssetName = `ext08-mcp-asset-${runSuffix}`;
  await step('publication.runtime_asset', 'publication runtime asset draft is created through the real endpoint', async () => {
    const runtimeAsset = await callApi('POST', '/v1/publication/endpoints/runtime-assets', {
      type: 'mcp_server',
      name: runtimeAssetName,
      displayName: 'EXT-08 MCP runtime asset',
    });
    assertHttp(runtimeAsset, 201, 'publication runtime asset create');
    runtimeAssetId = runtimeAsset.body.runtimeAsset && runtimeAsset.body.runtimeAsset.id;
    requireCheck(Boolean(runtimeAssetId), 'runtime asset create returned no id');
    return { httpStatus: runtimeAsset.status, detail: `runtimeAssetId=${runtimeAssetId}` };
  });

  let membershipId;
  await step('publication.membership', 'ready endpoint is added as a runtime membership', async () => {
    const membershipResponse = await callApi('POST', `/v1/publication/endpoints/runtime-assets/${runtimeAssetId}/memberships`, {
      endpointDefinitionIds: [endpoint.id],
    });
    assertHttp(membershipResponse, 201, 'publication membership add');
    const membership = membershipResponse.body.createdMemberships && membershipResponse.body.createdMemberships[0];
    requireCheck(Boolean(membership && membership.id), 'membership create returned no id');
    membershipId = membership.id;
    return { httpStatus: membershipResponse.status, detail: `membershipId=${membershipId}` };
  });

  let bindingId;
  await step('publication.upstream_binding', 'runtime membership receives an active fixed-primary binding to the loopback instance', async () => {
    const binding = await callApi('PUT', `/v1/runtime-memberships/${membershipId}/upstream-binding`, {
      sourceServiceAssetId,
      environment: 'ext08',
      selectionMode: 'fixed_primary',
      primaryInstanceId: instanceId,
      status: 'active',
      candidates: [{ sourceServiceInstanceId: instanceId }],
    });
    assertHttp(binding, 200, 'runtime upstream binding upsert');
    requireCheck(binding.body.binding && binding.body.binding.status === 'active', 'upstream binding is not active');
    bindingId = binding.body.binding.id;
    await delay(1100);
    return { httpStatus: binding.status, detail: `bindingId=${bindingId} revision=${binding.body.binding.revision} (settled 1.1s for SQLite second-precision verification timestamps)` };
  });

  await step('publication.profile', 'publication profile is reviewed with intent name and LLM description', async () => {
    const profile = await callApi('PUT', `/v1/publication/endpoints/runtime-memberships/${membershipId}/profile`, {
      intentName: 'ext08Ping',
      descriptionForLlm: 'SEC-EXT-08 loopback ping intent',
      status: 'reviewed',
    });
    assertHttp(profile, 200, 'publication profile upsert');
    requireCheck(profile.body.profile && profile.body.profile.status === 'reviewed', 'publication profile is not reviewed');
    return { httpStatus: profile.status, detail: `profileId=${profile.body.profile.id}` };
  });

  let publishRevision;
  await step('publish.membership', 'membership publishes to MCP and the runtime asset becomes active', async () => {
    const publish = await callApi('POST', `/v1/publication/endpoints/runtime-memberships/${membershipId}/publish`, {
      publishToMcp: true,
      autoStart: false,
    });
    assertHttp(publish, 201, 'publication publish');
    requireCheck(publish.body.publishBinding && publish.body.publishBinding.publishStatus === 'active', 'publish binding is not active');
    requireCheck(publish.body.publishBinding.publishedToMcp === true, 'publish did not target MCP');
    requireCheck(publish.body.membership && publish.body.membership.status === 'active', 'membership did not become active');
    requireCheck(publish.body.runtimeAsset && publish.body.runtimeAsset.status === 'active', 'runtime asset did not become active');
    publishRevision = publish.body.publishBinding.publicationRevision;
    return { httpStatus: publish.status, detail: `publishStatus=${publish.body.publishBinding.publishStatus} publicationRevision=${publishRevision}` };
  });

  await step('publish.state', 'published membership state is re-read from the real endpoint', async () => {
    const state = await callApi('GET', `/v1/publication/endpoints/runtime-memberships/${membershipId}`);
    assertHttp(state, 200, 'publication membership state');
    requireCheck(state.body.publishBinding && state.body.publishBinding.publishStatus === 'active', 'membership state is not published');
    requireCheck(state.body.publishBinding.publishedToMcp === true, 'membership state is not published to MCP');
    requireCheck(state.body.runtimeAsset && state.body.runtimeAsset.status === 'active', 'runtime asset state is not active');
    return { httpStatus: state.status, detail: `publishedToMcp=${state.body.publishBinding.publishedToMcp} revision=${state.body.publishBinding.publicationRevision}` };
  });

  let deployPort;
  let candidateRevision;
  let managedServerId;
  let behaviorFingerprint;
  await step('publish.preview', 'MCP endpoint preview resolves the custom streamable path and loopback consumer URL', async () => {
    deployPort = await pickFreePort();
    evidence.ports.deploy = deployPort;
    const preview = await callApi('POST', `/v1/runtime-assets/${runtimeAssetId}/mcp-endpoint-preview`, {
      transport: 'streamable',
      port: deployPort,
      endpointPath: '/ext08-mcp',
      inboundAuthMode: 'private_api_key',
    });
    assertHttp(preview, 201, 'MCP endpoint preview');
    requireCheck(preview.body.consumerUrl && preview.body.consumerUrl.endsWith('/ext08-mcp'), 'preview consumer URL does not match the custom endpoint path');
    return { httpStatus: preview.status, detail: `consumerUrl=${preview.body.consumerUrl} portMode=${preview.body.portMode} inboundAuthMode=${preview.body.inboundAuthMode}` };
  });

  await step('publish.deploy_mcp', 'MCP candidate verifies against the loopback upstream and activates with a custom transport/endpoint', async () => {
    const deploy = await callApi('POST', `/v1/runtime-assets/${runtimeAssetId}/deploy-mcp`, {
      transport: 'streamable',
      port: deployPort,
      endpointPath: '/ext08-mcp',
      inboundAuthMode: 'private_api_key',
      autoStart: false,
    });
    assertHttp(deploy, 201, 'MCP candidate activation');
    const verificationRun = deploy.body.verification && deploy.body.verification.run;
    requireCheck(verificationRun && verificationRun.status === 'passed', `candidate verification did not pass: ${JSON.stringify(deploy.body.verification)}`);
    candidateRevision = verificationRun.candidateRevision;
    managedServerId = deploy.body.managedServer && deploy.body.managedServer.id;
    requireCheck(Boolean(managedServerId), 'deploy did not create a managed server record');
    return { httpStatus: deploy.status, detail: `verificationStatus=${verificationRun.status} candidateRevision=${String(candidateRevision).slice(0, 12)} managedServerId=${managedServerId} toolsCount=${deploy.body.toolsCount}` };
  });

  await step('publish.activated', 'runtime asset detail confirms the activated candidate revision and cleared verification flag', async () => {
    const assetDetail = await callApi('GET', `/v1/runtime-assets/${runtimeAssetId}`);
    assertHttp(assetDetail, 200, 'runtime asset detail');
    const metadata = assetDetail.body.asset && assetDetail.body.asset.metadata;
    const activeRevision = metadata && metadata.activeRevision;
    requireCheck(activeRevision === candidateRevision, `activated revision mismatch: ${activeRevision} != ${candidateRevision}`);
    requireCheck(metadata.verificationRequired === false, 'runtime asset still requires verification after activation');
    behaviorFingerprint = metadata.activeMcpBehaviorFingerprint;
    evidence.identity = {
      documentId: document.body.id,
      endpointDefinitionId: endpoint.id,
      sourceServiceAssetId,
      sourceServiceInstanceId: instanceId,
      testSampleId: sampleId,
      runtimeAssetId,
      runtimeAssetName,
      membershipId,
      upstreamBindingId: bindingId,
      publishRevision,
      managedServerId,
      candidateRevision,
      activeRevision,
      behaviorFingerprint,
    };
    return { httpStatus: assetDetail.status, detail: `activeRevision=${String(activeRevision).slice(0, 12)} managedServerId=${metadata.managedServerId}` };
  });

  evidence.finishedAt = new Date().toISOString();
}

async function finalize(ok) {
  if (finished) return;
  finished = true;
  evidence.ok = ok;
  evidence.finishedAt = evidence.finishedAt || new Date().toISOString();
  evidence.failures = failures;
  for (const child of [...children].reverse()) {
    stopTree(child);
    await waitForExit(child, 5000);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  if (upstream) await new Promise(resolve => upstream.close(resolve));
  try {
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  } catch (error) {
    console.error(`[ext-08] failed to write evidence: ${redact(error.message)}`);
  }
  if (ok) {
    console.log(`EXT_08_VERIFY_OK ${JSON.stringify({ workPackage: 'SEC-EXT-08', steps: steps.map(item => ({ id: item.id, ok: item.ok, informational: item.informational || false })), notCovered, evidence: evidencePath, ports: { api: apiPort, ui: uiPort } })}`);
  } else {
    console.error(`EXT_08_VERIFY_FAIL ${JSON.stringify({ workPackage: 'SEC-EXT-08', failures, evidence: evidencePath })}`);
    process.exitCode = 1;
  }
}

main().then(() => finalize(true), error => {
  console.error(`[ext-08] ${sanitizedError(error)}`);
  if (!steps.some(item => item.ok === false)) {
    record('chain', 'unexpected failure outside a recorded step', false, { detail: sanitizedError(error) });
  }
  return finalize(false);
});
