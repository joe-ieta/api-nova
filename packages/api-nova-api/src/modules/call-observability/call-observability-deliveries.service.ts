import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  RuntimeEventDeliveryAttemptEntity, RuntimeEventDeliveryEntity, RuntimeEventSubscriptionEntity,
  RuntimeSubscriptionRevisionEntity,
} from '../../database/entities/runtime-call-observability.entity';
import {
  RuntimeObservabilityActorType, RuntimeObservabilityEventEntity, RuntimeObservabilityEventFamily,
  RuntimeObservabilityRetentionClass, RuntimeObservabilitySeverity, RuntimeObservabilityStatus,
} from '../../database/entities/runtime-observability-event.entity';
import { AuditAction, AuditLevel, AuditStatus } from '../../database/entities/audit-log.entity';
import { AuditService } from '../security/services/audit.service';
import { ObservabilityAuthorization } from './call-observability-access';
import { ObservabilityApiError, observabilitySuccess } from './call-observability-api.contract';
import { ObservabilityCommandStore, observabilityIdempotencyKey } from './call-observability-command.store';
import { ObservabilityCursorService } from './call-observability-cursor.service';
import { parseObservabilityQuery } from './call-observability-query';
import { sequenceKey } from './call-observability-storage';
import { CallObservabilityStore, ObservabilityWriteTransaction } from './call-observability.store';

const STATUSES = ['pending', 'in_flight', 'retry_wait', 'succeeded', 'dead', 'cancelled'] as const;
const MAX_SCAN = 1000;
const EVENT_RETENTION_MS = 14 * 86400000;
function invalid(field = 'body'): never { throw new ObservabilityApiError('INVALID_QUERY', field); }
function object(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function clean(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) invalid(field);
  return value.trim();
}
function utc(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) invalid(field);
  return new Date(value).toISOString();
}

@Injectable()
export class CallObservabilityDeliveriesService {
  constructor(private readonly store: CallObservabilityStore, private readonly commands: ObservabilityCommandStore,
    private readonly cursors: ObservabilityCursorService, private readonly audit: AuditService) {}

  async testSubscription(id: string, raw: unknown, query: Record<string, unknown>, key: unknown,
    authorization: ObservabilityAuthorization, internalRequestId: unknown) {
    this.id(id); parseObservabilityQuery(query, []);
    const input = this.testInput(raw), requestId = this.requestId(internalRequestId);
    const command = await this.commands.execute(authorization, {
      method: 'POST', path: '/api/v1/monitoring/observability/subscriptions/' + id + '/test',
      ...(key === undefined ? {} : { key }), request: input,
    }, async (tx, previous) => {
      const subscriptionId = previous
        ? (await tx.manager.getRepository(RuntimeEventDeliveryEntity).findOneBy({ id: previous.resourceId }))?.subscriptionId : id;
      if (subscriptionId !== id) throw new ObservabilityApiError('NOT_FOUND');
      await this.subscription(tx, id, authorization, false);
    }, tx => this.createTest(tx, id, input.reason !== undefined, authorization, requestId));
    return this.commandResponse(command.result.resourceId, command.result.operationId!, command.replayed);
  }

