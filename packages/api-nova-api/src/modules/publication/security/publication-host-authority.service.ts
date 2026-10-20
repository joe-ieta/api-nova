import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { User } from '../../../database/entities/user.entity';
import { EndpointDefinitionEntity as Endpoint } from '../../../database/entities/endpoint-definition.entity';
import { RuntimeAssetEndpointBindingEntity as Membership } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import { RuntimeAssetEntity as Runtime } from '../../../database/entities/runtime-asset.entity';
import { GatewayRouteBindingEntity as Route } from '../../../database/entities/gateway-route-binding.entity';
import { EndpointPublishBindingEntity as Binding } from '../../../database/entities/endpoint-publish-binding.entity';
import { UpstreamProductionChallengeEvidenceEntity as Evidence } from '../../../database/entities/upstream-production-challenge-evidence.entity';
import type { GatewayResolvedRoute } from '../../gateway-runtime/types/gateway-route-snapshot.types';
import { createPublicationSecurityPreviewAdapter, type PublicationPreviewSelector } from '../services/publication-security-preview-adapter';
import { createPublicationBatchCandidateExecutor, type FreshPublicationCapability } from '../services/publication-batch-candidate-executor';
import type { PublicationMemberValidationContext } from '../services/publication-member-transaction-writer';
import { createTrustedChallengeIntentAuthority, UPSTREAM_CHALLENGE_PERMISSION, type TrustedChallengeIntent } from './trusted-challenge-intent-authority';
import { createUpstreamSecurityContextAuthority } from './upstream-security-context-authority';
import { createUpstreamAuthenticationChallengeTransport } from './upstream-authentication-challenge-transport';
import { createUpstreamAuthenticationChallengeOrchestrator, type OrchestratedChallengeResult } from './upstream-authentication-challenge-orchestrator';
import { endpointUpstreamSecurityDeclaration } from './endpoint-upstream-security-readiness';
import { securityDigest } from './upstream-security-reconciliation';
import { PUBLICATION_HOST_AUTHORITY_PLAN, inspectPublicationHostAuthorityPlan, type PublicationHostAuthorityPlan } from './publication-host-authority-plan';

const denied = () => Error('publication_authority_unavailable');
const fingerprint = (value: unknown) => securityDigest(JSON.parse(JSON.stringify(value)));
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
type Issued = { session: unknown; selector: Readonly<PublicationPreviewSelector>; capability: Readonly<FreshPublicationCapability>; result: OrchestratedChallengeResult };

/** Default-off production composition. Trusted host code supplies authentication,
 * ownership and Registry capabilities; neither management JSON nor consumer secrets
 * are an identity source. This service does not grant/seed product permissions. */
@Injectable()
export class PublicationHostAuthorityService implements OnModuleDestroy {
  private host?: ReturnType<typeof inspectPublicationHostAuthorityPlan>;
  private contexts?: ReturnType<typeof createUpstreamSecurityContextAuthority>;
  private intents?: ReturnType<typeof createTrustedChallengeIntentAuthority>;
  private challenges?: ReturnType<typeof createUpstreamAuthenticationChallengeOrchestrator>;
  private issued = new WeakMap<object, Issued>();
  private requests = new WeakMap<object, Issued>();
  private closed = false;

