import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { RuntimeEventDeliveryEntity, RuntimeEventDeliveryAttemptEntity, RuntimeEventSubscriptionEntity,
  RuntimeSubscriptionRevisionEntity } from '../../database/entities/runtime-call-observability.entity';
import { RuntimeObservabilityEventEntity } from '../../database/entities/runtime-observability-event.entity';
import { CallObservabilityStore } from './call-observability.store';
import { EVENTS_DISPATCH_AUTHORIZER } from './call-observability-events.dispatcher';
import type { EventsDispatchAuthorizer } from './call-observability-events.dispatcher';

import { planWebhookRetry, isRetryableWebhookFailure, WEBHOOK_RETRY_WINDOW_MS } from './call-observability-webhook-retry';

const WINDOW_MS = WEBHOOK_RETRY_WINDOW_MS;
const MAX_ATTEMPTS = 6;

export interface DeliveryLeaseHandle {
  deliveryId: string;
  token: string;
  version: number;
  attemptNo: number;
}
export interface ClaimedDeliveryLease extends DeliveryLeaseHandle {
  eventId: string;
  subscriptionId: string;
  subscriptionRevision: number;
  startedAt: string;
  leaseUntil: string;
}
export interface DeliveryClaimOptions {
  limit?: number;
  scanLimit?: number;
  leaseMs?: number;
}
export type DeliveryLeaseResult = { kind: 'success'; httpStatus: number } |
  { kind: 'failure'; reason: 'network' | 'timeout' | 'http' | 'policy'; httpStatus?: number; retryAfter?: string };
export class DeliveryLeaseError extends Error {
  constructor(readonly code: string) { super(code); }
}

/** Database-only lease core. It does not send, schedule itself or expose destination/secret data.
 * All participating claimers, result writers and subscription mutations must use Store.transaction.
 * Invocation of the injected authorization resolver is database-only within that transaction.
 */
@Injectable()
export class CallObservabilityDeliveryLeaseService {
  constructor(private readonly store: CallObservabilityStore,
    @Optional() @Inject(EVENTS_DISPATCH_AUTHORIZER) private readonly authorizer?: EventsDispatchAuthorizer) {}