  async list(raw: Record<string, unknown>, authorization: ObservabilityAuthorization) {
    const parsed = this.listInput(raw);
    const binding = { kind: 'query' as const, endpoint: 'obsListDeliveries',
      sort: 'createdAt:desc,id:desc', authorization };
    const cursor = parsed.cursor ? this.cursors.open(parsed.cursor, binding) : undefined;
    const filter = cursor && !Object.keys(parsed.filter).length ? cursor.filter : parsed.filter;
    if (cursor) this.cursors.assertFilter(cursor, filter);
    return this.store.readSnapshot(async tx => {
      const snapshotSeq = cursor?.snapshotSeq || tx.snapshotSeq;
      if (BigInt(snapshotSeq) > BigInt(tx.snapshotSeq)) throw new ObservabilityApiError('QUERY_CURSOR_EXPIRED');
      const position = cursor?.position;
      if (position && (typeof position.createdAt !== 'string' || typeof position.id !== 'string')) invalid('cursor');
      const query = tx.manager.getRepository(RuntimeEventDeliveryEntity).createQueryBuilder('delivery')
        .where('delivery.eventSequence <= :snapshot', { snapshot: sequenceKey(snapshotSeq) });
      if (filter.subscriptionId) query.andWhere('delivery.subscriptionId = :subscriptionId', { subscriptionId: filter.subscriptionId });
      if (filter.eventId) query.andWhere('delivery.eventId = :eventId', { eventId: filter.eventId });
      if (filter.status) query.andWhere('delivery.status = :status', { status: filter.status });
      if (filter.from) query.andWhere('delivery.createdAt >= :from', { from: filter.from });
      if (filter.to) query.andWhere('delivery.createdAt < :to', { to: filter.to });
      if (position) query.andWhere('(delivery.createdAt < :createdAt OR ' +
        '(delivery.createdAt = :createdAt AND delivery.id < :id))', position);
      const rows = await query.orderBy('delivery.createdAt', 'DESC').addOrderBy('delivery.id', 'DESC')
        .take(MAX_SCAN + 1).getMany();
      const items: any[] = [];
      let scanned = 0;
      let last: RuntimeEventDeliveryEntity | undefined;
      for (const row of rows.slice(0, MAX_SCAN)) {
        scanned++; last = row;
        const subscription = await tx.manager.getRepository(RuntimeEventSubscriptionEntity).findOneBy({ id: row.subscriptionId });
        if (!subscription || !this.visible(subscription.scope, authorization)) continue;
        items.push(this.view(row, subscription));
        if (items.length === parsed.limit) break;
      }
      const hasMore = rows.length > scanned;
      const nextCursor = hasMore && last ? this.cursors.issue(binding, { filter, snapshotSeq,
        position: { createdAt: last.createdAt, id: last.id } }) : null;
      return observabilitySuccess({ items, nextCursor, hasMore, scannedDeliveries: scanned },
        { snapshotSeq, dataWatermark: tx.snapshotSeq, lagMs: null, historyCompleteSince: null, isPartial: true });
    });
  }

  async get(id: string, raw: Record<string, unknown>, authorization: ObservabilityAuthorization) {
    this.id(id);
    const parsed = this.detailInput(raw);
    const binding = { kind: 'query' as const, endpoint: 'obsGetDelivery', sort: 'attemptNo:desc', authorization };
    const cursor = parsed.cursor ? this.cursors.open(parsed.cursor, binding) : undefined;
    return this.store.readSnapshot(async tx => {
      const snapshotSeq = cursor?.snapshotSeq || tx.snapshotSeq;
      if (BigInt(snapshotSeq) > BigInt(tx.snapshotSeq)) throw new ObservabilityApiError('QUERY_CURSOR_EXPIRED');
      const delivery = await tx.manager.getRepository(RuntimeEventDeliveryEntity).findOneBy({ id });
      if (!delivery || delivery.eventSequence > sequenceKey(snapshotSeq)) throw new ObservabilityApiError('NOT_FOUND');
      const subscription = await tx.manager.getRepository(RuntimeEventSubscriptionEntity).findOneBy({ id: delivery.subscriptionId });
      if (!subscription || !this.visible(subscription.scope, authorization)) throw new ObservabilityApiError('NOT_FOUND');
      const attempts = tx.manager.getRepository(RuntimeEventDeliveryAttemptEntity);
      let maximum: number;
      if (cursor) {
        if (cursor.filter.deliveryId !== id || !Number.isSafeInteger(cursor.filter.maxAttemptNo)) invalid('attemptsCursor');
        maximum = Number(cursor.filter.maxAttemptNo);
      } else {
        const result = await attempts.createQueryBuilder('attempt').select('MAX(attempt.attemptNo)', 'maximum')
          .where('attempt.deliveryId = :id', { id }).getRawOne();
        maximum = Number(result?.maximum || 0);
      }
      const filter = { deliveryId: id, maxAttemptNo: maximum };
      if (cursor) this.cursors.assertFilter(cursor, filter);
      const position = cursor?.position;
      if (position && !Number.isSafeInteger(position.attemptNo)) invalid('attemptsCursor');
      const attemptQuery = attempts.createQueryBuilder('attempt').where('attempt.deliveryId = :id', { id })
        .andWhere('attempt.attemptNo <= :maximum', { maximum });
      if (position) attemptQuery.andWhere('attempt.attemptNo < :attemptNo', { attemptNo: position.attemptNo });
      const rows = await attemptQuery.orderBy('attempt.attemptNo', 'DESC').take(parsed.limit + 1).getMany();
      const hasMoreAttempts = rows.length > parsed.limit, page = rows.slice(0, parsed.limit), last = page.at(-1);
      const nextAttemptsCursor = hasMoreAttempts && last ? this.cursors.issue(binding, {
        filter, snapshotSeq, position: { attemptNo: last.attemptNo },
      }) : null;
      return observabilitySuccess({ ...this.view(delivery, subscription), attempts: page.map(row => this.attempt(row)),
        nextAttemptsCursor, hasMoreAttempts }, { snapshotSeq, dataWatermark: tx.snapshotSeq, lagMs: null,
          historyCompleteSince: null, isPartial: true });
    });
  }

