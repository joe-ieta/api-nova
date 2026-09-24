import { createHash } from 'node:crypto';
import { UpstreamCredentialRegistry } from 'api-nova-parser';
import { createUpstreamSecurityBindingEvaluator } from './upstream-security-binding-evaluator';
import { normalizeUpstreamSecurity, reconcileUpstreamSecurity } from './upstream-security-reconciliation';
const request={sourceServiceAssetId:'asset',endpointDefinitionId:'endpoint',url:'https://upstream.test/items',requestMethod:'GET'};
async function fixture(type='apiKey', constraints:Record<string,unknown>={}) {
 const values={secret:'private-test-value',username:'test-user',password:'test-pass'};
 let read: (key:string)=>Promise<string> = async key => values[key.toLowerCase()];
 const credential=type==='basic'?{type,usernameRef:'env:USERNAME',passwordRef:'env:PASSWORD'}
  :type==='apiKey'?{type,placement:{in:'header',name:'X-Key'},secretRef:'env:SECRET'}
  :type==='customHeader'?{type,name:'X-Key',secretRef:'env:SECRET'}:{type,secretRef:'env:SECRET'};
 const candidate:any={apiVersion:'security.apinova.io/v1',kind:'UpstreamCredentialBindings',metadata:{revision:'one',environment:'test'},reload:{mode:'manual',debounceMs:0,rejectPlaintextSecrets:true},secretProviders:{env:{type:'env'}},credentials:{selected:{...credential,...constraints}},sites:[{id:'site',sourceServiceAssetId:'asset',match:{scheme:'https',host:'upstream.test',port:443,basePath:'/'},allowedHosts:['upstream.test'],credential:'selected',endpoints:[]}]};
 const store=new UpstreamCredentialRegistry({environment:'test',providerFactory:description=>({type:description.type,resolve:key=>read(key)})});
 await store.reload(candidate);
 return {values,store,candidate,setRead:(next:typeof read)=>{read=next;}, evaluator:createUpstreamSecurityBindingEvaluator(()=>store.captureSnapshot())};
}
describe('trusted F1 binding evaluator opaque epochs',()=>{
 it.each(['apiKey','bearer','basic','customHeader'])('uses actual %s Resolver and exports no injected material',async type=>{
  const f=await fixture(type);
  const first=await f.evaluator.evaluate(request), second=await f.evaluator.evaluate(request);
  expect(first).toMatchObject({mode:'reference',credentialId:'selected',revision:'one',generation:1,secretsResolved:true});
  expect(first.providerEpoch).toMatch(/^[0-9a-f-]{36}$/);
  expect(second.providerEpoch).toBe(first.providerEpoch);
  const serialized=JSON.stringify(first)+JSON.stringify(f.evaluator);
  for(const value of Object.values(f.values)) {
   expect(serialized).not.toContain(value); expect(serialized).not.toContain(createHash('sha256').update(value).digest('hex'));
  }
  expect(serialized).not.toContain(Buffer.from('test-user:test-pass').toString('base64'));
  expect(serialized).not.toContain('headers'); expect(serialized).not.toContain('digest');
 });
 it('rotates on same-revision provider change and return to old content',async()=>{
  const f=await fixture(); const a=await f.evaluator.evaluate(request);
  f.values.secret='new-private-value'; const b=await f.evaluator.evaluate(request);
  f.values.secret='private-test-value'; const c=await f.evaluator.evaluate(request);
  expect(a.revision).toBe(b.revision); expect(a.generation).toBe(b.generation);
  expect(new Set([a.providerEpoch,b.providerEpoch,c.providerEpoch]).size).toBe(3);
 });
 it('separates real targets and invalidates same secret after Registry generation changes',async()=>{
  const f=await fixture(); const a=await f.evaluator.evaluate(request);
  expect((await f.evaluator.evaluate({...request,url:'https://upstream.test/other'})).providerEpoch).not.toBe(a.providerEpoch);
  const candidate={...f.candidate,metadata:{revision:'two',environment:'test'}}; await f.store.reload(candidate);
  const b=await f.evaluator.evaluate(request); expect(b.generation).toBe(2); expect(b.providerEpoch).not.toBe(a.providerEpoch);
 });
 it('fails closed with no error material and never reuses an epoch after provider recovery',async()=>{
  const f=await fixture(); const first=await f.evaluator.evaluate(request);
  f.setRead(async()=>{throw new Error('DO-NOT-EXPOSE-PRIVATE-PATH');});
  const rejected=await f.evaluator.evaluate(request);
  expect(rejected).toMatchObject({mode:'unresolved',reason:'SecretUnavailable',secretsResolved:false,providerEpoch:''});
  expect(JSON.stringify(rejected)).not.toContain('DO-NOT-EXPOSE');
  f.setRead(async()=>f.values.secret);
  expect((await f.evaluator.evaluate(request)).providerEpoch).not.toBe(first.providerEpoch);
 });
 it('loss of registry availability invalidates earlier observations',async()=>{
  const f=await fixture(); let available=true;
  const evaluator=createUpstreamSecurityBindingEvaluator(()=>{if(!available) throw new Error('private-path'); return f.store.captureSnapshot();});
  const first=await evaluator.evaluate(request); available=false;
  expect(await evaluator.evaluate(request)).toMatchObject({reason:'BindingMissing',providerEpoch:''});
  available=true; expect((await evaluator.evaluate(request)).providerEpoch).not.toBe(first.providerEpoch);
 }); it('restart and bounded eviction require a new epoch',async()=>{
  const f=await fixture(); const first=await f.evaluator.evaluate(request);
  expect((await createUpstreamSecurityBindingEvaluator(()=>f.store.captureSnapshot()).evaluate(request)).providerEpoch).not.toBe(first.providerEpoch);
  for(let n=0;n<256;n++) await f.evaluator.evaluate({...request,url:`https://upstream.test/path-${n}`});
  expect((await f.evaluator.evaluate(request)).providerEpoch).not.toBe(first.providerEpoch);
 });
 it('late old provider results cannot overwrite a newer successful evaluation',async()=>{
  const f=await fixture(); let release!:(value:string)=>void;
  f.setRead(()=>new Promise(resolve=>{release=resolve;}));
  const old=f.evaluator.evaluate(request); await Promise.resolve();
  f.setRead(async()=> 'new-value'); const current=await f.evaluator.evaluate(request);
  release('old-value'); expect(await old).toMatchObject({reason:'VerificationStale',secretsResolved:false});
  expect((await f.evaluator.evaluate(request)).providerEpoch).toBe(current.providerEpoch);
 });
 it('reload during an in-flight provider read cannot return an old configured binding',async()=>{
  const f=await fixture(); let release!:(value:string)=>void;
  f.setRead(()=>new Promise(resolve=>{release=resolve;})); const old=f.evaluator.evaluate(request); await Promise.resolve();
  f.setRead(async()=>f.values.secret); await f.store.reload({...f.candidate,metadata:{revision:'two',environment:'test'}});
  release(f.values.secret); expect(await old).toMatchObject({reason:'VerificationStale'});
 });
 it('None is explicit and a foreign target never falls back to anonymous',async()=>{
  const f=await fixture(); expect(await f.evaluator.evaluate({...request,url:'https://other.test/items'})).toMatchObject({reason:'BindingMissing',secretsResolved:false});
  await f.store.reload({...f.candidate,metadata:{revision:'two',environment:'test'},sites:[{...f.candidate.sites[0],credential:'none'}]});
  expect(await f.evaluator.evaluate(request)).toMatchObject({mode:'none',providerEpoch:'',secretsResolved:true});
 });
 it.each([[{enabled:false},'CredentialInactive'],[{methods:['POST']},'ScopeMismatch']])('uses actual resolver constraints %j',async(constraints,reason)=>{
  const f=await fixture('apiKey',constraints as any); expect(await f.evaluator.evaluate(request)).toMatchObject({reason,secretsResolved:false});
 });
 it('feeds opaque epoch into reconciliation while Configured never becomes Verified without evidence',async()=>{
  const f=await fixture(); const binding=await f.evaluator.evaluate(request);
  const declaration=normalizeUpstreamSecurity({components:{securitySchemes:{Key:{type:'apiKey',in:'header',name:'X-Key'}}}},{security:[{Key:[]}]});
  const input={declaration,context:{sourceServiceAssetId:'asset',endpointDefinitionId:'endpoint',target:request.url,method:'GET',environment:'test'},binding};
  const decision=reconcileUpstreamSecurity(input); expect(decision).toMatchObject({state:'Configured',canPublish:false});
  const evidence={contextDigest:decision.contextDigest!,providerEpoch:binding.providerEpoch,result:'passed' as const,verifiedAt:new Date().toISOString(),actorId:'test',resultId:'test-only'};
  f.values.secret='changed'; const changed=await f.evaluator.evaluate(request);
  expect(reconcileUpstreamSecurity({...input,binding:changed,evidence})).toMatchObject({state:'Configured',reason:'VerificationStale',canPublish:false});
 });
});