  constructor(private readonly database: DataSource,
    @Optional() @Inject(PUBLICATION_HOST_AUTHORITY_PLAN) plan?: PublicationHostAuthorityPlan) {
    if (!plan) return;
    // Invalid injection is isolated to this subsystem, never an implicit legacy fallback.
    try {
      const host = inspectPublicationHostAuthorityPlan(plan);
      this.contexts = createUpstreamSecurityContextAuthority({
        read: async (ids, manager = database.manager) => {
          const endpoint = await manager.findOneBy(Endpoint, { id: ids.endpointDefinitionId, sourceServiceAssetId: ids.sourceServiceAssetId });
          if (!endpoint) return undefined;
          const row = await host.bindings.read(ids, manager);
          if (!row || row.method !== endpoint.method.toUpperCase() ||
            fingerprint(row.declaration) !== fingerprint(endpointUpstreamSecurityDeclaration(endpoint)) ||
            row.selectedBranch !== endpoint.metadata?.upstreamSecuritySelectedBranch) return undefined;
          return row;
        },
      }, host.captureSnapshot);
      this.intents = createTrustedChallengeIntentAuthority({
        sessions: host.sessions, ownership: host.ownership, audit: host.audit,
        users: { findUserById: async id => (await database.manager.findOne(User, { where: { id }, relations: ['roles', 'roles.permissions'] }))! },
      });
      this.challenges = createUpstreamAuthenticationChallengeOrchestrator({
        authority: this.contexts, intents: this.intents, transport: createUpstreamAuthenticationChallengeTransport(this.contexts),
        repository: database.getRepository(Evidence), ttlMs: host.ttlMs,
      });
      this.host = host;
    } catch { this.closed = true; }
  }

  private selected(input: PublicationPreviewSelector): Readonly<PublicationPreviewSelector> {
    if (!input || Object.keys(input).sort().join(',') !== 'runtimeAssetId,runtimeMembershipId' ||
      !validId(input.runtimeAssetId) || !validId(input.runtimeMembershipId)) throw denied();
    return Object.freeze({ runtimeAssetId: input.runtimeAssetId, runtimeMembershipId: input.runtimeMembershipId });
  }
  private requireHost() {
    if (this.closed || !this.host || !this.contexts || !this.challenges || !this.intents) throw denied();
    return this.host;
  }
  private async access(session: unknown, selector: Readonly<PublicationPreviewSelector>, manager: EntityManager) {
    const host = this.requireHost(), identity = await host.sessions.resolve(session);
    if (!identity || !validId(identity.actorId) || !validId(identity.authenticationEpoch)) throw denied();
    const user = await manager.findOne(User, { where: { id: identity.actorId }, relations: ['roles', 'roles.permissions'] });
    if (!user?.isActive || user.isLocked) throw denied();
    const grants = user.roles.filter(role => role.enabled === true).flatMap(role =>
      role.permissions.filter(permission => [UPSTREAM_CHALLENGE_PERMISSION, 'server:manage'].includes(permission.name) && permission.enabled === true &&
        (permission.conditions == null || typeof permission.conditions === 'object' && !Array.isArray(permission.conditions) && !Object.keys(permission.conditions).length))
        .map(permission => ({ role: role.id, permission: permission.id, name: permission.name, roleUpdatedAt: role.updatedAt, permissionUpdatedAt: permission.updatedAt })));
    if (!grants.some(grant => grant.name === UPSTREAM_CHALLENGE_PERMISSION)) throw denied();
    const membership = await manager.findOneBy(Membership, { id: selector.runtimeMembershipId, runtimeAssetId: selector.runtimeAssetId });
    if (!membership?.enabled) throw denied();
    const endpoint = await manager.findOneBy(Endpoint, { id: membership.endpointDefinitionId });
    const runtime = await manager.findOneBy(Runtime, { id: membership.runtimeAssetId });
    if (!endpoint || !runtime) throw denied();
    const ids = { sourceServiceAssetId: endpoint.sourceServiceAssetId, endpointDefinitionId: endpoint.id };
    const ownership = await host.ownership.resolve(user.id, ids, manager);
    const membershipOwnership = await host.ownership.resolveMembership(user.id, selector, manager);
    if (!ownership || !membershipOwnership || !validId(ownership.revision) || !validId(membershipOwnership.revision)) throw denied();
    // The writer controls publication/status changes itself, including CAS revisions.
    const { status: _status, publicationRevision: _revision, updatedAt: _updated, ...memberConfiguration } = membership;
    const { status: _runtimeStatus, updatedAt: _runtimeUpdated, ...runtimeConfiguration } = runtime;
    return { actorId: user.id, ids, endpoint, membership, runtime,
      canManagePublication: grants.some(grant => grant.name === 'server:manage'),
      version: fingerprint({ identity, grants, ownership, membershipOwnership, memberConfiguration, runtimeConfiguration, endpoint }) };
  }
  private async observe(session: unknown, selector: Readonly<PublicationPreviewSelector>, manager = this.database.manager) {
    const before = await this.access(session, selector, manager);
    const context = await this.contexts!.currentContext(before.ids, manager);
    const after = await this.access(session, selector, manager);
    this.requireHost();
    if (before.version !== after.version) throw denied();
    const { credentialType: _credentialType, ...binding } = context;
    return { ...after, context: Object.freeze({ ...binding, actorId: after.actorId }),
      version: fingerprint({ access: after.version, binding }) };
  }
  private tracked(session: unknown, selector: Readonly<PublicationPreviewSelector>, capability: Readonly<FreshPublicationCapability>): Issued {
    this.requireHost();
    const tracked = capability?.proof && this.issued.get(capability.proof);
    if (!tracked || tracked.session !== session || fingerprint(tracked.selector) !== fingerprint(selector) ||
      capability.evidenceId !== tracked.capability.evidenceId || capability.contextVersion !== tracked.capability.contextVersion) throw denied();
    return tracked;
  }
  private async validate(session: unknown, selector: Readonly<PublicationPreviewSelector>, capability: Readonly<FreshPublicationCapability>, manager = this.database.manager) {
    this.tracked(session, selector, capability);
    const current = await this.observe(session, selector, manager);
    const row = await manager.findOneBy(Evidence, { id: capability.evidenceId });
    if (!row || !this.challenges!.matchesEvidence(capability.proof, row) || current.version !== capability.contextVersion ||
      !(await this.challenges!.authorizeProof(capability.proof, current.context))) throw denied();
    const after = await this.observe(session, selector, manager);
    const finalRow = await manager.findOneBy(Evidence, { id: capability.evidenceId });
    this.requireHost();
    if (after.version !== current.version || !finalRow || !this.challenges!.matchesEvidence(capability.proof, finalRow) ||
      !(await this.challenges!.authorizeProof(capability.proof, after.context))) throw denied();
    this.requireHost();
    return after;
  }

