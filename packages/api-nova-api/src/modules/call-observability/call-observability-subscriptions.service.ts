import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { RuntimeEventSubscriptionEntity, RuntimeSubscriptionRevisionEntity, RuntimeEventDeliveryEntity } from '../../database/entities/runtime-call-observability.entity';
import { AuditAction, AuditLevel, AuditStatus } from '../../database/entities/audit-log.entity';
import { AuditService } from '../security/services/audit.service';
import type { ObservabilityAuthorization } from './call-observability-access';
import { ObservabilityApiError } from './call-observability-api.contract';
import { ObservabilityCommandStore, observabilityEtag, requireObservabilityIfMatch } from './call-observability-command.store';
import { EVENTS_DISPATCH_AUTHORIZER } from './call-observability-events.dispatcher';
import type { EventsDispatchAuthorizer } from './call-observability-events.dispatcher';
import { CallObservabilityStore } from './call-observability.store';
import type { ObservabilityWriteTransaction } from './call-observability.store';
import { publicSequence } from './call-observability-storage';
import { normalizeObservabilitySubscription } from './call-observability-subscriptions.input';
import type { ObservabilitySubscriptionInput } from './call-observability-subscriptions.input';

export type NormalizedObservabilitySubscription = ObservabilitySubscriptionInput;
export const SUBSCRIPTION_CONFIGURATION_AUTHORIZER = Symbol('observability.subscriptionConfigurationAuthorizer');
export interface SubscriptionConfigurationAuthorizer {
  /** DB-only, current authorization of the exact destination, secretRef and signingKeyId supplied.
   * No DNS resolution, network calls, key material loading or silent configuration substitution.
   */
  authorize(ownerId: string, input: Readonly<NormalizedObservabilitySubscription>,
    manager: EntityManager): Promise<boolean>;
}
export interface SubscriptionMutationResult {
  subscriptionId: string;
  version: number;
  etag: string;
  effectiveFromSequence: string;
  pausedGapRange: { from: string; to: string } | null;
}
const MAX_VERSION = 2147483647;
const ROOT = '/api/v1/monitoring/observability/subscriptions';

/** Internal full-replacement commands only; no HTTP API or secret-bearing response. */
@Injectable()
export class CallObservabilitySubscriptionsService {
  constructor(private readonly store: CallObservabilityStore,
    private readonly commands: ObservabilityCommandStore,
    private readonly audit: AuditService,
    @Optional() @Inject(EVENTS_DISPATCH_AUTHORIZER) private readonly owners?: EventsDispatchAuthorizer,
    @Optional() @Inject(SUBSCRIPTION_CONFIGURATION_AUTHORIZER) private readonly configurations?: SubscriptionConfigurationAuthorizer) {}

  async create(raw: unknown, authorization: ObservabilityAuthorization, idempotencyKey: string) {
    const input = this.input(raw);
    const outcome = await this.commands.execute(authorization, {
      method: 'POST', path: ROOT, key: idempotencyKey, request: input,
    }, async (tx, previous) => {
      const current = await this.current(tx, authorization.principalId);
      this.cover(current, input.scope);
      await this.configuration(tx, authorization.principalId, input);
      // Replayed receipts cannot reveal resources that have since changed owner or scope.
      if (previous) await this.owned(tx, previous.resourceId, authorization.principalId, current);
    }, async tx => {
      const id = randomUUID(), boundary = tx.nextSequence();
      await tx.manager.getRepository(RuntimeEventSubscriptionEntity).insert({
        id, ownerId: authorization.principalId, name: input.name, version: 1,
        state: input.enabled ? 'active' : 'paused', destination: input.destination, secretRef: input.secretRef,
        filter: input.filter, scope: input.scope as unknown as QueryDeepPartialEntity<RuntimeEventSubscriptionEntity>['scope'], effectiveFromSequence: boundary,
        createdAt: tx.now, updatedAt: tx.now, pausedFromSequence: input.enabled ? null : boundary, deletedAt: null,
      });
      await this.revision(tx, id, 1, boundary, input);
      await this.auditChange(tx, authorization.principalId, id, 'create', 0, 1, boundary, null);
      return { statusCode: 201, resourceId: id, version: 1 };
    });
    return { ...outcome, etag: observabilityEtag('subscription:' + outcome.result.resourceId, outcome.result.version!) };
  }

