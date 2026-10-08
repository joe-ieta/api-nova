// OBS-16-04: actual authenticated Gateway, automatic collector/outbox/delivery workers.
// No manual runOnce; reports unmet thresholds and censored samples honestly.
// Each run owns a fresh SQLite database and loopback ports. No existing service or data is used.
'use strict';
const assert = require('node:assert/strict');
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
let apiBase, token, apiProcess, receiver, polling = false, curveTimer, pgStarted = false;
const postgres = process.argv.includes('--postgres');
const pgdata = path.join(workDir, 'pgdata');
const deliveries = [], observed = new Map(), requests = new Map(), resourceCurve = [];
const responseText = JSON.stringify({ ok: true, padding: 'x'.repeat(4000) });
const smoke = process.argv.includes('--smoke');
const rate = smoke ? 2 : 100;
const durationSeconds = Number(process.env.OBS_PERF_DURATION_SECONDS || (smoke ? 10 : 30));
const tailSeconds = Number(process.env.OBS_PERF_TAIL_SECONDS || 60);
assert.ok(Number.isInteger(durationSeconds) && durationSeconds >= 10 && durationSeconds <= 120);
assert.ok(Number.isInteger(tailSeconds) && tailSeconds >= 10 && tailSeconds <= 300);
const percentile = (values, p = 0.95) => values.length ? [...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1] : null;
const summary = values => ({ count: values.length, p50Ms: percentile(values,0.5), p95Ms: percentile(values), p99Ms: percentile(values,0.99), maxMs: values.length ? Math.max(...values) : null });
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
  return { status: r.status, body: data, headers: Object.fromEntries(r.headers) };
}
async function api(method, url, body, expected = method === 'POST' ? 201 : 200) {
  const r = await request(`${apiBase}/api${url}`, { method, body, headers: token ? { authorization: `Bearer ${token}` } : {} });
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
  const artifactPaths = [__filename, apiEntry,
    path.join(apiDir, 'dist/src/modules/asset-catalog/services/asset-catalog.service.js'),
    path.join(apiDir, 'dist/src/modules/gateway-runtime/services/gateway-security.service.js'),
    path.join(apiDir, 'dist/src/modules/gateway-runtime/services/gateway-candidate-replay-authority.js'),
    path.join(apiDir, 'dist/src/modules/runtime-verification/services/gateway-candidate-replay.service.js')];
  artifactPaths.push(path.join(root,'package-lock.json'), ...['call-observability.worker','call-observability-outbox.service','call-observability-delivery.worker'].flatMap(name=>[path.join(apiDir,'src/modules/call-observability',name+'.ts'),path.join(apiDir,'dist/src/modules/call-observability',name+'.js')]));
  evidence.artifacts = artifactPaths.map(file => ({ path: path.relative(root, file), sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
  evidence.workingTree = spawnSync('git', ['status', '--short', '--untracked-files=no'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout.trim();
  evidence.machine = { platform: process.platform, release: os.release(), architecture: os.arch(), cpuModel: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem(), freeMemoryBytes: os.freemem(), reference: '4 cores / 8 GiB / SSD; this host is not constrained to that reference', diskMedium: 'not independently verified' };
  evidence.load = { requestsPerSecond: rate, smoke, durationSeconds, tailSeconds, responseBytes: Buffer.byteLength(responseText), requestBodyBytes: 0, capture: 'default body capture', subscription: 'one invocation.completed per external gateway_request', automaticWorkers: true };
  evidence.notCovered = ['production hardware/identity/network', 'Linux/PostgreSQL performance', 'MCP performance', 'fixed uninstrumented baseline: no product switch disables producer instrumentation; direct upstream latency is not incremental capture overhead', 'long sustained capacity and thermal steady-state'];
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
  const log = fs.openSync(path.join(workDir, 'api.log'), 'w'); apiProcess = spawn(process.execPath, [apiEntry], { cwd: apiDir, env, stdio: ['ignore', log, log], windowsHide: true }); children.push(apiProcess); fs.closeSync(log);
  await step('isolated.start', async () => {
    const until = Date.now() + 90000; while (Date.now() < until) { if (apiProcess.exitCode !== null) throw new Error(`API exited ${apiProcess.exitCode}; see ${workDir}/api.log`);
      try { const r = await request(`${apiBase}/api/health/ready`); if (r.status === 200 && r.body.status === 'ready') return { port: apiPort }; } catch {} await delay(300); }
    throw new Error('API readiness timeout');
  });
  const login = await api('POST', '/auth/login', { username: 'extclosureadmin', password }, 200); token = login.accessToken; assert.ok(token); secrets.push(token);
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
  polling=true;
  const queryBase=`${obs}/invocations?runtimeAssetId=${assetId}&spanKind=gateway_request&origin=external&limit=200`;
  const pollErrors=[];
  let historyCursor;
  const recordPage = page => { const at=Date.now();for(const item of page.data.items){if(item.lifecycle==='finished' && !observed.has(item.requestId)) observed.set(item.requestId,{at,completedAt:Date.parse(item.completedAt),invocationId:item.invocationId});} };
  // Observe the newest page and one historical page per poll. Cursor snapshots are
  // exhausted and renewed, so late old records cannot hide behind the newest 200.
  // First visibility is always the real HTTP observation time, never backdated.
  const poller=(async()=>{while(polling){try{
    const page=await api('GET',queryBase);recordPage(page);
    const cursor=historyCursor||page.data.nextCursor;
    if(cursor){const historical=await api('GET',queryBase+'&cursor='+encodeURIComponent(cursor));recordPage(historical);historyCursor=historical.data.nextCursor;}
  }catch(e){pollErrors.push(redact(e.message));historyCursor=undefined;}await delay(100);}})();
  curveTimer=setInterval(()=>resourceCurve.push({at:Date.now(),hostFreeMemoryBytes:os.freemem(),loadGenerator:process.memoryUsage(),observed:observed.size,received:deliveries.length,hostCpuTimes:os.cpus().reduce((sum,c)=>({idle:sum.idle+c.times.idle,total:sum.total+Object.values(c.times).reduce((a,b)=>a+b,0)}),{idle:0,total:0})}),1000);
  const start=performance.now(),wallStart=Date.now(),load=[];
  for(let i=0;i<durationSeconds*rate;i++){
    const due=start+i*1000/rate; if(performance.now()<due)await delay(due-performance.now());
    load.push((async()=>{const sent=Date.now(),begin=performance.now();try{const r=await request(apiBase+'/api/v1/gateway/perf/payload',{headers:{'x-api-key':key}}); const row={sent,completed:Date.now(),durationMs:performance.now()-begin,status:r.status,requestId:r.headers['x-request-id'],scheduledOffsetMs:i*1000/rate,schedulingLagMs:Math.max(0,begin-due)}; requests.set(row.requestId||'failed-'+i,row); if(r.status!==200)row.error=redact(JSON.stringify(r.body)).slice(0,250); }catch(e){requests.set('failed-'+i,{sent,status:0,error:e.message});}})());
  }
  evidence.load.actualSchedulingDurationMs=performance.now()-start;await Promise.all(load); evidence.load.actualCompletionDurationMs=performance.now()-start; evidence.load.startedAt=new Date(wallStart).toISOString(); console.log(`LOAD_COMPLETE ${requests.size}`); save();
  const tailUntil=Date.now()+tailSeconds*1000;
  while(Date.now()<tailUntil){if(observed.size>=requests.size&&deliveries.length>=requests.size)break;await delay(1000);}
  polling=false;await poller;clearInterval(curveTimer);
  const completed=[...requests.values()].filter(r=>r.status===200), visible=completed.filter(r=>observed.has(r.requestId));
  evidence.requestLatency=summary(completed.map(r=>r.durationMs)); evidence.schedulingLag=summary(completed.map(r=>r.schedulingLagMs));
  evidence.visibility={...summary(visible.map(r=>Math.max(0,observed.get(r.requestId).at-observed.get(r.requestId).completedAt))),expected:completed.length,observed:visible.length,censored:completed.length-visible.length,p95Scope:visible.length===completed.length?'full completed cohort':'observed subset only; censored samples prevent a full-cohort pass',thresholdMs:3000,measurement:'HTTP metadata first observed minus recorded terminal completion; 100ms idle poll plus current/historical HTTP page durations add observation delay; rotating bounded pages include late older records'};
  evidence.visibility.pass=visible.length===completed.length&&evidence.visibility.p95Ms<=3000;
  const eligibleInvocations=new Set(visible.map(row=>observed.get(row.requestId).invocationId));
  const firstDeliveries=[...new Map([...deliveries].reverse().filter(d=>d.valid&&d.event?.eventType==='invocation.completed'&&d.event.dimensions?.origin==='external'&&eligibleInvocations.has(d.event.subject?.id)).map(d=>[d.event.eventId,d])).values()];
  evidence.delivery={...summary(firstDeliveries.map(d=>Math.max(0,d.receivedAt-Date.parse(d.event.occurredAt)))),expected:completed.length,received:firstDeliveries.length,censored:completed.length-firstDeliveries.length,p95Scope:firstDeliveries.length===completed.length?'full completed cohort':'received subset only; censored samples prevent a full-cohort pass',thresholdMs:5000,measurement:'healthy receiver receipt minus ordinary event occurredAt; receiver adds loopback HTTP response overhead; no test-subscription events'};
  evidence.delivery.pass=firstDeliveries.length===completed.length&&evidence.delivery.p95Ms<=5000;
  evidence.load.achievedSchedulingRate=requests.size/(evidence.load.actualSchedulingDurationMs/1000);evidence.load.successful=completed.length;evidence.load.failed=requests.size-completed.length;evidence.pollErrors=pollErrors;
  const latest=await api('GET',queryBase+'&includeTotal=true'); evidence.queryCapacity={gatewayInvocations:latest.data.total,requested:requests.size,firstPageSize:latest.data.items.length,partialBacklog:visible.length!==completed.length};
  evidence.queries=[];
  for(const [name,url] of [['detail',latest.data.items.length?obs+'/invocations/'+latest.data.items[0].invocationId:null],['list',queryBase],['summary',`${obs}/statistics/summary?scope=http_ingress&runtimeAssetId=${assetId}`]]){
    if(!url)continue;const times=[];for(let i=0;i<20;i++){const begin=performance.now();await api('GET',url);times.push(performance.now()-begin);}const result={name,...summary(times),thresholdMs:2000};result.pass=result.p95Ms<=2000;evidence.queries.push(result);
  }
  evidence.resources=resourceCurve;evidence.resourceBoundary='Host CPU/free-memory plus load-generator memory only; API process memory is not claimed';
  evidence.captureOverhead={status:'NOT_MEASURED',reason:'No equivalent uninstrumented Gateway product switch exists; direct upstream timing would include authentication/routing differences and cannot isolate capture overhead.'};
  evidence.measurementComplete=true;evidence.thresholdsPassed=evidence.load.failed===0&&evidence.visibility.pass&&evidence.delivery.pass&&evidence.queries.every(q=>q.pass);
  fs.writeFileSync(path.join(workDir,'samples.json'),JSON.stringify({requests:[...requests.values()],observed:[...observed.entries()],deliveries},null,2));
  if(!evidence.thresholdsPassed)process.exitCode=2;
}
async function finish(){
  polling=false;if(curveTimer)clearInterval(curveTimer);
  fs.writeFileSync(path.join(workDir,'samples.json'),redact(JSON.stringify({requests:[...requests.values()],observed:[...observed.entries()],deliveries},null,2)));
  evidence.resources=resourceCurve;
  for(const child of children)if(child.exitCode===null){if(process.platform==='win32')spawnSync('taskkill',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});else child.kill('SIGTERM');}
  for(const server of [...upstreams.map(u=>u.server),receiver].filter(Boolean)){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(pgStarted){await delay(300);await pgRun('pg_ctl',['-D',pgdata,'-m','fast','-w','-t','30','stop']);evidence.postgresStopped=true;}
  const apiLog=path.join(workDir,'api.log');if(fs.existsSync(apiLog))fs.writeFileSync(apiLog,redact(fs.readFileSync(apiLog,'utf8')));
  await delay(300);evidence.cleanup={};for(const [name,portNumber] of Object.entries(evidence.ports||{})){try{await fetch(`http://127.0.0.1:${portNumber}/health`,{signal:AbortSignal.timeout(1000)});evidence.cleanup[name]=false;}catch{evidence.cleanup[name]=true;}}
  if(Object.values(evidence.cleanup).some(value=>!value)){evidence.measurementComplete=false;process.exitCode=1;}
  evidence.finishedAt=new Date().toISOString();save();console.log(`OBS_16_04_PERFORMANCE_${evidence.measurementComplete?'MEASURED':'ERROR'} ${evidencePath}`);
}
main().catch(e=>{evidence.error=redact(e.stack);console.error(redact(e.message));process.exitCode=1;}).finally(finish);
