'use strict';
// Exercises real RuntimeAssets MCP publication, replay, activation and persisted HTTP lifecycle.
// Only observability/monitoring are no-op fixtures; SQL.js, publication, validators, lifecycle,
// ProcessManager, CLI processes and HTTP authentication execute their real code.
// The loopback OpenAPI fixture is not the authenticated management API endpoint.
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
require('ts-node').register({
  transpileOnly: true,
  project: require('node:path').resolve(__dirname, '../tsconfig.json'),
});
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const { generateKeyPair, exportJWK, SignJWT } =
  createRequire(require.resolve('api-nova-parser'))('jose');
const { persistedMcpInboundMode } =
  require('../src/modules/servers/services/mcp-inbound-process-env.ts');

const resource = 'https://auth-loop-runtime.example/mcp';
const issuer = 'https://auth-loop-issuer.example';
const initialize = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: 'persisted-loop-check', version: '1' } },
});

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitReady(child, port, output) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('CLI exited before readiness: ' + output());
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(500) });
      await response.arrayBuffer();
      if (response.status === 200) return;
    } catch { /* The isolated child may still be binding its port. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('CLI health timeout: ' + output());
}

async function request(port, headers = {}) {
  const response = await fetch('http://127.0.0.1:' + port + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', ...headers },
    body: initialize,
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.text();
  return { status: response.status, body };
}

test('temporary anonymous saved/reopened child expires without restart and audits refusal', {timeout:60000},async t=>{
 const grant={reason:'Isolated deployment check',actor:'spoofed-input',expiresAt:new Date(Date.now()+15000).toISOString(),allowProduction:false};
 await persistedLaunch(t,'anonymous',{...process.env,NODE_ENV:'test',API_NOVA_RUNTIME_AUTH_MODE:'jwt'}, {},grant);
});
const { DataSource } = require('typeorm');
const publication = require('./mcp-auth-publication-fixture.cjs');
const { Logger } = require('@nestjs/common');
const { EventEmitter2 } = require('@nestjs/event-emitter');
const http = require('node:http');
const { MCPServerEntity } = require('../src/database/entities/mcp-server.entity.ts');
const { ProcessInfoEntity } = require('../src/modules/servers/entities/process-info.entity.ts');
const { ProcessLogEntity } = require('../src/modules/servers/entities/process-log.entity.ts');
const { ProcessManagerService } = require('../src/modules/servers/services/process-manager.service.ts');
const { ServerLifecycleService } = require('../src/modules/servers/services/server-lifecycle.service.ts');
const { ServerMapper } = require('../src/modules/servers/utils/server-mapper.util.ts');
const { ParserService } = require('../src/modules/openapi/services/parser.service.ts');
const { ValidatorService } = require('../src/modules/openapi/services/validator.service.ts');
Logger.overrideLogger(false);
async function persistedLaunch(t, mode, inherited, credentials, temporaryAnonymous) {
  const originalEnv = {...process.env};
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'api nova auth loop-'));
  let db, manager, specServer;
  t.after(async () => {
    try { await manager?.onModuleDestroy(); } finally {
      if(specServer) { specServer.closeAllConnections(); await new Promise(resolve=>specServer.close(resolve)); }
      if(db?.isInitialized) await db.destroy();
      process.env = originalEnv;
      assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('api nova auth loop-'));
      await fs.rm(root,{recursive:true,force:true});
    }
  });
  process.env = {...inherited,API_NOVA_AUDIT_DIR:root,API_NOVA_RUNTIME_REQUIRED_SCOPES:'',API_NOVA_MCP_TOOL_SCOPES:'{}'};
  let spec = {openapi:'3.0.3',info:{title:'Persisted lifecycle fixture',version:'1'},servers:[{url:'http://127.0.0.1'}],paths:{}};
  let served=0, upstreamStatus=200, upstreamRequests=0;
  specServer = http.createServer((req,res)=>{ res.setHeader('content-type','application/json'); if(req.url==='/ping') { upstreamRequests++; res.statusCode=upstreamStatus; res.end(JSON.stringify({ok:upstreamStatus===200})); } else { served++; res.end(JSON.stringify(spec)); } });
  specServer.listen(0,'127.0.0.1'); await once(specServer,'listening');
  const specPort=specServer.address().port, port=await freePort();
  const open=async()=>{ db=new DataSource({type:'sqljs',location:path.join(root,'fixture.sqlite'),autoSave:true,synchronize:true,entities:[MCPServerEntity,ProcessInfoEntity,ProcessLogEntity,...publication.entities]}); await db.initialize(); };
  await open();
  const saved=await publication.publish(db,port,specPort,mode,status=>{upstreamStatus=status;},{temporaryAnonymous,actorId:'trusted-fixture-admin'});
  assert.equal(saved.config.temporaryAnonymous.actor,'trusted-fixture-admin');
  assert.ok(upstreamRequests>=3, 'actual replay reached the loopback upstream for failed and passed publications');
  spec=saved.openApiData;
  await db.destroy();
  let previousPid;
  for(let round=0;round<2;round++) {
    await open();
    const entity=await db.getRepository(MCPServerEntity).findOneByOrFail({id:saved.id});
    assert.equal(entity.inboundAuthMode,mode);
    assert.equal(entity.config.temporaryAnonymous.actor,'trusted-fixture-admin');
    const app={port:specPort,apiBaseUrl:`http://127.0.0.1:${specPort}`,processTimeout:1000,processMaxRetries:0,processRestartDelay:100};
    const config={get:(key,fallback)=>({PID_DIRECTORY:path.join(root,'pids'),LOG_DIRECTORY:path.join(root,'logs'),PROCESS_LOG_PERSIST_ENABLED:false}[key]??fallback)};
    const noop=()=>{}, events=new EventEmitter2();
    const logs=[]; const monitors={startMonitoring:noop,stopMonitoring:noop,startLogMonitoring:noop,stopLogMonitoring:noop,addLogEntry:(_id,entry)=>logs.push(entry)};
    manager=new ProcessManagerService(db.getRepository(ProcessInfoEntity),db.getRepository(ProcessLogEntity),events,config,app,monitors,monitors);
    const lifecycle=new ServerLifecycleService({},config,app,events,manager,{startHealthCheck:noop,stopHealthCheck:noop},{recordRuntimeControlEvent:async()=>{}},new ParserService(app),new ValidatorService());
    const launched=await lifecycle.startServer(entity);
    assert.equal(launched.endpoint,`http://127.0.0.1:${port}/mcp`);
    await waitReady({exitCode:null},port,()=> JSON.stringify(logs).slice(-6000));
    const info=manager.getProcessInfo(saved.id);
    assert.ok(info.pid>0); if(previousPid) assert.notEqual(info.pid,previousPid); previousPid=info.pid;
    assert.equal(info.config.env.API_NOVA_RUNTIME_AUTH_MODE,persistedMcpInboundMode(entity,inherited));
    assert.equal(info.config.env.API_NOVA_RUNTIME_API_KEYS,undefined);
    assert.equal(info.config.env.API_NOVA_RUNTIME_JWKS_JSON,undefined);
    assert.equal((await request(port)).status,mode==='anonymous'?200:401);
    if(mode!=='anonymous') assert.equal((await request(port,{'x-api-key':'wrong',authorization:'Bearer wrong'})).status,401);
    assert.equal((await request(port,credentials)).status,200);
    const requestsBeforeCall=upstreamRequests;
    await executePublishedTool(port,credentials,saved.tools[0].name);
    assert.equal(upstreamRequests,requestsBeforeCall+1,'published child performed one real upstream request');
    const dto=ServerMapper.toResponseDto(entity);
    assert.equal(dto.inboundAuthMode,mode); assert.equal(dto.effectiveInboundAuthMode,'unknown'); assert.deepEqual(dto.tags,['runtime-asset','mcp-runtime']);
    if(round===0) { await manager.stopProcess(saved.id,true); await new Promise(resolve=>setTimeout(resolve,150)); manager=undefined; await db.destroy(); }
  }
  assert.ok(served>=2,'both actual children loaded the fixture over HTTP');
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(temporaryAnonymous.expiresAt)-Date.now()+50)));
  const denied=await request(port);assert.equal(denied.status,403);assert.match(denied.body,/temporary_anonymous_expired/);
  await manager.stopProcess(saved.id,true);manager=undefined;
  async function collect(dir){let text='';for(const entry of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isDirectory())text+=await collect(p);else if(/\.(json|jsonl|log)$/.test(entry.name))text+=await fs.readFile(p,'utf8');}return text;}
  assert.match(await collect(root),/temporary_anonymous_expired/);
  console.log('PASS persisted actor + SQLite reopen + two real CLI launches + wall-clock expiry HTTP403 + durable audit');
  return port;
}

async function executePublishedTool(port, headers, toolName) {
  const send=async(body, session)=>fetch(`http://127.0.0.1:${port}/mcp`,{
    method:'POST', headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...headers,...(session?{'mcp-session-id':session}:{})},
    body:JSON.stringify(body),signal:AbortSignal.timeout(5000),
  });
  const initialization=await send(JSON.parse(initialize));
  assert.equal(initialization.status,200);
  const session=initialization.headers.get('mcp-session-id');
  await initialization.text();
  const notification=await send({jsonrpc:'2.0',method:'notifications/initialized'},session);
  await notification.text();
  const call=await send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:toolName,arguments:{}}},session);
  const body=await call.text();
  assert.equal(call.status,200,body);
  assert.match(body,/"httpStatus":200/);
  assert.match(body,/"ok":true/);
}