  async retry(id: string, raw: unknown, query: Record<string, unknown>, rawKey: unknown,
    authorization: ObservabilityAuthorization, internalRequestId: unknown) {
    this.id(id); parseObservabilityQuery(query, []);
    const input = this.retryInput(raw), key = observabilityIdempotencyKey(rawKey, true)!;
    const requestId = this.requestId(internalRequestId);
    const command = await this.commands.execute(authorization, {
      method: 'POST', path: '/api/v1/monitoring/observability/deliveries/' + id + '/retry', key, request: input,
    }, async (tx, previous) => {
      if (previous && previous.resourceId !== id) throw new ObservabilityApiError('NOT_FOUND');
      await this.delivery(tx, id, authorization, false);
    }, tx => this.retryDelivery(tx, id, input, authorization, requestId));
    return this.commandResponse(id, command.result.operationId!, command.replayed);
  }

  private async createTest(tx: ObservabilityWriteTransaction, subscriptionId: string, reasonProvided: boolean,
    authorization: ObservabilityAuthorization, requestId: string) {
    const subscription = await this.subscription(tx, subscriptionId, authorization, true);
    const revision = await tx.manager.getRepository(RuntimeSubscriptionRevisionEntity)
      .findOneBy({ subscriptionId, version: subscription.version });
    if (!revision || revision.revoked) throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
    const sequence = tx.nextSequence(), eventId = randomUUID(), deliveryId = randomUUID();
    const expiresAt = new Date(Date.parse(tx.now) + EVENT_RETENTION_MS);
    await tx.manager.getRepository(RuntimeObservabilityEventEntity).insert({
      id: eventId, eventFamily: RuntimeObservabilityEventFamily.RUNTIME_CONTROL, eventName: 'subscription.test',
      severity: RuntimeObservabilitySeverity.INFO, status: RuntimeObservabilityStatus.SUCCESS,
      occurredAt: new Date(tx.now), correlationId: requestId, actorType: RuntimeObservabilityActorType.USER,
      actorId: authorization.principalId, summary: 'Observability subscription test event',
      details: { test: true }, dimensions: { subscriptionId, subscriptionRevision: revision.version },
      retentionClass: RuntimeObservabilityRetentionClass.SHORT, sequence, schemaVersion: '1.0',
      subjectId: subscriptionId, subjectVersion: revision.version, dispatchState: 'materialized', expiresAt,
    });
    await tx.manager.getRepository(RuntimeEventDeliveryEntity).insert({
      id: deliveryId, subscriptionId, subscriptionRevision: revision.version, eventId, eventSequence: sequence,
      status: 'pending', version: 1, attemptCount: 0, replayGeneration: 0, nextAttemptAt: tx.now,
      leaseOwner: null, leaseUntil: null, lastError: {}, createdAt: tx.now, updatedAt: tx.now,
      expiresAt: expiresAt.toISOString(),
    });
    const log = await this.audit.log({ action: AuditAction.API_TESTED, level: AuditLevel.INFO,
      status: AuditStatus.SUCCESS, userId: authorization.principalId,
      resource: 'observability_delivery', resourceId: deliveryId,
      details: { operation: 'observability.subscription.test', requestId, result: 'queued',
        subscriptionId, subscriptionRevision: revision.version, eventId, reasonProvided } }, tx.manager);
    return { statusCode: 202 as const, resourceId: deliveryId, version: 1, operationId: log.id };
  }

