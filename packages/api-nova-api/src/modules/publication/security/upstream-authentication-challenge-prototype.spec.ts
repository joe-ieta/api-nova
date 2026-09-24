import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { createServer, request as httpRequest, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { UpstreamCredentialRegistry } from 'api-nova-parser';
import { normalizeUpstreamSecurity } from './upstream-security-reconciliation';
import { UpstreamAuthenticationEvidencePrototype as Evidence } from './upstream-authentication-evidence-prototype.entity';
import { createAuthenticationChallengePrototype } from './upstream-authentication-challenge-prototype';
const source='00000000-0000-0000-0000-000000000001', endpoint='00000000-0000-0000-0000-000000000002';
let db:DataSource, server:Server;
async function fixture(mode='normal',type='apiKey') {
 let count=0; const value={secret:'synthetic-valid-secret',username:'synthetic-user',password:'synthetic-password'};
 const header=type==='bearer'?'authorization':type==='basic'?'authorization':'x-key';
 const expected=()=>type==='bearer'?'Bearer '+value.secret:type==='basic'?'Basic '+Buffer.from(value.username+':'+value.password).toString('base64'):value.secret;
 server=createServer((req,res)=>{
  count++; res.setHeader('content-type','application/json');
  if(mode==='timeout') return;
  if(mode==='network-error') {req.socket.destroy();return;}
  if(mode==='redirect') {res.statusCode=302;res.setHeader('location','/redirected');res.end();return;}
  if(mode==='open'||mode==='wrong-accepted'&&Boolean(req.headers[header])||mode==='anonymous-after'&&count===4) {res.end('private-response-must-not-persist');return;}
  const valid=req.headers[header]===expected();
  res.statusCode=valid&&mode!=='valid-denied'?200:401;
  if(mode==='rotate'&&valid) value.secret='changed-valid-secret';
  res.end('private-response-must-not-persist');
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve)); const port=(server.address() as AddressInfo).port;
 const credential=type==='basic'?{type,usernameRef:'env:USERNAME',passwordRef:'env:PASSWORD'}:type==='apiKey'?{type,placement:{in:'header',name:'X-Key'},secretRef:'env:SECRET'}:type==='customHeader'?{type,name:'X-Key',secretRef:'env:SECRET'}:{type,secretRef:'env:SECRET'};
 const registry=new UpstreamCredentialRegistry({environment:'test',providerFactory:description=>({type:description.type,resolve:async key=>value[key.toLowerCase()]})});
 await registry.reload({apiVersion:'security.apinova.io/v1',kind:'UpstreamCredentialBindings',metadata:{revision:'one',environment:'test'},reload:{mode:'manual',debounceMs:0,rejectPlaintextSecrets:true},secretProviders:{env:{type:'env'}},credentials:{selected:credential},sites:[{id:'site',sourceServiceAssetId:source,match:{scheme:'http',host:'127.0.0.1',port,basePath:'/'},allowedHosts:['127.0.0.1'],credential:'selected',endpoints:[]}]});
 const transport={request:({url,method,headers,signal}:any)=>new Promise<number>((resolve,reject)=>{
  const target=new URL(url);
  // This explicit loopback-only capability has no production network exposure.
  if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||Number(target.port)!==port) {reject(new Error('outside fixture'));return;}
  const req=httpRequest(target,{method,headers,signal},res=>{res.resume();resolve(res.statusCode!);}); req.on('error',reject);req.end();
 })};
 const options={repository:db.getRepository(Evidence),captureSnapshot:()=>registry.captureSnapshot(),transport,timeoutMs:100};
 const service=createAuthenticationChallengePrototype(options);
 const scheme=type==='basic'||type==='bearer'?{type:'http',scheme:type}:{type:'apiKey',in:'header',name:'X-Key'};
 const input={sourceServiceAssetId:source,endpointDefinitionId:endpoint,url:`http://127.0.0.1:${port}/probe`,method:'GET' as const,actorId:'test-operator',declaration:normalizeUpstreamSecurity({components:{securitySchemes:{Protected:scheme}}},{security:[{Protected:[]}]})};
 return {service,options,input,value,count:()=>count};
}
describe('isolated durable authentication challenge prototype',()=>{
 beforeEach(async()=>{db=new DataSource({type:'sqljs',synchronize:true,entities:[Evidence]});await db.initialize();});
 afterEach(async()=>{if(server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}if(db?.isInitialized)await db.destroy();});
 it.each(['apiKey','bearer','basic','customHeader'])('requires four actual %s challenge responses and stores only safe evidence',async type=>{
  const f=await fixture('normal',type); const row=await f.service.challenge(f.input);
  expect(row).toMatchObject({result:'passed',anonymousBeforeStatus:401,wrongCredentialStatus:401,validCredentialStatus:200,anonymousAfterStatus:401});
  expect(f.count()).toBe(4);expect(await f.service.isCurrentPrototypeEvidence(row,f.input)).toBe(true);
  const persisted=JSON.stringify(await db.getRepository(Evidence).find());
  for(const secret of [...Object.values(f.value),'private-response-must-not-persist',Buffer.from(f.value.username+':'+f.value.password).toString('base64')]) expect(persisted).not.toContain(secret);
  expect(persisted).not.toContain('authorization');expect(persisted).not.toContain('secretRef');
 });
 it.each([['open',1],['wrong-accepted',2],['valid-denied',3],['anonymous-after',4],['redirect',1]])('rejects %s without accepting ordinary business success or following redirect',async(mode,count)=>{
  const f=await fixture(String(mode)); const row=await f.service.challenge(f.input);
  expect(row).toMatchObject({result:'failed',failureCode:'CHALLENGE_STATUS_REJECTED'});expect(f.count()).toBe(count);
  expect(await f.service.isCurrentPrototypeEvidence({...row,result:'passed'},f.input)).toBe(false);
 });
 it.each(['timeout','network-error'])('persists controlled %s failure without native error/response',async mode=>{
  const f=await fixture(mode);const row=await f.service.challenge(f.input);expect(row).toMatchObject({result:'failed',failureCode:'CHALLENGE_TRANSPORT_FAILED'});expect(f.count()).toBe(1);
 });
 it('rejects changed injected material/epoch after a real successful request',async()=>{
  const f=await fixture('rotate');const row=await f.service.challenge(f.input);expect(row).toMatchObject({result:'failed',failureCode:'CONTEXT_CHANGED'});expect(f.count()).toBe(4);
 });
 it('SQL.js disk close/reopen preserves audit but cannot promote an old process nonce to current proof',async()=>{
  const f=await fixture();const row=await f.service.challenge(f.input);expect(row.result).toBe('passed');
  const root=await mkdtemp(join(tmpdir(),'apinova-auth-ledger-'));
  try {
   const database=join(root,'evidence.sqlite');await writeFile(database,Buffer.from((db.driver as any).export()));await db.destroy();
   db=new DataSource({type:'sqljs',location:database,autoSave:true,entities:[Evidence]});await db.initialize();
   const restored=await db.getRepository(Evidence).findOneByOrFail({id:row.id});expect(restored.result).toBe('passed');
   const restarted=createAuthenticationChallengePrototype({...f.options,repository:db.getRepository(Evidence)});
   expect(await restarted.isCurrentPrototypeEvidence(restored,f.input)).toBe(false);expect(f.count()).toBe(4);
   await db.destroy();
  } finally {
   expect(dirname(resolve(root))).toBe(resolve(tmpdir()));expect(basename(root).startsWith('apinova-auth-ledger-')).toBe(true);
   await rm(root,{recursive:true,force:true});
  }
 });
 it('rejects unsupported method before storing evidence or making requests',async()=>{
  const f=await fixture();await expect(f.service.challenge({...f.input,method:'POST' as any})).rejects.toThrow('CHALLENGE_INPUT_INVALID');
  expect(f.count()).toBe(0);expect(await db.getRepository(Evidence).count()).toBe(0);
 });
});
