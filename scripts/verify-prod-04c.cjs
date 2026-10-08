'use strict';
// PROD-04C: complete binary sample lifecycle against isolated PostgreSQL and real HTTP.
// Requires built api-nova-api and PostgreSQL initdb/pg_ctl on PATH (or API_NOVA_TEST_PG_BIN).
// No existing database is used. Time advancement is explicit fixture SQL in this owned database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { Client } = require('pg');
const root = path.resolve(__dirname, '..');
const apiDir = path.join(root, 'packages/api-nova-api');
const apiEntry = path.join(apiDir, 'dist/src/main.js');
// A separate process executes the real object-store primitives, exposing only IPC test barriers.
// It neither replaces service methods nor touches any database outside the parent-owned cluster.
if (process.argv[2] === '--fence-worker') {
  process.env.DB_TYPE='postgres'; require('reflect-metadata');
  const { DataSource }=require('typeorm');
  const { EndpointTestSampleObjectEntity }=require(path.join(apiDir,'dist/src/database/entities/endpoint-test-sample-object.entity.js'));
  const { EndpointTestSampleObjectService }=require(path.join(apiDir,'dist/src/modules/endpoint-testing/services/endpoint-test-sample-object.service.js'));
  const config=JSON.parse(process.argv[3]); let connection;
  (async()=>{
    connection=await new DataSource({type:'postgres',host:'127.0.0.1',port:Number(process.env.DB_PORT),username:process.env.DB_USERNAME,database:'postgres',entities:[EndpointTestSampleObjectEntity],synchronize:false,extra:{application_name:config.applicationName}}).initialize();
    const service=new EndpointTestSampleObjectService(connection.getRepository(EndpointTestSampleObjectEntity));
    await service.withSampleFence(config.sampleId,async()=>{
      const staged=config.stage ? await service.prepare(config.sampleId,Buffer.from([0,255,128,1]),'application/octet-stream','decoded_response_body') : undefined;
      process.send({phase:'held',staged});
      await new Promise(resolve=>process.once('message',resolve));
      await service.assertSampleFence(config.sampleId);
      process.send({phase:'unexpected-live'});
    });
  })().catch(e=>process.send?.({phase:'fence-error',code:e.code||e.message})).finally(async()=>{await connection?.destroy().catch(()=>{});process.disconnect?.();});
  return;
}
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const workDir = fs.realpathSync.native(fs.mkdtempSync(path.join(root, '.tmp/prod-04c-')));
const objectDir = path.join(workDir, 'sample-objects'); fs.mkdirSync(objectDir);
const obsDir = path.join(workDir, 'observability'); fs.mkdirSync(obsDir);
const sentinel = path.join(obsDir, 'independent-retention-sentinel'); fs.writeFileSync(sentinel, 'OBS retention must remain independent');
const pgdata = path.join(workDir, 'pgdata');
const registryPath = path.join(workDir, 'registry.json');
const evidencePath = path.join(workDir, 'evidence.json');
const secrets = [], children = [];
const evidence = { marker: 'PROD_04C_LOCAL_PG_HTTP_V1', startedAt: new Date().toISOString(), platform: process.platform, node: process.version,
  commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout.trim(), steps: [], fixtures: [],
  notCovered: ['production deployment identity and filesystem ACL approval', 'Linux filesystem lifecycle', 'binary-exact comparison (unsupported by contract)', 'MCP real binary candidate outbound'] };
let pgStarted = false, db, upstream, env, apiBase, token, readerToken, currentChild;
const bytes = Buffer.from([0x89,0x50,0x4e,0x47,0,0xff,0x80,1,2,3,4,5]);
const cases = {
  '/binary': { body: bytes, type: 'image/png' },
  '/pdf': { body: Buffer.concat([Buffer.from('%PDF-'), bytes]), type: 'application/pdf' },
  '/boundary': { body: Buffer.alloc(1024, 0xf1), type: 'application/octet-stream' },
  '/over': { body: Buffer.alloc(1025, 0xf2), type: 'application/octet-stream', chunks: true },
  '/gzip': { body: bytes, type: 'application/octet-stream', gzip: true },
  '/unknown': { body: bytes, type: 'application/x-unknown-binary' },
  '/badlength': { body: bytes, type: 'application/octet-stream', badLength: true },
};
const received = [];
const hash = b => createHash('sha256').update(b).digest('hex');
const delay = ms => new Promise(r => setTimeout(r, ms));
function redact(value) { let out = String(value); for (const secret of secrets) if (secret) out = out.split(secret).join('[redacted]'); return out; }
function save() { fs.writeFileSync(evidencePath, redact(JSON.stringify(evidence, null, 2))); }
async function step(id, fn) { try { const details = await fn(); evidence.steps.push({ id, passed: true, details }); console.log(`PASS ${id}`); save(); return details; }
 catch(e) { evidence.steps.push({ id, passed: false, error: redact(e.message) }); save(); throw e; } }
