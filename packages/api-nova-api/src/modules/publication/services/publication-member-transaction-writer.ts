import { endpointUpstreamSecurityReadiness } from '../security/endpoint-upstream-security-readiness';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { PublicationProfileEntity as Profile, PublicationProfileStatus } from '../../../database/entities/publication-profile.entity';
import { EndpointPublishBindingEntity as Binding, PublicationBindingStatus, PublicationReviewStatus } from '../../../database/entities/endpoint-publish-binding.entity';
import { GatewayRouteBindingEntity as Route, GatewayRouteBindingStatus } from '../../../database/entities/gateway-route-binding.entity';
import { RuntimeAssetEndpointBindingEntity as Membership, RuntimeAssetEndpointBindingStatus } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import { RuntimeAssetEntity as Runtime, RuntimeAssetStatus, RuntimeAssetType } from '../../../database/entities/runtime-asset.entity';
import { EndpointDefinitionEntity as Endpoint } from '../../../database/entities/endpoint-definition.entity';
import { UpstreamProductionChallengeEvidenceEntity as Evidence } from '../../../database/entities/upstream-production-challenge-evidence.entity';
import { newGatewayHeaderPolicyDraft, normalizeGatewayHeaderMigration } from '../../gateway-runtime/services/gateway-header-migration';

