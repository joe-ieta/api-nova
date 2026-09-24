import { normalizeUpstreamSecurity as normalize, reconcileUpstreamSecurity as reconcile, TrustedSecurityBinding } from './upstream-security-reconciliation';
const schemes = { Key:{type:'apiKey',in:'header',name:'X-Key'}, Bearer:{type:'http',scheme:'bearer'}, Basic:{type:'http',scheme:'basic'}, OAuth:{type:'oauth2'} };
const context = {sourceServiceAssetId:'source',endpointDefinitionId:'endpoint',target:'https://example.test/a',method:'GET',environment:'test'};
const binding: TrustedSecurityBinding = {mode:'reference',credentialId:'key',credential:{type:'apiKey',placement:{in:'header',name:'x-key'},secretRef:'env:KEY'},revision:'r1',generation:1,providerEpoch:'opaque-epoch',secretsResolved:true};
const declaration=(security:unknown)=>normalize({components:{securitySchemes:schemes}},{security});
const decide=(security:unknown, extras:any={})=>reconcile({declaration:declaration(security),context,binding,...extras});
describe('upstream security declaration and trusted reconciliation',()=>{
 it('preserves root inheritance and explicit operation empty override',()=>{
  const root={security:[{Key:[]}],components:{securitySchemes:schemes}};
  expect(normalize(root,{})).toMatchObject({source:'global',expression:[{Key:[]}]});
  expect(normalize(root,{security:[]})).toEqual({version:1,source:'operation-explicit-empty',expression:[],schemes:{}});
 });
 it.each([null,{},'Key',[null],[[]],[{Missing:[]}],[{Key:'bad'}]])('rejects invalid or unresolved declaration %j',security=>{
  expect(decide(security)).toMatchObject({state:'Declared',canPublish:false});
 });
 it('does not classify absent declarations as protected or borrow unrelated OAuth',()=>{
  expect(reconcile({declaration:normalize({components:{securitySchemes:schemes}},{}),context})).toMatchObject({state:'Unsecured',canPublish:true});
 });
 it('blocks mixed OAuth even when an anonymous arm is selected',()=>{
  expect(decide([{OAuth:[]},{}],{selectedBranch:1})).toMatchObject({reason:'OAuthUnsupported'});
 });
 it('requires explicit OR selection and never falls back after missing binding',()=>{
  expect(decide([{Key:[]},{}])).toMatchObject({reason:'BindingAmbiguous'});
  expect(decide([{Key:[]},{}],{selectedBranch:0,binding:undefined})).toMatchObject({reason:'BindingMissing'});
  expect(decide([{Key:[]},{}],{selectedBranch:1,binding:{...binding,mode:'none'}})).toMatchObject({state:'Unsecured'});
 });
 it('rejects AND without partially applying a single credential',()=>{
  expect(decide([{Key:[],Bearer:[]}])).toMatchObject({reason:'CombinationUnsupported'});
 });
 it.each(['none','unresolved'])('does not let %s erase a protected declaration',mode=>{
  expect(decide([{Key:[]}],{binding:{...binding,mode}}).canPublish).toBe(false);
 });
 it.each([
  ['apiKey',{type:'apiKey',placement:{in:'header',name:'X-KEY'},secretRef:'env:K'},'Key'],
  ['customHeader',{type:'customHeader',name:'x-key',secretRef:'env:K'},'Key'],
  ['bearer',{type:'bearer',secretRef:'env:K'},'Bearer'],
  ['basic',{type:'basic',usernameRef:'env:U',passwordRef:'env:P'},'Basic'],
 ])('accepts compatible %s only as Configured',(_label,credential,name)=>{
  expect(decide([{[String(name)]:[]}],{binding:{...binding,credential}})).toMatchObject({state:'Configured',reason:'VerificationMissing'});
 });
 it('does not accept bearer as Basic or API key query as header',()=>{
  expect(decide([{Basic:[]}],{binding:{...binding,credential:{type:'bearer',secretRef:'env:K'}}})).toMatchObject({reason:'BindingIncompatible'});
  const d=normalize({components:{securitySchemes:{Key:{type:'apiKey',in:'query',name:'X-Key'}}}},{security:[{Key:[]}]});
  expect(reconcile({declaration:d,context,binding})).toMatchObject({reason:'BindingIncompatible'});
 });
 it.each([
  [{enabled:false},'CredentialInactive'],
  [{expiresAt:'2000-01-01T00:00:00Z'},'CredentialInactive'],
  [{environment:'production'},'ScopeMismatch'],
  [{methods:['POST']},'ScopeMismatch'],
  [{allowedHosts:['other.test']},'ScopeMismatch'],
  [{endpointDefinitionIds:['other']},'ScopeMismatch'],
 ])('rejects current lifecycle/scope constraints %j', (constraints,reason)=>{
  expect(decide([{Key:[]}],{binding:{...binding,credential:{...binding.credential,...constraints}}})).toMatchObject({state:'Declared',reason,canPublish:false});
 });
 it('does not call compatible metadata Configured before trusted secret resolution',()=>{
  expect(decide([{Key:[]}],{binding:{...binding,secretsResolved:false}})).toMatchObject({reason:'SecretUnavailable'});
 }); it('requires authentication evidence even when no declaration explicitly requires the configured secret',()=>{
  expect(reconcile({declaration:normalize({},{}),context,binding})).toMatchObject({state:'Configured',canPublish:false});
 });
 it.each(['SecretUnavailable','CredentialInactive','ScopeMismatch','BindingAmbiguous'])('propagates %s without anonymous fallback',reason=>{
  expect(decide([{}],{binding:{...binding,reason}})).toMatchObject({state:'Declared',reason,canPublish:false});
 });
 it('binds evidence to declaration, source, endpoint, target, method, environment, generation and provider epoch',()=>{
  const first=decide([{Key:[]}]);
  const evidence={contextDigest:first.contextDigest,providerEpoch:binding.providerEpoch,result:'passed',verifiedAt:new Date().toISOString(),actorId:'operator',resultId:'probe-1'};
  expect(decide([{Key:[]}],{evidence})).toMatchObject({state:'Verified',canPublish:true});
  for(const field of Object.keys(context)) expect(decide([{Key:[]}],{context:{...context,[field]:field==='target'?'https://changed.test/a':'changed'},evidence})).toMatchObject({state:'Configured',reason:'VerificationStale'});
  expect(decide([{Key:[]}],{binding:{...binding,generation:2},evidence})).toMatchObject({reason:'VerificationStale'});
  expect(decide([{Key:[]}],{binding:{...binding,providerEpoch:'rotated-without-new-revision'},evidence})).toMatchObject({reason:'VerificationStale'});
  expect(decide([{Key:[]}],{evidence:{...evidence,result:'failed'}})).toMatchObject({reason:'VerificationFailed'});
  expect(JSON.stringify(first)).not.toContain('env:KEY');
 });
});
