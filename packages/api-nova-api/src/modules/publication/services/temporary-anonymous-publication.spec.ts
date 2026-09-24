import { PublicationService } from './publication.service';
import { RuntimeAssetType } from '../../../database/entities/runtime-asset.entity';
describe('temporary anonymous publication governance',()=>{
 const grant=()=>({reason:'Timed demo',actor:'spoofed-body',expiresAt:new Date(Date.now()+60000).toISOString(),allowProduction:false});
 const setup=(existing?:any)=>{
  const service:any=Object.create(PublicationService.prototype);
  Object.assign(service,{resolveMembershipPublicationContext:jest.fn().mockResolvedValue({runtimeAsset:{id:'runtime',type:RuntimeAssetType.GATEWAY_SERVICE},endpointDefinition:{id:'endpoint'},sourceServiceAsset:{id:'source'}}),
   extractPrimaryEndpoint:()=>({path:'/demo',method:'GET'}),findGatewayRouteBinding:jest.fn().mockResolvedValue(existing),
   ensureRouteConflictFree:jest.fn(),recordAuditEvent:jest.fn(),emitGatewaySnapshotRefresh:jest.fn(),buildMembershipPublicationState:jest.fn(),
   routeBindingRepository:{create:(x:any)=>x,save:jest.fn()}});return service;
 };
 it('overwrites body actor from trusted control plane identity',async()=>{
  const service=setup();await service.configureRuntimeMembershipGatewayRoute('membership',{upstreamConfig:{temporaryAnonymous:grant()}},'trusted-admin');
  expect(service.routeBindingRepository.save).toHaveBeenCalledWith(expect.objectContaining({upstreamConfig:expect.objectContaining({temporaryAnonymous:expect.objectContaining({actor:'trusted-admin'})})}));
 });
 it('requires a trusted actor even when body has one',async()=>{
  const service=setup();await expect(service.configureRuntimeMembershipGatewayRoute('membership',{upstreamConfig:{temporaryAnonymous:grant()}})).rejects.toThrow('Trusted actor');
  expect(service.routeBindingRepository.save).not.toHaveBeenCalled();
 });
 it.each([null,{...grant(),expiresAt:''},{...grant(),expiresAt:'2000-01-01T00:00:00Z'}])('rejects cleared/expired grant %#',async policy=>{
  const service=setup();await expect(service.configureRuntimeMembershipGatewayRoute('membership',{upstreamConfig:{temporaryAnonymous:policy}},'admin')).rejects.toThrow();
 });
 it('preserves a grant when an unrelated upstream configuration is replaced',async()=>{
  const old=grant();const service=setup({id:'route',upstreamConfig:{temporaryAnonymous:old}});
  await service.configureRuntimeMembershipGatewayRoute('membership',{upstreamConfig:{cache:{ttlMs:20}}},'trusted-admin');
  expect(service.routeBindingRepository.save).toHaveBeenCalledWith(expect.objectContaining({upstreamConfig:{cache:{ttlMs:20},temporaryAnonymous:old}}));
 });
});
