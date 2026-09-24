import { endpointUpstreamSecurityReadiness as readiness } from './endpoint-upstream-security-readiness';
import { normalizeUpstreamSecurity } from './upstream-security-reconciliation';
const endpoint:any={id:'endpoint',sourceServiceAssetId:'source',method:'GET',rawOperation:{},metadata:{}};
describe('persisted declaration readiness',()=>{
 it('preserves ordinary undeclared legacy endpoints',()=>expect(readiness(endpoint).canPublish).toBe(true));
 it('retains root requirements after import and ignores a forged metadata Verified',()=>{
  const declaration=normalizeUpstreamSecurity({security:[{Key:[]}],components:{securitySchemes:{Key:{type:'apiKey',in:'header',name:'X-Key'}}}},{});
  const restored=JSON.parse(JSON.stringify({...endpoint,metadata:{upstreamSecurityDeclaration:declaration,upstreamSecurity:{state:'Verified',canPublish:true},testStatus:'passed'}}));
  expect(readiness(restored)).toMatchObject({state:'Declared',reason:'BindingMissing',canPublish:false});
 });
 it('rejects unresolved operation declarations even without import metadata',()=>{
  expect(readiness({...endpoint,rawOperation:{security:[{Unknown:[]}]}})).toMatchObject({reason:'DeclarationUnresolved',canPublish:false});
 });
 it('keeps explicit empty operation overriding inherited requirements',()=>{
  const declaration=normalizeUpstreamSecurity({security:[{Key:[]}],components:{securitySchemes:{Key:{type:'apiKey',in:'header',name:'X-Key'}}}},{});
  expect(readiness({...endpoint,rawOperation:{security:[]},metadata:{upstreamSecurityDeclaration:declaration}})).toMatchObject({state:'Unsecured',canPublish:true});
 });
 it('preserves a malformed inherited declaration instead of making it anonymous',()=>{
  expect(readiness({...endpoint,metadata:{upstreamSecurityDeclaration:normalizeUpstreamSecurity({security:null},{})}})).toMatchObject({reason:'DeclarationInvalid',canPublish:false});
 });
});
