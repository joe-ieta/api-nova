import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EndpointDefinitionEntity } from '../../../database/entities/endpoint-definition.entity';
import { endpointUpstreamSecurityReadiness } from '../../publication/security/endpoint-upstream-security-readiness';
import type { GatewayResolvedRoute } from '../types/gateway-route-snapshot.types';

export function assertGatewayUpstreamDeclaration(endpoint: EndpointDefinitionEntity): void {
  const decision = endpointUpstreamSecurityReadiness(endpoint);
  if (!decision.canPublish) throw new ServiceUnavailableException('gateway_upstream_security_unverified');
}
/** Read the current declaration rather than trusting a previously published snapshot. */
@Injectable()
export class GatewayUpstreamSecurityRuntimeGuard {
  constructor(@InjectRepository(EndpointDefinitionEntity) private readonly endpoints: Repository<EndpointDefinitionEntity>) {}
  async assertCurrent(route: GatewayResolvedRoute): Promise<void> {
    const current = await this.endpoints.findOne({ where: { id: route.endpointDefinition.id } });
    if (!current || current.sourceServiceAssetId !== route.sourceServiceAsset.id) {
      throw new ServiceUnavailableException('gateway_upstream_security_context_unavailable');
    }
    assertGatewayUpstreamDeclaration(current);
  }
}
