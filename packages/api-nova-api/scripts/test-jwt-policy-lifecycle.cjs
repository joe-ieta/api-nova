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
const {GatewayConsumerCredentialEntity}=load('database/entities/gateway-consumer-credential.entity');
const {ProcessInfoEntity}=load('modules/servers/entities/process-info.entity');
const {ProcessLogEntity}=load('modules/servers/entities/process-log.entity');
const {ProcessManagerService}=load('modules/servers/services/process-manager.service');
const {ServerLifecycleService}=load('modules/servers/services/server-lifecycle.service');
const {GatewaySecurityService}=load('modules/gateway-runtime/services/gateway-security.service');
const {ParserService}=load('modules/openapi/services/parser.service');
const {ValidatorService}=load('modules/openapi/services/validator.service');
Logger.overrideLogger(false);
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;}
async function close(server){if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}}
async function freePort(){const s=http.createServer();const p=await listen(s);await close(s);return p;}
const initialize=JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'rotation',version:'1'}}});

const { generateKeyPair, exportJWK, SignJWT } = require('node:module').createRequire(require.resolve('api-nova-parser'))('jose');
test('persisted JWT parameters survive database reopen and govern a real CLI child', {timeout:60000}, async t=>{
 const oldEnv={...process.env},root=await fs.mkdtemp(path.join(os.tmpdir(),'api-nova-jwt-policy-'));
 let db,manager,upstream,gateway;
 t.after(async()=>{try{await manager?.onModuleDestroy();await close(gateway);await close(upstream);if(db?.isInitialized)await db.destroy();}finally{process.env=oldEnv;assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('api-nova-jwt-policy-'));await fs.rm(root,{recursive:true,force:true});}});
 const ec=await generateKeyPair('ES384'),rsa=await generateKeyPair('RS256');
 const issuer='https://jwt-policy.example',resource='https://runtime.example/mcp';
 const jwtPolicy={algorithms:['ES384'],requiredClaims:['sub','exp','iat','tenant'],clockToleranceSeconds:30};
 process.env={...oldEnv,API_NOVA_AUDIT_DIR:root,API_NOVA_RUNTIME_REQUIRED_SCOPES:'',API_NOVA_MCP_TOOL_SCOPES:'{}',API_NOVA_RUNTIME_ISSUER:issuer,
 API_NOVA_MCP_RESOURCE:resource,API_NOVA_GATEWAY_RESOURCE:resource,API_NOVA_RUNTIME_JWKS_JSON:JSON.stringify({keys:[{...await exportJWK(ec.publicKey),alg:'ES384',kid:'ec'},{...await exportJWK(rsa.publicKey),alg:'RS256',kid:'rsa'}]}),
 API_NOVA_RUNTIME_JWT_POLICY:JSON.stringify({algorithms:['RS256'],requiredClaims:['sub','exp','iat'],clockToleranceSeconds:0})};
 delete process.env.API_NOVA_RUNTIME_JWKS_URI;
 let upstreamStatus=200,spec={};
 upstream=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.statusCode=req.url==='/ping'?upstreamStatus:200;res.end(JSON.stringify(req.url==='/ping'?{ok:upstreamStatus===200}:spec));});
 const upstreamPort=await listen(upstream),port=await freePort();
 const open=async()=>new DataSource({type:'sqljs',location:path.join(root,'jwt.sqlite'),autoSave:true,synchronize:true,entities:[MCPServerEntity,ProcessInfoEntity,ProcessLogEntity,...publication.entities]}).initialize();
 db=await open();
 const saved=await publication.publish(db,port,upstreamPort,'private_jwt',status=>{upstreamStatus=status;},{jwtPolicy});spec=saved.openApiData;
 assert.deepEqual(saved.config.jwtPolicy,jwtPolicy);
 await db.destroy();db=await open();
 const entity=await db.getRepository(MCPServerEntity).findOneByOrFail({id:saved.id});assert.deepEqual(entity.config.jwtPolicy,jwtPolicy);
 const noop=()=>{},events=new EventEmitter2(),monitors={startMonitoring:noop,stopMonitoring:noop,startLogMonitoring:noop,stopLogMonitoring:noop,addLogEntry:noop};
 const app={port:upstreamPort,apiBaseUrl:'http://127.0.0.1:'+upstreamPort,processTimeout:1000,processMaxRetries:0,processRestartDelay:100};
 const config={get:(key,fallback)=>({PID_DIRECTORY:path.join(root,'pids'),LOG_DIRECTORY:path.join(root,'logs'),PROCESS_LOG_PERSIST_ENABLED:false}[key]??fallback)};
 manager=new ProcessManagerService(db.getRepository(ProcessInfoEntity),db.getRepository(ProcessLogEntity),events,config,app,monitors,monitors);
 const lifecycle=new ServerLifecycleService({},config,app,events,manager,{startHealthCheck:noop,stopHealthCheck:noop},{recordRuntimeControlEvent:async()=>{}},new ParserService(app),new ValidatorService());
 await lifecycle.startServer(entity);
 for(let n=0;n<80;n++){try{if((await fetch('http://127.0.0.1:'+port+'/health')).status===200)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 const pid=manager.getProcessInfo(entity.id).pid;
 const security=new GatewaySecurityService({log:async()=>{}},db.getRepository(GatewayConsumerCredentialEntity));
 gateway=http.createServer(async(req,res)=>{try{await security.authorize({policies:{auth:{mode:'jwt'}},runtimeAsset:{id:entity.config.runtimeAssetId},routeBinding:{id:'route',routeVisibility:'external',upstreamConfig:{jwtPolicy}}},req);res.end('ok');}catch(error){res.writeHead(error.getStatus?.()||500).end();}});
 const gatewayPort=await listen(gateway);
 async function token(alg='ES384',claims={tenant:'a'},expiry=60){const now=Math.floor(Date.now()/1000);return new SignJWT(claims).setProtectedHeader({alg,kid:alg==='ES384'?'ec':'rsa'}).setIssuer(issuer).setAudience(resource).setSubject('consumer').setIssuedAt(now-100).setExpirationTime(now+expiry).sign(alg==='ES384'?ec.privateKey:rsa.privateKey);}
 async function both(jwt,status){const headers={authorization:'Bearer '+jwt};const r=await fetch('http://127.0.0.1:'+port+'/mcp',{method:'POST',headers:{...headers,'content-type':'application/json',accept:'application/json, text/event-stream'},body:initialize,signal:AbortSignal.timeout(6000)});await r.text();assert.equal(r.status,status);const g=await fetch('http://127.0.0.1:'+gatewayPort,{headers});await g.text();assert.equal(g.status,status);assert.equal(manager.getProcessInfo(entity.id).pid,pid);}
 await both(await token(),200);
 await both(await token('RS256'),401);
 await both(await token('ES384',{}),401);
 await both(await token('ES384',{tenant:'a'},-5),200);
 await both(await token('ES384',{tenant:'a'},-60),401);
});
