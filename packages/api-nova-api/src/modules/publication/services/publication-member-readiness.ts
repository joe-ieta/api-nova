import { evaluatePublicationReadiness } from '../../asset-catalog/endpoint-readiness.policy';
import { EndpointDefinitionEntity } from '../../../database/entities/endpoint-definition.entity';
import { PublicationProfileEntity } from '../../../database/entities/publication-profile.entity';
import { EndpointPublishBindingEntity } from '../../../database/entities/endpoint-publish-binding.entity';
import { RuntimeAssetEndpointBindingEntity } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import { RuntimeAssetEntity, RuntimeAssetType } from '../../../database/entities/runtime-asset.entity';
import { GatewayRouteBindingEntity } from '../../../database/entities/gateway-route-binding.entity';

export interface PublicationMemberRows {
  membership: RuntimeAssetEndpointBindingEntity;
  runtime: RuntimeAssetEntity;
  endpoint: EndpointDefinitionEntity;
  profile: PublicationProfileEntity | null;
  binding: EndpointPublishBindingEntity | null;
  routes: GatewayRouteBindingEntity[];
}

/** Current production gate. Persisted evidence/state cannot enable protected publication.
 * Preview is an observation; the writer must evaluate current rows again in its transaction. */
export function evaluatePublicationMemberReadiness(
  rows: PublicationMemberRows,
  validateGatewayRoute?: (route: GatewayRouteBindingEntity) => string,
) {
  const { membership, runtime, endpoint, profile, binding, routes } = rows;
  const gateway = runtime.type === RuntimeAssetType.GATEWAY_SERVICE;
  const readiness = evaluatePublicationReadiness(endpoint, profile ?? {}, {
    routeRequired: gateway,
    routeConfigured: routes.length === 1 && Boolean(routes[0].routePath && routes[0].routeMethod),
  });
  const reasons = [...readiness.reasons];
  if (!membership.enabled) reasons.push('MEMBERSHIP_DISABLED');
  if (![RuntimeAssetType.MCP_SERVER, RuntimeAssetType.GATEWAY_SERVICE].includes(runtime.type)) reasons.push('RUNTIME_TYPE_UNSUPPORTED');
  if (membership.runtimeAssetId !== runtime.id || membership.endpointDefinitionId !== endpoint.id
    || [profile, binding, ...routes].some(row => row
      && (row.endpointDefinitionId !== endpoint.id || row.runtimeAssetEndpointBindingId !== membership.id))) {
    reasons.push('PUBLICATION_CONTEXT_MISMATCH');
  }
  if (!Number.isSafeInteger(membership.publicationRevision) || membership.publicationRevision < 0
    || (binding?.publicationRevision ?? 0) !== membership.publicationRevision) reasons.push('PUBLICATION_REVISION_MISMATCH');
  if (routes.length > 1) reasons.push('GATEWAY_ROUTE_AMBIGUOUS');
  if (!gateway && routes.length) reasons.push('PUBLICATION_CONTEXT_MISMATCH');
  if (gateway && routes.length === 1) {
    try {
      if (!validateGatewayRoute?.(routes[0])) reasons.push('GATEWAY_HEADER_POLICY_NOT_READY');
    } catch { reasons.push('GATEWAY_HEADER_POLICY_NOT_READY'); }
  }
  return { ...readiness, ready: reasons.length === 0, reasons };
}
