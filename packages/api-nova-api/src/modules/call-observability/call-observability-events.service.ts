import { hasEventDeletionGap } from './call-observability-event-gaps';
import { OBSERVABILITY_PUBLIC_BASE } from '../../common/http-api-paths';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { RuntimeObservabilityEventEntity } from '../../database/entities/runtime-observability-event.entity';
import { intersectObservabilityAssets, ObservabilityAuthorization } from './call-observability-access';
import { ObservabilityApiError, observabilitySuccess } from './call-observability-api.contract';
import { ObservabilityCursor, ObservabilityCursorService } from './call-observability-cursor.service';
import { ObservabilityFilter } from './call-observability-query';
import { publicSequence, sequenceKey } from './call-observability-storage';
import { CallObservabilityStore } from './call-observability.store';

export const EVENTS_SNAPSHOT_AUTHORIZER = Symbol('events.snapshotAuthorizer');
export interface EventsSnapshotAuthorizer {
  /** Validate a previously issued invocation-only overview snapshot against current scope and filter. */
  authorize(sequence: string, scope: ObservabilityAuthorization, filter: ObservabilityFilter): Promise<boolean>;
}

export const EVENT_QUERY_KEYS = ['after', 'afterSequence', 'until', 'origin', 'eventTypes', 'severities', 'spanKinds', 'outcomes',
  'runtimeAssetId', 'serverType', 'callerId', 'endpointDefinitionId', 'toolName', 'limit'] as const;
export const EVENT_TYPES = ['invocation.completed', 'invocation.reconciled', 'caller.discovered',
  'server.state_changed', 'server.snapshot', 'metrics.bucket_updated', 'pipeline.state_changed'];
const ENUMS: Record<string, string[]> = {
  eventTypes: EVENT_TYPES, severities: ['debug', 'info', 'warning', 'error', 'critical'],
  spanKinds: ['gateway_request', 'mcp_protocol', 'mcp_tool', 'upstream_api'],
  outcomes: ['success', 'error', 'rejected', 'timeout', 'cancelled', 'incomplete', 'unknown'],
  serverType: ['gateway', 'mcp'], origin: ['external', 'test', 'probe', 'internal'],
};
export const MAX_EVENT_SCAN = 1000;
const CURSOR_TTL = 15 * 60000;

function parse(raw: Record<string, unknown>, previous: ObservabilityFilter = {}) {
  if (!raw || Array.isArray(raw) || typeof raw !== 'object' || Object.keys(raw).length > EVENT_QUERY_KEYS.length) {
    throw new ObservabilityApiError('INVALID_QUERY', 'query');
  }
  const filter: ObservabilityFilter = { ...previous };
  for (const [key, value] of Object.entries(raw)) {
    if (!(EVENT_QUERY_KEYS as readonly string[]).includes(key) || typeof value !== 'string' || !value ||
      value.length > (key === 'after' || key === 'until' ? 8192 : 500) || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new ObservabilityApiError('INVALID_QUERY', key);
    }
    if (['after', 'afterSequence', 'until', 'limit'].includes(key)) continue;
    if (ENUMS[key]) {
      const values = value.split(',');
      if (values.some(item => !ENUMS[key].includes(item)) || new Set(values).size !== values.length ||
        (['serverType', 'origin'].includes(key) && values.length !== 1)) throw new ObservabilityApiError('INVALID_QUERY', key);
      filter[key] = values.sort().join(',');
    } else filter[key] = value;
  }
  const limit = raw.limit === undefined ? 50 : Number(raw.limit);
  if (raw.limit !== undefined && (!/^[1-9]\d{0,2}$/.test(String(raw.limit)) || limit > 200)) {
    throw new ObservabilityApiError('INVALID_QUERY', 'limit');
  }
  return { filter, limit };
}

@Injectable()
export class CallObservabilityEventsService {
  constructor(private readonly store: CallObservabilityStore, private readonly cursors: ObservabilityCursorService,
    @Optional() @Inject(EVENTS_SNAPSHOT_AUTHORIZER) private readonly snapshots?: EventsSnapshotAuthorizer) {}

  async list(raw: Record<string, unknown>, authorization: ObservabilityAuthorization) {
    try { return await this.read(raw, authorization); }
    catch (error) {
      if (!(error instanceof ObservabilityApiError) || error.code !== 'EVENT_CURSOR_EXPIRED') throw error;
      return this.store.readSnapshot(async tx => {
        const repository = tx.manager.getRepository(RuntimeObservabilityEventEntity);
        const now = tx.manager.connection.driver.preparePersistentValue(new Date(tx.now),
          repository.metadata.findColumnWithPropertyName('expiresAt')!);
        const assets = intersectObservabilityAssets(authorization,
          typeof raw.runtimeAssetId === 'string' ? [raw.runtimeAssetId] : undefined);
        const query = repository.createQueryBuilder('event').where('event.schemaVersion = :schema', { schema: '1.0' })
          .andWhere('event.eventName IN (:...types)', { types: EVENT_TYPES })
          .andWhere('event.sequence IS NOT NULL AND event.expiresAt > :now', { now });
        if (assets !== null) {
          if (assets.length) query.andWhere('event.runtimeAssetId IN (:...assets)', { assets: [...assets] });
          else query.andWhere('1 = 0');
        }
        const first = await query.orderBy('event.sequence', 'ASC').take(1).getOne();
        throw new ObservabilityApiError('EVENT_CURSOR_EXPIRED', undefined, {
          availableFrom: first ? publicSequence(first.sequence!) : null, resnapshotRequired: true,
        });
      });
    }
  }

