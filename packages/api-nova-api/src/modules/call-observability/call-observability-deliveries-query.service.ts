import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  RuntimeEventDeliveryEntity, RuntimeEventDeliveryAttemptEntity, RuntimeEventSubscriptionEntity,
} from '../../database/entities/runtime-call-observability.entity';
import { RuntimeObservabilityEventEntity } from '../../database/entities/runtime-observability-event.entity';
import type { ObservabilityAuthorization } from './call-observability-access';
import { ObservabilityApiError } from './call-observability-api.contract';
import { EVENTS_DISPATCH_AUTHORIZER } from './call-observability-events.dispatcher';
import type { EventsDispatchAuthorizer } from './call-observability-events.dispatcher';
import { CallObservabilityStore } from './call-observability.store';

const STATUSES = ['pending', 'in_flight', 'retry_wait', 'succeeded', 'dead', 'cancelled'] as const;
const RESULTS = ['in_flight', 'succeeded', 'failed', 'lease_expired'] as const;
const ERROR_CODES = [
  'DELIVERY_LEASE_EXPIRED', 'DELIVERY_ATTEMPTS_EXHAUSTED', 'DELIVERY_WINDOW_EXPIRED',
  'DELIVERY_POLICY_REJECTED', 'DELIVERY_TIMEOUT', 'DELIVERY_NETWORK_ERROR',
  'DELIVERY_HTTP_ERROR', 'SUBSCRIPTION_DELETED',
] as const;
type DeliveryStatus = typeof STATUSES[number];
type AttemptResult = typeof RESULTS[number] | 'unknown';
type SafeErrorCode = typeof ERROR_CODES[number] | 'DELIVERY_ERROR';

export interface DeliveryAttemptQueryView {
  attemptNo: number;
  startedAt: string | null;
  completedAt: string | null;
  result: AttemptResult;
  durationMs: number | null;
  httpStatus: number | null;
  errorCode: SafeErrorCode | null;
}
export interface DeliveryDetailQueryView {
  id: string;
  subscriptionId: string;
  subscriptionRevision: number;
  eventId: string;
  status: DeliveryStatus;
  version: number;
  attemptCount: number;
  replayGeneration: number;
  nextAttemptAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  expiresAt: string;
  errorCode: SafeErrorCode | null;
  suspendedBySubscription: boolean;
  attempts: DeliveryAttemptQueryView[];
  hasMoreAttempts: boolean;
  nextAfterAttemptNo: number | null;
}

/**
 * Internal query core only, not an HTTP/cursor contract or registered endpoint.
 * raw accepts only take (default 20, 1..50) and afterAttemptNo (positive int32).
 * Omit afterAttemptNo for the first page; later pages use attemptNo > supplied
 * value in ascending order, with take+1 bounded reads. Numeric decimal strings
 * are accepted alongside numbers. No public signed cursor/snapshot is promised.
 *
 * Each read resolves fresh current owner authorization in the DB snapshot;
 * foreign/deleted subscriptions, incomplete scope coverage, missing event asset
 * evidence and expired delivery all produce the same NOT_FOUND response.
 * Event expiry alone does not shorten delivery retention: an existing event row
 * is used solely for authorization. If it is removed, fail closed instead of
 * guessing historical asset ownership. No event details/payload are exposed.
 * Pause affects the suspension flag only. This core never mutates delivery state.
 */
@Injectable()
export class CallObservabilityDeliveriesQueryService {
  constructor(
    private readonly store: CallObservabilityStore,
    @Optional() @Inject(EVENTS_DISPATCH_AUTHORIZER)
    private readonly authorizer?: EventsDispatchAuthorizer,
  ) {}

