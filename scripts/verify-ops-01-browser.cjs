// OPS-01: real Chromium UI workflow in an isolated local environment.
// Requires Playwright (or OPS_PLAYWRIGHT_MODULE) and an installed browser.
// OPS_BROWSER_PATH optionally selects an executable. Timing is diagnostic only.
// Each run owns a fresh SQLite database and loopback ports. No existing service or data is used.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const lifecycleScenario = process.argv.includes('--lifecycle');
const importScenario = lifecycleScenario || process.argv.includes('--import') || process.argv.includes('--import-file');
const apiDir = path.join(root, 'packages/api-nova-api');
const apiEntry = path.join(apiDir, 'dist/src/main.js');
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const workDir = fs.realpathSync.native(fs.mkdtempSync(path.join(root, '.tmp/ops-01-browser-')));
const dbPath = path.join(workDir, 'acceptance.sqlite');
const registryPath = path.join(workDir, 'registry.json');
const evidencePath = path.join(workDir, 'evidence.json');
const secrets = [];
const children = [];
const upstreams = [];
const evidence = { marker: 'OPS_01_BROWSER_LOCAL_HTTP_V1', startedAt: new Date().toISOString(),
  commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout.trim(),
  platform: process.platform, node: process.version, database: { type: 'sqlite', path: dbPath, isolated: true }, steps: [],
  scenario: process.argv.includes('--import-file') ? 'openapi-file-import' : importScenario ? 'openapi-url-import' : 'manual-registration',
  notCovered: ['external deployed upstreams', 'PostgreSQL', 'production identity providers', 'MCP transport', ...(importScenario ? ['browser manual registration', 'browser unbound import', process.argv.includes('--import-file') ? 'browser URL import' : 'browser file import'] : ['browser OpenAPI import']), 'browser migration branches', 'production deployment signoff'], timings:'diagnostic only'  };