  private async retryDelivery(tx: ObservabilityWriteTransaction, id: string,
    input: { reason: string; subscriptionRevision?: number }, authorization: ObservabilityAuthorization,
    requestId: string) {
    const delivery = await this.delivery(tx, id, authorization, true);
    if (!['dead', 'cancelled'].includes(delivery.status)) throw new ObservabilityApiError('DELIVERY_NOT_RETRYABLE');
    const subscription = await this.subscription(tx, delivery.subscriptionId, authorization, true, true);
    const event = await tx.manager.getRepository(RuntimeObservabilityEventEntity).findOneBy({ id: delivery.eventId });
    if (!event || !event.expiresAt || event.expiresAt.getTime() <= Date.parse(tx.now)) {
      throw new ObservabilityApiError('EVENT_EXPIRED', undefined, {
        state: 'expired', expiredAt: event?.expiresAt?.toISOString() || delivery.expiresAt,
      });
    }
    let revisionNumber = input.subscriptionRevision ?? delivery.subscriptionRevision;
    if (delivery.status === 'cancelled') {
      if (input.subscriptionRevision === undefined || subscription.deletedAt || subscription.state !== 'enabled' ||
        input.subscriptionRevision !== subscription.version) throw new ObservabilityApiError('DELIVERY_NOT_RETRYABLE');
      revisionNumber = input.subscriptionRevision;
    }
    const revision = await tx.manager.getRepository(RuntimeSubscriptionRevisionEntity)
      .findOneBy({ subscriptionId: subscription.id, version: revisionNumber });
    if (!revision || revision.revoked) throw new ObservabilityApiError('DELIVERY_NOT_RETRYABLE');
    if (delivery.version >= 2147483647 || delivery.replayGeneration >= 2147483647) {
      throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
    }
    Object.assign(delivery, { subscriptionRevision: revisionNumber, status: 'pending', version: delivery.version + 1,
      replayGeneration: delivery.replayGeneration + 1, nextAttemptAt: tx.now, leaseOwner: null,
      leaseUntil: null, lastError: {}, updatedAt: tx.now });
    await tx.manager.getRepository(RuntimeEventDeliveryEntity).save(delivery);
    const log = await this.audit.log({ action: AuditAction.CONFIG_UPDATED, level: AuditLevel.INFO,
      status: AuditStatus.SUCCESS, userId: authorization.principalId,
      resource: 'observability_delivery', resourceId: id,
      details: { operation: 'observability.delivery.retry', requestId, result: 'queued',
        subscriptionId: subscription.id, subscriptionRevision: revisionNumber,
        replayGeneration: delivery.replayGeneration, reasonProvided: true } }, tx.manager);
    return { statusCode: 202 as const, resourceId: id, version: delivery.version, operationId: log.id };
  }

  private async commandResponse(id: string, auditId: string, replayed: boolean) {
    return this.store.readSnapshot(async tx => {
      const delivery = await tx.manager.getRepository(RuntimeEventDeliveryEntity).findOneBy({ id });
      if (!delivery) throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
      const subscription = await tx.manager.getRepository(RuntimeEventSubscriptionEntity).findOneBy({ id: delivery.subscriptionId });
      if (!subscription) throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
      return observabilitySuccess({ ...this.view(delivery, subscription), replayed, auditId },
        { snapshotSeq: tx.snapshotSeq, dataWatermark: tx.snapshotSeq, lagMs: null,
          historyCompleteSince: null, isPartial: true });
    });
  }

