import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { AssetCatalogService } from '../../asset-catalog/services/asset-catalog.service';
import { EndpointDefinitionEntity } from '../../../database/entities/endpoint-definition.entity';
import { SourceServiceAssetEntity } from '../../../database/entities/source-service-asset.entity';
import { endpointUpstreamSecurityReadiness } from './endpoint-upstream-security-readiness';
describe('OpenAPI security import survives SQL.js restart',()=>{
 it('preserves global declarations by endpoint identity and explicit empty override despite duplicate operationIds',async()=>{
  let db=new DataSource({type:'sqljs',synchronize:true,entities:[EndpointDefinitionEntity,SourceServiceAssetEntity]}); await db.initialize();
  try {
   const service:any=Object.create(AssetCatalogService.prototype);
   service.endpointDefinitionRepository=db.getRepository(EndpointDefinitionEntity);
   service.sourceServiceRepository=db.getRepository(SourceServiceAssetEntity);
   service.logger={log:()=>{}};
   const result=await service.syncDocumentToAssets({documentId:'doc',documentName:'fixture',spec:{openapi:'3.0.3',security:[{Key:[]}],components:{securitySchemes:{Key:{type:'apiKey',in:'header',name:'X-Key'}}},paths:{'/protected':{get:{operationId:'duplicate'}},'/open':{get:{operationId:'duplicate',security:[]}}}}});
   expect(result.endpoints).toHaveLength(2);
   const image=(db.driver as any).export(); await db.destroy();
   db=new DataSource({type:'sqljs',database:image,entities:[EndpointDefinitionEntity,SourceServiceAssetEntity]}); await db.initialize();
   const endpoints=await db.getRepository(EndpointDefinitionEntity).find();
   const protectedEndpoint=endpoints.find(e=>e.path==='/protected')!;
   const openEndpoint=endpoints.find(e=>e.path==='/open')!;
   expect(protectedEndpoint.id).not.toBe(openEndpoint.id);
   expect(protectedEndpoint.metadata!.upstreamSecurityDeclaration).toMatchObject({source:'global',expression:[{Key:[]}],schemes:{Key:{type:'apiKey',in:'header',name:'X-Key'}}});
   expect(endpointUpstreamSecurityReadiness(protectedEndpoint)).toMatchObject({reason:'BindingMissing',canPublish:false});
   expect(endpointUpstreamSecurityReadiness(openEndpoint)).toMatchObject({state:'Unsecured',canPublish:true});
  } finally { if(db.isInitialized) await db.destroy(); }
 });
});