  async update(id: string, raw: unknown, ifMatch: unknown, principalId: string): Promise<SubscriptionMutationResult> {
    this.id(id);
    const input = this.input(raw);
    return this.store.transaction(async tx => {
      const row = await this.owned(tx, id, principalId);
      requireObservabilityIfMatch(ifMatch, 'subscription:' + id, row.version);
      this.advanceVersion(row.version);
      const current = await this.current(tx, principalId);
      this.cover(current, input.scope);
      await this.configuration(tx, principalId, input);
      const previous = await this.liveRevision(tx, row);
      const boundary = tx.nextSequence(), version = row.version + 1;
      const pausedGapRange = row.state === 'paused' && input.enabled && row.pausedFromSequence
        ? { from: publicSequence(row.pausedFromSequence), to: publicSequence(boundary) } : null;
      await tx.manager.getRepository(RuntimeSubscriptionRevisionEntity).update(previous.id, { effectiveUntilSequence: boundary });
      await this.revision(tx, id, version, boundary, input);
      await tx.manager.getRepository(RuntimeEventSubscriptionEntity).update(id, {
        name: input.name, version, state: input.enabled ? 'active' : 'paused',
        destination: input.destination, secretRef: input.secretRef, filter: input.filter, scope: input.scope as unknown as QueryDeepPartialEntity<RuntimeEventSubscriptionEntity>['scope'],
        effectiveFromSequence: boundary, updatedAt: tx.now,
        pausedFromSequence: input.enabled ? null : row.pausedFromSequence || boundary,
      });
      await this.auditChange(tx, principalId, id, 'update', row.version, version, boundary, pausedGapRange);
      return { subscriptionId: id, version, etag: observabilityEtag('subscription:' + id, version),
        effectiveFromSequence: publicSequence(boundary), pausedGapRange };
    });
  }

  async remove(id: string, ifMatch: unknown, principalId: string): Promise<SubscriptionMutationResult> {
    this.id(id);
    return this.store.transaction(async tx => {
      const row = await this.owned(tx, id, principalId);
      requireObservabilityIfMatch(ifMatch, 'subscription:' + id, row.version);
      this.advanceVersion(row.version);
      const previous = await this.liveRevision(tx, row);
      const deliveries = tx.manager.getRepository(RuntimeEventDeliveryEntity);
      const statuses = ['pending', 'retry_wait', 'in_flight'];
      const exhausted = await deliveries.createQueryBuilder('delivery')
        .where('delivery.subscriptionId = :id AND delivery.status IN (:...statuses)', { id, statuses })
        .andWhere('(delivery.version >= :maximum OR delivery.version < 1)', { maximum: MAX_VERSION }).getOne();
      if (exhausted) throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
      const boundary = tx.nextSequence(), version = row.version + 1;
      await tx.manager.getRepository(RuntimeSubscriptionRevisionEntity).update(previous.id, { effectiveUntilSequence: boundary });
      // Deletion does not need destination or secret authorization. Preserve the stored revision snapshot.
      await tx.manager.getRepository(RuntimeSubscriptionRevisionEntity).insert({
        id: randomUUID(), subscriptionId: id, version, effectiveFromSequence: boundary,
        effectiveUntilSequence: null, config: { ...previous.config, enabled: false }, revoked: true, createdAt: tx.now,
      });
      await tx.manager.getRepository(RuntimeSubscriptionRevisionEntity).update({ subscriptionId: id }, { revoked: true });
      await tx.manager.getRepository(RuntimeEventSubscriptionEntity).update(id, {
        state: 'deleted', version, deletedAt: tx.now, updatedAt: tx.now, effectiveFromSequence: boundary,
      });
      // Invalidate all outstanding lease handles without claiming a send result or destroying attempt history.
      await deliveries.createQueryBuilder().update().set({ status: 'cancelled', version: () => '"version" + 1',
        leaseOwner: null, leaseUntil: null, lastError: { code: 'SUBSCRIPTION_DELETED' } as unknown as QueryDeepPartialEntity<RuntimeEventDeliveryEntity>['lastError'], updatedAt: tx.now })
        .where('subscriptionId = :id AND status IN (:...statuses)', { id, statuses }).execute();
      const pausedGapRange = row.state === 'paused' && row.pausedFromSequence
        ? { from: publicSequence(row.pausedFromSequence), to: publicSequence(boundary) } : null;
      await this.auditChange(tx, principalId, id, 'remove', row.version, version, boundary, pausedGapRange);
      return { subscriptionId: id, version, etag: observabilityEtag('subscription:' + id, version),
        effectiveFromSequence: publicSequence(boundary), pausedGapRange };
    });
  }

