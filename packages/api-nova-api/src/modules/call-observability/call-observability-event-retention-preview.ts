import { RuntimeEventDeliveryEntity } from '../../database/entities/runtime-call-observability.entity';
import { RuntimeObservabilityEventEntity } from '../../database/entities/runtime-observability-event.entity';
import { CallObservabilityStore } from './call-observability.store';
import { ObservabilityAuthorization } from './call-observability-access';
import { ObservabilityStorageError, publicSequence, sequenceKey } from './call-observability-storage';
import { EVENT_TYPES } from './call-observability-events.service';

export interface EventRetentionPreviewOptions {
  enabled?: boolean;
  limit?: number;
  /** Internal caller-supplied page anchor; never persisted or echoed by this preview. */
  afterSequence?: string;
}
export interface EventRetentionPreview {
  enabled: boolean;
  scanned: number;
  eligible: number;
  notExpired: number;
  protectedByLease: number;
  protectedByDelivery: number;
  invalid: number;
  hasMore: boolean;
}

export type EventRetentionClassification = 'eligible' | 'not_expired' | 'lease_active' | 'invalid';

/** Shared expiry/lease classification behind both the E2A preview and the E2B
 * delete executor. Callers must still re-read the delivery reference under their
 * own transaction; neither path may act on a stale snapshot. */
export function classifyEventRetention(
  event: Pick<RuntimeObservabilityEventEntity,
    'expiresAt' | 'dispatchState' | 'dispatchLeaseOwner' | 'dispatchLeaseUntil'>,
  now: number,
): EventRetentionClassification {
  const expiry = event.expiresAt?.getTime();
  if (!Number.isFinite(expiry)) return 'invalid';
  if (expiry > now) return 'not_expired';
  const until = event.dispatchLeaseUntil?.getTime();
  const owned = typeof event.dispatchLeaseOwner === 'string' && event.dispatchLeaseOwner.length > 0;
  if (!['pending', 'leased', 'materialized', 'suppressed'].includes(event.dispatchState || '') ||
    (event.dispatchState === 'leased' && !owned) ||
    (until !== undefined && !Number.isFinite(until)) ||
    ((event.dispatchState === 'leased' || owned) && until === undefined)) return 'invalid';
  if (until !== undefined && until > now) return 'lease_active';
  return 'eligible';
}

/** Pure read-only preview. Eligibility is snapshot evidence, never authorization
 * to act later. A future executor must recheck leases/references under its write
 * transaction and commit its own progress; this function writes no progress. */
export async function previewEventRetention(store: CallObservabilityStore,
  authorization: ObservabilityAuthorization, options: EventRetentionPreviewOptions = {}): Promise<EventRetentionPreview> {
  const limit = options.limit ?? 128;
  if ((options.enabled !== undefined && typeof options.enabled !== 'boolean') ||
    !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new ObservabilityStorageError('INVALID_GC_LIMIT');
  const after = options.afterSequence ?? '0';
  if (typeof after !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(after) || publicSequence(after) !== after) {
    throw new ObservabilityStorageError('INVALID_EVENT_PREVIEW_CURSOR');
  }
  const result: EventRetentionPreview = { enabled: options.enabled === true, scanned: 0, eligible: 0,
    notExpired: 0, protectedByLease: 0, protectedByDelivery: 0, invalid: 0, hasMore: false };
  if (!result.enabled) return result;
  const assets = authorization.runtimeAssetIds;
  if (assets !== null && !assets.length) return result;
  return store.readSnapshot(async tx => {
    if (BigInt(after) > BigInt(tx.snapshotSeq)) throw new ObservabilityStorageError('INVALID_EVENT_PREVIEW_CURSOR');
    const query = tx.manager.getRepository(RuntimeObservabilityEventEntity).createQueryBuilder('event')
      .select(['event.id', 'event.sequence', 'event.expiresAt', 'event.dispatchState', 'event.dispatchLeaseOwner', 'event.dispatchLeaseUntil'])
      .where('event.schemaVersion = :schema AND event.sequence > :after AND event.sequence <= :high',
        { schema: '1.0', after: sequenceKey(after), high: sequenceKey(tx.snapshotSeq) })
      .andWhere('event.eventName IN (:...types)', { types: EVENT_TYPES })
      .orderBy('event.sequence', 'ASC').take(limit + 1);
    if (assets !== null) query.andWhere('event.runtimeAssetId IN (:...assets)', { assets: [...assets] });
    const rows = await query.getMany(), now = Date.parse(tx.now);
    result.hasMore = rows.length > limit;
    for (const event of rows.slice(0, limit)) {
      result.scanned++;
      const classification = classifyEventRetention(event, now);
      if (classification === 'invalid') { result.invalid++; continue; }
      if (classification === 'not_expired') { result.notExpired++; continue; }
      if (classification === 'lease_active') { result.protectedByLease++; continue; }
      const referenced = await tx.manager.getRepository(RuntimeEventDeliveryEntity).createQueryBuilder('delivery')
        .where('delivery.eventId = :id', { id: event.id }).getExists();
      if (referenced) { result.protectedByDelivery++; continue; }
      result.eligible++;
    }
    return result;
  });
}
