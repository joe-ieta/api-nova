import type { RuntimeAssetEndpointBindingEntity } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import type { EndpointPublishBindingEntity } from '../../../database/entities/endpoint-publish-binding.entity';
import type { GatewayRouteBindingEntity } from '../../../database/entities/gateway-route-binding.entity';

/** Service-owned revision continuity, not an authorization or deployment grant. */
interface GatewayPublicationContinuity {
  version: 1;
  routeBindingId: string;
  publishBindingId: string;
  fromRevision: number;
  toRevision: number;
}

export function gatewayPublicationContinuityFloor(
  membership: RuntimeAssetEndpointBindingEntity,
  published: EndpointPublishBindingEntity,
  route: GatewayRouteBindingEntity,
): number | null {
  const value = membership.bindingConfig?.gatewayPublicationContinuity as GatewayPublicationContinuity | undefined;
  if (!value || value.version !== 1 || value.routeBindingId !== route.id || value.publishBindingId !== published.id
    || published.runtimeAssetEndpointBindingId !== membership.id || route.runtimeAssetEndpointBindingId !== membership.id
    || published.endpointDefinitionId !== membership.endpointDefinitionId || route.endpointDefinitionId !== membership.endpointDefinitionId
    || !Number.isSafeInteger(value.fromRevision) || value.fromRevision < 1
    || value.toRevision !== membership.publicationRevision || value.toRevision !== published.publicationRevision
    || !Number.isSafeInteger(value.toRevision) || value.toRevision < value.fromRevision) return null;
  return value.fromRevision;
}

export function nextGatewayPublicationContinuity(
  membership: RuntimeAssetEndpointBindingEntity,
  published: EndpointPublishBindingEntity,
  route: GatewayRouteBindingEntity,
  nextRevision: number,
): GatewayPublicationContinuity {
  // Offline/revoked publications start a new chain: republishing alone must not
  // resurrect an older revoked deployment, even if its route policy is unchanged.
  const continuing = membership.status === 'active' && published.publishStatus === 'active'
    && published.publishedToHttp && route.status === 'active'
    && published.publicationRevision === membership.publicationRevision;
  const fromRevision = continuing
    ? gatewayPublicationContinuityFloor(membership, published, route) ?? membership.publicationRevision
    : nextRevision;
  return { version: 1, routeBindingId: route.id, publishBindingId: published.id, fromRevision, toRevision: nextRevision };
}
