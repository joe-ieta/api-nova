'use strict';
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net');
const {once}=require('node:events'),{spawnSync}=require('node:child_process'),{createHash}=require('node:crypto'),Module=require('node:module');
const root=path.resolve(__dirname,'..'),api=path.resolve(root,'../api-nova-api');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'apinova-managed-runtime-'));
const build=spawnSync(process.execPath,[require.resolve('typescript/bin/tsc'),path.join(root,'src/managed/entry.ts'),path.join(root,'src/managed/handoff.ts'),'--outDir',directory,'--module','commonjs','--target','ES2020','--types','node','--skipLibCheck'],{encoding:'utf8'});
assert.equal(build.status,0,build.stdout+build.stderr);
// Actual dedicated compiled entry; lazy runtime dependency executes current TS
// sources in the isolated child. No shared dist compilation or mock READY.
fs.writeFileSync(path.join(directory,'runtime.js'),`
require(${JSON.stringify(require.resolve('ts-node'))}).register({transpileOnly:true,project:${JSON.stringify(path.join(root,'tsconfig.json'))}});
const Module=require('node:module'),original=Module._resolveFilename;
Module._resolveFilename=function(name,...rest){if(name==='api-nova-parser')return ${JSON.stringify(path.resolve(root,'../api-nova-parser/src/index.ts'))};return original.call(this,name,...rest);};
module.exports=require(${JSON.stringify(path.join(root,'src/managed/runtime.ts'))});
`);
require('ts-node').register({transpileOnly:true,project:path.join(api,'tsconfig.json')});
const original=Module._resolveFilename;
Module._resolveFilename=function(name,...rest){if(name==='api-nova-server')return path.join(directory,'handoff.js');if(name==='api-nova-server/dist/managed/entry.js')return path.join(directory,'entry.js');return original.call(this,name,...rest);};
const spawned=[];const childProcesses=require('node:child_process'),nativeSpawn=childProcesses.spawn;
childProcesses.spawn=(...args)=>{const child=nativeSpawn(...args),seen={args,output:''};spawned.push(seen);child.stdout?.on('data',chunk=>{seen.output+=chunk;});child.stderr?.on('data',chunk=>{seen.output+=chunk;});return child;};
const {startManagedMcpChannel}=require(path.join(api,'src/modules/servers/services/managed-mcp-channel.ts'));
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StreamableHTTPClientTransport}=require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const {SSEClientTransport}=require('@modelcontextprotocol/sdk/client/sse.js');
after(()=>{childProcesses.spawn=nativeSpawn;Module._resolveFilename=original;fs.rmSync(directory,{recursive:true,force:true});});
const hash=t=>createHash('sha256').update(t).digest('hex');
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):x;
async function freePort(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function fixture(t,mode='streamable'){
 const received=[];
 const upstream=http.createServer((req,res)=>{received.push({path:req.url,headers:req.headers});if(req.url==='/redirect'){res.writeHead(302,{location:'/redirect-target'});res.end();}else{res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true}));}});
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');t.after(()=>{upstream.closeAllConnections();upstream.close();});
 const port=await freePort(),upstreamPort=upstream.address().port;
 const spec={openapi:'3.0.3',info:{title:'fixture',version:'1'},servers:[{url:'http://127.0.0.1:'+upstreamPort}],paths:{}};
 const bindings=[];for(const name of ['inherit','override','none','redirect']){spec.paths['/'+name]={get:{operationId:name,parameters:[{in:'header',name:'Authorization',schema:{type:'string'}},{in:'header',name:'X-Private',schema:{type:'string'}}],responses:{'200':{description:'ok'}}}};bindings.push({method:'GET',path:'/'+name,endpointDefinitionId:'endpoint-'+name,sourceServiceAssetId:'source-one'});}
 const registry={apiVersion:'security.apinova.io/v1',kind:'UpstreamCredentialBindings',metadata:{revision:'r1',environment:'test'},reload:{mode:'manual',debounceMs:0,rejectPlaintextSecrets:true},secretProviders:{env:{type:'env'}},credentials:{parent:{type:'bearer',secretRef:'env:UPSTREAM_PARENT'},override:{type:'apiKey',placement:{in:'header',name:'X-Private'},secretRef:'env:UPSTREAM_OVERRIDE'}},sites:[{id:'fixture',sourceServiceAssetId:'source-one',match:{scheme:'http',host:'127.0.0.1',port:upstreamPort,basePath:'/'},allowedHosts:['127.0.0.1'],credential:'parent',endpoints:[{endpointDefinitionId:'endpoint-override',credential:'override'},{endpointDefinitionId:'endpoint-none',credential:'none'}]}]};
 const file=path.join(directory,'registry-'+port+'.json'),text=JSON.stringify(registry);fs.writeFileSync(file,text);
 const payload={version:1,launchId:'launch-'+port,managedServerId:'server-one',runtimeAssetId:'asset-one',inboundAuthMode:'private_api_key',candidateRevision:'candidate-one',verificationRunId:'run-one',behaviorFingerprint:hash(JSON.stringify(canonical(spec))),transport:{type:mode,host:'127.0.0.1',port,endpoint:'/managed'},openApiData:spec,trustedOperationBindings:bindings,registrySource:{configId:'registry-one',path:file,format:'json',environment:'test',expectedRevision:'r1',expectedContentDigest:hash(text)}};
 const environmentValues={API_NOVA_RUNTIME_AUTH_MODE:'api_key',API_NOVA_MCP_RESOURCE:'https://managed.example.invalid/mcp',API_NOVA_RUNTIME_API_KEYS:JSON.stringify([{id:'client-one',subject:'synthetic-consumer',secretHash:hash('synthetic-client-key'),resources:['https://managed.example.invalid/mcp'],scopes:[],expiresAt:Math.floor(Date.now()/1000)+120}]),UPSTREAM_PARENT:'synthetic-parent-secret',UPSTREAM_OVERRIDE:'synthetic-override-secret'};
 const input={payload,launchId:payload.launchId,serverId:payload.managedServerId,approvedEnvironmentNames:Object.keys(environmentValues),environmentValues};
 async function start(){const handle=await startManagedMcpChannel(input);t.after(()=>handle.close());return handle;}
 return{input,received,start,port,registry,file};
}
for(const mode of ['streamable','sse'])test(mode+' real READY, authenticated MCP calls, inherit override None and no redirect',{timeout:25000},async t=>{
 const f=await fixture(t,mode),handle=await f.start();const revisions=await handle.ready;
 assert.equal(handle.state,'runtimeReady');assert.equal(revisions.authMode,'api_key');assert.equal(revisions.credentialMode,'single-hop');
 assert.equal((await fetch('http://127.0.0.1:'+f.port+'/managed',{headers:{accept:'text/event-stream'}})).status,401);
 const headers={'x-api-key':'synthetic-client-key'};
 const transport=mode==='sse'?new SSEClientTransport(new URL('http://127.0.0.1:'+f.port+'/managed'),{requestInit:{headers},eventSourceInit:{fetch:(url,init)=>fetch(url,{...init,headers:{...Object.fromEntries(new Headers(init?.headers)),...headers}})}}):new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+f.port+'/managed'),{requestInit:{headers}});
 const client=new Client({name:'isolated',version:'1'});t.after(()=>client.close());await client.connect(transport);
 const list=await client.listTools();assert.equal(list.tools.length,4);
 for(const name of ['inherit','override','none','redirect']){const result=await client.callTool({name,arguments:{Authorization:'consumer-secret','X-Private':'consumer-private'}});assert.equal(result.isError,name==='redirect',JSON.stringify(result));}
 assert.equal(f.received.length,4);assert.equal(f.received[0].headers.authorization,'Bearer synthetic-parent-secret');assert.equal(f.received[1].headers['x-private'],'synthetic-override-secret');assert.equal(f.received[1].headers.authorization,undefined);assert.equal(f.received[2].headers.authorization,undefined);assert.equal(f.received[2].headers['x-private'],undefined);assert.ok(!JSON.stringify(f.received).includes('consumer-'));assert.ok(!f.received.some(r=>r.path==='/redirect-target'));
 await client.close();await handle.close();assert.deepEqual(await handle.closed,{code:'STOPPED'});assert.throws(()=>process.kill(handle.pid,0));const observed=spawned.at(-1);assert.equal(observed.output,'');assert.equal(observed.args[1].length,1);assert.ok(!JSON.stringify(observed.args[1]).includes('secret'));
});
for(const defect of ['secret','digest','binding','anonymous','missing-auth','jwt','revision','host','persisted-jwt','persisted-anonymous'])test('pre-listen '+defect+' failure emits fixed code and zero upstream sends',{timeout:15000},async t=>{
 const f=await fixture(t);
 if(defect==='secret'){delete f.input.environmentValues.UPSTREAM_PARENT;f.input.approvedEnvironmentNames=f.input.approvedEnvironmentNames.filter(x=>x!=='UPSTREAM_PARENT');}
 if(defect==='digest')f.input.payload.registrySource.expectedContentDigest='0'.repeat(64);
 if(defect==='revision')f.input.payload.registrySource.expectedRevision='wrong';
 if(defect==='binding')f.input.payload.trustedOperationBindings.pop();
 if(['anonymous','jwt'].includes(defect))f.input.environmentValues.API_NOVA_RUNTIME_AUTH_MODE=defect;
 if(defect==='missing-auth'){delete f.input.environmentValues.API_NOVA_RUNTIME_AUTH_MODE;f.input.approvedEnvironmentNames=f.input.approvedEnvironmentNames.filter(x=>x!=='API_NOVA_RUNTIME_AUTH_MODE');}
 if(defect==='persisted-jwt')f.input.payload.inboundAuthMode='private_jwt';
 if(defect==='persisted-anonymous')f.input.payload.inboundAuthMode='anonymous';
 if(defect==='host')f.input.payload.transport.host='0.0.0.0';
 const handle=await f.start();await assert.rejects(handle.ready,/MANAGED_RUNTIME_FAILED/);assert.deepEqual(await handle.closed,{code:'MANAGED_RUNTIME_FAILED'});assert.equal(f.received.length,0);
 await assert.rejects(fetch('http://127.0.0.1:'+f.port+'/health',{signal:AbortSignal.timeout(500)}));
});
test('occupied real listener fails before READY and does not close another server',{timeout:15000},async t=>{
 const f=await fixture(t),occupied=net.createServer();occupied.listen(f.port,'127.0.0.1');await once(occupied,'listening');t.after(()=>occupied.close());
 const handle=await f.start();await assert.rejects(handle.ready,/MANAGED_RUNTIME_FAILED/);assert.deepEqual(await handle.closed,{code:'MANAGED_RUNTIME_FAILED'});assert.equal(occupied.listening,true);assert.equal(f.received.length,0);
});
