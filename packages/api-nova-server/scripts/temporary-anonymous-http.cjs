const assert=require('node:assert/strict');
const {once}=require('node:events');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createMcpServer,startStreamableMcpServer}=require('../dist/index.js');
const {flushRuntimeAudit}=require('api-nova-parser');
async function main(){
 const original={...process.env};
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'api-nova-temporary-anonymous-'));
 process.env.API_NOVA_AUDIT_DIR=root;process.env.API_NOVA_RUNTIME_AUTH_MODE='anonymous';process.env.NODE_ENV='test';
 const grant={reason:'Short acceptance window',actor:'trusted-admin',expiresAt:new Date(Date.now()+2000).toISOString(),allowProduction:false};
 process.env.API_NOVA_TEMPORARY_ANONYMOUS=JSON.stringify(grant);
 const spec={openapi:'3.0.3',info:{title:'Anonymous acceptance',version:'1'},paths:{}};
 const server=await startStreamableMcpServer(()=>createMcpServer({openApiData:spec},{registerSignalHandlers:false}),'/mcp',0);
 if(!server.listening)await once(server,'listening');
 const url=`http://127.0.0.1:${server.address().port}/mcp`;
 const request=(session)=>fetch(url,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','x-anonymous-expiry':'2099',...(session?{'mcp-session-id':session}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method:session?'tools/list':'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'acceptance',version:'1'}}})});
 try{
  let response=await request();assert.equal(response.status,200);const session=response.headers.get('mcp-session-id');assert.ok(session);await response.text();
  await new Promise(resolve=>setTimeout(resolve, Math.max(0,Date.parse(grant.expiresAt)-Date.now()+20)));
  response=await request(session);assert.equal(response.status,403);assert.deepEqual(await response.json(),{error:'temporary_anonymous_expired'});
  grant.expiresAt=new Date(Date.now()+60000).toISOString();
  process.env.NODE_ENV='production';
  for(const [policy,host,status] of [[false,false,403],[true,false,403],[false,true,403],[true,true,200]]){
   process.env.API_NOVA_TEMPORARY_ANONYMOUS=JSON.stringify({...grant,allowProduction:policy});
   process.env.API_NOVA_ALLOW_TEMPORARY_ANONYMOUS_IN_PRODUCTION=String(host);
   response=await request();assert.equal(response.status,status);await response.text();
  }
  process.env.API_NOVA_TEMPORARY_ANONYMOUS='{bad';response=await request();assert.equal(response.status,503);await response.text();
  await flushRuntimeAudit();
  async function collect(dir){let text='';for(const entry of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);text+=entry.isDirectory()?await collect(p):await fs.readFile(p,'utf8');}return text;}
  assert.match(await collect(root),/temporary_anonymous_expired/);
  console.log('PASS MCP real HTTP: allow, expiry+audit, production four-way matrix, malformed refusal (7 cases)');
 }finally{server.closeAllConnections?.();await new Promise(r=>server.close(r));process.env=original;await fs.rm(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