  private testInput(raw: unknown): { reason?: string } {
    if (raw === undefined || raw === null) return {};
    if (!object(raw) || Object.keys(raw).some(key => key !== 'reason') || Buffer.byteLength(JSON.stringify(raw)) > 4096) invalid();
    return raw.reason === undefined ? {} : { reason: clean(raw.reason, 'reason', 500) };
  }
  private retryInput(raw: unknown): { reason: string; subscriptionRevision?: number } {
    if (!object(raw) || Object.keys(raw).some(key => !['reason', 'subscriptionRevision'].includes(key)) ||
      Buffer.byteLength(JSON.stringify(raw)) > 4096) invalid();
    const input: { reason: string; subscriptionRevision?: number } = { reason: clean(raw.reason, 'reason', 500) };
    if (raw.subscriptionRevision !== undefined) {
      if (!Number.isSafeInteger(raw.subscriptionRevision) || Number(raw.subscriptionRevision) < 1 ||
        Number(raw.subscriptionRevision) > 2147483647) invalid('subscriptionRevision');
      input.subscriptionRevision = Number(raw.subscriptionRevision);
    }
    return input;
  }
  private listInput(raw: Record<string, unknown>) {
    const allowed = ['subscriptionId', 'eventId', 'status', 'from', 'to', 'cursor', 'limit'];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.includes(key))) invalid('query');
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value !== 'string' || !value || value.length > (key === 'cursor' ? 8192 : 500)) invalid(key);
    }
    const limit = raw.limit === undefined ? 50 : Number(raw.limit);
    if (raw.limit !== undefined && (!/^[1-9]\d{0,2}$/.test(String(raw.limit)) || limit > 200)) invalid('limit');
    const filter: Record<string, string> = {};
    if (raw.subscriptionId !== undefined) { this.id(String(raw.subscriptionId)); filter.subscriptionId = String(raw.subscriptionId); }
    if (raw.eventId !== undefined) { this.id(String(raw.eventId)); filter.eventId = String(raw.eventId); }
    if (raw.status !== undefined) {
      if (!(STATUSES as readonly string[]).includes(String(raw.status))) invalid('status');
      filter.status = String(raw.status);
    }
    if (raw.from !== undefined) filter.from = utc(String(raw.from), 'from');
    if (raw.to !== undefined) filter.to = utc(String(raw.to), 'to');
    if (filter.from && filter.to && filter.from >= filter.to) invalid('to');
    return { limit, cursor: raw.cursor === undefined ? undefined : String(raw.cursor), filter };
  }
  private detailInput(raw: Record<string, unknown>) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).some(key => !['attemptsCursor', 'attemptsLimit'].includes(key))) invalid('query');
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value !== 'string' || !value || value.length > (key === 'attemptsCursor' ? 8192 : 3)) invalid(key);
    }
    const limit = raw.attemptsLimit === undefined ? 50 : Number(raw.attemptsLimit);
    if (raw.attemptsLimit !== undefined && (!/^[1-9]\d{0,2}$/.test(String(raw.attemptsLimit)) || limit > 200)) invalid('attemptsLimit');
    return { limit, cursor: raw.attemptsCursor === undefined ? undefined : String(raw.attemptsCursor) };
  }
  private id(id: string): void {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/.test(id)) invalid('id');
  }
  private requestId(value: unknown): string {
    return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      ? value : randomUUID();
  }
  private visible(scope: any, authorization: ObservabilityAuthorization): boolean {
    if (scope?.mode === 'all') return authorization.runtimeAssetIds === null;
    return scope?.mode === 'assets' && Array.isArray(scope.runtimeAssetIds) &&
      (authorization.runtimeAssetIds === null ||
        scope.runtimeAssetIds.every((id: string) => authorization.runtimeAssetIds!.includes(id)));
  }
  private async subscription(tx: ObservabilityWriteTransaction, id: string,
    authorization: ObservabilityAuthorization, lock: boolean, allowDeleted = false) {
    const query = tx.manager.getRepository(RuntimeEventSubscriptionEntity)
      .createQueryBuilder('subscription').where('subscription.id = :id', { id });
    if (lock && tx.manager.connection.options.type === 'postgres') query.setLock('pessimistic_write');
    const subscription = await query.getOne();
    if (!subscription || (!allowDeleted && subscription.deletedAt) || !this.visible(subscription.scope, authorization)) {
      throw new ObservabilityApiError('NOT_FOUND');
    }
    return subscription;
  }
  private async delivery(tx: ObservabilityWriteTransaction, id: string,
    authorization: ObservabilityAuthorization, lock: boolean) {
    const query = tx.manager.getRepository(RuntimeEventDeliveryEntity)
      .createQueryBuilder('delivery').where('delivery.id = :id', { id });
    if (lock && tx.manager.connection.options.type === 'postgres') query.setLock('pessimistic_write');
    const delivery = await query.getOne();
    if (!delivery) throw new ObservabilityApiError('NOT_FOUND');
    await this.subscription(tx, delivery.subscriptionId, authorization, false, true);
    return delivery;
  }
  private view(delivery: RuntimeEventDeliveryEntity, subscription: RuntimeEventSubscriptionEntity) {
    return { deliveryId: delivery.id, eventId: delivery.eventId, subscriptionId: delivery.subscriptionId,
      subscriptionRevision: delivery.subscriptionRevision, version: delivery.version, status: delivery.status,
      attemptCount: delivery.attemptCount, replayGeneration: delivery.replayGeneration,
      suspendedBySubscription: subscription.state === 'paused',
      nextAttemptAt: ['pending', 'retry_wait'].includes(delivery.status) ? delivery.nextAttemptAt : null,
      lastError: this.safeError(delivery.lastError), createdAt: delivery.createdAt, updatedAt: delivery.updatedAt,
      expiresAt: delivery.expiresAt };
  }
  private safeError(value: unknown): Record<string, unknown> {
    if (!object(value)) return {};
    const safe: Record<string, unknown> = {};
    for (const key of ['category', 'code', 'httpStatus', 'at']) {
      const item = value[key];
      if (typeof item === 'number' && Number.isSafeInteger(item)) safe[key] = item;
      else if (typeof item === 'string' && item.length <= 200 && !/[\u0000-\u001f\u007f]/.test(item)) safe[key] = item;
    }
    return safe;
  }
  private attempt(attempt: RuntimeEventDeliveryAttemptEntity) {
    return { attemptNo: attempt.attemptNo, startedAt: attempt.startedAt, completedAt: attempt.completedAt,
      durationMs: attempt.durationMs, httpStatus: attempt.httpStatus, result: attempt.result,
      errorCategory: attempt.errorCategory, responseSummary: this.safeSummary(attempt.responseSummary) };
  }
  private safeSummary(value: string | null): string | null {
    if (value === null) return null;
    return value.slice(0, 1000).replace(/(authorization|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  }
}
