import type { EndpointDefinitionEntity } from '../../../database/entities/endpoint-definition.entity';
import { normalizeUpstreamSecurity, reconcileUpstreamSecurity, type SecurityDeclaration } from './upstream-security-reconciliation';

/** Readiness never trusts a caller-written metadata.state/evidence as Verified. */
export function endpointUpstreamSecurityReadiness(endpoint: Pick<EndpointDefinitionEntity, 'id' | 'sourceServiceAssetId' | 'method' | 'rawOperation' | 'metadata'>) {
  const stored = endpoint.metadata?.upstreamSecurityDeclaration as SecurityDeclaration | undefined;
  const root: Record<string, unknown> = {};
  if (stored?.version === 1) {
    root.components = { securitySchemes: stored.schemes };
    if (stored.source === 'global' || stored.source === 'global-explicit-empty') root.security = stored.expression;
  }
  let declaration = normalizeUpstreamSecurity(root, endpoint.rawOperation);
  if (stored?.version === 1 && stored.reason && !Object.prototype.hasOwnProperty.call(endpoint.rawOperation || {}, 'security')) declaration = { ...declaration, reason: stored.reason };
  const selected = endpoint.metadata?.upstreamSecuritySelectedBranch;
  return reconcileUpstreamSecurity({ declaration,
    selectedBranch: typeof selected === 'number' ? selected : undefined,
    context: { sourceServiceAssetId: endpoint.sourceServiceAssetId, endpointDefinitionId: endpoint.id,
      method: endpoint.method, target: '', environment: '' },
  });
}