async function port() { const s = http.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function request(url, { method = 'GET', body, auth = token, headers = {}, binary = false } = {}) {
  const r = await fetch(url, { method, headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(45000) });
  const raw = Buffer.from(await r.arrayBuffer()); let data = raw; if (!binary) { try { data = JSON.parse(raw.toString()); } catch { data = raw.toString(); } }
  return { status: r.status, body: data, headers: Object.fromEntries(r.headers) };
}
async function api(method, url, body, expected = method === 'POST' ? 201 : 200, base = apiBase) {
  const r = await request(base + '/api' + url, { method, body }); assert.equal(r.status, expected, `${method} ${url}: ${r.status} ${redact(JSON.stringify(r.body)).slice(0,2000)}`); return r.body;
}
const sampleUrl = id => '/v1/endpoint-testing/test-samples/' + encodeURIComponent(id);
async function download(id, expected, auth = token) { const r = await request(apiBase + '/api' + sampleUrl(id) + '/binary-content', { auth, binary: true }); assert.equal(r.status, expected, `download ${id}: ${r.status} ${r.body.toString().slice(0,400)}`); return r; }
function pgTool(name) { return process.env.API_NOVA_TEST_PG_BIN ? path.join(process.env.API_NOVA_TEST_PG_BIN, name + (process.platform === 'win32' ? '.exe' : '')) : name; }
async function pgRun(name, args) {
  const pgEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^PG|^DATABASE_URL$/i.test(k)));
  const log = fs.openSync(path.join(workDir, 'pg-tools.log'), 'a');
  const child = spawn(pgTool(name), args, { env: pgEnv, windowsHide: true, stdio: ['ignore',log,log] }); fs.closeSync(log);
  await new Promise((resolve,reject) => { child.once('error',reject); child.once('exit',code => code === 0 ? resolve() : reject(new Error(`${name} exited ${code}; see pg-tools.log`))); });
}
async function startApi(label) {
  const apiPort = await port(), mcpPort = await port(), base = `http://127.0.0.1:${apiPort}`;
  const log = fs.openSync(path.join(workDir, `api-${label}.log`), 'w');
  const child = spawn(process.execPath, [apiEntry], { cwd: apiDir, env: { ...env, PORT: String(apiPort), MCP_PORT: String(mcpPort), MCP_SERVER_PORT: String(mcpPort), API_BASE_URL: base, PID_DIRECTORY: path.join(workDir, 'pids-' + label), LOG_DIRECTORY: path.join(workDir, 'logs-' + label) }, windowsHide: true, stdio: ['ignore',log,log] }); children.push(child); fs.closeSync(log);
  const until = Date.now() + 90000;
  while (Date.now() < until) { if (child.exitCode !== null) throw new Error(`API ${label} exited ${child.exitCode}`); try { const r = await request(base + '/api/health/ready', { auth: null }); if (r.status === 200 && r.body.status === 'ready') return { child, base, apiPort }; } catch {} await delay(300); }
  throw new Error(`API ${label} readiness timeout`);
}
async function stopApi(child) {
  if (child && child.exitCode === null && child.signalCode === null) {
    const done = new Promise(resolve => child.once('exit', resolve));
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); else child.kill('SIGTERM');
    await Promise.race([done, delay(10000)]); assert.ok(child.exitCode !== null || child.signalCode !== null, 'owned API did not stop');
  }
}
async function capture(record) {
  const before = (await api('GET', `/v1/endpoint-testing/endpoints/${record.id}/test-samples`)).data.map(s => s.id);
  const result = await api('POST', `/v1/assets/endpoints/${record.id}/test`, { sourceServiceInstanceId: record.instanceId, environment: 'prod04c' }); assert.equal(result.test.passed, true, JSON.stringify(result));
  const list = (await api('GET', `/v1/endpoint-testing/endpoints/${record.id}/test-samples`)).data; const sample = list.find(s => !before.includes(s.id)); assert.ok(sample); return sample;
}
async function objectFor(id) { return (await db.query('SELECT * FROM endpoint_test_sample_objects WHERE "sampleId"=$1', [id])).rows[0]; }
async function ageSample(id) {
  const date = new Date(Date.now()-91*86400000).toISOString(); await db.query('UPDATE endpoint_test_samples SET "capturedAt"=$1 WHERE id=$2', [date,id]); evidence.fixtures.push({ kind:'retention-age', sampleId:id, capturedAt:date, reason:'explicit owned-database 91-day fixture; no production clock/policy change' });
}
async function ageRevocation(id) {
  const row = (await db.query('SELECT "responsePayload" FROM endpoint_test_samples WHERE id=$1',[id])).rows[0];
  const payload = typeof row.responsePayload === 'string' ? JSON.parse(row.responsePayload) : row.responsePayload;
  assert.equal(payload.deletionState,'pending'); payload.deletionRequestedAt = new Date(Date.now()-6*60000).toISOString();
  await db.query('UPDATE endpoint_test_samples SET "responsePayload"=$1 WHERE id=$2',[JSON.stringify(payload),id]); evidence.fixtures.push({kind:'revocation-grace',sampleId:id,deletionRequestedAt:payload.deletionRequestedAt,reason:'explicit owned-database six-minute fixture'});
}
async function fenceWorker(sampleId,stage=false) {
  const applicationName='prod04c-fence-'+randomUUID();
  const child=spawn(process.execPath,[__filename,'--fence-worker',JSON.stringify({sampleId,stage,applicationName})],{cwd:root,env,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']}); children.push(child);
  const messages=[]; child.on('message',m=>messages.push(m));
  async function wait(phase){const until=Date.now()+15000;while(Date.now()<until){const m=messages.find(m=>m.phase===phase);if(m)return m;if(child.exitCode!==null)throw new Error('Fence worker exited before '+phase);await delay(30);}throw new Error('Fence worker timeout '+phase);}
  return {child,applicationName,held:await wait('held'),wait};
}
async function main() {
  assert.ok(fs.existsSync(apiEntry),'Build api-nova-api first');
  evidence.artifacts = [__filename,apiEntry,path.join(apiDir,'dist/src/modules/endpoint-testing/services/endpoint-testing.service.js'),path.join(apiDir,'dist/src/modules/endpoint-testing/services/endpoint-test-sample-object.service.js'),path.join(apiDir,'dist/src/modules/asset-catalog/services/binary-test-response.js'),path.join(apiDir,'dist/src/modules/runtime-verification/services/runtime-verification.service.js')].map(p=>({path:path.relative(root,p),sha256:hash(fs.readFileSync(p))}));
  await step('isolated.postgresql_migrations', async()=>{
    const pgPort = await port(); await pgRun('initdb',['-D',pgdata,'-U','prod04c_fixture','--auth=trust','--no-locale','--encoding=UTF8']);
    fs.appendFileSync(path.join(pgdata,'postgresql.conf'),`\nlisten_addresses = '127.0.0.1'\nport = ${pgPort}\nmax_connections = 40\nfsync = on\nsynchronous_commit = on\n`);
    fs.writeFileSync(path.join(pgdata,'pg_hba.conf'),'host all prod04c_fixture 127.0.0.1/32 trust\nlocal all prod04c_fixture trust\n');
    await pgRun('pg_ctl',['-D',pgdata,'-l',path.join(workDir,'postgres.log'),'-w','-t','30','start']); pgStarted=true;
    db = new Client({host:'127.0.0.1',port:pgPort,user:'prod04c_fixture',database:'postgres'}); await db.connect();
    const password='ProdBinary!7'+randomBytes(18).toString('hex'), jwt=randomBytes(32).toString('hex'); secrets.push(password,jwt);
    env={...process.env}; for(const k of Object.keys(env)) if(/^(API_NOVA_|DB_|SUPER_ADMIN_|JWT_|MAIL_|MCP_|ENDPOINT_TEST_SAMPLE_|PG)/i.test(k)) delete env[k];
    Object.assign(env,{NODE_ENV:'test',DB_TYPE:'postgres',DB_HOST:'127.0.0.1',DB_PORT:String(pgPort),DB_USERNAME:'prod04c_fixture',DB_PASSWORD:'',DB_DATABASE:'postgres',DB_SSL:'false',DB_SYNCHRONIZE:'false',DB_LOGGING:'false',JWT_SECRET:jwt,JWT_REFRESH_SECRET:jwt,SUPER_ADMIN_USERNAME:'binaryadmin',SUPER_ADMIN_EMAIL:'binaryadmin@example.invalid',SUPER_ADMIN_PASSWORD:password,
      ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED:'true',ENDPOINT_TEST_SAMPLE_BINARY_DIR:objectDir,ENDPOINT_TEST_SAMPLE_MAX_BYTES:'1024',ENDPOINT_TEST_SAMPLE_RETENTION_DAYS:'90',
      API_NOVA_AUDIT_DIR:path.join(workDir,'audit'),API_NOVA_OBSERVABILITY_DATA_DIR:obsDir,API_NOVA_RUNTIME_CREDENTIAL_SOURCE:'database',API_NOVA_RUNTIME_AUTH_MODE:'api_key',API_NOVA_RUNTIME_REQUIRED_SCOPES:'',API_NOVA_RUNTIME_ALLOW_HTTP_LOOPBACK:'true',API_NOVA_UPSTREAM_CREDENTIAL_FILE:registryPath,API_NOVA_UPSTREAM_CREDENTIAL_FORMAT:'json',API_NOVA_UPSTREAM_CREDENTIAL_ENVIRONMENT:'prod04c',API_NOVA_UPSTREAM_CREDENTIAL_RELOAD_MODE:'manual',THROTTLE_LIMIT:'10000',THROTTLE_TTL:'60',NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost'});
    fs.writeFileSync(registryPath,JSON.stringify({apiVersion:'security.apinova.io/v1',kind:'UpstreamCredentialBindings',metadata:{revision:'bootstrap',environment:'prod04c'},reload:{mode:'manual',debounceMs:0,rejectPlaintextSecrets:true},secretProviders:{},credentials:{},sites:[]}));
    const args=process.platform==='win32'?['/d','/s','/c','npm run migration:run --workspace api-nova-api']:['run','migration:run','--workspace','api-nova-api'];
    const m=spawnSync(process.platform==='win32'?(process.env.ComSpec||'cmd.exe'):'npm',args,{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:300000,maxBuffer:32e6});fs.writeFileSync(path.join(workDir,'migration.log'),redact(`${m.stdout}\n${m.stderr}`));assert.equal(m.status,0,'migrations failed');
    return {port:pgPort,isolated:true,version:(await db.query('SELECT version()')).rows[0].version};
  });
  const started=await startApi('first'); apiBase=started.base;currentChild=started.child;
  token=(await api('POST','/auth/login',{username:'binaryadmin',password:env.SUPER_ADMIN_PASSWORD},200)).accessToken;assert.ok(token);secrets.push(token);
  await step('identity.real_read_only_user',async()=>{
    const permissions=await api('GET','/permissions?limit=100');const list=permissions.data||permissions;const read=list.find(p=>p.name==='server:read');assert.ok(read,JSON.stringify(permissions).slice(0,500));
    const role=await api('POST','/roles',{name:'binary_reader',permissionIds:[read.id],enabled:true});
    const reader=await api('POST','/users',{username:'binaryreader',email:'binaryreader@example.invalid',password:env.SUPER_ADMIN_PASSWORD,status:'active',roleIds:[role.id]});
    await api('PUT',`/users/${reader.id}`,{emailVerified:true});
    readerToken=(await api('POST','/auth/login',{username:'binaryreader',password:env.SUPER_ADMIN_PASSWORD},200)).accessToken;assert.ok(readerToken);secrets.push(readerToken);return {roleId:role.id,permissions:['server:read']};
  });
  upstream=http.createServer((req,res)=>{const route=new URL(req.url,'http://localhost').pathname;received.push(route);const c=cases[route];if(!c){res.writeHead(404);return res.end();}res.setHeader('content-type',c.type);if(c.badLength){res.setHeader('content-length',String(c.body.length+8));res.setHeader('connection','close');return res.end(c.body);}if(c.gzip){res.setHeader('content-encoding','gzip');return res.end(gzipSync(c.body));}if(c.chunks){res.write(c.body.subarray(0,512));return res.end(c.body.subarray(512));}res.end(c.body);});
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));const upstreamPort=upstream.address().port, upstreamUrl=`http://127.0.0.1:${upstreamPort}`;
  const records={},samples={};
  await step('capture.real_http_binary_matrix',async()=>{
    const spec={openapi:'3.0.3',info:{title:'Binary lifecycle source',version:'1.0.0'},paths:Object.fromEntries(Object.keys(cases).map(p=>[p,{get:{operationId:'binary'+p.replace(/\W/g,''),responses:{'200':{description:'Binary response',content:{'application/octet-stream':{schema:{type:'string',format:'binary'}}}}}}}]))};
    const doc=await api('POST','/documents',{name:'Binary lifecycle',content:JSON.stringify(spec),status:'valid'});
    const endpoints=(await api('GET','/v1/assets/endpoints')).data.filter(e=>e.metadata?.documentId===doc.id);assert.equal(endpoints.length,Object.keys(cases).length);
    const source=(await api('GET',`/v1/assets/endpoints/${endpoints[0].id}`)).sourceServiceAsset.id;
    const instance=await api('POST',`/v1/assets/source-services/${source}/instances`,{name:'binary-live',environment:'prod04c',scheme:'http',host:'127.0.0.1',port:upstreamPort,basePath:'/',enabled:true,isDefault:true});
    for(const [p,c] of Object.entries(cases)){
      const endpoint=endpoints.find(e=>e.path===p);assert.ok(endpoint);
      const rec={id:endpoint.id,source,instanceId:instance.id,path:p};records[p]=rec;
      if(c.badLength) continue;
      await api('POST',`/v1/assets/source-services/${rec.source}/instances/${instance.id}/probe`,{});await api('POST',`/v1/assets/endpoints/${rec.id}/probe`,{});
      const s=await capture(rec);samples[p]=s;const d=s.responsePayload;
      if(p==='/unknown'){assert.equal(d.captureState,'unavailable');assert.equal(d.reason,'untrusted_media_type');assert.equal(d?.opaqueObjectId,undefined);assert.equal(await objectFor(s.id),undefined);await download(s.id,404);continue;}
      assert.equal(d.kind,'binary');assert.equal(d.measurement,'decoded_response_body');assert.equal(d.preview,undefined);
      if(p==='/over'){assert.equal(d.captureState,'too_large');assert.equal(d.isComplete,false);assert.equal(d.sha256,null);assert.equal(d.opaqueObjectId,undefined);continue;}
      assert.equal(d.captureState,'stored');assert.equal(d.observedBytes,c.body.length);assert.equal(d.sha256,hash(c.body));assert.deepEqual((await download(s.id,200)).body,c.body);
      assert.deepEqual(s.tags||[],[]);const runs=(await api('GET',`/v1/endpoint-testing/endpoints/${rec.id}/test-runs`)).data;assert.equal(runs[0].responsePayload.opaqueObjectId,undefined,'run must not own object reference');
    }
    return Object.fromEntries(Object.entries(samples).map(([p,s])=>[p,{id:s.id,descriptor:s.responsePayload}]));
  });
  await step('capture.incorrect_content_length_does_not_create_complete_sample',async()=>{
    const rec=records['/badlength'];const before=(await db.query('SELECT count(*) AS count FROM endpoint_test_sample_objects')).rows[0].count;
    const r=await api('POST',`/v1/assets/endpoints/${rec.id}/test`,{sourceServiceInstanceId:rec.instanceId,environment:'prod04c'});assert.equal(r.test.passed,false);
    const samples=(await api('GET',`/v1/endpoint-testing/endpoints/${rec.id}/test-samples`)).data;assert.equal(samples.length,0);
    const runs=(await api('GET',`/v1/endpoint-testing/endpoints/${rec.id}/test-runs`)).data;assert.equal(runs.length,1);assert.equal(runs[0].status,'failed');assert.equal(runs[0].responsePayload?.sha256,undefined);
    assert.equal((await db.query('SELECT count(*) AS count FROM endpoint_test_sample_objects')).rows[0].count,before);return {upstreamSentBytes:bytes.length,declaredBytes:bytes.length+8,result:r.test,createdSamples:0,createdObjects:0};
  });
  await step('download.real_authorization_and_safe_headers',async()=>{
    const id=samples['/binary'].id;await download(id,401,null);await download(id,401,'invalid');await download(id,403,readerToken);await download(randomUUID(),403,readerToken);await download(randomUUID(),404);await download(samples['/binary'].responsePayload.opaqueObjectId,404);
    const read=await request(apiBase+`/api/v1/endpoint-testing/endpoints/${records['/binary'].id}/test-samples`,{auth:readerToken});assert.equal(read.status,200);
    const r=await download(id,200);assert.equal(r.headers['content-type'],'application/octet-stream');assert.equal(r.headers['x-content-type-options'],'nosniff');assert.equal(r.headers['cache-control'],'no-store');assert.match(r.headers['content-disposition'],/^attachment;/);
    const ranged=await request(apiBase+'/api'+sampleUrl(id)+'/binary-content',{headers:{range:'bytes=0-1'}});assert.equal(ranged.status,400);assert.ok(!JSON.stringify(read.body).includes(objectDir));return {denials:[401,401,403,403,404,404],range:400,exactBytes:true};
  });
  // Candidate acceptance is real network traffic; no seeded routes or mocked replay adapters.
  const rec=records['/binary'];let assetId,firstRevision,key;
  await step('gateway.explicit_status_only_candidate_real_outbound',async()=>{
    await api('PATCH',sampleUrl(samples['/binary'].id),{tags:['smoke'],metadata:{responseAssertion:{mode:'status'}}});
    const registry=JSON.parse(fs.readFileSync(registryPath));registry.metadata.revision='binary-live';registry.sites=[{id:'binary-site',sourceServiceAssetId:rec.source,match:{scheme:'http',host:'127.0.0.1',port:upstreamPort,basePath:'/'},allowedHosts:['127.0.0.1'],credential:'none',headerPolicy:{version:1,requestHeaders:[],responseHeaders:[]},endpoints:[{endpointDefinitionId:rec.id}]}];fs.writeFileSync(registryPath,JSON.stringify(registry));const status=await api('GET','/security/upstream-credentials/status');await api('POST','/security/upstream-credentials/reload',{expectedGeneration:status.generation,reason:'Binary lifecycle owned loopback'},200);
    assetId=(await api('POST','/v1/publication/endpoints/runtime-assets',{type:'gateway_service',name:'binary-gateway',servicePrefix:'binaryclosure'})).runtimeAsset.id;
    rec.membershipId=(await api('POST',`/v1/publication/endpoints/runtime-assets/${assetId}/memberships`,{endpointDefinitionIds:[rec.id]})).createdMemberships[0].id;
    await api('PUT',`/v1/publication/endpoints/runtime-memberships/${rec.membershipId}/gateway-route`,{routePath:'/binary',routeMethod:'GET',upstreamPath:'/binary',upstreamMethod:'GET',routeVisibility:'external',authPolicyRef:'api-key-default',upstreamConfig:{headerPolicyMigration:{version:1,mode:'v1',source:'registry'}}});
    await api('PUT',`/v1/publication/endpoints/runtime-memberships/${rec.membershipId}/profile`,{intentName:'binaryRead',descriptionForLlm:'Read binary sample',status:'reviewed'});await api('POST',`/v1/publication/endpoints/runtime-memberships/${rec.membershipId}/publish`,{publishToHttp:true,autoStart:false});
    await api('PUT',`/v1/runtime-memberships/${rec.membershipId}/upstream-binding`,{sourceServiceAssetId:rec.source,environment:'prod04c',selectionMode:'fixed_primary',primaryInstanceId:rec.instanceId,status:'active',candidates:[{sourceServiceInstanceId:rec.instanceId}]});
    key=(await api('POST',`/v1/runtime-assets/${assetId}/runtime-access-credentials`,{name:'Binary consumer',protocols:['gateway'],scopes:[],toolScopes:[]})).apiKey;secrets.push(key,key.split('.').slice(1).join('.'));
    const before=received.length;const result=await api('POST',`/v1/runtime-assets/${assetId}/deploy-gateway`,{publishedOnly:true});assert.equal(result.verification.run.status,'passed',JSON.stringify(result));assert.equal(result.verification.run.activationStatus,'activated');assert.ok(received.length>before);firstRevision=result.verification.run.candidateRevision;
    const saved=await api('GET',`/v1/runtime-assets/${assetId}/verification-runs/${result.verification.run.id}`);const smoke=saved.results.filter(r=>r.kind==='smoke');assert.ok(smoke.length);for(const r of smoke)assert.deepEqual(r.evidence.responsePayload,{omitted:true,reason:'binary_status_only'});
    const call=await request(apiBase+'/api/v1/gateway/binaryclosure/binary',{auth:null,headers:{'x-api-key':key},binary:true});assert.equal(call.status,200);assert.deepEqual(call.body,bytes);return {assetId,run:result.verification.run,realOutboundCount:received.length-before,bodyEvidenceOmitted:true};
  });
  await step('gateway.unchanged_redeploy_reuses_verified_revision',async()=>{
    const runIds=[];
    for(let attempt=0;attempt<2;attempt++){
      const before=received.length;
      const result=await api('POST',`/v1/runtime-assets/${assetId}/deploy-gateway`,{publishedOnly:true});
      assert.equal(result.verification.run.status,'passed',JSON.stringify(result));
      assert.equal(result.verification.run.activationStatus,'activated');
      assert.equal(result.verification.run.candidateRevision,firstRevision);
      assert.ok(received.length>before,'repeat deployment must still execute candidate verification');
      runIds.push(result.verification.run.id);
    }
    assert.notEqual(runIds[0],runIds[1]);
    const rows=await db.query('SELECT id FROM gateway_route_snapshots WHERE "runtimeAssetId"=$1 AND revision=$2',[assetId,firstRevision]);
    assert.equal(rows.rowCount,1,'one immutable snapshot per verified revision');
    const call=await request(apiBase+'/api/v1/gateway/binaryclosure/binary',{auth:null,headers:{'x-api-key':key},binary:true});
    assert.equal(call.status,200);assert.deepEqual(call.body,bytes);
    return {candidateRevision:firstRevision,distinctVerificationRunIds:runIds,persistedSnapshotCount:rows.rowCount,liveConsumerStatus:call.status};
  });
  await step('gateway.unsupported_blocks_before_outbound_preserves_live',async()=>{
    await api('PATCH',sampleUrl(samples['/binary'].id),{metadata:{responseAssertion:{mode:'exact'}}});await delay(1100);const before=received.length;const rejected=await api('POST',`/v1/runtime-assets/${assetId}/deploy-gateway`,{publishedOnly:true},409);const r={verification:rejected.error.details.verification};assert.equal(r.verification.run.status,'blocked',JSON.stringify(r));assert.equal(received.length,before,'unsupported binary candidate must not reach upstream');
    const call=await request(apiBase+'/api/v1/gateway/binaryclosure/binary',{auth:null,headers:{'x-api-key':key},binary:true});assert.equal(call.status,200);assert.deepEqual(call.body,bytes);await api('PATCH',sampleUrl(samples['/binary'].id),{metadata:{responseAssertion:{mode:'status'}},tags:[]});return {blockedRun:r.verification.run,previousRevision:firstRevision,previousRouteStillServed:true};
  });
  await step('gateway.missing_object_blocks_before_outbound',async()=>{
    const id=samples['/binary'].id;await api('PATCH',sampleUrl(id),{tags:['smoke']});const o=await objectFor(id);const file=path.join(objectDir,o.objectKey+'.raw'),backup=file+'.missing-fixture';
    fs.renameSync(file,backup);evidence.fixtures.push({kind:'missing-selected-binary-object',sampleId:id,reason:'temporarily move only owned object; restore after candidate check'});
    let rejected;const before=received.length;
    try {await download(id,503);await delay(1100);rejected=await request(apiBase+`/api/v1/runtime-assets/${assetId}/deploy-gateway`,{method:'POST',body:{publishedOnly:true}});}
    finally {fs.renameSync(backup,file);}
    assert.equal(rejected.status,409,'candidate with missing binary evidence must be blocked');assert.equal(rejected.body.error.details.verification.run.status,'blocked');assert.equal(received.length,before,'missing binary evidence must block before business outbound');
    await download(id,200);await api('PATCH',sampleUrl(id),{tags:[]});return {sampleId:id,status:rejected.status,run:rejected.body.error.details.verification.run};
  });
  let active,archived,fresh;
  await step('retention.active_old_preserved_only_expired_archived_revoked',async()=>{
    active=await capture(rec);archived=await capture(rec);fresh=await capture(rec);await ageSample(active.id);await ageSample(archived.id);await api('POST',sampleUrl(archived.id)+'/archive',{});await api('POST',sampleUrl(fresh.id)+'/archive',{});await download(archived.id,200);
    const result=await api('POST','/v1/endpoint-testing/test-samples/cleanup',{});assert.equal(result.pendingObjectCount,1);assert.equal(result.retentionDays,90);await download(active.id,200);await download(fresh.id,200);await download(archived.id,410);assert.equal((await objectFor(archived.id)).state,'delete_pending');return {active:active.id,expiredArchived:archived.id,freshArchived:fresh.id,result};
  });
  await step('delete.immediate_revocation_idempotence_and_grace',async()=>{
    const id=fresh.id;const first=await api('DELETE',sampleUrl(id));const second=await api('DELETE',sampleUrl(id));assert.equal(first.pending,true);assert.equal(second.pending,true);await download(id,410);
    const cleanup=await api('POST','/v1/endpoint-testing/test-samples/binary-objects/cleanup',{});assert.equal(cleanup.deletedCount,0);assert.ok(cleanup.deferredCount>=2);const obj=await objectFor(id);assert.ok(fs.existsSync(path.join(objectDir,obj.objectKey+'.raw')));return {sampleId:id,cleanup};
  });
  await step('restart.ready_bytes_and_revocation_survive',async()=>{
    await stopApi(currentChild);const restart=await startApi('restart');currentChild=restart.child;apiBase=restart.base;await download(active.id,200);await download(fresh.id,410);await download(archived.id,410);return {processId:currentChild.pid,activeId:active.id,revoked:[fresh.id,archived.id]};
  });
  await step('cleanup.real_pg_two_processes_retry_and_repeat',async()=>{
    await ageRevocation(fresh.id);await ageRevocation(archived.id);const second=await startApi('peer');
    const results=await Promise.all([api('POST','/v1/endpoint-testing/test-samples/binary-objects/cleanup',{}),api('POST','/v1/endpoint-testing/test-samples/binary-objects/cleanup',{},201,second.base)]);
    // Advisory try-lock contention may be reported as a retryable failure; convergence is required.
    const retry=await api('POST','/v1/endpoint-testing/test-samples/binary-objects/cleanup',{});await download(fresh.id,404);await download(archived.id,404);await download(active.id,200);
    for(const id of [fresh.id,archived.id]){const o=await objectFor(id);assert.equal(o.state,'deleted');assert.equal(fs.existsSync(path.join(objectDir,o.objectKey+'.raw')),false);}
    const repeated=await api('POST','/v1/endpoint-testing/test-samples/binary-objects/cleanup',{});assert.equal(repeated.deletedCount,0);assert.equal(repeated.failedCount,0);await stopApi(second.child);return {processes:2,results,retry,repeated};
  });
  await step('cleanup.filesystem_failure_tombstone_then_recovery',async()=>{
    const s=await capture(rec);await api('DELETE',sampleUrl(s.id));await ageRevocation(s.id);const o=await objectFor(s.id),file=path.join(objectDir,o.objectKey+'.raw'),backup=file+'.acceptance-backup';
    assert.ok(file.startsWith(objectDir+path.sep));fs.renameSync(file,backup);fs.mkdirSync(file);evidence.fixtures.push({kind:'unsafe-object-directory',sampleId:s.id,reason:'replace only owned object with a directory to force bounded cleanup rejection'});
    const failed=await api('POST','/v1/endpoint-testing/test-samples/binary-objects/cleanup',{});assert.equal(failed.failedCount,1);assert.equal((await objectFor(s.id)).state,'delete_pending');await download(s.id,410);fs.rmdirSync(file);fs.renameSync(backup,file);
    const retry=await api('POST','/v1/endpoint-testing/test-samples/binary-objects/cleanup',{});assert.equal(retry.deletedCount,1);await download(s.id,404);return {failed,retry};
  });
  await step('postgres.fence_disconnect_cannot_publish_or_delete',async()=>{
    const s=await capture(rec);await api('DELETE',sampleUrl(s.id));await ageRevocation(s.id);const o=await objectFor(s.id);
    const worker=await fenceWorker(s.id);const busy=await api('POST','/v1/endpoint-testing/test-samples/binary-objects/cleanup',{});assert.equal(busy.failedCount,1);assert.equal((await objectFor(s.id)).state,'delete_pending');assert.ok(fs.existsSync(path.join(objectDir,o.objectKey+'.raw')));
    const killed=await db.query('SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE application_name=$1',[worker.applicationName]);assert.ok(killed.rows.length);assert.ok(killed.rows.every(r=>r.terminated));worker.child.send({op:'continue'});const lost=await worker.wait('fence-error');assert.match(lost.code,/OBJECT_FENCE_/);
    const retry=await api('POST','/v1/endpoint-testing/test-samples/binary-objects/cleanup',{});assert.equal(retry.deletedCount,1);await download(s.id,404);return {busy,terminatedOwnedFenceConnections:killed.rows.length,lost,retry};
  });
  await step('postgres.crashed_writer_staged_orphan_grace_and_recovery',async()=>{
    const sampleId=randomUUID();const worker=await fenceWorker(sampleId,true);const o=await objectFor(sampleId);assert.equal(o.state,'staged');assert.ok(fs.existsSync(path.join(objectDir,o.objectKey+'.stage')));await stopApi(worker.child);
    const freshCleanup=await api('POST','/v1/endpoint-testing/test-samples/binary-objects/cleanup',{});assert.equal(freshCleanup.deletedCount,0);assert.ok(freshCleanup.deferredCount>=1);
    const aged=new Date(Date.now()-6*60000).toISOString();await db.query('UPDATE endpoint_test_sample_objects SET "createdAt"=$1 WHERE id=$2',[aged,o.id]);evidence.fixtures.push({kind:'crashed-writer-stage-age',sampleId,createdAt:aged,reason:'real writer process terminated after stage write; six-minute fixture only'});
    const recovered=await api('POST','/v1/endpoint-testing/test-samples/binary-objects/cleanup',{});assert.equal(recovered.orphanDeletedCount,1);assert.equal((await objectFor(sampleId)).state,'deleted');assert.equal(fs.existsSync(path.join(objectDir,o.objectKey+'.stage')),false);await download(sampleId,404);return {sampleId,writerPid:worker.child.pid,freshCleanup,recovered};
  });
  await step('separation.obs_sentinel_and_independent_identical_samples',async()=>{
    assert.equal(fs.readFileSync(sentinel,'utf8'),'OBS retention must remain independent');const a=await capture(rec),b=await capture(rec);assert.notEqual(a.id,b.id);assert.notEqual(a.responsePayload.opaqueObjectId,b.responsePayload.opaqueObjectId);assert.equal(a.responsePayload.sha256,b.responsePayload.sha256);await api('DELETE',sampleUrl(a.id));await download(a.id,410);await download(b.id,200);return {sampleIds:[a.id,b.id],independentObjectIds:true,obsSentinelUnchanged:true};
  });
  evidence.ok=true;
}
async function finish(){
  const errors=[];for(const child of children)try{await stopApi(child);}catch(e){errors.push(e.message);}
  if(upstream){upstream.closeAllConnections();await new Promise(r=>upstream.close(r));}
  if(db)try{await db.end();}catch(e){errors.push(e.message);}
  if(pgStarted)try{await pgRun('pg_ctl',['-D',pgdata,'-w','-t','30','-m','fast','stop']);pgStarted=false;}catch(e){errors.push(e.message);}
  for(const name of fs.readdirSync(workDir).filter(n=>n.endsWith('.log'))) {const p=path.join(workDir,name);fs.writeFileSync(p,redact(fs.readFileSync(p,'utf8')));}
  evidence.cleanup={ownedApiProcessesStopped:children.every(c=>c.exitCode!==null||c.signalCode!==null),ownedPostgresStopped:!pgStarted,filesRetainedForAudit:true,errors};if(errors.length){evidence.ok=false;process.exitCode=1;}
  evidence.finishedAt=new Date().toISOString();save();console.log(`${evidence.ok?'PROD_04C_VERIFY_OK':'PROD_04C_VERIFY_FAIL'} ${evidencePath}`);
}
main().catch(e=>{evidence.ok=false;evidence.error=redact(e.stack);console.error(redact(e.message));process.exitCode=1;}).finally(finish);
