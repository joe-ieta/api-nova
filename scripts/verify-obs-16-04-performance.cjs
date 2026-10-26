// OBS-16-04: actual authenticated Gateway, automatic collector/outbox/delivery workers.
// No manual runOnce; timing is diagnostic by default, correctness remains required.
// Each run owns a fresh SQLite database and loopback ports. No existing service or data is used.
'use strict';
const assert = require('node:assert/strict');
const { assessObservabilityAcceptance } = require('./obs-acceptance-policy.cjs');
const { createObservabilityManagementSession } = require('./obs-management-session.cjs');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes, createHash, createHmac } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const apiDir = path.join(root, 'packages/api-nova-api');
const apiEntry = path.join(apiDir, 'dist/src/main.js');
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const workDir = fs.realpathSync.native(fs.mkdtempSync(path.join(root, '.tmp/obs-16-04-performance-')));
const dbPath = path.join(workDir, 'acceptance.sqlite');
const registryPath = path.join(workDir, 'registry.json');
const evidencePath = path.join(workDir, 'evidence.json');
const secrets = [];
const children = [];
const upstreams = [];
const evidence = { marker: 'OBS_16_04_PERFORMANCE_V1', startedAt: new Date().toISOString(),
  commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout.trim(),
  platform: process.platform, node: process.version, database: { type: 'sqlite', driver: 'sqljs', autoSave: true, path: dbPath, isolated: true }, steps: [],
  notCovered: ['external deployed upstreams', 'PostgreSQL', 'browser interactions', 'production identity providers', 'MCP transport'] };
