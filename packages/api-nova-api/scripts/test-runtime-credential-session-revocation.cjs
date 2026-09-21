'use strict';
process.env.DB_TYPE='sqlite';
require('reflect-metadata');
const path=require('node:path');
require('ts-node').register({transpileOnly:true,project:path.resolve(__dirname,'../tsconfig.json')});
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),http=require('node:http');
const {once}=require('node:events');
const {test}=require('node:test');
const {DataSource}=require('typeorm');
const {Logger}=require('@nestjs/common');
const {EventEmitter2}=require('@nestjs/event-emitter');
const publication=require('./mcp-auth-publication-fixture.cjs');
const source='../src/';
const load=p=>require(source+p+'.ts');
const {MCPServerEntity}=load('database/entities/mcp-server.entity');
const {RuntimeAssetEntity}=load('database/entities/runtime-asset.entity');
const {GatewayConsumerCredentialEntity}=load('database/entities/gateway-consumer-credential.entity');
const {ProcessInfoEntity}=load('modules/servers/entities/process-info.entity');
const {ProcessLogEntity}=load('modules/servers/entities/process-log.entity');
const {ProcessManagerService}=load('modules/servers/services/process-manager.service');
const {ServerLifecycleService}=load('modules/servers/services/server-lifecycle.service');
const {RuntimeCredentialResolverService}=load('modules/servers/services/runtime-credential-resolver.service');
const {RuntimeCredentialRotationService}=load('modules/runtime-assets/services/runtime-credential-rotation.service');
const {RuntimeAssetsService}=load('modules/runtime-assets/services/runtime-assets.service');
const {GatewaySecurityService}=load('modules/gateway-runtime/services/gateway-security.service');
const {ParserService}=load('modules/openapi/services/parser.service');
const {ValidatorService}=load('modules/openapi/services/validator.service');
Logger.overrideLogger(false);
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;}
async function close(server){if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}}
async function freePort(){const s=http.createServer();const p=await listen(s);await close(s);return p;}
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StreamableHTTPClientTransport}=require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const {SSEClientTransport}=require('@modelcontextprotocol/sdk/client/sse.js');
for(const transportType of ['streamable','sse']) test(transportType+': persisted revocation denies existing sessions and reconnects in the real CLI', {timeout:60000},async t=>{
 const oldEnv={...process.env},root=await fs.mkdtemp(path.join(os.tmpdir(),'api-nova-session-revoke-'));
 let db,manager,resolver,upstream; const clients=[];let openStreams=0;
 t.after(async()=>{try{for(const client of clients)await client.close().catch(()=>{});await manager?.onModuleDestroy();await resolver?.onModuleDestroy();await close(upstream);if(db?.isInitialized)await db.destroy();}finally{process.env=oldEnv;assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('api-nova-session-revoke-'));await fs.rm(root,{recursive:true,force:true});}});
 process.env={...oldEnv,API_NOVA_RUNTIME_CREDENTIAL_SOURCE:'database',API_NOVA_AUDIT_DIR:root,API_NOVA_RUNTIME_REQUIRED_SCOPES:'',API_NOVA_MCP_TOOL_SCOPES:'{}'};
 delete process.env.API_NOVA_RUNTIME_CREDENTIAL_RESOLVER_URL;
 let upstreamStatus=200,spec={},calls=0;
 upstream=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.statusCode=req.url==='/ping'?upstreamStatus:200;if(req.url==='/ping')calls++;res.end(JSON.stringify(req.url==='/ping'?{ok:upstreamStatus===200}:spec));});
 const upstreamPort=await listen(upstream),port=await freePort();
 db=await new DataSource({type:'sqljs',location:path.join(root,'revocation.sqlite'),autoSave:true,synchronize:true,entities:[MCPServerEntity,ProcessInfoEntity,ProcessLogEntity,...publication.entities]}).initialize();
 const entity=await publication.publish(db,port,upstreamPort,'private_api_key',status=>{upstreamStatus=status;},{transport:transportType});spec=entity.openApiData;
 const id=entity.config.runtimeAssetId,repo=db.getRepository(GatewayConsumerCredentialEntity),audit={log:async()=>{}};
 const management=Object.create(RuntimeAssetsService.prototype);Object.assign(management,{runtimeAssetRepository:db.getRepository(RuntimeAssetEntity),gatewayConsumerCredentialRepository:repo,auditService:audit});
 const initial=await management.createGatewayConsumerCredential(id,{name:'session',subject:'stable',protocols:['gateway','mcp'],toolScopes:['*']});
 const survivor=await management.createGatewayConsumerCredential(id,{name:'survivor',subject:'other',protocols:['mcp'],toolScopes:['*']});
 resolver=new RuntimeCredentialResolverService(db);
 const noop=()=>{},events=new EventEmitter2(),logs=[];
 const monitors={startMonitoring:noop,stopMonitoring:noop,startLogMonitoring:noop,stopLogMonitoring:noop,addLogEntry:(_id,item)=>logs.push(item)};
 const app={port:upstreamPort,apiBaseUrl:'http://127.0.0.1:'+upstreamPort,processTimeout:1000,processMaxRetries:0,processRestartDelay:100};
 const config={get:(key,fallback)=>({PID_DIRECTORY:path.join(root,'pids'),LOG_DIRECTORY:path.join(root,'logs'),PROCESS_LOG_PERSIST_ENABLED:false}[key]??fallback)};
 manager=new ProcessManagerService(db.getRepository(ProcessInfoEntity),db.getRepository(ProcessLogEntity),events,config,app,monitors,monitors,resolver);
 const lifecycle=new ServerLifecycleService({},config,app,events,manager,{startHealthCheck:noop,stopHealthCheck:noop},{recordRuntimeControlEvent:async()=>{}},new ParserService(app),new ValidatorService(),resolver);
 await lifecycle.startServer(entity);
 for(let n=0;n<80;n++){try{if((await fetch('http://127.0.0.1:'+port+'/health')).status===200)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 const pid=manager.getProcessInfo(entity.id).pid;
 const endpoint=new URL('http://127.0.0.1:'+port+'/mcp');
 async function observedFetch(url,init){const response=await fetch(url,init);if((init?.method||'GET')==='GET'&&response.status===200&&response.headers.get('content-type')?.includes('text/event-stream'))openStreams++;return response;}
 async function connect(key){const client=new Client({name:'session-revocation',version:'1'});clients.push(client);const headers={'x-api-key':key};const transport=transportType==='streamable'?new StreamableHTTPClientTransport(endpoint,{requestInit:{headers},fetch:observedFetch}):new SSEClientTransport(endpoint,{requestInit:{headers},eventSourceInit:{fetch:(url,init)=>observedFetch(url,{...init,headers:{...init?.headers,...headers}})}});await client.connect(transport);return {client,transport};}
 const {client,transport}=await connect(initial.apiKey);
 for(let n=0;n<50&&!openStreams;n++)await new Promise(r=>setTimeout(r,20));assert.ok(openStreams>0,'actual server-sent event stream established before revocation');
 const tools=await client.listTools();assert.equal(tools.tools.length,1);const tool=tools.tools[0].name;
 const before=calls;const success=await client.callTool({name:tool,arguments:{}});assert.notEqual(success.isError,true);assert.equal(calls,before+1);
 // A policy update must affect an established session, including its tool listing.
 const row=await repo.findOneByOrFail({id:initial.credential.id});await repo.update(row.id,{accessPolicy:{...row.accessPolicy,toolScopes:[]}});
 assert.deepEqual((await client.listTools()).tools,[]);
 await assert.rejects(()=>client.callTool({name:tool,arguments:{}}));assert.equal(calls,before+1);
 await repo.update(row.id,{accessPolicy:row.accessPolicy});
 assert.equal((await client.listTools()).tools.length,1);
 await management.revokeGatewayConsumerCredential(id,initial.credential.id);
 await assert.rejects(()=>client.callTool({name:tool,arguments:{}}));
 await assert.rejects(()=>client.listTools());assert.equal(calls,before+1);
 // Raw reconnect validates the credential before session and replay dispatch.
 const reconnect=await fetch(endpoint,{headers:{accept:'text/event-stream','x-api-key':initial.apiKey,...(transport.sessionId?{'mcp-session-id':transport.sessionId}:{}),'last-event-id':'revoked-cursor'},signal:AbortSignal.timeout(5000)});
 assert.equal(reconnect.status,401);await reconnect.text();
 await assert.rejects(()=>connect(initial.apiKey));
 // Destroy and reopen the real persisted database while the CLI PID stays alive.
 await db.destroy();await db.initialize();assert.equal((await db.getRepository(GatewayConsumerCredentialEntity).findOneByOrFail({id:row.id})).status,'revoked');
 await assert.rejects(()=>client.callTool({name:tool,arguments:{}}));await assert.rejects(()=>connect(initial.apiKey));assert.equal(calls,before+1);
 const healthy=await connect(survivor.apiKey);assert.equal((await healthy.client.listTools()).tools.length,1);assert.notEqual((await healthy.client.callTool({name:tool,arguments:{}})).isError,true);assert.equal(calls,before+2);
 assert.equal(manager.getProcessInfo(entity.id).pid,pid);
 assert.ok(!JSON.stringify(logs).includes(initial.apiKey));
 for(const active of clients)await active.close().catch(()=>{});
 await manager.stopProcess(entity.id,true);
 async function records(dir){const all=[];for(const entry of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())all.push(...await records(file));else if(/^calls-v2-.*\.jsonl$/.test(entry.name))all.push(...(await fs.readFile(file,'utf8')).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)));}return all;}
 const evidence=await records(root);
 assert.ok(evidence.some(record=>record.spanKind==='mcp_protocol'&&record.statusCode===401&&record.failureStage==='admission'),'revocation refusal is recorded in durable admission audit');
 assert.ok(!JSON.stringify(evidence).includes(initial.apiKey),'audit never includes the revoked secret');
});