  async detail(id: string, raw: unknown, principalId: string): Promise<DeliveryDetailQueryView> {
    if (!identifier(id, 240)) throw new ObservabilityApiError('INVALID_QUERY', 'id');
    if (!identifier(principalId, 500)) throw new ObservabilityApiError('UNAUTHENTICATED');
    const { take, afterAttemptNo } = paging(raw);
    if (!this.authorizer) throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
    let controlledError: ObservabilityApiError | undefined;
    const unavailableObject = (): never => {
      controlledError = new ObservabilityApiError('NOT_FOUND');
      throw controlledError;
    };
    try {
      return await this.store.readSnapshot(async tx => {
        const authorization = await this.authorizer!.resolve(principalId, tx.manager);
        if (!validAuthorization(authorization, principalId)) return unavailableObject();
        const delivery = await tx.manager.getRepository(RuntimeEventDeliveryEntity).findOne({
          where: { id },
          select: {
            id: true, subscriptionId: true, subscriptionRevision: true, eventId: true, eventSequence: true,
            status: true, version: true, attemptCount: true, replayGeneration: true,
            nextAttemptAt: true, lastError: true, createdAt: true, updatedAt: true, expiresAt: true,
          },
        });
        if (!delivery || !timestamp(delivery.expiresAt) ||
            Date.parse(delivery.expiresAt) <= Date.parse(tx.now) ||
            !identifier(delivery.subscriptionId, 500) || !identifier(delivery.eventId, 500) ||
            !STATUSES.includes(delivery.status as DeliveryStatus) ||
            !integer(delivery.version, 1) || !integer(delivery.subscriptionRevision, 1) ||
            !integer(delivery.attemptCount, 0) || !integer(delivery.replayGeneration, 0)) return unavailableObject();
        const subscription = await tx.manager.getRepository(RuntimeEventSubscriptionEntity).findOne({
          where: { id: delivery.subscriptionId, ownerId: principalId },
          select: { id: true, ownerId: true, scope: true, state: true, deletedAt: true },
        });
        if (!subscription || subscription.deletedAt || !['active', 'paused'].includes(subscription.state) ||
            !coversScope(authorization!, subscription.scope)) return unavailableObject();
        const event = await tx.manager.getRepository(RuntimeObservabilityEventEntity).findOne({
          where: { id: delivery.eventId },
          select: { id: true, runtimeAssetId: true, sequence: true },
        });
        if (!event || !event.sequence || event.sequence !== delivery.eventSequence ||
            (event.runtimeAssetId != null && !identifier(event.runtimeAssetId, 500)) ||
            (authorization!.runtimeAssetIds !== null &&
              (!event.runtimeAssetId || !authorization!.runtimeAssetIds.includes(event.runtimeAssetId)))) {
          return unavailableObject();
        }
        // Never fetch responseSummary, raw error strings or any lease/secret fields.
        const query = tx.manager.getRepository(RuntimeEventDeliveryAttemptEntity).createQueryBuilder('attempt')
          .select(['attempt.attemptNo', 'attempt.startedAt', 'attempt.completedAt', 'attempt.result',
            'attempt.durationMs', 'attempt.httpStatus', 'attempt.errorCategory'])
          .where('attempt.deliveryId = :id', { id })
          .andWhere('attempt.attemptNo > :after', { after: afterAttemptNo })
          .orderBy('attempt.attemptNo', 'ASC').take(take + 1);
        const rows = await query.getMany();
        if (rows.some(row => !integer(row.attemptNo, 1) || row.attemptNo > delivery.attemptCount)) {
          return unavailableObject();
        }
        const hasMoreAttempts = rows.length > take;
        const attempts = rows.slice(0, take).map(row => ({
          attemptNo: row.attemptNo,
          startedAt: timestamp(row.startedAt),
          completedAt: timestamp(row.completedAt),
          result: RESULTS.includes(row.result as typeof RESULTS[number])
            ? row.result as AttemptResult : 'unknown' as const,
          durationMs: integer(row.durationMs, 0) ? row.durationMs : null,
          httpStatus: Number.isInteger(row.httpStatus) && row.httpStatus! >= 100 && row.httpStatus! <= 599
            ? row.httpStatus : null,
          errorCode: safeErrorCode(row.errorCategory),
        }));
        return {
          id: delivery.id, subscriptionId: delivery.subscriptionId,
          subscriptionRevision: delivery.subscriptionRevision, eventId: delivery.eventId,
          status: delivery.status as DeliveryStatus, version: delivery.version,
          attemptCount: delivery.attemptCount, replayGeneration: delivery.replayGeneration,
          nextAttemptAt: timestamp(delivery.nextAttemptAt),
          createdAt: timestamp(delivery.createdAt), updatedAt: timestamp(delivery.updatedAt),
          expiresAt: delivery.expiresAt,
          errorCode: safeErrorCode(delivery.lastError?.code),
          suspendedBySubscription: subscription.state === 'paused',
          attempts, hasMoreAttempts,
          nextAfterAttemptNo: hasMoreAttempts ? attempts[attempts.length - 1].attemptNo : null,
        };
      });
    } catch (error) {
      if (error === controlledError) throw error;
      // Backend/driver/auth errors must not leak SQL, destinations or raw causes.
      throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
    }
  }
}

function identifier(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value);
}
function integer(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= 2147483647;
}
function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? value : null;
}
function safeErrorCode(value: unknown): SafeErrorCode | null {
  if (value == null || value === '') return null;
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value)
    ? value as SafeErrorCode : 'DELIVERY_ERROR';
}
function validAuthorization(value: ObservabilityAuthorization | null, principalId: string): boolean {
  return !!value && value.principalId === principalId && Array.isArray(value.requiredPermissions) &&
    value.requiredPermissions.includes('monitoring:read') &&
    value.requiredPermissions.includes('monitoring:subscription:manage') &&
    (value.runtimeAssetIds === null || (Array.isArray(value.runtimeAssetIds) &&
      value.runtimeAssetIds.length <= 10000 && value.runtimeAssetIds.every(id => identifier(id, 500))));
}
function coversScope(authorization: ObservabilityAuthorization, scope: unknown): boolean {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return false;
  const value = scope as { mode?: unknown; runtimeAssetIds?: unknown };
  if (value.mode === 'all') return authorization.runtimeAssetIds === null;
  if (value.mode !== 'assets' || !Array.isArray(value.runtimeAssetIds) || value.runtimeAssetIds.length > 200 ||
      !value.runtimeAssetIds.every(id => identifier(id, 500))) return false;
  return authorization.runtimeAssetIds === null ||
    value.runtimeAssetIds.every(id => authorization.runtimeAssetIds!.includes(id));
}
function paging(raw: unknown): { take: number; afterAttemptNo: number } {
  if (raw === undefined) return { take: 20, afterAttemptNo: 0 };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).some(key => key !== 'take' && key !== 'afterAttemptNo')) {
    throw new ObservabilityApiError('INVALID_QUERY');
  }
  const value = raw as Record<string, unknown>;
  const parse = (input: unknown, field: string, maximum: number): number => {
    const parsed = typeof input === 'string' && /^[1-9][0-9]{0,9}$/.test(input) ? Number(input) : input;
    if (!integer(parsed, 1) || parsed > maximum) throw new ObservabilityApiError('INVALID_QUERY', field);
    return parsed;
  };
  return {
    take: value.take === undefined ? 20 : parse(value.take, 'take', 50),
    afterAttemptNo: value.afterAttemptNo === undefined ? 0 : parse(value.afterAttemptNo, 'afterAttemptNo', 2147483647),
  };
}