export interface PublicationMemberIds { membershipId: string; evidenceId: string }
export interface PublicationMemberValidationContext { endpoint: Endpoint; evidence: Evidence; membershipId: string; runtimeAssetId: string }
/** A host capability must revalidate the live proof/context. Reading an evidence row is not authorization. */
export type PublicationMemberValidator = (context: PublicationMemberValidationContext) => Promise<string>;
declare const ticketBrand: unique symbol;
export type PublicationMemberWriteTicket = { readonly [ticketBrand]: true };
export interface PublicationMemberCommitResult { membershipId: string; publicationRevision: number; profileId: string; bindingId: string; routeId?: string }
export class PublicationMemberAfterCommitError extends Error {
  readonly committed = true;
  constructor(readonly result: Readonly<PublicationMemberCommitResult>) { super('publication_after_commit_failed'); }
}
interface Rows { membership: Membership; runtime: Runtime; endpoint: Endpoint; evidence: Evidence; profile: Profile | null; binding: Binding | null; route: Route | null }
interface Ticket { ids: PublicationMemberIds; digest: string; contextVersion: string; routeDraft?: Pick<Route, 'routePath' | 'routeMethod' | 'upstreamPath' | 'upstreamMethod'> }
function digest(value: unknown): string {
  const stable = (input: any): any => input instanceof Date ? input.toISOString() : Array.isArray(input) ? input.map(stable)
    : input && typeof input === 'object' ? Object.fromEntries(Object.keys(input).sort().map(key => [key, stable(input[key])])) : input;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

/** Proof-backed tickets remain host-only. The Unsecured Gateway method is called by explicit membership publication. */
export class PublicationMemberTransactionWriter {
  private readonly tickets = new WeakMap<PublicationMemberWriteTicket, Ticket>();
  constructor(private readonly database: DataSource, private readonly validate: PublicationMemberValidator, private readonly now = () => new Date()) {}

  /** Explicit membership action for Unsecured endpoints only; never consumes evidence or proof. */
  async commitUnsecuredGateway(membershipId: string,
    validateRoute: (route: Route, endpoint: Endpoint, profile: Profile | null) => string): Promise<PublicationMemberCommitResult> {
    return this.database.transaction('SERIALIZABLE', async manager => {
      const lock = this.database.options.type === 'postgres' ? { lock: { mode: 'pessimistic_write' as const } } : {};
      const membership = await manager.findOneOrFail(Membership, { where: { id: membershipId }, ...lock });
      const runtime = await manager.findOneOrFail(Runtime, { where: { id: membership.runtimeAssetId }, ...lock });
      const endpoint = await manager.findOneOrFail(Endpoint, { where: { id: membership.endpointDefinitionId }, ...lock });
      if (!membership.enabled || runtime.type !== RuntimeAssetType.GATEWAY_SERVICE || !endpointUpstreamSecurityReadiness(endpoint).canPublish)
        throw new Error('publication_transaction_validation_failed');
      const where = { runtimeAssetEndpointBindingId: membership.id };
      const routes = await manager.find(Route, { where, take: 2, ...lock });
      const route = routes[0];
      if (routes.length !== 1 || route.endpointDefinitionId !== endpoint.id) throw new Error('publication_transaction_route_required');
      const migration = normalizeGatewayHeaderMigration(route.upstreamConfig?.headerPolicyMigration, route.id);
      if (migration.mode !== 'v1' || migration.source !== 'registry' || route.upstreamConfig?.headerPolicy !== undefined) throw new Error('GATEWAY_HEADER_POLICY_NOT_READY');
      const routeView = (value: Route) => { const { status, publishBindingId, lastPublishedAt, updatedAt, ...configuration } = value; return digest(configuration); };
      const routeConfiguration = routeView(route);
      const currentProfile = await manager.findOne(Profile, { where, order: { version: 'DESC' }, ...lock });
      const currentBinding = await manager.findOne(Binding, { where, ...lock });
      if ([currentProfile, currentBinding].some(row => row && row.endpointDefinitionId !== endpoint.id)) throw new Error('publication_transaction_validation_failed');
      const contextVersion = validateRoute(route, endpoint, currentProfile);
      if (!contextVersion) throw new Error('publication_transaction_validation_failed');
      const profile = currentProfile ?? manager.create(Profile, { id: randomUUID(), endpointDefinitionId: endpoint.id, runtimeAssetEndpointBindingId: membership.id, version: 1 });
      const binding = currentBinding ?? manager.create(Binding, { id: randomUUID(), endpointDefinitionId: endpoint.id, runtimeAssetEndpointBindingId: membership.id, publicationRevision: 0 });
      if (binding.publicationRevision !== membership.publicationRevision) throw new Error('publication_transaction_revision_mismatch');
      const publicationRevision = membership.publicationRevision + 1;
      const claimed = await manager.update(Membership, { id: membership.id, publicationRevision: membership.publicationRevision }, { status: RuntimeAssetEndpointBindingStatus.ACTIVE, publicationRevision });
      if (claimed.affected !== 1) throw new Error('publication_transaction_revision_conflict');
      profile.status = PublicationProfileStatus.PUBLISHED; await manager.save(Profile, profile);
      Object.assign(binding, { publicationProfileId: profile.id, publicationRevision, reviewStatus: PublicationReviewStatus.REVIEWED,
        publishStatus: PublicationBindingStatus.ACTIVE, publishedToHttp: true, publishedToMcp: false, publishedAt: this.now(), offlineAt: null, offlineBy: null });
      await manager.save(Binding, binding);
      Object.assign(route, { publishBindingId: binding.id, status: GatewayRouteBindingStatus.ACTIVE, lastPublishedAt: this.now() });
      await manager.save(Route, route);
      await manager.update(Runtime, { id: runtime.id }, { status: RuntimeAssetStatus.ACTIVE });
      const finalEndpoint = await manager.findOneByOrFail(Endpoint, { id: endpoint.id });
      const finalRoute = await manager.findOneByOrFail(Route, { id: route.id });
      if (routeView(finalRoute) !== routeConfiguration || digest(finalEndpoint) !== digest(endpoint) || !endpointUpstreamSecurityReadiness(finalEndpoint).canPublish
        || validateRoute(finalRoute, finalEndpoint, profile) !== contextVersion) throw new Error('publication_transaction_context_changed');
      return { membershipId, publicationRevision, profileId: profile.id, bindingId: binding.id, routeId: route.id };
    });
  }

  async prepare(ids: PublicationMemberIds, routeDraft?: Ticket['routeDraft']): Promise<PublicationMemberWriteTicket> {
    const capturedIds = structuredClone(ids);
    const rows = await this.read(this.database.manager, capturedIds);
    this.check(rows);
    const contextVersion = await this.validateContext(rows);
    const ticket = Object.freeze({}) as PublicationMemberWriteTicket;
    this.tickets.set(ticket, { ids: capturedIds, digest: digest(rows), contextVersion, routeDraft: routeDraft && structuredClone(routeDraft) });
    return ticket;
  }

  async commit(ticket: PublicationMemberWriteTicket, afterCommit?: (result: Readonly<PublicationMemberCommitResult>) => Promise<void>): Promise<PublicationMemberCommitResult> {
    const plan = this.tickets.get(ticket); if (!plan) throw new Error('publication_transaction_ticket_invalid');
    this.tickets.delete(ticket);
    const result = await this.database.transaction('SERIALIZABLE', async manager => {
      const rows = await this.read(manager, plan.ids, true);
      this.check(rows);
      if (digest(rows) !== plan.digest || await this.validateContext(rows) !== plan.contextVersion) throw new Error('publication_transaction_context_changed');
      const protectedDigest = digest([rows.endpoint, rows.evidence]);
      let route = rows.route;
      if (rows.runtime.type === RuntimeAssetType.GATEWAY_SERVICE && !route) {
        if (!plan.routeDraft) throw new Error('publication_transaction_route_required');
        // Keep the current new-route v1/default gate closed, even in this standalone writer.
        route = manager.create(Route, { ...plan.routeDraft, id: randomUUID(), endpointDefinitionId: rows.endpoint.id,
          runtimeAssetEndpointBindingId: rows.membership.id, upstreamConfig: newGatewayHeaderPolicyDraft({}) });
      }
      if (route?.upstreamConfig?.headerPolicy !== undefined || route?.upstreamConfig?.headerPolicyMigration !== undefined) throw new Error('GATEWAY_HEADER_POLICY_NOT_READY');
      const profile = rows.profile ?? manager.create(Profile, { id: randomUUID(), endpointDefinitionId: rows.endpoint.id,
        runtimeAssetEndpointBindingId: rows.membership.id, version: 1 });
      const binding = rows.binding ?? manager.create(Binding, { id: randomUUID(), endpointDefinitionId: rows.endpoint.id,
        runtimeAssetEndpointBindingId: rows.membership.id, publicationRevision: 0 });
      if (binding.publicationRevision !== rows.membership.publicationRevision) throw new Error('publication_transaction_revision_mismatch');
      const publicationRevision = rows.membership.publicationRevision + 1;
      const claimed = await manager.update(Membership, { id: rows.membership.id, publicationRevision: rows.membership.publicationRevision },
        { status: RuntimeAssetEndpointBindingStatus.ACTIVE, publicationRevision });
      if (claimed.affected !== 1) throw new Error('publication_transaction_revision_conflict');
      profile.status = PublicationProfileStatus.PUBLISHED; await manager.save(Profile, profile);
      Object.assign(binding, { publicationProfileId: profile.id, publicationRevision, reviewStatus: PublicationReviewStatus.REVIEWED,
        publishStatus: PublicationBindingStatus.ACTIVE, publishedToMcp: rows.runtime.type === RuntimeAssetType.MCP_SERVER,
        publishedToHttp: rows.runtime.type === RuntimeAssetType.GATEWAY_SERVICE, publishedAt: this.now(), offlineAt: null, offlineBy: null });
      await manager.save(Binding, binding);
      if (route) { Object.assign(route, { publishBindingId: binding.id, status: GatewayRouteBindingStatus.ACTIVE, lastPublishedAt: this.now() }); await manager.save(Route, route); }
      await manager.update(Runtime, { id: rows.runtime.id }, { status: RuntimeAssetStatus.ACTIVE });
      const after = await this.read(manager, plan.ids);
      this.check(after);
      if (digest([after.endpoint, after.evidence]) !== protectedDigest || await this.validateContext(after) !== plan.contextVersion) throw new Error('publication_transaction_context_changed');
      // The validator may await a live context authority. Re-read protected rows
      // after that await as well; validation must never bless a stale evidence row.
      const final = await this.read(manager, plan.ids);
      this.check(final);
      if (digest([final.endpoint, final.evidence]) !== protectedDigest) throw new Error('publication_transaction_context_changed');
      return { membershipId: rows.membership.id, publicationRevision, profileId: profile.id, bindingId: binding.id, ...(route ? { routeId: route.id } : {}) };
    });
    // The durable transaction has finished. Hook failure cannot roll back or replay it.
    if (afterCommit) {
      try { await afterCommit(Object.freeze({ ...result })); }
      catch { throw new PublicationMemberAfterCommitError(Object.freeze({ ...result })); }
    }
    return result;
  }

  private async validateContext(rows: Rows): Promise<string> {
    const version = await this.validate(structuredClone({ endpoint: rows.endpoint, evidence: rows.evidence, membershipId: rows.membership.id, runtimeAssetId: rows.runtime.id }));
    if (typeof version !== 'string' || !version) throw new Error('publication_transaction_validation_failed');
    return version;
  }
  private check(rows: Rows): void {
    const { membership, runtime, endpoint, evidence, profile, binding, route } = rows;
    if (!membership.enabled || membership.runtimeAssetId !== runtime.id || membership.endpointDefinitionId !== endpoint.id
      || evidence.endpointDefinitionId !== endpoint.id || evidence.sourceServiceAssetId !== endpoint.sourceServiceAssetId
      || evidence.evidenceKind !== 'production_challenge_v1' || evidence.challengeVersion !== 1 || evidence.result !== 'passed'
      || evidence.revokedAt || evidence.expiresAt.getTime() <= this.now().getTime()
      || evidence.completedAt.getTime() > this.now().getTime()
      || [profile, binding, route].some(row => row && (row.endpointDefinitionId !== endpoint.id || row.runtimeAssetEndpointBindingId !== membership.id))) throw new Error('publication_transaction_validation_failed');
  }
  private async read(manager: EntityManager, ids: PublicationMemberIds, lock = false): Promise<Rows> {
    const locking = lock && this.database.options.type === 'postgres' ? { lock: { mode: 'pessimistic_write' as const } } : {};
    const membership = await manager.findOneOrFail(Membership, { where: { id: ids.membershipId }, ...locking });
    const runtime = await manager.findOneOrFail(Runtime, { where: { id: membership.runtimeAssetId }, ...locking });
    const endpoint = await manager.findOneOrFail(Endpoint, { where: { id: membership.endpointDefinitionId }, ...locking });
    const evidence = await manager.findOneOrFail(Evidence, { where: { id: ids.evidenceId }, ...locking });
    const where = { runtimeAssetEndpointBindingId: membership.id };
    const profile = await manager.findOne(Profile, { where, order: { version: 'DESC' }, ...locking });
    const binding = await manager.findOne(Binding, { where, ...locking });
    const routes = await manager.find(Route, { where, take: 2, ...locking });
    if (routes.length > 1) throw new Error('publication_transaction_route_ambiguous');
    const route = routes[0] ?? null;
    return { membership, runtime, endpoint, evidence, profile, binding, route };
  }
}