  async challenge(session: unknown, selection: PublicationPreviewSelector, signal?: AbortSignal): Promise<Readonly<FreshPublicationCapability>> {
    const selector = this.selected(selection);
    let result: OrchestratedChallengeResult | undefined;
    let intent: TrustedChallengeIntent | undefined;
    try {
      const before = await this.observe(session, selector);
      intent = await this.intents!.issue(session, before.ids);
      result = await this.challenges!.execute(intent, signal);
      await this.intents!.complete(intent, 'passed'); intent = undefined;
      const after = await this.observe(session, selector);
      if (before.version !== after.version || signal?.aborted ||
        !(await this.challenges!.authorizeProof(result.proof, after.context))) throw denied();
      this.requireHost();
      const capability = Object.freeze({ ...result, contextVersion: after.version });
      this.issued.set(result.proof, { session, selector, capability, result });
      return capability;
    } catch {
      if (result) try { await this.challenges!.revoke(result); } catch { /* Local revocation already happened. */ }
      if (intent) try { await this.intents!.complete(intent, 'failed'); } catch { /* Lease remains closed. */ }
      throw denied();
    }
  }
  async authorize(proof: FreshPublicationCapability['proof'], session: unknown, selection: PublicationPreviewSelector): Promise<boolean> {
    try {
      const capability = this.issued.get(proof)?.capability;
      if (!capability) return false;
      await this.validate(session, this.selected(selection), capability);
      this.requireHost(); return true;
    } catch { return false; }
  }
  async validateTransaction(session: unknown, selection: PublicationPreviewSelector, capability: Readonly<FreshPublicationCapability>, context: PublicationMemberValidationContext): Promise<string> {
    const selector = this.selected(selection);
    if (context.manager.connection !== this.database || context.membershipId !== selector.runtimeMembershipId ||
      context.runtimeAssetId !== selector.runtimeAssetId || context.evidence.id !== capability.evidenceId) throw denied();
    const current = await this.validate(session, selector, capability, context.manager);
    if (!current.canManagePublication || fingerprint(context.endpoint) !== fingerprint(current.endpoint) ||
      !this.challenges!.matchesEvidence(capability.proof, context.evidence)) throw denied();
    this.requireHost();
    return current.version;
  }
  preview(session: unknown, selection: PublicationPreviewSelector, proof?: FreshPublicationCapability['proof']) {
    return createPublicationSecurityPreviewAdapter(this.database, this).preview(session, selection, proof);
  }
  /** Real validator is wired, but G2 activation readiness deliberately stays false. */
  executeBatch(session: unknown, selections: readonly PublicationPreviewSelector[]) {
    return createPublicationBatchCandidateExecutor({
      database: this.database, authorization: this, readiness: createPublicationSecurityPreviewAdapter(this.database, this),
      fresh: async (caller, selector) => this.challenge(caller, selector),
      validateTransaction: (caller, selector, capability, context) => this.validateTransaction(caller, selector, capability, context),
    }).executeBatch(session, selections);
  }
  /** Only authenticated host middleware may bind the exact request object. */
  async bindRequest(request: object, session: unknown, selection: PublicationPreviewSelector, capability: Readonly<FreshPublicationCapability>): Promise<void> {
    if (!request || typeof request !== 'object' || this.requests.has(request)) throw denied();
    const selector = this.selected(selection);
    await this.validate(session, selector, capability);
    if (this.requests.has(request)) throw denied();
    this.requests.set(request, this.tracked(session, selector, capability));
  }
  async authorizeGateway(request: object, route: GatewayResolvedRoute, targetUrl: string): Promise<boolean> {
    try {
      const binding = this.requests.get(request);
      if (!binding || binding.selector.runtimeAssetId !== route.runtimeAsset.id ||
        binding.selector.runtimeMembershipId !== route.membership.id) return false;
      const current = await this.validate(binding.session, binding.selector, binding.capability);
      const storedRoute = await this.database.manager.findOneBy(Route, { id: route.routeBinding.id, runtimeAssetEndpointBindingId: route.membership.id });
      const publication = storedRoute?.publishBindingId && await this.database.manager.findOneBy(Binding, { id: storedRoute.publishBindingId });
      if (!storedRoute || !publication || storedRoute.status !== 'active' || publication.publishStatus !== 'active' ||
        !publication.publishedToHttp || publication.runtimeAssetEndpointBindingId !== current.membership.id ||
        publication.endpointDefinitionId !== current.endpoint.id || publication.publicationRevision !== current.membership.publicationRevision ||
        current.runtime.type !== 'gateway_service' || current.runtime.status !== 'active' || current.membership.status !== 'active' ||
        route.membership.publicationRevision !== current.membership.publicationRevision ||
        route.sourceServiceAsset.id !== current.endpoint.sourceServiceAssetId ||
        fingerprint(route.endpointDefinition) !== fingerprint(current.endpoint) ||
        fingerprint(route.routeBinding) !== fingerprint(storedRoute) ||
        current.context.target !== targetUrl || current.context.method !== route.routeBinding.upstreamMethod) return false;
      // Revalidate after all asynchronous route/publication reads.
      const final = await this.validate(binding.session, binding.selector, binding.capability);
      const finalRoute = await this.database.manager.findOneBy(Route, { id: storedRoute.id });
      const finalPublication = await this.database.manager.findOneBy(Binding, { id: publication.id });
      if (final.membership.publicationRevision !== current.membership.publicationRevision ||
        final.membership.status !== 'active' || final.runtime.status !== 'active' ||
        fingerprint(finalRoute) !== fingerprint(storedRoute) || fingerprint(finalPublication) !== fingerprint(publication)) return false;
      this.requireHost();
      return true;
    } catch { return false; }
  }
  async revoke(capability: Readonly<FreshPublicationCapability>): Promise<void> {
    const tracked = this.issued.get(capability.proof);
    if (!tracked || tracked.capability !== capability) throw denied();
    this.issued.delete(capability.proof);
    await this.challenges!.revoke(tracked.result);
  }
  onModuleDestroy(): void { this.closed = true; this.issued = new WeakMap(); this.requests = new WeakMap(); }
}