let apiBase, managementSession, apiProcess, receiver, polling = false, curveTimer, pgStarted = false;
const postgres = process.argv.includes('--postgres');
const pgdata = path.join(workDir, 'pgdata');
const deliveries = [], observed = new Map(), requests = new Map(), resourceCurve = [], producerCurve = [];
const relaxedTimeouts = process.argv.includes('--relaxed-timeouts');
const enforceTimingGates = process.argv.includes('--enforce-timing-gates');
function timeoutOption(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  assert.ok(Number.isInteger(value) && value >= min && value <= max, name + ' outside allowed bounds');
  return value;
}
const requestTimeoutMs = timeoutOption('OBS_PERF_REQUEST_TIMEOUT_MS', relaxedTimeouts ? 180000 : 45000, 1000, 600000);
const managementTimeoutMs = timeoutOption('OBS_PERF_MANAGEMENT_TIMEOUT_MS', relaxedTimeouts ? 180000 : 45000, 1000, 600000);
const diagnosticTimeoutMs = timeoutOption('OBS_PERF_DIAGNOSTIC_TIMEOUT_MS', relaxedTimeouts ? 60000 : 30000, 1000, 180000);
const shutdownTimeoutMs = timeoutOption('OBS_PERF_SHUTDOWN_TIMEOUT_MS', relaxedTimeouts ? 180000 : 30000, 1000, 600000);
const diagnosticRequests = new Map();
let diagnosticSequence = 0;
function diagnostics(command, timeoutMs = diagnosticTimeoutMs) {
  return new Promise((resolve, reject) => {
    if (!apiProcess?.connected) return reject(new Error('Diagnostic IPC unavailable'));
    const id = ++diagnosticSequence;
    const timer = setTimeout(() => { diagnosticRequests.delete(id); reject(new Error('Diagnostic ' + command + ' timed out')); }, timeoutMs);
    diagnosticRequests.set(id, value => { clearTimeout(timer); resolve(value); });
    apiProcess.send({type:'obs-perf-diagnostics',command,id}, error => { if (error) { clearTimeout(timer); diagnosticRequests.delete(id); reject(error); } });
  });
}
const responseText = JSON.stringify({ ok: true, padding: 'x'.repeat(4000) });
const successfulRequest = row => row.status === 200 && row.responseValid === true;
const smoke = process.argv.includes('--smoke');
const rate = smoke ? 2 : 100;
const durationSeconds = Number(process.env.OBS_PERF_DURATION_SECONDS || (smoke ? 10 : 30));
const tailSeconds = Number(process.env.OBS_PERF_TAIL_SECONDS || (enforceTimingGates ? (relaxedTimeouts ? 300 : 60) : (smoke ? 60 : 1200)));
assert.ok(Number.isInteger(durationSeconds) && durationSeconds >= 10 && durationSeconds <= 120);
assert.ok(Number.isInteger(tailSeconds) && tailSeconds >= 10 && tailSeconds <= 1800);
const percentile = (values, p = 0.95) => values.length ? [...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1] : null;
const summary = values => ({ count: values.length, p50Ms: percentile(values,0.5), p95Ms: percentile(values), p99Ms: percentile(values,0.99), maxMs: values.length ? Math.max(...values) : null });
function redact(value) { let text = String(value); for (const s of secrets) if (s) text = text.split(s).join('[redacted]'); return text; }
function save() { fs.writeFileSync(evidencePath, redact(JSON.stringify(evidence, null, 2))); }
async function step(id, fn) {
  try { const details = await fn(); evidence.steps.push({ id, passed: true, details: structuredClone(details) }); console.log(`PASS ${id}`); save(); return details; }
  catch (e) { evidence.steps.push({ id, passed: false, error: redact(e.message) }); save(); throw e; }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(url, { method = 'GET', body, headers = {}, timeoutMs = requestTimeoutMs, signal } = {}) {
  const r = await fetch(url, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, body: data, headers: Object.fromEntries(r.headers) };
}
async function api(method, url, body, expected = method === 'POST' ? 201 : 200, requestOptions = {}) {
  const r = await managementSession.request(method, url, body, { timeoutMs: managementTimeoutMs, ...requestOptions });
  assert.equal(r.status, expected, `${method} ${url}: ${r.status} ${redact(JSON.stringify(r.body)).slice(0, 1800)}`); return r.body;
}
async function port() { const s = http.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
function spec(title, paths, server) { return { openapi: '3.0.3', info: { title, version: '1.0.0' }, ...(server ? { servers: [{ url: server }] } : {}),
  paths: Object.fromEntries(paths.map(p => [p, { get: { operationId: title + p.replace(/\W/g, ''), responses: { '200': { description: 'Success', content: { 'application/json': { schema: { type: 'object' } } } } } } }])) }; }
async function upstream(name) {
  const state = { name, received: [], documents: {} };
  state.server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    state.received.push({ path: url.pathname, credentialPresent: Boolean(req.headers['x-api-key'] || req.headers.authorization) });
    res.setHeader('content-type', 'application/json');
    if (state.documents[url.pathname]) return res.end(JSON.stringify(state.documents[url.pathname]));
    res.end(responseText);
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
  const result = await api('POST', '/security/upstream-credentials/reload', { expectedGeneration: status.generation, reason: 'EXT lifecycle controlled loopback upstream registration' }, 200);
  assert.equal(result.generation, status.generation + 1); return { generation: result.generation };
}
async function importUrl(host, name, paths, bound) {
  const url = `${host.url}/${name}.json`; host.documents[`/${name}.json`] = spec(name, paths, bound ? host.url : undefined);
  const parsed = await api('GET', `/openapi/parse-url?url=${encodeURIComponent(url)}`); assert.equal(parsed.endpoints.length, paths.length);
  const fetched = await request(url); assert.equal(fetched.status, 200);
  const doc = await api('POST', '/documents', { name, content: JSON.stringify(fetched.body), status: 'valid', metadata: { importSource: 'url', originalUrl: url } });
  const catalog = await api('GET', '/v1/assets/endpoints');
  const endpoints = catalog.data.filter(x => x.metadata?.documentId === doc.id); assert.equal(endpoints.length, paths.length);
  const records = [];
  for (const ep of endpoints) { const d = await api('GET', `/v1/assets/endpoints/${ep.id}`); records.push({ id: ep.id, path: ep.path, source: d.sourceServiceAsset.id, documentId: doc.id }); }
  return records;
}
async function instances(source) { return (await api('GET', `/v1/assets/source-services/${source}/instances`)).data; }
async function attach(source, host) {
  return api('POST', `/v1/assets/source-services/${source}/instances`, { name: `upstream-${host.name}`, environment: 'extclosure', scheme: 'http', host: '127.0.0.1', port: host.port, basePath: '/', enabled: true, isDefault: true });
}
async function ready(record, instance) {
  await api('POST', `/v1/assets/source-services/${record.source}/instances/${instance.id}/probe`, {});
  const probe = await api('POST', `/v1/assets/endpoints/${record.id}/probe`, {}); assert.equal(probe.endpoint.status, 'verified');
  const test = await api('POST', `/v1/assets/endpoints/${record.id}/test`, { sourceServiceInstanceId: instance.id, environment: instance.environment }); assert.equal(test.test.passed, true);
  const samples = (await api('GET', `/v1/endpoint-testing/endpoints/${record.id}/test-samples`)).data; assert.ok(samples.length);
  // Compare stable business fields across host replacement; the response's instance identifies A/B separately.
  for (const sample of samples) await api('PATCH', `/v1/endpoint-testing/test-samples/${sample.id}`, { tags: ['smoke'] });
  const readiness = await api('GET', `/v1/assets/endpoints/${record.id}/readiness`); assert.equal(readiness.ready, true, JSON.stringify(readiness));
  record.instanceId = instance.id; record.environment = instance.environment; record.sampleIds = samples.map(s => s.id);
}
async function binding(record) {
  const r = await api('PUT', `/v1/runtime-memberships/${record.membershipId}/upstream-binding`, { sourceServiceAssetId: record.source,
    environment: record.environment, selectionMode: 'fixed_primary', primaryInstanceId: record.instanceId, status: 'active', candidates: [{ sourceServiceInstanceId: record.instanceId }] });
  record.bindingId = r.binding.id; record.bindingRevision = r.binding.revision;
}
async function deploy(assetId) {
  await delay(1100);
  const result = await api('POST', `/v1/runtime-assets/${assetId}/deploy-gateway`, { publishedOnly: true });
  assert.equal(result.verification?.run?.status, 'passed', JSON.stringify(result)); assert.equal(result.verification.run.activationStatus, 'activated');
  return result.verification.run;
}
async function pgRun(name, args) {
  const pgEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG|^DATABASE_URL$/i.test(key)));
  const executable=process.env.API_NOVA_TEST_PG_BIN?path.join(process.env.API_NOVA_TEST_PG_BIN,name+(process.platform==='win32'?'.exe':'')):name;
  const fd=fs.openSync(path.join(workDir,'pg-tools.log'),'a');const child=spawn(executable,args,{env:pgEnv,windowsHide:true,stdio:['ignore',fd,fd]});fs.closeSync(fd);
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`${name} exited ${code}`)));});
}
async function main() {
  assert.ok(fs.existsSync(apiEntry), 'Build api-nova-api first');
  const artifactPaths = [__filename, path.join(root, 'scripts/obs-acceptance-policy.cjs'),
    path.join(root, 'scripts/obs-management-session.cjs'), apiEntry,
    path.join(apiDir, 'dist/src/modules/asset-catalog/services/asset-catalog.service.js'),
    path.join(apiDir, 'dist/src/modules/gateway-runtime/services/gateway-security.service.js'),
    path.join(apiDir, 'dist/src/modules/gateway-runtime/services/gateway-candidate-replay-authority.js'),
    path.join(apiDir, 'dist/src/modules/runtime-verification/services/gateway-candidate-replay.service.js')];
  artifactPaths.push(path.join(root,'package-lock.json'), path.join(root,'scripts/obs-performance-diagnostics.cjs'), path.join(root,'packages/api-nova-parser/src/audit/runtime-call-audit.ts'), path.join(root,'packages/api-nova-parser/dist/audit/runtime-call-audit.js'), ...['call-observability.worker','call-observability.collector','call-observability.store','call-observability-callers.projector','call-observability-payload.coordinator','call-observability-outbox.service','call-observability-delivery.worker'].flatMap(name=>[path.join(apiDir,'src/modules/call-observability',name+'.ts'),path.join(apiDir,'dist/src/modules/call-observability',name+'.js')]));
  artifactPaths.push(...['sqljs-persistence','database.module','data-source'].flatMap(name=>[path.join(apiDir,'src/database',name+'.ts'),path.join(apiDir,'dist/src/database',name+'.js')]));

  artifactPaths.push(...['runtime-observability/services/runtime-observability.service','runtime-observability/services/runtime-observability-write-lane','gateway-runtime/services/gateway-runtime-metrics.service'].flatMap(name=>[path.join(apiDir,'src/modules',name+'.ts'),path.join(apiDir,'dist/src/modules',name+'.js')]));
  evidence.artifacts = artifactPaths.map(file => ({ path: path.relative(root, file), sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
  evidence.workingTree = spawnSync('git', ['status', '--short', '--untracked-files=no'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout.trim();
  evidence.machine = { platform: process.platform, release: os.release(), architecture: os.arch(), cpuModel: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem(), freeMemoryBytes: os.freemem(), reference: '4 cores / 8 GiB / SSD; this host is not constrained to that reference', diskMedium: 'not independently verified' };
  evidence.timeouts = { profile: relaxedTimeouts ? 'relaxed-diagnostic' : 'standard', requestTimeoutMs, managementTimeoutMs, diagnosticTimeoutMs, shutdownTimeoutMs, tailSeconds, performanceTargetsUnchanged: true, timingGates: enforceTimingGates ? 'enforced-benchmark' : 'diagnostic-only', observationGuard: 'Finite completeness collection guard; an incomplete cohort never passes as complete.' };
  evidence.load = { requestsPerSecond: rate, smoke, durationSeconds, tailSeconds, responseBytes: Buffer.byteLength(responseText), requestBodyBytes: 0, capture: 'default body capture', subscription: 'one invocation.completed per external gateway_request', automaticWorkers: true };
  evidence.notCovered = ['production hardware/identity/network', 'Linux performance', ...(postgres ? ['SQLite performance'] : ['PostgreSQL performance']), 'MCP performance', 'fixed uninstrumented baseline: no product switch disables producer instrumentation; direct upstream latency is not incremental capture overhead', 'long sustained capacity and thermal steady-state'];
  const a = await upstream('A'); const b = a; const apiPort = await port(); const mcpPort = await port(); apiBase = `http://127.0.0.1:${apiPort}`;
  evidence.ports = { api: apiPort, mcp: mcpPort, upstreamA: a.port, upstreamB: b.port };
  const password = `ExtClosure!${randomBytes(18).toString('hex')}`; const jwt = randomBytes(32).toString('hex'); secrets.push(password, jwt);
  const receiverSecret = randomBytes(32).toString('hex'); secrets.push(receiverSecret);
  receiver = http.createServer((req,res) => { const chunks = []; req.on('data', c=>chunks.push(c)); req.on('end',()=>{ const body=Buffer.concat(chunks).toString(); const signed=createHmac('sha256',receiverSecret).update(String(req.headers['x-apinova-timestamp'])+'.'+body).digest('hex'); const valid=req.headers['x-apinova-signature']==='sha256='+signed; let event; try {event=JSON.parse(body);} catch {} deliveries.push({receivedAt:Date.now(), valid, event}); res.writeHead(valid?202:401);res.end(); }); });
  await new Promise(r=>receiver.listen(0,'127.0.0.1',r)); const receiverPort=receiver.address().port; evidence.ports.receiver=receiverPort;
  const env = { ...process.env }; for (const k of Object.keys(env)) if (/^(API_NOVA_|DB_|SUPER_ADMIN_|JWT_|MAIL_|MCP_|PG|DATABASE_URL$)/i.test(k)) delete env[k];
  Object.assign(env, { NODE_ENV: 'test', PORT: String(apiPort), MCP_PORT: String(mcpPort), MCP_SERVER_PORT: String(mcpPort), DB_TYPE: 'sqlite', DB_SQLITE_PATH: dbPath, DB_SYNCHRONIZE: 'false', DB_LOGGING: 'false', JWT_SECRET: jwt, JWT_REFRESH_SECRET: jwt,
    SUPER_ADMIN_USERNAME: 'extclosureadmin', SUPER_ADMIN_EMAIL: 'extclosure@example.invalid', SUPER_ADMIN_PASSWORD: password,
    API_NOVA_RUNTIME_CREDENTIAL_SOURCE: 'database', API_NOVA_RUNTIME_AUTH_MODE: 'api_key', API_NOVA_RUNTIME_REQUIRED_SCOPES: '', API_NOVA_RUNTIME_ALLOW_HTTP_LOOPBACK: 'true',
    API_NOVA_UPSTREAM_CREDENTIAL_FILE: registryPath, API_NOVA_UPSTREAM_CREDENTIAL_FORMAT: 'json', API_NOVA_UPSTREAM_CREDENTIAL_ENVIRONMENT: 'extclosure', API_NOVA_UPSTREAM_CREDENTIAL_RELOAD_MODE: 'manual',
    API_NOVA_AUDIT_DIR: path.join(workDir, 'audit'), PID_DIRECTORY: path.join(workDir, 'pids'), LOG_DIRECTORY: path.join(workDir, 'logs'), API_BASE_URL: apiBase, THROTTLE_LIMIT: '10000', THROTTLE_TTL: '60' });
  Object.assign(env, { API_NOVA_OBSERVABILITY_DATA_DIR:path.join(workDir,'observability'), API_NOVA_OBSERVABILITY_COLLECTOR_ENABLED:'true', API_NOVA_OBSERVABILITY_OUTBOX_ENABLED:'true', API_NOVA_OBSERVABILITY_WEBHOOK_ENABLED:'true', API_NOVA_OBSERVABILITY_SOURCE_ID_SECRET:randomBytes(32).toString('hex'), API_NOVA_OBSERVABILITY_CURSOR_SECRET:randomBytes(32).toString('hex'), API_NOVA_OBSERVABILITY_IDEMPOTENCY_SECRET:randomBytes(32).toString('hex'), API_NOVA_OBSERVABILITY_WEBHOOK_ALLOWED_HOSTS:`127.0.0.1:${receiverPort}`, API_NOVA_OBSERVABILITY_WEBHOOK_ALLOW_HTTP:'true', API_NOVA_OBSERVABILITY_WEBHOOK_ALLOWED_PRIVATE_IPS:'127.0.0.1', API_NOVA_OBSERVABILITY_WEBHOOK_SECRET_REFS:'perf.receiver', API_NOVA_OBSERVABILITY_WEBHOOK_SECRETS:JSON.stringify({'perf.receiver':receiverSecret}), NO_PROXY:'127.0.0.1,localhost', no_proxy:'127.0.0.1,localhost' });
  if(postgres){
    const pgPort=await port();await pgRun('initdb',['-D',pgdata,'-U','obsperf_fixture','--auth=trust','--no-locale','--encoding=UTF8']);
    fs.appendFileSync(path.join(pgdata,'postgresql.conf'),`\nlisten_addresses = '127.0.0.1'\nport = ${pgPort}\nmax_connections = 40\nfsync = on\nsynchronous_commit = on\n`);
    fs.writeFileSync(path.join(pgdata,'pg_hba.conf'),'host all obsperf_fixture 127.0.0.1/32 trust\nlocal all obsperf_fixture trust\n');
    await pgRun('pg_ctl',['-D',pgdata,'-l',path.join(workDir,'postgres.log'),'-w','-t','30','start']);pgStarted=true;
    Object.assign(env,{DB_TYPE:'postgres',DB_HOST:'127.0.0.1',DB_PORT:String(pgPort),DB_USERNAME:'obsperf_fixture',DB_PASSWORD:'',DB_DATABASE:'postgres',DB_SSL:'false'});delete env.DB_SQLITE_PATH;
    const client=new (require('pg').Client)({host:'127.0.0.1',port:pgPort,user:'obsperf_fixture',database:'postgres',ssl:false});await client.connect();try{evidence.database={type:'postgres',driver:'pg',port:pgPort,isolated:true,fsync:true,synchronousCommit:true,version:(await client.query('SELECT version()')).rows[0].version};}finally{await client.end();}
    evidence.notCovered=evidence.notCovered.map(item=>item==='Linux/PostgreSQL performance'?'Linux/SQLite performance':item);
  }
  fs.writeFileSync(registryPath, JSON.stringify(registry('bootstrap', [])));
  await step('isolated.migration', async () => {
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm run migration:run --workspace api-nova-api'] : ['run', 'migration:run', '--workspace', 'api-nova-api'];
    const r = spawnSync(process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm', args, { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 32e6 });
    fs.writeFileSync(path.join(workDir, 'migration.log'), redact(`${r.stdout}\n${r.stderr}`)); assert.equal(r.status, 0, 'migration failed; see migration.log'); return { freshDatabase: postgres || fs.existsSync(dbPath) };
  });
  const log = fs.openSync(path.join(workDir, 'api.log'), 'w'); apiProcess = spawn(process.execPath, ['--require', path.join(root,'scripts/obs-performance-diagnostics.cjs'), apiEntry], { cwd: apiDir, env, stdio: ['ignore', log, log, 'ipc'], windowsHide: true }); children.push(apiProcess); fs.closeSync(log);
  apiProcess.on('message', message => { if (message?.type !== 'obs-perf-health') return; producerCurve.push(message); const done = diagnosticRequests.get(message.id); if (done) { diagnosticRequests.delete(message.id); done(message); } });
  await step('isolated.start', async () => {
    const until = Date.now() + (relaxedTimeouts ? 180000 : 90000); while (Date.now() < until) { if (apiProcess.exitCode !== null) throw new Error(`API exited ${apiProcess.exitCode}; see ${workDir}/api.log`);
      try { const r = await request(`${apiBase}/api/health/ready`); if (r.status === 200 && r.body.status === 'ready') return { port: apiPort }; } catch {} await delay(300); }
    throw new Error('API readiness timeout');
  });
  managementSession = createObservabilityManagementSession({ baseUrl: apiBase, request, username: 'extclosureadmin', password,
    timeoutMs: managementTimeoutMs, rememberSecret: value => secrets.push(value) });
  await managementSession.login();
  evidence.managementSession = { mechanism: 'ordinary login with fresh credentials', proactiveExpiryMarginSeconds: 60,
    concurrentLogin: 'single-flight', unauthorizedRetry: 'GET once only; mutations are never replayed', productTokenLifetimeUnchanged: true };
  const registered = await api('POST','/v1/assets/endpoints/manual',{name:'perf-source',baseUrl:a.url,method:'GET',path:'/payload',description:'Isolated performance payload'});
  const rec = {id:registered.id,path:'/payload',source:registered.sourceServiceAsset.id};
  const instance = (await instances(rec.source)).find(i=>i.enabled) || await attach(rec.source,a);
  await ready(rec,instance); await reloadRegistry([rec],a,'perf-source');
  const assetId=(await api('POST','/v1/publication/endpoints/runtime-assets',{type:'gateway_service',name:'perf-gateway',servicePrefix:'perf'})).runtimeAsset.id;
  rec.membershipId=(await api('POST',`/v1/publication/endpoints/runtime-assets/${assetId}/memberships`,{endpointDefinitionIds:[rec.id]})).createdMemberships[0].id;
  await api('PUT',`/v1/publication/endpoints/runtime-memberships/${rec.membershipId}/gateway-route`,{routePath:'/payload',routeMethod:'GET',upstreamPath:'/payload',upstreamMethod:'GET',routeVisibility:'external',authPolicyRef:'api-key-default',upstreamConfig:{headerPolicyMigration:{version:1,mode:'v1',source:'registry'}}});
  await api('PUT',`/v1/publication/endpoints/runtime-memberships/${rec.membershipId}/profile`,{intentName:'perfPayload',descriptionForLlm:'Read performance payload',status:'reviewed'});
  await api('POST',`/v1/publication/endpoints/runtime-memberships/${rec.membershipId}/publish`,{publishToHttp:true,autoStart:false}); await binding(rec);
  const key=(await api('POST',`/v1/runtime-assets/${assetId}/runtime-access-credentials`,{name:'Performance consumer',protocols:['gateway'],scopes:[],toolScopes:[]})).apiKey;secrets.push(key);
  await deploy(assetId);
  const obs='/monitoring/observability';
  const sub=await api('POST',obs+'/subscriptions',{name:'Local performance receiver',destination:{type:'webhook',url:`http://127.0.0.1:${receiverPort}/events`},secretRef:'perf.receiver',filter:{runtimeAssetIds:[assetId],eventTypes:['invocation.completed'],spanKinds:['gateway_request']},enabled:true});
  evidence.subscriptionId=sub.data.id; evidence.assetId=assetId;
  // Let fixture-only test/probe audit records drain before starting the external load.
  await delay(4000);
  evidence.producerBeforeLoad = await diagnostics('snapshot');
  polling=true;
  const pollAbort = new AbortController();
  let measurementCutoffAt = Infinity;
  const queryBase=`${obs}/invocations?runtimeAssetId=${assetId}&spanKind=gateway_request&origin=external&limit=200`;
  const pollErrors=[];
  let historyCursor;
  const recordPage = page => { const at=Date.now();if(at>measurementCutoffAt)return;for(const item of page.data.items){if(item.lifecycle==='finished' && !observed.has(item.requestId)) observed.set(item.requestId,{at,completedAt:Date.parse(item.completedAt),invocationId:item.invocationId});} };
  // Observe the newest page and one historical page per poll. Cursor snapshots are
  // exhausted and renewed, so late old records cannot hide behind the newest 200.
  // First visibility is always the real HTTP observation time, never backdated.
  const poller=(async()=>{while(polling){try{
    const page=await api('GET',queryBase,undefined,200,{signal:pollAbort.signal});recordPage(page);
    const cursor=historyCursor||page.data.nextCursor;
    if(cursor&&polling){const historical=await api('GET',queryBase+'&cursor='+encodeURIComponent(cursor),undefined,200,{signal:pollAbort.signal});recordPage(historical);historyCursor=historical.data.nextCursor;}
  }catch(e){if(polling)pollErrors.push(redact(e.message));historyCursor=undefined;}if(polling)await delay(100);}})();
  curveTimer=setInterval(()=>resourceCurve.push({at:Date.now(),hostFreeMemoryBytes:os.freemem(),loadGenerator:process.memoryUsage(),observed:observed.size,received:deliveries.length,hostCpuTimes:os.cpus().reduce((sum,c)=>({idle:sum.idle+c.times.idle,total:sum.total+Object.values(c.times).reduce((a,b)=>a+b,0)}),{idle:0,total:0})}),1000);
  const start=performance.now(),wallStart=Date.now(),load=[];
  for(let i=0;i<durationSeconds*rate;i++){
    const due=start+i*1000/rate; if(performance.now()<due)await delay(due-performance.now());
    load.push((async()=>{const sent=Date.now(),begin=performance.now();try{const r=await request(apiBase+'/api/v1/gateway/perf/payload',{headers:{'x-api-key':key}}); const row={sent,completed:Date.now(),durationMs:performance.now()-begin,status:r.status,requestId:r.headers['x-request-id'],scheduledOffsetMs:i*1000/rate,schedulingLagMs:Math.max(0,begin-due)}; row.attemptIndex=i;row.responseValid=r.status===200&&JSON.stringify(r.body)===responseText;if(r.status===200&&!row.responseValid)row.error='Unexpected Gateway response payload'; if(r.status!==200)row.error=redact(JSON.stringify(r.body)).slice(0,250); requests.set(String(i),row); }catch(e){requests.set(String(i),{attemptIndex:i,sent,completed:Date.now(),durationMs:performance.now()-begin,status:0,error:e.message});}})());
  }
  evidence.load.actualSchedulingDurationMs=performance.now()-start;await Promise.all(load); evidence.load.actualCompletionDurationMs=performance.now()-start; evidence.load.startedAt=new Date(wallStart).toISOString(); console.log(`LOAD_COMPLETE ${requests.size}`); save();
  const tailStart=Date.now(), tailUntil=tailStart+tailSeconds*1000;
  let nextProgressAt=tailStart;
  while(Date.now()<tailUntil){const success=[...requests.values()].filter(successfulRequest);const delivered=new Set(deliveries.filter(row=>row.valid&&row.event?.eventType==='invocation.completed').map(row=>row.event.subject?.id));if(success.length&&success.every(row=>observed.has(row.requestId)&&delivered.has(observed.get(row.requestId).invocationId)) )break;if(Date.now()>=nextProgressAt){console.log(`DRAIN_PROGRESS visible=${success.filter(row=>observed.has(row.requestId)).length}/${success.length} delivered=${success.filter(row=>observed.has(row.requestId)&&delivered.has(observed.get(row.requestId).invocationId)).length}/${success.length} elapsedSeconds=${Math.round((Date.now()-tailStart)/1000)}`);nextProgressAt=Date.now()+30000;}await delay(1000);}
  measurementCutoffAt=Date.now();evidence.measurementCutoffAt=new Date(measurementCutoffAt).toISOString();
  evidence.load.observationDurationAfterCompletionMs=measurementCutoffAt-(wallStart+evidence.load.actualCompletionDurationMs);
  polling=false;pollAbort.abort(new Error('Observation window closed'));await poller;clearInterval(curveTimer);
  const completed=[...requests.values()].filter(successfulRequest), visible=completed.filter(r=>observed.has(r.requestId));
  evidence.load.expectedAttempts=durationSeconds*rate;
  evidence.load.successRequestIdsUnique=completed.every(row=>typeof row.requestId==='string'&&row.requestId.length>0)&&new Set(completed.map(row=>row.requestId)).size===completed.length;
  evidence.load.allAttemptsRecorded=requests.size===durationSeconds*rate;
  evidence.requestLatency=summary(completed.map(r=>r.durationMs)); evidence.schedulingLag=summary(completed.map(r=>r.schedulingLagMs));
  evidence.visibility={...summary(visible.map(r=>Math.max(0,observed.get(r.requestId).at-observed.get(r.requestId).completedAt))),expected:completed.length,observed:visible.length,censored:completed.length-visible.length,p95Scope:visible.length===completed.length?'full completed cohort':'observed subset only; censored samples prevent a full-cohort pass',thresholdMs:3000,measurement:'HTTP metadata first observed minus recorded terminal completion; 100ms idle poll plus current/historical HTTP page durations add observation delay; rotating bounded pages include late older records'};
  evidence.visibility.pass=visible.length===completed.length&&evidence.visibility.p95Ms<=3000;
  const eligibleInvocations=new Set(visible.map(row=>observed.get(row.requestId).invocationId));
  const firstDeliveries=[...new Map([...deliveries].reverse().filter(d=>d.receivedAt<=measurementCutoffAt&&d.valid&&d.event?.eventType==='invocation.completed'&&d.event.dimensions?.origin==='external'&&eligibleInvocations.has(d.event.subject?.id)).map(d=>[d.event.subject.id,d])).values()];
  evidence.delivery={...summary(firstDeliveries.map(d=>Math.max(0,d.receivedAt-Date.parse(d.event.occurredAt)))),expected:completed.length,received:firstDeliveries.length,censored:completed.length-firstDeliveries.length,p95Scope:firstDeliveries.length===completed.length?'full completed cohort':'received subset only; censored samples prevent a full-cohort pass',thresholdMs:5000,measurement:'first valid ordinary invocation.completed receipt per successful invocation minus occurredAt; full invocation membership, not event count; no test-subscription events'};
  evidence.delivery.pass=firstDeliveries.length===completed.length&&evidence.delivery.p95Ms<=5000;
  evidence.load.achievedSchedulingRate=requests.size/(evidence.load.actualSchedulingDurationMs/1000);evidence.load.rateTolerancePercent=5;evidence.load.scheduleWithinTolerance=Math.abs(evidence.load.achievedSchedulingRate/rate-1)<=0.05;evidence.load.successful=completed.length;evidence.load.failed=requests.size-completed.length;evidence.pollErrors=pollErrors;
  const latest=await api('GET',queryBase+'&includeTotal=true'); evidence.queryCapacity={gatewayInvocations:latest.data.total,requested:requests.size,firstPageSize:latest.data.items.length,partialBacklog:visible.length!==completed.length};
  evidence.queries=[];
  for(const [name,url] of [['detail',latest.data.items.length?obs+'/invocations/'+latest.data.items[0].invocationId:null],['list',queryBase],['summary',`${obs}/statistics/summary?scope=http_ingress&origin=external&runtimeAssetId=${assetId}`]]){
    if(!url)continue;const times=[];for(let i=0;i<20;i++){
      const begin=performance.now();const response=await api('GET',url);times.push(performance.now()-begin);
      const checkItem=item=>{assert.equal(item.runtimeAssetId,assetId);assert.equal(item.lifecycle,'finished');assert.equal(item.outcome,'success');assert.ok(completed.some(row=>row.requestId===item.requestId&&observed.get(row.requestId)?.invocationId===item.invocationId),'query item must belong to completed cohort');};
      if(name==='detail'){assert.equal(response.data.invocationId,latest.data.items[0].invocationId);checkItem(response.data);}
      if(name==='list'){assert.equal(response.data.items.length,Math.min(200,completed.length));assert.equal(new Set(response.data.items.map(item=>item.invocationId)).size,response.data.items.length);response.data.items.forEach(checkItem);}
      if(name==='summary'){assert.equal(response.data.metrics.selectedInvocations,completed.length);assert.equal(response.data.metrics.successes,completed.length);assert.equal(response.data.metrics.failures,0);}
    }const result={name,...summary(times),correctnessPassed:true,thresholdMs:2000};result.pass=result.p95Ms<=2000;evidence.queries.push(result);
  }
  evidence.resources=resourceCurve;evidence.resourceBoundary='Host CPU/free-memory and generator memory; isolated IPC samples API memory, producer health and event-loop delay every second. Cumulative inclusive phase timers include waiting and overlap, so their totals must not be added. Sampling/timing adds diagnostic overhead and is not a production health endpoint.';
  evidence.producerAfterMeasurement = await diagnostics('snapshot');
  evidence.captureOverhead={status:'NOT_MEASURED',reason:'No equivalent uninstrumented Gateway product switch exists; direct upstream timing would include authentication/routing differences and cannot isolate capture overhead.'};
  evidence.measurementComplete=true;evidence.thresholdsPassed=evidence.load.allAttemptsRecorded&&evidence.load.successRequestIdsUnique&&evidence.load.scheduleWithinTolerance&&evidence.load.failed===0&&evidence.visibility.pass&&evidence.delivery.pass&&evidence.queries.every(q=>q.pass);
  fs.writeFileSync(path.join(workDir,'samples.json'),JSON.stringify({requests:[...requests.values()],observed:[...observed.entries()],deliveries},null,2));
  // The final decision also requires source integrity and clean shutdown.
}
function sourceIntegrity() {
  const directory=path.join(workDir,'audit'), sequences=new Map(), finished=new Set();
  let count=0, bytes=0, parseFailures=0, duplicates=0, finishedGatewayRecords=0;
  for(const name of fs.existsSync(directory)?fs.readdirSync(directory):[]) {
    if(!/^calls-v2-.*\.jsonl$/.test(name))continue;
    const raw=fs.readFileSync(path.join(directory,name));bytes+=raw.length;
    for(const line of raw.toString('utf8').split('\n')) { if(!line.trim())continue;try {
      const row=JSON.parse(line), seq=Number(row.sourceSequence), pid=row.processId;
      if(!Number.isSafeInteger(seq)||seq<1||!pid)throw new Error('invalid source sequence');
      if(!sequences.has(pid))sequences.set(pid,new Set());const seen=sequences.get(pid);if(seen.has(seq))duplicates++;seen.add(seq);count++;
      if(row.phase==='finished'&&row.spanKind==='gateway_request'&&row.origin==='external'){finishedGatewayRecords++;finished.add(row.requestId);}
    } catch {parseFailures++;} }
  }
  const processes=[...sequences].map(([processId,seen])=>{const ordered=[...seen].sort((a,b)=>a-b);return {processId,count:seen.size,min:ordered[0],max:ordered.at(-1),missingWithinRange:ordered.at(-1)-ordered[0]+1-seen.size};});
  const health=evidence.producerFlushed?.health;const producer=health?sequences.get(health.processId):undefined;
  const successes=[...requests.values()].filter(successfulRequest);
  return {count,bytes,parseFailures,duplicateSequences:duplicates,processes,finishedGatewayRecords,
    successfulGatewayTerminalRecords:successes.filter(row=>finished.has(row.requestId)).length,successfulGatewayExpected:successes.length,
    missingWithinObservedSequenceRange:processes.reduce((n,p)=>n+p.missingWithinRange,0),
    missingThroughProducerSequence:Number.isSafeInteger(health?.currentSourceSequence)?health.currentSourceSequence-(producer?.size||0):null,
    boundary:'Source files after producer flush/shutdown; visibility and delivery latency remain fixed at the earlier measurement endpoint.'};
}
async function finish(){
  polling=false;if(curveTimer)clearInterval(curveTimer);
  fs.writeFileSync(path.join(workDir,'samples.json'),redact(JSON.stringify({requests:[...requests.values()],observed:[...observed.entries()],deliveries},null,2)));
  evidence.resources=resourceCurve;
  if(apiProcess?.exitCode===null && apiProcess.connected) {
    try { evidence.producerFlushed = await diagnostics('flush'); } catch(error) { evidence.producerFlushError=redact(error.message); }
    const exited=new Promise(resolve=>{const timer=setTimeout(()=>{apiProcess.removeListener('exit',done);resolve(false);},shutdownTimeoutMs);function done(code,signal){clearTimeout(timer);evidence.apiExit={code,signal};resolve(code===0&&signal===null);}apiProcess.once('exit',done);});
    apiProcess.send({type:'obs-perf-diagnostics',command:'shutdown'},()=>{});
    evidence.gracefulShutdown=await exited;
  }
  evidence.producerCurve=producerCurve;
  for(const child of children)if(child.exitCode===null){if(process.platform==='win32')spawnSync('taskkill',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});else child.kill('SIGTERM');}
  for(const server of [...upstreams.map(u=>u.server),receiver].filter(Boolean)){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(pgStarted){await delay(300);await pgRun('pg_ctl',['-D',pgdata,'-m','fast','-w','-t','30','stop']);evidence.postgresStopped=true;}
  const apiLog=path.join(workDir,'api.log');if(fs.existsSync(apiLog))fs.writeFileSync(apiLog,redact(fs.readFileSync(apiLog,'utf8')));
  await delay(300);evidence.cleanup={};for(const [name,portNumber] of Object.entries(evidence.ports||{})){try{await fetch(`http://127.0.0.1:${portNumber}/health`,{signal:AbortSignal.timeout(1000)});evidence.cleanup[name]=false;}catch{evidence.cleanup[name]=true;}}
  if(Object.values(evidence.cleanup).some(value=>!value)){evidence.measurementComplete=false;process.exitCode=1;}
  if(!Number.isSafeInteger(evidence.producerFlushed?.health?.currentSourceSequence)||evidence.gracefulShutdown!==true) { evidence.measurementComplete=false; evidence.thresholdsPassed=false; process.exitCode=1; }
  evidence.sourceIntegrity = sourceIntegrity();
  fs.writeFileSync(path.join(workDir,'audit-source-summary.json'),JSON.stringify(evidence.sourceIntegrity,null,2));
  if(evidence.sourceIntegrity.successfulGatewayTerminalRecords!==evidence.sourceIntegrity.successfulGatewayExpected || evidence.sourceIntegrity.parseFailures || evidence.sourceIntegrity.missingWithinObservedSequenceRange || evidence.sourceIntegrity.missingThroughProducerSequence || evidence.sourceIntegrity.duplicateSequences || evidence.producerFlushed?.health?.droppedRecords || evidence.producerFlushed?.health?.writeFailures || evidence.producerFlushError || evidence.gracefulShutdown===false) { evidence.thresholdsPassed=false; if(process.exitCode!==1)process.exitCode=2; }
  evidence.receiverIntegrity={allSignaturesValid:deliveries.length>0&&deliveries.every(row=>row.valid),allEventsParsed:deliveries.length>0&&deliveries.every(row=>row.event&&typeof row.event==='object')};
  Object.assign(evidence,assessObservabilityAcceptance(evidence,{enforceTimingGates}));
  if(process.exitCode!==1)process.exitCode=evidence.acceptancePassed?0:2;
  evidence.finishedAt=new Date().toISOString();save();console.log(`OBS_16_04_PERFORMANCE_${evidence.measurementComplete?'MEASURED':'ERROR'} ${evidencePath}`);
}
main().catch(e=>{evidence.error=redact(e.stack);console.error(redact(e.message));process.exitCode=1;}).finally(finish);
