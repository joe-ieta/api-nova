import { compileGatewayHeaderPolicy, assertGatewayHeaderPolicyReady } from './gateway-header-policy';
import { GatewayPolicyService } from './gateway-policy.service';
import { RuntimeAssetType } from '../../../database/entities/runtime-asset.entity';
import { PublicationService } from '../../publication/services/publication.service';

describe('Header v1 compilation preparation and safe activation boundary',()=>{
 it('compiles immutable normalized inline policy with stable identity',()=>{
  const one=compileGatewayHeaderPolicy({routeId:'r',inlinePolicy:{version:1,requestHeaders:['X-Business']}})!;
  const same=compileGatewayHeaderPolicy({routeId:'r',inlinePolicy:{version:1,requestHeaders:['x-business']}})!;
  expect(one.requestHeaders).toContain('x-business');expect(one.identity).toBe(same.identity);
  expect(Object.isFrozen(one)).toBe(true);
 });
 it('rejects two policy sources and never substitutes inline policy for Registry',()=>{
  expect(()=>compileGatewayHeaderPolicy({routeId:'r',inlinePolicy:{version:1},registryConfigured:true})).toThrow('SOURCE_CONFLICT');
  const compiled=compileGatewayHeaderPolicy({routeId:'r',inlinePolicy:{version:1}})!;
  expect(compileGatewayHeaderPolicy({routeId:'r',registryConfigured:true,registryPolicy:compiled})).toBe(compiled);
 });
 it('rejects reserved and dynamic credential name extensions',()=>{
  for(const name of ['authorization','x-forwarded-for','cookie','x-request-id','content-length','x-private-auth'])
   expect(()=>compileGatewayHeaderPolicy({routeId:'r',inlinePolicy:{version:1,requestHeaders:[name]},managedHeaderNames:['x-private-auth']})).toThrow();
 });
 it('fails closed before route activation until transport and cache enforcement are ready',()=>{
  expect(()=>assertGatewayHeaderPolicyReady({version:1},'r')).toThrow('NOT_READY');
  expect(()=>new GatewayPolicyService().compileForRoute({id:'r',authPolicyRef:'anonymous',routeVisibility:'external',upstreamConfig:{headerPolicy:{version:1}}} as any)).toThrow('NOT_READY');
  expect(()=>assertGatewayHeaderPolicyReady(undefined,'r')).not.toThrow();
 });
 it('rejects saving unsupported v1, null and malformed policies before database writes',async()=>{
  const service:any=Object.create(PublicationService.prototype);
  service.resolveMembershipPublicationContext=jest.fn();
  for(const headerPolicy of [{version:1},null,{version:2}])
   await expect(service.configureRuntimeMembershipGatewayRoute('m',{upstreamConfig:{headerPolicy}})).rejects.toMatchObject({response:{code:'GATEWAY_HEADER_POLICY_NOT_READY'}});
  expect(service.resolveMembershipPublicationContext).not.toHaveBeenCalled();
 });

 it('does not let an existing unsupported policy disappear through an update',async()=>{
  const service:any=Object.create(PublicationService.prototype);
  Object.assign(service,{resolveMembershipPublicationContext:async()=>({runtimeAsset:{type:RuntimeAssetType.GATEWAY_SERVICE},endpointDefinition:{}}),extractPrimaryEndpoint:()=>({path:'/demo',method:'GET'}),findGatewayRouteBinding:async()=>({upstreamConfig:{headerPolicy:{version:1}}}),routeBindingRepository:{save:jest.fn()}});
  await expect(service.configureRuntimeMembershipGatewayRoute('m',{upstreamConfig:{}})).rejects.toMatchObject({response:{code:'GATEWAY_HEADER_POLICY_NOT_READY'}});
  expect(service.routeBindingRepository.save).not.toHaveBeenCalled();
 });
});