  private async read(raw: Record<string, unknown>, authorization: ObservabilityAuthorization) {
    parse(raw); // Reject duplicate/nested/unknown input before opening signed tokens.
    let snapshotStart: string | undefined;
    if (raw.afterSequence !== undefined) {
      if (raw.after !== undefined || typeof raw.afterSequence !== 'string' ||
        !/^(0|[1-9]\d{0,19})$/.test(raw.afterSequence)) {
        throw new ObservabilityApiError('INVALID_QUERY', 'afterSequence');
      }
      try { snapshotStart = publicSequence(raw.afterSequence); }
      catch { throw new ObservabilityApiError('INVALID_QUERY', 'afterSequence'); }
      if (snapshotStart !== raw.afterSequence) throw new ObservabilityApiError('INVALID_QUERY', 'afterSequence');
    }
    const binding = { kind: 'event' as const, endpoint: 'obsListEvents', sort: 'sequence:asc', authorization };
    let after: ObservabilityCursor | undefined, until: ObservabilityCursor | undefined;
    if (raw.after) after = this.cursors.open(String(raw.after), binding);
    if (raw.until) until = this.cursors.open(String(raw.until), binding);
    const { filter, limit } = parse(raw, after?.filter || until?.filter);
    for (const cursor of [after, until]) if (cursor) this.cursors.assertFilter(cursor, filter);
    // Authorization is additional to, never a replacement for, the existing event scope.
    if (snapshotStart !== undefined &&
      (!this.snapshots || !await this.snapshots.authorize(snapshotStart, authorization, filter))) {
      throw new ObservabilityApiError('CURSOR_SCOPE_MISMATCH');
    }
    const position = (cursor: ObservabilityCursor) => {
      const value = cursor.position.sequence;
      if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value) ||
        publicSequence(value) !== value || BigInt(value) > BigInt(cursor.snapshotSeq)) {
        throw new ObservabilityApiError('INVALID_QUERY', 'after');
      }
      return value;
    };
    return this.store.readSnapshot(async tx => {
      const repository = tx.manager.getRepository(RuntimeObservabilityEventEntity);
      const assets = intersectObservabilityAssets(authorization,
        filter.runtimeAssetId === undefined ? undefined : [String(filter.runtimeAssetId)]);
      const scoped = () => {
        const query = repository.createQueryBuilder('event')
          .where('event.schemaVersion = :schema', { schema: '1.0' })
          .andWhere('event.sequence IS NOT NULL')
          .andWhere('event.eventName IN (:...types)', { types: EVENT_TYPES });
        if (assets !== null) {
          if (assets.length) query.andWhere('event.runtimeAssetId IN (:...assets)', { assets: [...assets] });
          else query.andWhere('1 = 0');
        }
        return query;
      };
      const start = after ? position(after) : snapshotStart ?? '0';
      const high = until ? position(until) : after && after.position.complete !== 'true' ? after.snapshotSeq : tx.snapshotSeq;
      if (BigInt(high) > BigInt(tx.snapshotSeq) || BigInt(start) > BigInt(high) ||
        (after && after.position.complete !== 'true' && BigInt(high) > BigInt(after.snapshotSeq))) {
        throw new ObservabilityApiError('CURSOR_SCOPE_MISMATCH');
      }
      if ((after || snapshotStart !== undefined) && await hasEventDeletionGap(tx, assets, start, high)) {
        throw new ObservabilityApiError('EVENT_CURSOR_EXPIRED');
      }
      // Use the driver's timestamp representation on SQLite and PostgreSQL alike.
      const column = repository.metadata.findColumnWithPropertyName('expiresAt')!;
      const now = tx.manager.connection.driver.preparePersistentValue(new Date(tx.now), column);
      const range = () => scoped().andWhere('event.sequence > :start AND event.sequence <= :high',
        { start: sequenceKey(start), high: sequenceKey(high) });
      if ((after || snapshotStart !== undefined) && await range().andWhere('(event.expiresAt IS NULL OR event.expiresAt <= :now)', { now }).getExists()) {
        throw new ObservabilityApiError('EVENT_CURSOR_EXPIRED');
      }
      const retained = () => range().andWhere('event.expiresAt > :now', { now });
      const earliestExpiry = await retained().orderBy('event.expiresAt', 'ASC').take(1).getOne();
      const deadline = Math.min(Date.now() + CURSOR_TTL, after?.expiresAt ?? Infinity,
        until?.expiresAt ?? Infinity, earliestExpiry?.expiresAt?.getTime() ?? Infinity);
      const ttl = Math.floor(deadline - Date.now());
      if (ttl < 1000) throw new ObservabilityApiError('EVENT_CURSOR_EXPIRED');
      const rows = await retained().orderBy('event.sequence', 'ASC').take(MAX_EVENT_SCAN + 1).getMany();
      const items = [];
      let scanned = start, consumed = 0;
      for (const row of rows.slice(0, MAX_EVENT_SCAN)) {
        scanned = publicSequence(row.sequence!);
        consumed++;
        if (this.matches(row, filter)) items.push(this.view(row));
        if (items.length === limit) break;
      }
      const hasMore = consumed < rows.length;
      if (!hasMore) scanned = high;
      const issue = (sequence: string, complete: boolean) => {
        const remaining = Math.floor(deadline - Date.now()) - 1;
        if (remaining < 1000) throw new ObservabilityApiError('EVENT_CURSOR_EXPIRED');
        return this.cursors.issue(binding, {
          filter, snapshotSeq: high, position: { sequence, complete: String(complete) },
        }, remaining);
      };
      return observabilitySuccess({ items, nextCursor: issue(scanned, !hasMore), hasMore,
        highWatermark: high, highWatermarkCursor: issue(high, true), scannedEvents: consumed }, {
        snapshotSeq: high, dataWatermark: tx.snapshotSeq, lagMs: null, historyCompleteSince: null, isPartial: true,
      });
    });
  }

  private matches(row: RuntimeObservabilityEventEntity, filter: ObservabilityFilter): boolean {
    const values = { eventTypes: row.eventName, severities: row.severity,
      origin: row.details?.origin ?? row.dimensions?.origin,
      spanKinds: row.details?.spanKind, outcomes: row.eventName.startsWith('invocation.') ? row.details?.outcome : undefined,
      runtimeAssetId: row.runtimeAssetId, serverType: row.dimensions?.serverType,
      callerId: row.dimensions?.callerId, endpointDefinitionId: row.dimensions?.endpointDefinitionId,
      toolName: row.details?.toolName };
    return Object.entries(filter).every(([key, value]) => typeof values[key] === 'string' &&
      (ENUMS[key] ? String(value).split(',').includes(values[key]) : value === values[key]));
  }

  private view(row: RuntimeObservabilityEventEntity) {
    // No arbitrary stored details, correlation ids, body, headers, IPs or storage references.
    const data: Record<string, unknown> = {};
    for (const key of ['spanKind', 'outcome', 'toolName', 'durationMs', 'completionSource',
      'bucketKind', 'bucketId', 'bucketVersion', 'bucketStart', 'bucketEnd', 'dataWatermark',
      'state', 'previousState', 'evidenceScope', 'generation', 'serverHealth', 'coverage', 'recomputeFailures']) {
      const value = row.details?.[key];
      if ((typeof value === 'string' && value.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value)) ||
        (typeof value === 'number' && Number.isFinite(value)) || value === null) data[key] = value;
    }
    const member = row.eventName === 'server.state_changed' && row.details?.evidenceScope === 'retained_business_in_flight';
    if (member) {
      if (row.details.delta === 1 || row.details.delta === -1) data.delta = row.details.delta;
      if (row.details.invocationId === row.subjectId) data.invocationId = row.subjectId;
      if (typeof row.details.revisionSequence === 'string' && /^(0|[1-9]\d{0,19})$/.test(row.details.revisionSequence)) {
        data.revisionSequence = row.details.revisionSequence;
      }
    }
    const invocation = row.eventName.startsWith('invocation.');
    if (row.eventName === 'metrics.bucket_updated') data.refreshRequired = true;
    return { schemaVersion: '1.0', eventId: row.id, sequence: publicSequence(row.sequence!),
      eventType: row.eventName, occurredAt: row.occurredAt.toISOString(), recordedAt: row.createdAt.toISOString(),
      severity: row.severity, server: { runtimeAssetId: row.runtimeAssetId || null,
        type: ['gateway', 'mcp'].includes(String(row.dimensions?.serverType)) ? row.dimensions!.serverType : null },
      subject: { kind: member ? 'in_flight_member' : invocation ? 'invocation' : row.eventName === 'metrics.bucket_updated' ? 'bucket' :
        row.eventName === 'pipeline.state_changed' ? 'pipeline' : row.eventName === 'caller.discovered' ? 'caller' : 'server',
        id: row.subjectId || null, version: row.subjectVersion ?? null },
      historical: row.dispatchState === 'suppressed', data,
      links: invocation && row.subjectId ? {
        invocation: OBSERVABILITY_PUBLIC_BASE + '/invocations/' + encodeURIComponent(row.subjectId),
      } : {} };
  }
}
