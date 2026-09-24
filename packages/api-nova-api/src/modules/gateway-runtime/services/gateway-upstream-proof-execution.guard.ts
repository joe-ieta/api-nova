import { ServiceUnavailableException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { SecurityProof } from '../../publication/security/upstream-security-proof-authority';
import type { PublicationPreviewAuthorization } from '../../publication/services/publication-security-preview-adapter';
import { endpointUpstreamSecurityReadiness } from '../../publication/security/endpoint-upstream-security-readiness';
import { securityDigest } from '../../publication/security/upstream-security-reconciliation';
import { EndpointDefinitionEntity } from '../../../database/entities/endpoint-definition.entity';
import type { GatewayResolvedRoute } from '../types/gateway-route-snapshot.types';
export interface GatewayExecutionProofScope {
  readonly runtimeAssetId: string;
  readonly runtimeMembershipId: string;
  readonly endpointDefinitionId: string;
  readonly sourceServiceAssetId: string;
}
export interface GatewayExecutionProofReader {
  /** Host-held mapping only. Never reconstruct a proof/session from headers, metadata or a DB row. */
  read(request: object, scope: GatewayExecutionProofScope): Promise<Readonly<{ proof: SecurityProof; session: unknown }> | undefined>;
}
/** Independent pre-execution adapter, not yet registered in the production Gateway module.
 * Passing this guard never bypasses E1 declaration/Verified or Header-policy guards. */
export class GatewayUpstreamProofExecutionGuard {
  constructor(private readonly endpoints: Pick<Repository<EndpointDefinitionEntity>, 'findOneBy'>,
    private readonly capabilities: GatewayExecutionProofReader,
    private readonly authorization: PublicationPreviewAuthorization) {}

  async assertCurrent(route: GatewayResolvedRoute, request: object): Promise<void> {
    const unavailable = () => new ServiceUnavailableException('gateway_upstream_proof_unavailable');
    try {
      const scope = Object.freeze({ runtimeAssetId: route.runtimeAsset.id, runtimeMembershipId: route.membership.id,
        endpointDefinitionId: route.endpointDefinition.id, sourceServiceAssetId: route.sourceServiceAsset.id });
      if (!Object.values(scope).every(value => typeof value === 'string' && value.length > 0)) throw unavailable();
      const current = await this.endpoints.findOneBy({ id: scope.endpointDefinitionId });
      if (!current || current.sourceServiceAssetId !== scope.sourceServiceAssetId
        || route.endpointDefinition.sourceServiceAssetId !== scope.sourceServiceAssetId) throw unavailable();
      const requiresProof = !endpointUpstreamSecurityReadiness(current).canPublish || !endpointUpstreamSecurityReadiness(route.endpointDefinition).canPublish;
      if (!requiresProof) return;
      const captured = securityDigest(current);
      const capability = await this.capabilities.read(request, scope);
      if (!capability) throw unavailable();
      const proof = capability.proof, session = capability.session;
      const selector = Object.freeze({ runtimeAssetId: scope.runtimeAssetId, runtimeMembershipId: scope.runtimeMembershipId });
      if (!(await this.authorization.authorize(proof, session, selector))) throw unavailable();
      const latest = await this.endpoints.findOneBy({ id: scope.endpointDefinitionId });
      if (!latest || securityDigest(latest) !== captured) throw unavailable();
      if (!(await this.authorization.authorize(proof, session, selector))) throw unavailable();
    } catch { throw unavailable(); }
  }
}