let apiBase, token, apiProcess;
function redact(value) { let text = String(value); for (const s of secrets) if (s) text = text.split(s).join('[redacted]'); return text; }
function save() { fs.writeFileSync(evidencePath, redact(JSON.stringify(evidence, null, 2))); }
async function step(id, fn) {
  try { const details = await fn(); evidence.steps.push({ id, passed: true, details: structuredClone(details) }); console.log(`PASS ${id}`); save(); return details; }
  catch (e) { evidence.steps.push({ id, passed: false, error: redact(e.message) }); save(); throw e; }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(url, { method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(url, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(45000) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, body: data, headers:Object.fromEntries(r.headers.entries()) };
}
async function api(method, url, body, expected = method === 'POST' ? 201 : 200) {
  const r = await request(`${apiBase}/api${url}`, { method, body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  assert.equal(r.status, expected, `${method} ${url}: ${r.status} ${redact(JSON.stringify(r.body)).slice(0, 1800)}`); return r.body;
}
async function port() { const s = http.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function upstream(name) {
  const state = { name, received: [], documents: {} };
  state.server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    state.received.push({ path: url.pathname, credentialPresent: Boolean(req.headers['x-api-key'] || req.headers.authorization) });
    res.setHeader('content-type', 'application/json');
    if (state.documents[url.pathname]) return res.end(JSON.stringify(state.documents[url.pathname]));
    res.end(JSON.stringify({ ok: true, path: url.pathname, instance: name }));
  });
  await new Promise(r => state.server.listen(0, '127.0.0.1', r)); state.port = state.server.address().port; state.url = `http://127.0.0.1:${state.port}`;
  upstreams.push(state); return state;
}
function registry(revision, sites) { return { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision, environment: 'extclosure' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: {}, credentials: {}, sites }; }
async function reloadRegistry(records, host, revision) {
  const status = await api('GET', '/security/upstream-credentials/status');
  const grouped = new Map();
  for (const r of records) { if (!grouped.has(r.source)) grouped.set(r.source, []); grouped.get(r.source).push({ endpointDefinitionId: r.id }); }
  const sites = [...grouped].map(([source, endpoints], i) => ({ id: `site-${i}`, sourceServiceAssetId: source,
    match: { scheme: 'http', host: '127.0.0.1', port: host.port, basePath: '/' }, allowedHosts: ['127.0.0.1'], credential: 'none',
    headerPolicy: { version: 1, requestHeaders: [], responseHeaders: [] }, endpoints }));
  fs.writeFileSync(registryPath, JSON.stringify(registry(revision, sites)));
  const result = await api('POST', '/security/upstream-credentials/reload', { expectedGeneration: status.generation, reason: 'OPS browser controlled loopback upstream registration' }, 200);
  assert.equal(result.generation, status.generation + 1); return { generation: result.generation };
}
async function instances(source) { return (await api('GET', `/v1/assets/source-services/${source}/instances`)).data; }
async function main() {
  const { chromium } = require(process.env.OPS_PLAYWRIGHT_MODULE || 'playwright');
  assert.ok(fs.existsSync(apiEntry), 'Build api-nova-api first');
  if (lifecycleScenario) {
    evidence.scenario = 'openapi-no-server-multi-endpoint-migration';
    evidence.notCovered = evidence.notCovered.filter(x => !['browser unbound import', 'browser migration branches'].includes(x));
  }
  const artifactPaths = [__filename, path.join(__dirname,'ops-browser-lifecycle.cjs'), path.join(__dirname,'ops-browser-logs.cjs'), path.join(root,'packages/api-nova-ui/src/services/runtime-logs.ts'), path.join(root,'packages/api-nova-ui/src/modules/logs/LogViewer.vue'), path.join(__dirname,'ops-browser-import.cjs'), path.join(root,'packages/api-nova-ui/src/modules/openapi/OpenAPIManager.vue'), path.join(__dirname,'ops-browser-scenario.cjs'), path.join(__dirname,'ops-browser-publication.cjs'), path.join(__dirname,'ops-browser-consumption.cjs'), path.join(root,'packages/api-nova-ui/src/modules/endpoint-registry/EndpointRegistry.vue'), path.join(root,'packages/api-nova-ui/src/modules/runtime-assets/RuntimeAssetDetail.vue'), apiEntry,
    path.join(root, 'packages/api-nova-ui/src/modules/endpoint-registry/SourceServiceInstancesDialog.vue'),
    path.join(root, 'packages/api-nova-ui/src/modules/endpoint-registry/RuntimeUpstreamBindingDialog.vue'),
    path.join(root, 'packages/api-nova-parser/dist/core/normalizer.js'),
    path.join(apiDir, 'dist/src/modules/openapi/services/parser.service.js'),
    path.join(apiDir, 'dist/src/modules/asset-catalog/services/asset-catalog.service.js'),
    path.join(apiDir, 'dist/src/modules/gateway-runtime/services/gateway-security.service.js'),
    path.join(apiDir, 'dist/src/modules/gateway-runtime/services/gateway-candidate-replay-authority.js'),
    path.join(apiDir, 'dist/src/modules/runtime-verification/services/gateway-candidate-replay.service.js')];
  evidence.artifacts = artifactPaths.map(file => ({ path: path.relative(root, file), sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
  try { const d=await require('check-disk-space').default(process.platform==='win32' ? 'C:/' : '/'); evidence.systemDisk={size:d.size,free:d.free,usedRatio:(d.size-d.free)/d.size,requiredFreeBytes:5*1024**3,additionalFreeBytesNeeded:Math.max(0,5*1024**3-d.free)}; } catch(e) {evidence.systemDisk={error:e.message};}
  evidence.workingTree = spawnSync('git', ['status', '--short', '--untracked-files=no'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout.trim();
  const a = await upstream('A'); const b = lifecycleScenario ? await upstream('B') : null; const apiPort = await port(); const mcpPort = await port(); apiBase = `http://127.0.0.1:${apiPort}`;
  evidence.ports = { api: apiPort, mcp: mcpPort, upstreamA: a.port, ...(b ? { upstreamB: b.port } : {}) };
  const password = `ExtClosure!${randomBytes(18).toString('hex')}`; const jwt = randomBytes(32).toString('hex'); secrets.push(password, jwt);
  const env = { ...process.env }; for (const k of Object.keys(env)) if (/^(API_NOVA_|DB_|SUPER_ADMIN_|JWT_|MAIL_|MCP_)/i.test(k)) delete env[k];
  Object.assign(env, { NODE_ENV: 'test', PORT: String(apiPort), MCP_PORT: String(mcpPort), MCP_SERVER_PORT: String(mcpPort), DB_TYPE: 'sqlite', DB_SQLITE_PATH: dbPath, DB_SYNCHRONIZE: 'false', DB_LOGGING: 'false', JWT_SECRET: jwt, JWT_REFRESH_SECRET: jwt,
    SUPER_ADMIN_USERNAME: 'extclosureadmin', SUPER_ADMIN_EMAIL: 'extclosure@example.invalid', SUPER_ADMIN_PASSWORD: password,
    API_NOVA_RUNTIME_CREDENTIAL_SOURCE: 'database', API_NOVA_RUNTIME_AUTH_MODE: 'api_key', API_NOVA_RUNTIME_REQUIRED_SCOPES: '', API_NOVA_RUNTIME_ALLOW_HTTP_LOOPBACK: 'true',
    API_NOVA_UPSTREAM_CREDENTIAL_FILE: registryPath, API_NOVA_UPSTREAM_CREDENTIAL_FORMAT: 'json', API_NOVA_UPSTREAM_CREDENTIAL_ENVIRONMENT: 'extclosure', API_NOVA_UPSTREAM_CREDENTIAL_RELOAD_MODE: 'manual',
    API_NOVA_AUDIT_DIR: path.join(workDir, 'audit'), PID_DIRECTORY: path.join(workDir, 'pids'), LOG_DIRECTORY: path.join(workDir, 'logs'), API_BASE_URL: apiBase, THROTTLE_LIMIT: '10000', THROTTLE_TTL: '60' });
  Object.assign(env, { API_NOVA_OBSERVABILITY_DATA_DIR:path.join(workDir,'observability'), API_NOVA_OBSERVABILITY_COLLECTOR_ENABLED:'true', API_NOVA_OBSERVABILITY_SOURCE_ID_SECRET:randomBytes(32).toString('hex'), API_NOVA_OBSERVABILITY_CURSOR_SECRET:randomBytes(32).toString('hex'), API_NOVA_OBSERVABILITY_IDEMPOTENCY_SECRET:randomBytes(32).toString('hex') });
  fs.writeFileSync(registryPath, JSON.stringify(registry('bootstrap', [])));
  await step('isolated.migration', async () => {
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm run migration:run --workspace api-nova-api'] : ['run', 'migration:run', '--workspace', 'api-nova-api'];
    const r = spawnSync(process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm', args, { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 32e6 });
    fs.writeFileSync(path.join(workDir, 'migration.log'), redact(`${r.stdout}\n${r.stderr}`)); assert.equal(r.status, 0, 'migration failed; see migration.log'); return { freshDatabase: fs.existsSync(dbPath) };
  });
  const packaged=!process.argv.includes('--vite');
  if(packaged) {
    const dist=path.join(root,'packages/api-nova-ui/dist');assert.ok(fs.existsSync(path.join(dist,'index.html')),'Build UI first');
    fs.symlinkSync(dist,path.join(workDir,'public'),process.platform==='win32'?'junction':'dir');
    evidence.uiArtifacts=[path.join(dist,'index.html'),...fs.readdirSync(path.join(dist,'assets')).filter(f=>/\.(js|css)$/.test(f)).map(f=>path.join(dist,'assets',f))].map(file=>({path:path.relative(root,file),sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')}));
  }
  evidence.uiMode=packaged?'packaged':'vite';
  const log = fs.openSync(path.join(workDir, 'api.log'), 'w'); apiProcess = spawn(process.execPath, [apiEntry], { cwd: packaged?workDir:apiDir, env, stdio: ['ignore', log, log], windowsHide: true }); children.push(apiProcess); fs.closeSync(log);
  await step('isolated.start', async () => {
    const until = Date.now() + 90000; while (Date.now() < until) { if (apiProcess.exitCode !== null) throw new Error(`API exited ${apiProcess.exitCode}; see ${workDir}/api.log`);
      try { const r = await request(`${apiBase}/api/health/ready`); if (r.status === 200 && r.body.status === 'ready') return { port: apiPort }; } catch {} await delay(300); }
    throw new Error('API readiness timeout');
  });

  let uiBase=apiBase;
  if(!packaged) {
  const uiPort = await port(); evidence.ports.ui = uiPort;
  const uiLog = fs.openSync(path.join(workDir, 'ui.log'), 'w');
  const ui = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], { cwd: path.join(root, 'packages/api-nova-ui'), env: { ...env, VITE_PROXY_TARGET: apiBase }, stdio: ['ignore', uiLog, uiLog], windowsHide: true }); children.push(ui); fs.closeSync(uiLog);
  uiBase = 'http://127.0.0.1:' + uiPort;
  for (let attempt=0; attempt<120; attempt++) { try { if ((await request(uiBase)).status===200) break; } catch {} await delay(500); }
  }
  const browser = await chromium.launch({ headless:true, ...(process.env.OPS_BROWSER_PATH ? {executablePath:process.env.OPS_BROWSER_PATH} : {}) });
  const context=await browser.newContext({locale:'zh-CN', viewport:{width:1440,height:1000}});
  const page=await context.newPage(); page.setDefaultTimeout(30000);
  evidence.browser={version:browser.version(), pageErrors:[]};
  page.on('pageerror',e=>evidence.browser.pageErrors.push(redact(e.message)));
  page.on('response',async r=>{if(r.url().endsWith('/auth/login')&&r.ok()) {try {const b=await r.json();secrets.push(b.accessToken,b.refreshToken);}catch{}}});
  try {
    await require('./ops-browser-scenario.cjs')({page,context,uiBase,apiBase,password,username:'extclosureadmin',upstream:a,replacement:b,lifecycleScenario,step,api,request,evidence,workDir,redact,secrets,importScenario,
      managementLogin:async()=>{const r=await api('POST','/auth/login',{username:'extclosureadmin',password},200); token=r.accessToken; secrets.push(token,r.refreshToken);},
      reloadRegistry,instances});
    assert.deepEqual(evidence.browser.pageErrors,[], 'Browser uncaught errors');
    evidence.ok=true;
  } finally {
    fs.writeFileSync(path.join(workDir,'browser-final.txt'),redact(await page.locator('body').innerText().catch(()=>'')));
    await page.screenshot({path:path.join(workDir,'browser-final.png'),fullPage:true,mask:[page.locator('input[type=password]'),page.locator('.api-key-created')]}).catch(()=>{});
    await browser.close();
  }
}
async function finish() {
  for (const child of children) if (child.exitCode === null) { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); else child.kill('SIGTERM'); }
  for (const up of upstreams) { up.server.closeAllConnections(); await new Promise(resolve => up.server.close(resolve)); }
  const apiLog = path.join(workDir, 'api.log'); if (fs.existsSync(apiLog)) fs.writeFileSync(apiLog, redact(fs.readFileSync(apiLog, 'utf8')));
  evidence.cleanup={};
  for (const [name,value] of Object.entries(evidence.ports || {})) { try { await fetch('http://127.0.0.1:'+value+'/health',{signal:AbortSignal.timeout(1000)}); evidence.cleanup[name]=false; } catch { evidence.cleanup[name]=true; } }
  if(Object.values(evidence.cleanup).some(ok=>!ok)) {evidence.ok=false;process.exitCode=1;}
  evidence.finishedAt = new Date().toISOString(); save(); console.log(`${evidence.ok ? 'OPS_01_BROWSER_VERIFY_OK' : 'OPS_01_BROWSER_VERIFY_FAIL'} ${evidencePath}`);
}
main().catch(e => { evidence.ok = false; evidence.error = redact(e.stack); console.error(redact(e.message)); process.exitCode = 1; }).finally(finish);
