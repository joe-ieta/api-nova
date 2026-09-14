import { Inject, Injectable, Optional } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { RuntimeEventSubscriptionEntity, RuntimeSubscriptionRevisionEntity, RuntimeEventDeliveryEntity,
  RuntimePipelineStateEntity } from '../../database/entities/runtime-call-observability.entity';
import { RuntimeObservabilityEventEntity } from '../../database/entities/runtime-observability-event.entity';
import { ObservabilityAuthorization } from './call-observability-access';
import { CallObservabilityStore } from './call-observability.store';
import { canonicalJson, contentHash, expiresAfter, publicSequence, sequenceKey } from './call-observability-storage';

export const EVENTS_DISPATCH_AUTHORIZER = Symbol('events.dispatchAuthorizer');
export const EVENTS_DISPATCH_CHECKPOINT = 'call-observability:events-dispatch:v1';
/** Database-only callback inside the Store transaction; never use network I/O or cached JWT claims. */
export interface EventsDispatchAuthorizer {
  resolve(ownerId: string, manager: EntityManager): Promise<ObservabilityAuthorization | null>;
}
/** Subscription management must persist this immutable shape for EVERY change, including pause/resume.
 * Sequence windows are (effectiveFromSequence, effectiveUntilSequence].
 */
export interface EventsDispatchRevisionConfig {
  enabled: boolean;
  scope: { mode: 'all' } | { mode: 'assets'; runtimeAssetIds: string[] };
  filter: Record<string, string[]>;
}
const FILTERS = ['runtimeAssetIds', 'serverTypes', 'eventTypes', 'severities', 'spanKinds', 'outcomes',
  'callerIds', 'endpointDefinitionIds', 'toolNames'];
export class EventsDispatchError extends Error {
  constructor(readonly code: string) { super(code); }
}

/** Explicitly invoked core, not a scheduled worker and not a webhook sender. */
@Injectable()
export class CallObservabilityEventsDispatcher {
  constructor(private readonly store: CallObservabilityStore,
    @Optional() @Inject(EVENTS_DISPATCH_AUTHORIZER) private readonly authorizer?: EventsDispatchAuthorizer) {}

