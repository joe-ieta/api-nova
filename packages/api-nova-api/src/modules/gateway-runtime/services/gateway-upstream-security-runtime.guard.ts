import { Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EndpointDefinitionEntity } from '../../../database/entities/endpoint-definition.entity';
import { endpointUpstreamSecurityReadiness } from '../../publication/security/endpoint-upstream-security-readiness';
import type { GatewayResolvedRoute } from '../types/gateway-route-snapshot.types';
import { PublicationHostAuthorityService } from '../../publication/security/publication-host-authority.service';

export function assertGatewayUpstreamDeclaration(endpoint: EndpointDefinitionEntity): void {
  const decision = endpointUpstreamSecurityReadiness(endpoint);
  if (!decision.canPublish) throw new ServiceUnavailableException('gateway_upstream_security_unverified');
}
/** Read the current declaration rather than trusting a previously published snapshot. */
@Injectable()
export class GatewayUpstreamSecurityRuntimeGuard {
  constructor(@InjectRepository(EndpointDefinitionEntity) private readonly endpoints: Repository<EndpointDefinitionEntity>,
    @Optional() private readonly authority?: PublicationHostAuthorityService) {}
  async assertCurrent(route: GatewayResolvedRoute, request?: object, targetUrl?: string): Promise<void> {
    const current = await this.endpoints.findOne({ where: { id: route.endpointDefinition.id } });
    if (!current || current.sourceServiceAssetId !== route.sourceServiceAsset.id) {
      throw new ServiceUnavailableException('gateway_upstream_security_context_unavailable');
    }
    const snapshot = endpointUpstreamSecurityReadiness(route.endpointDefinition);
    const persisted = endpointUpstreamSecurityReadiness(current);
    if (snapshot.canPublish && persisted.canPublish) return;
    if (!snapshot.canPublish && !persisted.canPublish && request && targetUrl &&
      await this.authority?.authorizeGateway(request, route, targetUrl)) return;
    throw new ServiceUnavailableException('gateway_upstream_security_unverified');
  }
}
