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
const initialize=JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'rotation',version:'1'}}});
async function request(port,key){const r=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','x-api-key':key},body:initialize,signal:AbortSignal.timeout(6000)});await r.text();return r.status;}
test('rotation, expiry and revocation reach Gateway and the same real managed CLI child on its next request', {timeout:60000},async t=>{
 const oldEnv={...process.env},root=await fs.mkdtemp(path.join(os.tmpdir(),'api-nova-rotation-'));
 let db,manager,resolver,upstream,gateway;
 t.after(async()=>{try{await manager?.onModuleDestroy();await resolver?.onModuleDestroy();await close(gateway);await close(upstream);if(db?.isInitialized)await db.destroy();}finally{process.env=oldEnv;assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('api-nova-rotation-'));await fs.rm(root,{recursive:true,force:true});}});
 process.env={...oldEnv,API_NOVA_RUNTIME_CREDENTIAL_SOURCE:'database',API_NOVA_AUDIT_DIR:root,API_NOVA_RUNTIME_REQUIRED_SCOPES:'',API_NOVA_MCP_TOOL_SCOPES:'{}'};
 delete process.env.API_NOVA_RUNTIME_CREDENTIAL_RESOLVER_URL;
 let upstreamStatus=200,spec={};
 upstream=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.statusCode=req.url==='/ping'?upstreamStatus:200;res.end(JSON.stringify(req.url==='/ping'?{ok:upstreamStatus===200}:spec));});
 const upstreamPort=await listen(upstream),port=await freePort();
 db=await new DataSource({type:'sqljs',location:path.join(root,'rotation.sqlite'),autoSave:true,synchronize:true,entities:[MCPServerEntity,ProcessInfoEntity,ProcessLogEntity,...publication.entities]}).initialize();
 const entity=await publication.publish(db,port,upstreamPort,'private_api_key',status=>{upstreamStatus=status;});spec=entity.openApiData;
 const id=entity.config.runtimeAssetId,repo=db.getRepository(GatewayConsumerCredentialEntity),audit={log:async()=>{}};
 const management=Object.create(RuntimeAssetsService.prototype);Object.assign(management,{runtimeAssetRepository:db.getRepository(RuntimeAssetEntity),gatewayConsumerCredentialRepository:repo,auditService:audit});
 const initial=await management.createGatewayConsumerCredential(id,{name:'rotation',subject:'stable',protocols:['gateway','mcp'],toolScopes:['*']});
 const rotation=new RuntimeCredentialRotationService(repo,audit);
 resolver=new RuntimeCredentialResolverService(db);
 const noop=()=>{},events=new EventEmitter2(),logs=[];
 const monitors={startMonitoring:noop,stopMonitoring:noop,startLogMonitoring:noop,stopLogMonitoring:noop,addLogEntry:(_id,item)=>logs.push(item)};
 const app={port:upstreamPort,apiBaseUrl:`http://127.0.0.1:${upstreamPort}`,processTimeout:1000,processMaxRetries:0,processRestartDelay:100};
 const config={get:(key,fallback)=>({PID_DIRECTORY:path.join(root,'pids'),LOG_DIRECTORY:path.join(root,'logs'),PROCESS_LOG_PERSIST_ENABLED:false}[key]??fallback)};
 manager=new ProcessManagerService(db.getRepository(ProcessInfoEntity),db.getRepository(ProcessLogEntity),events,config,app,monitors,monitors,resolver);
 const lifecycle=new ServerLifecycleService({},config,app,events,manager,{startHealthCheck:noop,stopHealthCheck:noop},{recordRuntimeControlEvent:async()=>{}},new ParserService(app),new ValidatorService(),resolver);
 await lifecycle.startServer(entity);
 for(let n=0;n<80;n++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).status===200)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 const pid=manager.getProcessInfo(entity.id).pid;
 const security=new GatewaySecurityService(audit,repo);
 gateway=http.createServer(async(req,res)=>{try{await security.authorize({policies:{auth:{mode:'api_key'}},runtimeAsset:{id},routeBinding:{id:'route',routeVisibility:'external'}},req);res.end('ok');}catch(error){res.writeHead(error.getStatus?.()||500).end();}});
 const gatewayPort=await listen(gateway);
 async function both(key,status){assert.equal(await request(port,key),status);const response=await fetch(`http://127.0.0.1:${gatewayPort}`,{headers:{'x-api-key':key}});await response.text();assert.equal(response.status,status);assert.equal(manager.getProcessInfo(entity.id).pid,pid);}
 await both(initial.apiKey,200);
 const successor=await rotation.rotate(id,initial.credential.id,2,'fixture-admin');
 await both(initial.apiKey,200);await both(successor.apiKey,200);
 await new Promise(r=>setTimeout(r,Math.max(0,Number(successor.overlapEndsAt)*1000-Date.now()+50)));
 await both(initial.apiKey,401);await both(successor.apiKey,200);
 await management.revokeGatewayConsumerCredential(id,successor.credential.id);
 await both(successor.apiKey,401);
 const expiring=await management.createGatewayConsumerCredential(id,{name:'expire',protocols:['gateway','mcp'],expiresAt:Math.floor(Date.now()/1000)+2});
 await both(expiring.apiKey,200);await new Promise(r=>setTimeout(r,2100));await both(expiring.apiKey,401);
 assert.ok(!JSON.stringify(logs).includes('RESOLVER_TOKEN'));
 assert.equal(manager.getProcessInfo(entity.id).config.env.API_NOVA_RUNTIME_CREDENTIAL_RESOLVER_TOKEN,undefined);
 await resolver.onModuleDestroy();
 assert.equal(await request(port,successor.apiKey),503,'resolver failure must not restore cached credentials');
});