  async claim(options: DeliveryClaimOptions = {}): Promise<{ leases: ClaimedDeliveryLease[]; scanned: number }> {
    const limit = options.limit ?? 10, scanLimit = options.scanLimit ?? 100, leaseMs = options.leaseMs ?? 30000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(scanLimit) ||
      scanLimit < limit || scanLimit > 200 || !Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 60000) {
      throw new DeliveryLeaseError('INVALID_CLAIM_OPTIONS');
    }
    if (!this.authorizer) throw new DeliveryLeaseError('AUTHORIZER_UNAVAILABLE');
    return this.store.transaction(async tx => {
      const nowMs = Date.parse(tx.now), repository = tx.manager.getRepository(RuntimeEventDeliveryEntity);
      const candidates = await repository.createQueryBuilder('delivery')
        .where('(delivery.status IN (:...queued) AND delivery.nextAttemptAt <= :now) OR ' +
          '(delivery.status = :inFlight AND delivery.leaseUntil <= :now)',
          { queued: ['pending', 'retry_wait'], inFlight: 'in_flight', now: tx.now })
        .orderBy('delivery.nextAttemptAt', 'ASC').addOrderBy('delivery.id', 'ASC').take(scanLimit).getMany();
      const leases: ClaimedDeliveryLease[] = [];
      let scanned = 0;
      for (const delivery of candidates) {
        if (leases.length >= limit) break;
        scanned++;
        const event = await this.eligible(tx.manager, delivery, nowMs);
        if (!event) continue; // In particular, a paused subscription does not mutate queued state.
        const attempts = await this.attempts(tx.manager, delivery);
        if (!attempts) continue;
        const firstMs = attempts.length ? Date.parse(attempts[0].startedAt) : nowMs;
        if (!Number.isFinite(firstMs) || firstMs > nowMs) continue;
        const last = attempts[attempts.length - 1];
        const recovering = delivery.status === 'in_flight';
        if (recovering) {
          if (!last || last.result !== 'in_flight' || !delivery.leaseOwner ||
            !Number.isFinite(Date.parse(delivery.leaseUntil || '')) || Date.parse(delivery.leaseUntil!) > nowMs) continue;
          await this.closeAttempt(tx.manager, delivery.id, last, tx.now, 'lease_expired', null, 'DELIVERY_LEASE_EXPIRED');
        } else if (last?.result === 'in_flight') continue;
        if (attempts.length >= MAX_ATTEMPTS || nowMs >= firstMs + WINDOW_MS) {
          await this.replaceDelivery(tx.manager, delivery, { status: 'dead', leaseOwner: null, leaseUntil: null,
            lastError: { code: attempts.length >= MAX_ATTEMPTS ? 'DELIVERY_ATTEMPTS_EXHAUSTED' : 'DELIVERY_WINDOW_EXPIRED' },
            updatedAt: tx.now });
          continue;
        }
        const attemptNo = attempts.length + 1, token = randomUUID();
        const leaseUntil = new Date(Math.min(nowMs + leaseMs, firstMs + WINDOW_MS,
          event.expiresAt!.getTime(), Date.parse(delivery.expiresAt))).toISOString();
        await this.replaceDelivery(tx.manager, delivery, { status: 'in_flight', attemptCount: attemptNo,
          leaseOwner: token, leaseUntil, updatedAt: tx.now,
          ...(recovering ? { lastError: { code: 'DELIVERY_LEASE_EXPIRED' } } : {}) });
        // Claim consumes an attempt even when the process crashes before making any network request.
        await tx.manager.getRepository(RuntimeEventDeliveryAttemptEntity).insert({ id: randomUUID(), deliveryId: delivery.id,
          attemptNo, startedAt: tx.now, completedAt: null, result: 'in_flight', durationMs: null,
          httpStatus: null, errorCategory: null, responseSummary: null });
        leases.push({ deliveryId: delivery.id, token, version: delivery.version + 1, attemptNo,
          eventId: delivery.eventId, subscriptionId: delivery.subscriptionId,
          subscriptionRevision: delivery.subscriptionRevision, startedAt: tx.now, leaseUntil });
      }
      return { leases, scanned };
    });
  }

  /** False means stale, expired or no longer authorized. Never interpret false as acknowledged success. */
  async complete(lease: DeliveryLeaseHandle, result: DeliveryLeaseResult): Promise<boolean> {
    if (!lease || typeof lease.deliveryId !== 'string' || typeof lease.token !== 'string' ||
      !Number.isSafeInteger(lease.version) || lease.version < 1 ||
      !Number.isInteger(lease.attemptNo) || lease.attemptNo < 1 || lease.attemptNo > MAX_ATTEMPTS) {
      throw new DeliveryLeaseError('INVALID_LEASE_HANDLE');
    }
    this.validateResult(result);
    if (!this.authorizer) throw new DeliveryLeaseError('AUTHORIZER_UNAVAILABLE');
    return this.store.transaction(async tx => {
      const nowMs = Date.parse(tx.now);
      const delivery = await tx.manager.getRepository(RuntimeEventDeliveryEntity).findOneBy({
        id: lease.deliveryId, status: 'in_flight', leaseOwner: lease.token, version: lease.version,
      });
      if (!delivery || delivery.attemptCount !== lease.attemptNo ||
        !Number.isFinite(Date.parse(delivery.leaseUntil || '')) || Date.parse(delivery.leaseUntil!) <= nowMs ||
        !await this.eligible(tx.manager, delivery, nowMs)) return false;
      const attempts = await this.attempts(tx.manager, delivery);
      if (!attempts?.length) return false;
      const attempt = attempts[attempts.length - 1], firstMs = Date.parse(attempts[0].startedAt);
      if (attempt.result !== 'in_flight' || !Number.isFinite(firstMs) || nowMs >= firstMs + WINDOW_MS ||
        Date.parse(attempt.startedAt) > nowMs) return false;
      const success = result.kind === 'success';
      const retryable = result.kind === 'failure' && result.reason !== 'policy' && isRetryableWebhookFailure(result.reason === 'http'
        ? { kind: 'http', statusCode: result.httpStatus! } : { kind: 'network' });
      const decision = !success && retryable ? planWebhookRetry({ completedAttempts: lease.attemptNo,
        now: new Date(tx.now), startedAt: new Date(firstMs), expiresAt: new Date(delivery.expiresAt),
        retryAfter: result.kind === 'failure' ? result.retryAfter : undefined }) : null;
      const retry = decision?.status === 'retry_wait';
      const code = success ? null : result.kind === 'failure' && result.reason === 'policy' ? 'DELIVERY_POLICY_REJECTED' : result.kind === 'failure' && result.reason === 'timeout' ? 'DELIVERY_TIMEOUT' :
        result.kind === 'failure' && result.reason === 'network' ? 'DELIVERY_NETWORK_ERROR' : 'DELIVERY_HTTP_ERROR';
      await this.replaceDelivery(tx.manager, delivery, { status: success ? 'succeeded' : retry ? 'retry_wait' : 'dead',
        leaseOwner: null, leaseUntil: null, nextAttemptAt: decision?.status === 'retry_wait' ? decision.nextAttemptAt : tx.now,
        lastError: code ? { code } : {}, updatedAt: tx.now });
      await this.closeAttempt(tx.manager, delivery.id, attempt, tx.now, success ? 'succeeded' : 'failed',
        result.httpStatus ?? null, code);
      return true;
    });
  }

  /** Internal sender context, never an HTTP response. No network or secret resolution in this transaction. */
  async readForSend(lease: DeliveryLeaseHandle) {
    if (!this.authorizer) throw new DeliveryLeaseError('AUTHORIZER_UNAVAILABLE');
    return this.store.transaction(async tx => {
      const delivery = await tx.manager.getRepository(RuntimeEventDeliveryEntity).findOneBy({
        id: lease.deliveryId, status: 'in_flight', leaseOwner: lease.token, version: lease.version,
      });
      if (!delivery || delivery.attemptCount !== lease.attemptNo ||
          !Number.isFinite(Date.parse(delivery.leaseUntil || '')) || Date.parse(delivery.leaseUntil!) <= Date.parse(tx.now)) return null;
      const event = await this.eligible(tx.manager, delivery, Date.parse(tx.now));
      if (!event) return null;
      const revision = await tx.manager.getRepository(RuntimeSubscriptionRevisionEntity).findOneBy({
        subscriptionId: delivery.subscriptionId, version: delivery.subscriptionRevision,
      });
      const subscription = await tx.manager.getRepository(RuntimeEventSubscriptionEntity).findOneBy({ id: delivery.subscriptionId });
      const config = revision?.config;
      // Internal immutable sender config; never fall back to a newer subscription destination.
      if (!subscription || !config || ['destination', 'secretRef', 'signingKeyId'].some(key =>
          typeof config[key] !== 'string' || !config[key] || config[key].length > 4096)) {
        throw new DeliveryLeaseError('DELIVERY_CONFIGURATION_UNAVAILABLE');
      }
      return { event, ownerId: subscription.ownerId, destination: config.destination as string,
        secretRef: config.secretRef as string, signingKeyId: config.signingKeyId as string };
    });
  }
  private async eligible(manager: EntityManager, delivery: RuntimeEventDeliveryEntity, nowMs: number) {
    if (delivery.replayGeneration !== 0 || !Number.isSafeInteger(delivery.version) || delivery.version < 1 ||
      delivery.version >= 2147483647 || !Number.isFinite(Date.parse(delivery.expiresAt)) ||
      Date.parse(delivery.expiresAt) <= nowMs) return null;
    const subscription = await manager.getRepository(RuntimeEventSubscriptionEntity).findOneBy({ id: delivery.subscriptionId });
    if (!subscription || subscription.state !== 'active' || subscription.deletedAt) return null;
    const revision = await manager.getRepository(RuntimeSubscriptionRevisionEntity).findOneBy({
      subscriptionId: subscription.id, version: delivery.subscriptionRevision,
    });
    if (!revision || revision.revoked || revision.config?.enabled !== true) return null;
    const event = await manager.getRepository(RuntimeObservabilityEventEntity).findOneBy({ id: delivery.eventId });
    if (!event || !event.sequence || event.sequence !== delivery.eventSequence || event.dispatchState === 'suppressed' ||
      !(event.expiresAt instanceof Date) || !Number.isFinite(event.expiresAt.getTime()) || event.expiresAt.getTime() <= nowMs ||
      !/^\d{20}$/.test(event.sequence) || !/^\d{20}$/.test(revision.effectiveFromSequence) ||
      revision.effectiveFromSequence >= event.sequence || (revision.effectiveUntilSequence !== null &&
        (!/^\d{20}$/.test(revision.effectiveUntilSequence) || revision.effectiveUntilSequence < event.sequence))) return null;
    const scope = revision.config.scope;
    if (!scope || (scope.mode !== 'all' && scope.mode !== 'assets') || (scope.mode === 'assets' &&
      (!Array.isArray(scope.runtimeAssetIds) || !event.runtimeAssetId || !scope.runtimeAssetIds.includes(event.runtimeAssetId)))) return null;
    const authorization = await this.authorizer!.resolve(subscription.ownerId, manager);
    if (!authorization || authorization.principalId !== subscription.ownerId ||
      !authorization.requiredPermissions.includes('monitoring:read') || (authorization.runtimeAssetIds !== null &&
        (!event.runtimeAssetId || !authorization.runtimeAssetIds.includes(event.runtimeAssetId)))) return null;
    return event;
  }

  private async attempts(manager: EntityManager, delivery: RuntimeEventDeliveryEntity) {
    const rows = await manager.getRepository(RuntimeEventDeliveryAttemptEntity).find({
      where: { deliveryId: delivery.id }, order: { attemptNo: 'ASC' }, take: MAX_ATTEMPTS + 1,
    });
    // Inconsistent legacy state must not reset the attempt budget or the 24-hour clock.
    if (rows.length > MAX_ATTEMPTS || delivery.attemptCount !== rows.length || rows.some((row, index) =>
      row.attemptNo !== index + 1 || !Number.isFinite(Date.parse(row.startedAt)) ||
      (index > 0 && Date.parse(row.startedAt) < Date.parse(rows[index - 1].startedAt)))) return null;
    return rows;
  }

  private async replaceDelivery(manager: EntityManager, row: RuntimeEventDeliveryEntity,
    changes: Partial<RuntimeEventDeliveryEntity>): Promise<void> {
    const query = manager.getRepository(RuntimeEventDeliveryEntity).createQueryBuilder().update()
      .set({ ...changes, version: row.version + 1 }).where('id = :id AND version = :version AND status = :status',
        { id: row.id, version: row.version, status: row.status });
    if (row.leaseOwner == null) query.andWhere('leaseOwner IS NULL');
    else query.andWhere('leaseOwner = :token', { token: row.leaseOwner });
    if ((await query.execute()).affected !== 1) throw new DeliveryLeaseError('LEASE_FENCE_CONFLICT');
  }

  private async closeAttempt(manager: EntityManager, deliveryId: string, attempt: RuntimeEventDeliveryAttemptEntity,
    now: string, result: string, httpStatus: number | null, errorCategory: string | null): Promise<void> {
    const updated = await manager.getRepository(RuntimeEventDeliveryAttemptEntity).update({
      id: attempt.id, deliveryId, attemptNo: attempt.attemptNo, result: 'in_flight',
    }, { completedAt: now, result, durationMs: Math.max(0, Math.min(2147483647, Date.parse(now) - Date.parse(attempt.startedAt))),
      httpStatus, errorCategory, responseSummary: null });
    if (updated.affected !== 1) throw new DeliveryLeaseError('ATTEMPT_FENCE_CONFLICT');
  }

  private validateResult(result: DeliveryLeaseResult): void {
    if (!result || !['success', 'failure'].includes(result.kind) ||
      (result.httpStatus !== undefined && (!Number.isInteger(result.httpStatus) || result.httpStatus < 100 || result.httpStatus > 599)) ||
      (result.kind === 'success' && !(result.httpStatus >= 200 && result.httpStatus < 300)) ||
      (result.kind === 'failure' && (!['network', 'timeout', 'http', 'policy'].includes(result.reason) ||
        (result.reason === 'http' && (result.httpStatus === undefined || result.httpStatus < 300))))) {
      throw new DeliveryLeaseError('INVALID_DELIVERY_RESULT');
    }
  }
}
