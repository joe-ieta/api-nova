import { PublicationService } from '../services/publication.service';
import { RuntimeAssetsService } from '../../runtime-assets/services/runtime-assets.service';
import * as reader from '../../runtime-assets/services/mcp-ownership-reader';
import { normalizeUpstreamSecurity } from './upstream-security-reconciliation';
const protectedEndpoint = () => ({id:'endpoint',sourceServiceAssetId:'source',method:'GET',path:'/ping',status:'verified',publishEnabled:true,rawOperation:{},metadata:{testStatus:'passed',lastProbeStatus:'healthy',upstreamSecurityDeclaration:normalizeUpstreamSecurity({security:[{Key:[]}],components:{securitySchemes:{Key:{type:'apiKey',in:'header',name:'X-Key'}}}},{})}});
describe('security gates before publication or execution preparation',()=>{
 afterEach(()=>jest.restoreAllMocks());
 it.each(['gateway_service','mcp_server'])('%s publication rejects before revision/profile/route writes',async type=>{
  const service:any=Object.create(PublicationService.prototype);
  const profile={status:'reviewed',intentName:'ping',descriptionForLlm:'ping'};
  service.ensureProfile=jest.fn(async()=>profile);
  service.findGatewayRouteBinding=jest.fn(async()=>null);
  service.ensureDefaultGatewayRoute=jest.fn();
  const save=jest.fn(); service.profileRepository={save}; service.bindingRepository={save}; service.routeBindingRepository={save}; service.runtimeBindingRepository={save};
  const context={endpointDefinition:protectedEndpoint(),sourceServiceAsset:{id:'source'},runtimeAsset:{id:'runtime',type},membership:{id:'membership',publicationRevision:4}};
  await expect(service.publishMembershipContext(context,true)).rejects.toThrow('upstream_security:BindingMissing');
  expect(service.ensureProfile).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); expect(service.ensureDefaultGatewayRoute).not.toHaveBeenCalled();
  expect(context.membership.publicationRevision).toBe(4); expect(profile.status).toBe('reviewed');
 });
 it.each(['gateway_service','mcp_server'])('%s assembly rejects before resolver/replay/network preparation',async type=>{
  const service:any=Object.create(RuntimeAssetsService.prototype);
  const asset={id:'runtime',type,name:'fixture'};
  const rows=[{membership:{id:'membership',enabled:true},endpointDefinition:protectedEndpoint(),sourceServiceAsset:{id:'source'},publishBinding:{publishedToMcp:true,publishedToHttp:true},gatewayRouteBinding:{status:'active'}}];
  service.requireRuntimeAsset=jest.fn(async()=>asset);
  service.runtimeAssetRepository={manager:{}};
  service.listRuntimeAssetMemberships=jest.fn(async()=>({data:rows,total:1}));
  jest.spyOn(reader,'readMcpOwnership').mockResolvedValue({asset,rows} as any);
  const resolve=jest.fn(); service.runtimeUpstreamBindingsService={resolve};
  const assemble=type==='gateway_service'?'assembleGatewayRuntimeAssetPayload':'assembleMcpRuntimeAssetPayload';
  await expect(service[assemble]('runtime')).rejects.toMatchObject({response:{code:'UPSTREAM_SECURITY_BLOCKED',reason:'BindingMissing',state:'Declared'}});
  expect(resolve).not.toHaveBeenCalled();
 });
});