  private input(raw: unknown): NormalizedObservabilitySubscription {
    // Own the parsed object so caller mutation cannot change the idempotency digest after authorization.
    return JSON.parse(JSON.stringify(normalizeObservabilitySubscription(raw))) as NormalizedObservabilitySubscription;
  }

  private async current(tx: ObservabilityWriteTransaction, principalId: string): Promise<ObservabilityAuthorization> {
    if (!this.owners) throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
    const current = await this.owners.resolve(principalId, tx.manager);
    if (!current || current.principalId !== principalId || !current.requiredPermissions.includes('monitoring:read') ||
      !current.requiredPermissions.includes('monitoring:subscription:manage')) throw new ObservabilityApiError('FORBIDDEN');
    return current;
  }

  private cover(authorization: ObservabilityAuthorization, scope: NormalizedObservabilitySubscription['scope']): void {
    if (!scope || !['all', 'assets'].includes(scope.mode) || (scope.mode === 'assets' &&
      (!Array.isArray(scope.runtimeAssetIds) || scope.runtimeAssetIds.some(id => typeof id !== 'string' || !id)))) {
      throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
    }
    if (authorization.runtimeAssetIds === null) return;
    if (scope.mode !== 'assets' || scope.runtimeAssetIds.some(id => !authorization.runtimeAssetIds!.includes(id))) {
      throw new ObservabilityApiError('FORBIDDEN');
    }
  }

  private async owned(tx: ObservabilityWriteTransaction, id: string, principalId: string,
    current?: ObservabilityAuthorization): Promise<RuntimeEventSubscriptionEntity> {
    const row = await tx.manager.getRepository(RuntimeEventSubscriptionEntity).findOneBy({ id, ownerId: principalId });
    if (!row || row.deletedAt || !['active', 'paused'].includes(row.state)) throw new ObservabilityApiError('NOT_FOUND');
    const authorization = current ?? await this.current(tx, principalId);
    this.cover(authorization, row.scope);
    return row;
  }

  private async configuration(tx: ObservabilityWriteTransaction, ownerId: string, input: NormalizedObservabilitySubscription) {
    if (!this.configurations) throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
    if (!await this.configurations.authorize(ownerId, input, tx.manager)) throw new ObservabilityApiError('FORBIDDEN');
  }

  private async liveRevision(tx: ObservabilityWriteTransaction, row: RuntimeEventSubscriptionEntity) {
    const revision = await tx.manager.getRepository(RuntimeSubscriptionRevisionEntity).findOneBy({
      subscriptionId: row.id, version: row.version,
    });
    if (!revision || revision.revoked || revision.effectiveUntilSequence !== null) {
      throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
    }
    return revision;
  }

  private async revision(tx: ObservabilityWriteTransaction, id: string, version: number, boundary: string,
    input: NormalizedObservabilitySubscription) {
    await tx.manager.getRepository(RuntimeSubscriptionRevisionEntity).insert({
      id: randomUUID(), subscriptionId: id, version, effectiveFromSequence: boundary, effectiveUntilSequence: null,
      config: { destination: input.destination, secretRef: input.secretRef, signingKeyId: input.signingKeyId,
        scope: input.scope, filter: input.filter, enabled: input.enabled } as unknown as QueryDeepPartialEntity<RuntimeSubscriptionRevisionEntity>['config'], revoked: false, createdAt: tx.now,
    });
  }

  private advanceVersion(version: number): void {
    if (!Number.isInteger(version) || version < 1 || version >= MAX_VERSION) throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
  }
  private id(id: string): void {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/.test(id)) throw new ObservabilityApiError('INVALID_QUERY', 'id');
  }
  private async auditChange(tx: ObservabilityWriteTransaction, principalId: string, id: string,
    operation: 'create' | 'update' | 'remove', previousVersion: number, version: number, boundary: string,
    pausedGapRange: SubscriptionMutationResult['pausedGapRange']): Promise<void> {
    await this.audit.log({ action: AuditAction.CONFIG_UPDATED, level: AuditLevel.INFO, status: AuditStatus.SUCCESS,
      userId: principalId, resource: 'observability_subscription', resourceId: id,
      details: { operation: 'observability.subscription.' + operation, previousVersion, version,
        effectiveFromSequence: publicSequence(boundary), pausedGapRange } }, tx.manager);
  }
}