  async dispatchBatch(limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new EventsDispatchError('INVALID_BATCH_LIMIT');
    return this.store.transaction(async tx => {
      // Store's counter-row lock serializes this checkpoint across PostgreSQL processes;
      // its SQLite lane serializes readers/writers sharing a DataSource.
      const checkpoints = tx.manager.getRepository(RuntimePipelineStateEntity);
      const checkpoint = await checkpoints.findOne({ where: { id: EVENTS_DISPATCH_CHECKPOINT } });
      let scannedThrough = sequenceKey(checkpoint?.value?.sequence ?? '0');
      const high = tx.currentSequence();
      if (scannedThrough > high) throw new EventsDispatchError('CHECKPOINT_AHEAD_OF_STORE');
      const rows = await tx.manager.getRepository(RuntimeObservabilityEventEntity).createQueryBuilder('event')
        .where('event.sequence > :after AND event.sequence <= :high', { after: scannedThrough, high })
        .orderBy('event.sequence', 'ASC').take(limit + 1).getMany();
      const hasMore = rows.length > limit, events = rows.slice(0, limit);
      const subscriptions = await tx.manager.getRepository(RuntimeEventSubscriptionEntity).createQueryBuilder('subscription')
        .where('subscription.state = :state', { state: 'active' })
        .andWhere('subscription.deletedAt IS NULL').take(201).getMany();
      if (subscriptions.length > 200) throw new EventsDispatchError('SUBSCRIPTION_BATCH_TOO_LARGE');
      if (subscriptions.length && !this.authorizer) throw new EventsDispatchError('AUTHORIZER_UNAVAILABLE');
      const owners = new Map<string, ObservabilityAuthorization | null>();
      let created = 0, skipped = 0;
      for (const event of events) {
        scannedThrough = sequenceKey(event.sequence!);
        if (event.dispatchState === 'suppressed' || (event.expiresAt && event.expiresAt.getTime() <= Date.parse(tx.now))) {
          skipped++; continue;
        }
        if (!['pending', 'dispatched'].includes(event.dispatchState || '')) {
          throw new EventsDispatchError('UNSUPPORTED_EVENT_DISPATCH_STATE');
        }
        for (const subscription of subscriptions) {
          if (!owners.has(subscription.ownerId)) owners.set(subscription.ownerId,
            await this.authorizer!.resolve(subscription.ownerId, tx.manager));
          const authorization = owners.get(subscription.ownerId);
          if (!authorization || authorization.principalId !== subscription.ownerId ||
            !authorization.requiredPermissions.includes('monitoring:read') ||
            (authorization.runtimeAssetIds !== null && (!event.runtimeAssetId ||
              !authorization.runtimeAssetIds.includes(event.runtimeAssetId)))) continue;
          const revisions = await tx.manager.getRepository(RuntimeSubscriptionRevisionEntity).createQueryBuilder('revision')
            .where('revision.subscriptionId = :subscriptionId', { subscriptionId: subscription.id })
            .andWhere('revision.effectiveFromSequence < :sequence', { sequence: event.sequence })
            .andWhere('(revision.effectiveUntilSequence IS NULL OR revision.effectiveUntilSequence >= :sequence)')
            .take(2).getMany();
          if (revisions.length > 1) throw new EventsDispatchError('OVERLAPPING_SUBSCRIPTION_REVISIONS');
          const revision = revisions[0];
          if (!revision || revision.revoked) continue;
          const config = this.config(revision.config);
          if (!config.enabled || (config.scope.mode === 'assets' && (!event.runtimeAssetId ||
            !config.scope.runtimeAssetIds.includes(event.runtimeAssetId))) || !this.matches(event, config.filter)) continue;
          const deliveries = tx.manager.getRepository(RuntimeEventDeliveryEntity);
          // The unique database constraint is a second line of defence; all core calls hold the Store lock.
          if (await deliveries.findOne({ where: { subscriptionId: subscription.id, eventId: event.id } })) continue;
          await deliveries.insert({
            id: contentHash(canonicalJson([subscription.id, event.id])), subscriptionId: subscription.id,
            subscriptionRevision: revision.version, eventId: event.id, eventSequence: event.sequence!,
            status: 'pending', version: 1, attemptCount: 0, replayGeneration: 0,
            nextAttemptAt: tx.now, leaseOwner: null, leaseUntil: null, lastError: {},
            createdAt: tx.now, updatedAt: tx.now, expiresAt: expiresAfter(tx.now, 30),
          });
          created++;
        }
        await tx.manager.getRepository(RuntimeObservabilityEventEntity).update(event.id, { dispatchState: 'dispatched' });
      }
      if (!hasMore) scannedThrough = high;
      await checkpoints.save({ id: EVENTS_DISPATCH_CHECKPOINT, value: { sequence: scannedThrough }, updatedAt: tx.now });
      return { scanned: events.length, created, skipped, hasMore, checkpoint: publicSequence(scannedThrough),
        highWatermark: publicSequence(high) };
    });
  }

  private config(value: any): EventsDispatchRevisionConfig {
    const strings = (items: unknown): items is string[] => Array.isArray(items) && items.length <= 200 &&
      items.every(item => typeof item === 'string' && item.length > 0 && item.length <= 500);
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean' ||
      !value.scope || !['all', 'assets'].includes(value.scope.mode) ||
      (value.scope.mode === 'assets' && !strings(value.scope.runtimeAssetIds)) ||
      !value.filter || typeof value.filter !== 'object' || Array.isArray(value.filter) ||
      Object.entries(value.filter).some(([key, items]) => !FILTERS.includes(key) || !strings(items))) {
      throw new EventsDispatchError('INVALID_SUBSCRIPTION_REVISION_CONFIG');
    }
    return value;
  }

  private matches(event: RuntimeObservabilityEventEntity, filter: Record<string, string[]>): boolean {
    const details = event.details || {}, dimensions = event.dimensions || {};
    const fields: Record<string, unknown> = {
      runtimeAssetIds: event.runtimeAssetId, serverTypes: dimensions.serverType ?? details.serverType,
      eventTypes: event.eventName, severities: event.severity, spanKinds: details.spanKind ?? dimensions.spanKind,
      outcomes: details.outcome, callerIds: dimensions.callerId ?? details.callerId,
      endpointDefinitionIds: event.endpointDefinitionId ?? dimensions.endpointDefinitionId,
      toolNames: dimensions.toolName ?? details.toolName,
    };
    return Object.entries(filter).every(([key, values]) => typeof fields[key] === 'string' && values.includes(fields[key] as string));
  }
}
