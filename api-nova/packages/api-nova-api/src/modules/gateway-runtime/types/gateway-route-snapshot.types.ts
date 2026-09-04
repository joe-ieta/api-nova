import { GatewayRouteBindingEntity } from '../../../database/entities/gateway-route-binding.entity';
import { RuntimeAssetEntity } from '../../../database/entities/runtime-asset.entity';
import { RuntimeAssetEndpointBindingEntity } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import { EndpointPublishBindingEntity } from '../../../database/entities/endpoint-publish-binding.entity';
import { EndpointDefinitionEntity } from '../../../database/entities/endpoint-definition.entity';
import { SourceServiceAssetEntity } from '../../../database/entities/source-service-asset.entity';
import { GatewayCompiledPolicyBundle } from './gateway-policy.types';

export type GatewayResolvedRoute = {
  routeBinding: GatewayRouteBindingEntity;
  runtimeAsset: RuntimeAssetEntity;
  membership: RuntimeAssetEndpointBindingEntity;
  publishBinding: EndpointPublishBindingEntity;
  endpointDefinition: EndpointDefinitionEntity;
  sourceServiceAsset: SourceServiceAssetEntity;
  upstreamBaseUrl: string;
  params: Record<string, string>;
  policies: GatewayCompiledPolicyBundle;
};

export type GatewaySnapshotRouteEntry = {
  routeBinding: GatewayRouteBindingEntity;
  runtimeAsset: RuntimeAssetEntity;
  membership: RuntimeAssetEndpointBindingEntity;
  publishBinding: EndpointPublishBindingEntity;
  endpointDefinition: EndpointDefinitionEntity;
  sourceServiceAsset: SourceServiceAssetEntity;
  upstreamBaseUrl: string;
  normalizedRoutePath: string;
  routeMethod: string;
  priorityScore: number;
  policies: GatewayCompiledPolicyBundle;
};
