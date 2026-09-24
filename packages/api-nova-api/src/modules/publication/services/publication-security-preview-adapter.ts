import type { DataSource } from 'typeorm';
import type { SecurityProof } from '../security/upstream-security-proof-authority';
import { securityDigest } from '../security/upstream-security-reconciliation';
import { PublicationProfileEntity as Profile } from '../../../database/entities/publication-profile.entity';
import { EndpointPublishBindingEntity as Binding } from '../../../database/entities/endpoint-publish-binding.entity';
import { GatewayRouteBindingEntity as Route } from '../../../database/entities/gateway-route-binding.entity';
import { RuntimeAssetEndpointBindingEntity as Membership } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import { RuntimeAssetEntity as Runtime, RuntimeAssetType } from '../../../database/entities/runtime-asset.entity';
import { EndpointDefinitionEntity as Endpoint } from '../../../database/entities/endpoint-definition.entity';

export interface PublicationPreviewSelector { runtimeAssetId: string; runtimeMembershipId: string }
export interface PublicationPreviewAuthorization {
  /** Host supplies the G1 authorization adapter, not a request boolean or persisted state. */
  authorize(proof: SecurityProof, session: unknown, selector: PublicationPreviewSelector): Promise<boolean>;
}
export type PublicationPreviewReason = 'SECURITY_PROOF_REQUIRED' | 'SECURITY_PROOF_UNAVAILABLE' | 'PREVIEW_CONTEXT_UNAVAILABLE'
  | 'PREVIEW_CONTEXT_CHANGED' | 'MEMBERSHIP_DISABLED' | 'PROFILE_MISSING' | 'PROFILE_NOT_REVIEWED' | 'BINDING_MISSING'
  | 'GATEWAY_ROUTE_MISSING' | 'GATEWAY_ROUTE_AMBIGUOUS' | 'GATEWAY_HEADER_POLICY_NOT_READY' | 'PUBLICATION_ACTIVATION_NOT_READY';
export interface PublicationSecurityPreview {
  readonly canPublish: false;
  readonly proofCurrent: boolean;
  readonly phase: 'proof_required' | 'blocked' | 'preview_validated';
  readonly reasons: readonly PublicationPreviewReason[];
  readonly progress?: Readonly<{ profileExists: boolean; bindingExists: boolean; gatewayRouteExists: boolean }>;
}
/** Read-only, unregistered preview capability. Never issues proofs, deploys, refreshes or creates drafts. */
export function createPublicationSecurityPreviewAdapter(database: Pick<DataSource, 'getRepository'>, authorization: PublicationPreviewAuthorization) {
  const blocked = (reason: PublicationPreviewReason, phase: PublicationSecurityPreview['phase'] = 'blocked'): PublicationSecurityPreview =>
    Object.freeze({ canPublish: false, proofCurrent: false, phase, reasons: Object.freeze([reason]) });
  async function read(selector: PublicationPreviewSelector) {
    const membership = await database.getRepository(Membership).findOneBy({ id: selector.runtimeMembershipId, runtimeAssetId: selector.runtimeAssetId });
    if (!membership) throw Error();
    const runtime = await database.getRepository(Runtime).findOneByOrFail({ id: membership.runtimeAssetId });
    const endpoint = await database.getRepository(Endpoint).findOneByOrFail({ id: membership.endpointDefinitionId });
    const where = { runtimeAssetEndpointBindingId: membership.id };
    const profile = await database.getRepository(Profile).findOne({ where, order: { version: 'DESC' } });
    const binding = await database.getRepository(Binding).findOneBy(where);
    const routes = await database.getRepository(Route).find({ where, order: { id: 'ASC' }, take: 2 });
    if ([profile, binding, ...routes].some(row => row && row.endpointDefinitionId !== endpoint.id)) throw Error();
    return { membership, runtime, endpoint, profile, binding, routes };
  }
  async function readiness(session: unknown, selector: PublicationPreviewSelector, proof?: SecurityProof): Promise<PublicationSecurityPreview> {
    if (!proof) return blocked('SECURITY_PROOF_REQUIRED', 'proof_required');
    try {
      if (!selector || Object.keys(selector).sort().join(',') !== 'runtimeAssetId,runtimeMembershipId'
        || ![selector.runtimeAssetId, selector.runtimeMembershipId].every(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id))) return blocked('PREVIEW_CONTEXT_UNAVAILABLE');
      const selected = Object.freeze({ ...selector });
      if (!(await authorization.authorize(proof, session, selected))) return blocked('SECURITY_PROOF_UNAVAILABLE');
      const before = await read(selected);
      if (!(await authorization.authorize(proof, session, selected))) return blocked('SECURITY_PROOF_UNAVAILABLE');
      const after = await read(selected);
      if (securityDigest(before) !== securityDigest(after)) return blocked('PREVIEW_CONTEXT_CHANGED');
      if (!(await authorization.authorize(proof, session, selected))) return blocked('SECURITY_PROOF_UNAVAILABLE');
      // Nothing below produces a reusable authorization; publishing must validate again.
      const reasons: PublicationPreviewReason[] = [];
      if (!after.membership.enabled) reasons.push('MEMBERSHIP_DISABLED');
      if (!after.profile) reasons.push('PROFILE_MISSING');
      else if (!['reviewed', 'published'].includes(after.profile.status)) reasons.push('PROFILE_NOT_REVIEWED');
      if (!after.binding) reasons.push('BINDING_MISSING');
      if (after.runtime.type === RuntimeAssetType.GATEWAY_SERVICE) {
        if (!after.routes.length) reasons.push('GATEWAY_ROUTE_MISSING');
        if (after.routes.length > 1) reasons.push('GATEWAY_ROUTE_AMBIGUOUS');
        if (after.routes.some(route => route.upstreamConfig?.headerPolicy !== undefined || route.upstreamConfig?.headerPolicyMigration !== undefined)) reasons.push('GATEWAY_HEADER_POLICY_NOT_READY');
      }
      const phase = reasons.length ? 'blocked' : 'preview_validated';
      reasons.push('PUBLICATION_ACTIVATION_NOT_READY');
      return Object.freeze({ canPublish: false, proofCurrent: true, phase, reasons: Object.freeze(reasons),
        progress: Object.freeze({ profileExists: Boolean(after.profile), bindingExists: Boolean(after.binding), gatewayRouteExists: Boolean(after.routes.length) }) });
    } catch { return blocked('PREVIEW_CONTEXT_UNAVAILABLE'); }
  }
  return Object.freeze({ readiness, preview: readiness,
    async list(session: unknown, items: readonly { selector: PublicationPreviewSelector; proof?: SecurityProof }[]): Promise<readonly PublicationSecurityPreview[]> {
      if (!Array.isArray(items) || items.length > 100) throw Error('publication_preview_selection_invalid');
      const captured = items.map(item => ({ selector: { ...item.selector }, proof: item.proof }));
      const result: PublicationSecurityPreview[] = [];
      for (const item of captured) result.push(await readiness(session, item.selector, item.proof));
      return Object.freeze(result);
    },
  });
}
