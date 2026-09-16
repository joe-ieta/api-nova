import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { RuntimeVerificationService } from './runtime-verification.service';
import { RuntimeResponseAssertionService } from './runtime-response-assertion.service';
import { McpCandidateReplayService } from './mcp-candidate-replay.service';
import { GatewayRouteSnapshotService } from '../../gateway-runtime/services/gateway-route-snapshot.service';
import { RuntimeUpstreamBindingsService } from '../../runtime-upstream-bindings/services/runtime-upstream-bindings.service';
import { RuntimeGovernanceInvalidationService } from '../../runtime-governance/services/runtime-governance-invalidation.service';
import { RuntimeAssetEntity } from '../../../database/entities/runtime-asset.entity';
import { RuntimeAssetEndpointBindingEntity } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import { RuntimeUpstreamBindingEntity } from '../../../database/entities/runtime-upstream-binding.entity';
import { RuntimeUpstreamBindingInstanceEntity } from '../../../database/entities/runtime-upstream-binding-instance.entity';
import { SourceServiceAssetEntity } from '../../../database/entities/source-service-asset.entity';
import { SourceServiceInstanceEntity } from '../../../database/entities/source-service-instance.entity';
import { EndpointTestSampleEntity } from '../../../database/entities/endpoint-test-sample.entity';
import { RuntimeVerificationRunEntity } from '../../../database/entities/runtime-verification-run.entity';
import { RuntimeVerificationResultEntity } from '../../../database/entities/runtime-verification-result.entity';
import { MCPServerEntity } from '../../../database/entities/mcp-server.entity';
import { GatewayRouteSnapshotEntity } from '../../../database/entities/gateway-route-snapshot.entity';
const entities = [RuntimeAssetEntity,RuntimeAssetEndpointBindingEntity,RuntimeUpstreamBindingEntity,RuntimeUpstreamBindingInstanceEntity,SourceServiceAssetEntity,SourceServiceInstanceEntity,EndpointTestSampleEntity,RuntimeVerificationRunEntity,RuntimeVerificationResultEntity,MCPServerEntity,GatewayRouteSnapshotEntity];
const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const wait=()=>new Promise(r=>setTimeout(r,1050));
describe('bounded SQL.js registered fixture -> binding -> verification -> activation -> invalidation -> republish',()=>{
 let db:DataSource;
 beforeEach(async()=>{db=new DataSource({type:'sqljs',synchronize:true,entities});await db.initialize();});
 afterEach(async()=>{await db.destroy();});
 it.each(['mcp_server','gateway_service'])('%s retains last verified version and publishes a reverified binding',async type=>{
  const repo=(entity:any):any=>db.getRepository(entity);
  await repo(SourceServiceAssetEntity).save({id:id(1),sourceKey:'synthetic-source'});
  await repo(SourceServiceInstanceEntity).save({id:id(2),sourceServiceAssetId:id(1),name:'local',environment:'test',scheme:'http',host:'127.0.0.1',port:1,status:'healthy'});
  await repo(RuntimeAssetEntity).save({id:id(3),name:'fixture',type,servicePrefix:'fixture',metadata:{managedServerId:id(9)}});
  await repo(RuntimeAssetEndpointBindingEntity).save({id:id(4),runtimeAssetId:id(3),endpointDefinitionId:id(5),status:'active',publicationRevision:1});
  await repo(EndpointTestSampleEntity).save({id:id(6),endpointDefinitionId:id(5),testRunId:id(7),fingerprint:'fixture',responseStatusCode:200,tags:['smoke'],capturedAt:new Date(),requestPayload:{},responsePayload:{ok:true}});
  await repo(MCPServerEntity).save({id:id(9),name:'fixture',port:9044,transport:'streamable',openApiData:{},config:{runtimeAssetId:id(3),endpoint:'/mcp'}});
  const invalidate=new RuntimeGovernanceInvalidationService(repo(RuntimeAssetEntity),repo(RuntimeAssetEndpointBindingEntity),repo(RuntimeUpstreamBindingEntity),repo(RuntimeUpstreamBindingInstanceEntity));
  const bindings=new RuntimeUpstreamBindingsService(repo(RuntimeUpstreamBindingEntity),repo(RuntimeUpstreamBindingInstanceEntity),repo(SourceServiceInstanceEntity),db,{log:async()=>{}} as any,invalidate);
  const dto:any={sourceServiceAssetId:id(1),environment:'test',selectionMode:'fixed_primary',primaryInstanceId:id(2),status:'active',candidates:[{sourceServiceInstanceId:id(2)}]};
  let binding=await bindings.upsert(id(4),dto,{actorId:'operator-fixture'}); await wait();
  const snapshot:any=new GatewayRouteSnapshotService({} as any,{} as any,repo(GatewayRouteSnapshotEntity),repo(RuntimeAssetEndpointBindingEntity),{} as any,repo(RuntimeAssetEntity),{} as any,repo(SourceServiceAssetEntity),bindings);
  // Synthetic route construction only; candidate storage, activation and rollback are production implementations.
  snapshot.buildSnapshot=async()=>[{runtimeAsset:await repo(RuntimeAssetEntity).findOneBy({id:id(3)}),membership:await repo(RuntimeAssetEndpointBindingEntity).findOneBy({id:id(4)}),publishBinding:{id:id(10)},routeBinding:{id:id(11),updatedAt:new Date(),pathMatchMode:'exact'},sourceServiceInstance:{id:id(2)},normalizedRoutePath:'/fixture/ping',routeMethod:'GET',upstreamBaseUrl:'http://127.0.0.1:1',policies:{},priorityScore:1}];
  let status=200;
  // No real upstream: replay outcome is injected for the state-machine test, not claimed as HTTP evidence.
  const gatewayReplay:any={replay:async()=>({statusCode:status,body:{ok:status===200},headers:{},bodyBytes:2,truncated:false,durationMs:1,routePath:'/fixture/ping',method:'GET'})};
  const verify=new RuntimeVerificationService(repo(RuntimeAssetEntity),repo(RuntimeAssetEndpointBindingEntity),repo(EndpointTestSampleEntity),repo(RuntimeVerificationRunEntity),repo(RuntimeVerificationResultEntity),bindings,snapshot,gatewayReplay,new McpCandidateReplayService(),new RuntimeResponseAssertionService());
  const context:any={mcpEndpointConfig:{port:9044,transport:'streamable',endpointPath:'/mcp'}};
  const plan=()=>verify.planCandidate(id(3),{},context);
  const execute=async(run:any)=>{
   if(type==='gateway_service')return verify.executeGatewayCandidate(id(3),run.id);
   const result=await verify.executeMcpCandidate(id(3),run.id,[{runtimeMembershipId:id(4),tool:{name:'fixture',handler:async()=>({content:[{type:'text',text:'fixture',_meta:{httpStatus:status}}],structuredContent:{data:{ok:status===200}}})}}] as any);
   if(result.run.status==='passed')await db.transaction(manager=>verify.activateMcpCandidate(id(3),run.id,manager));
   return result;
  };
  const first=await plan();expect(first.canExecute).toBe(true);await execute(first.run);
  const active=(await repo(RuntimeAssetEntity).findOneByOrFail({id:id(3)})).metadata.activeRevision;expect(active).toBe(first.run.candidateRevision);
  context.behaviorFingerprint = 'unpublished-candidate'; const old=await plan();
  binding=await bindings.upsert(id(4),{...dto,expectedRevision:binding.binding.revision},{actorId:'operator-fixture'});
  const changed=await repo(RuntimeAssetEntity).findOneByOrFail({id:id(3)});
  expect(changed.metadata.verificationRequired).toBe(true);expect(changed.metadata.verificationRequiredContext.actorId).toBe('operator-fixture');
  if(type==='mcp_server')await expect(execute(old.run)).rejects.toThrow('MCP_CANDIDATE_STALE');
  else expect((await execute(old.run)).run.status).toBe('failed');
  expect((await repo(RuntimeAssetEntity).findOneByOrFail({id:id(3)})).metadata.activeRevision).toBe(active);
  if(type==='gateway_service') { expect(await repo(GatewayRouteSnapshotEntity).count()).toBe(1); expect(snapshot.snapshot).toHaveLength(1); }
  await wait();status=500;const failed=await plan();expect((await execute(failed.run)).run.status).toBe('failed');
  expect((await repo(RuntimeAssetEntity).findOneByOrFail({id:id(3)})).metadata.activeRevision).toBe(active);
  status=200;let fresh=await plan();expect(fresh.run.candidateRevision).not.toBe(active);
  if(type==='gateway_service') {
   await db.query(`CREATE TRIGGER fixture_reject_activation BEFORE UPDATE ON runtime_assets BEGIN SELECT RAISE(ABORT, 'fixture activation write failure'); END`);
   expect((await execute(fresh.run)).run.status).toBe('failed');
   expect(await repo(GatewayRouteSnapshotEntity).count()).toBe(1);
   expect((await repo(RuntimeAssetEntity).findOneByOrFail({id:id(3)})).metadata.activeRevision).toBe(active);
   expect(snapshot.snapshot).toHaveLength(1);
   await db.query('DROP TRIGGER fixture_reject_activation'); fresh=await plan();
  }
  await execute(fresh.run);
  const published=await repo(RuntimeAssetEntity).findOneByOrFail({id:id(3)});
  expect(published.metadata.activeRevision).toBe(fresh.run.candidateRevision);expect(published.metadata.verificationRequired).toBe(false);
 },15000);
});
