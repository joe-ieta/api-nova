import { Inject, Injectable, Optional } from '@nestjs/common';
import { RuntimeInvocationRevisionEntity } from '../../database/entities/runtime-call-observability.entity';
import { RuntimeObservabilityEventEntity } from '../../database/entities/runtime-observability-event.entity';
import { ObservabilityAuthorization } from './call-observability-access';
import { ObservabilityApiError, observabilitySuccess } from './call-observability-api.contract';
import { ObservabilityCursorService } from './call-observability-cursor.service';
import { ObservabilityFilter } from './call-observability-query';
import { publicSequence, sequenceKey } from './call-observability-storage';
import { CallObservabilityStore } from './call-observability.store';

export const EVENTS_SNAPSHOT_AUTHORIZER = Symbol('events.snapshotAuthorizer');
export interface EventsSnapshotAuthorizer {
  /** Must validate a previously issued overview snapshot against both current scope and filter. */
  authorize(sequence: string, scope: ObservabilityAuthorization, filter: ObservabilityFilter): Promise<boolean>;
}
export const EVENT_QUERY_KEYS = ['after', 'afterSequence', 'until', 'limit', 'eventTypes', 'severities',
  'spanKinds', 'outcomes', 'origin', 'runtimeAssetId', 'serverType', 'callerId', 'endpointDefinitionId', 'toolName'] as const;
const FILTER_KEYS = EVENT_QUERY_KEYS.filter(key => !['after', 'afterSequence', 'until', 'limit'].includes(key));
const ENUMS: Record<string, string[]> = {
  severities: ['debug', 'info', 'warning', 'error', 'critical'],
  spanKinds: ['gateway_request', 'mcp_protocol', 'mcp_tool', 'upstream_api'],
  outcomes: ['success', 'error', 'rejected', 'timeout', 'cancelled', 'incomplete', 'unknown'],
  serverType: ['gateway', 'mcp'],
  origin: ['external', 'test', 'probe', 'internal'],
};
export class EventsCursorExpiredError extends ObservabilityApiError {
  constructor(readonly earliestAvailableCursor: string) { super('EVENT_CURSOR_EXPIRED'); }
}

@Injectable()
export class CallObservabilityEventsService {
  constructor(private readonly store: CallObservabilityStore, private readonly cursors: ObservabilityCursorService,
    @Optional() @Inject(EVENTS_SNAPSHOT_AUTHORIZER) private readonly snapshots?: EventsSnapshotAuthorizer) {}

  async list(raw: Record<string, unknown>, authorization: ObservabilityAuthorization) {
    const invalid = (field: string): never => { throw new ObservabilityApiError('INVALID_QUERY', field); };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('query');
    for (const [key, value] of Object.entries(raw)) {
      if (!(EVENT_QUERY_KEYS as readonly string[]).includes(key) || typeof value !== 'string' || !value ||
        value.length > (['after', 'until'].includes(key) ? 8192 : 1000) || /[\u0000-\u001f\u007f]/.test(value)) invalid('query');
    }
    if (raw.after !== undefined && raw.afterSequence !== undefined) invalid('afterSequence');
    const limit = raw.limit === undefined ? 50 : Number(raw.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 ||
      (raw.limit !== undefined && !/^[1-9]\d{0,2}$/.test(String(raw.limit)))) invalid('limit');
    const binding = { kind: 'event' as const, endpoint: 'obsListEvents', sort: 'sequence:asc', authorization };
    let expired = false;
    const open = (token: unknown) => {
      if (token === undefined) return undefined;
      try { return this.cursors.open(String(token), binding); }
      catch (error) {
        if (error instanceof ObservabilityApiError && error.code === 'EVENT_CURSOR_EXPIRED') { expired = true; return undefined; }
        throw error;
      }
    };
    const after = open(raw.after), until = open(raw.until);
    const filter: ObservabilityFilter = { ...(after?.filter || until?.filter || {}) };
    for (const key of FILTER_KEYS) {
      if (raw[key] === undefined) continue;
      const value = String(raw[key]);
      const plural = ['eventTypes', 'severities', 'spanKinds', 'outcomes'].includes(key);
      const values = plural ? value.split(',') : [value];
      if (values.length > 16 || values.some(item => !item || item.length > 240 || item.trim() !== item ||
        (ENUMS[key] && !ENUMS[key].includes(item)))) invalid(key);
      // Canonical CSV avoids the shared query cursor's two-element array limit.
      filter[key] = [...new Set(values)].sort().join(',');
    }
    if (after) this.cursors.assertFilter(after, filter);
    if (until) this.cursors.assertFilter(until, filter);
    const position = (value: unknown): string => {
      if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value)) return invalid('cursor');
      try { return publicSequence(value); } catch { return invalid('cursor'); }
    };
    if (raw.afterSequence !== undefined) {
      position(raw.afterSequence);
      if (!this.snapshots || !await this.snapshots.authorize(String(raw.afterSequence), authorization, filter)) {
        throw new ObservabilityApiError('CURSOR_SCOPE_MISMATCH');
      }
    }
    return this.store.readSnapshot(async tx => {
      const base = () => {
        const query = tx.manager.getRepository(RuntimeObservabilityEventEntity).createQueryBuilder('event')
          .where('event.sequence IS NOT NULL').andWhere('event.sequence <= :snapshot', { snapshot: sequenceKey(tx.snapshotSeq) });
        const assets = authorization.runtimeAssetIds;
        if (assets !== null) {
          if (!assets.length) query.andWhere('1 = 0');
          else query.andWhere('event.runtimeAssetId IN (:...assets)', { assets: [...assets] });
        }
        if (filter.runtimeAssetId) query.andWhere('event.runtimeAssetId = :asset', { asset: filter.runtimeAssetId });
        return query;
      };
      const latest = await base().orderBy('event.sequence', 'DESC').getOne();
      const visibleHigh = latest?.sequence ? publicSequence(latest.sequence) : '0';
      // Expired rows currently remain durable. A future event GC MUST retain this per-scope boundary.
      const expiredRow = await base().andWhere('event.expiresAt <= :now', { now: new Date(tx.now) })
        .orderBy('event.sequence', 'DESC').getOne();
      const floor = expiredRow?.sequence ? publicSequence(expiredRow.sequence) : '0';
      const issue = (sequence: string, high: string) => this.cursors.issue(binding,
        { filter, snapshotSeq: high, position: { sequence } });
      if (expired) throw new EventsCursorExpiredError(issue(floor, visibleHigh));
      let start = after ? position(after.position.sequence) : raw.afterSequence !== undefined ? position(raw.afterSequence) : '0';
      let high = until ? position(until.position.sequence) : after && BigInt(start) < BigInt(after.snapshotSeq)
        ? after.snapshotSeq : visibleHigh;
      // Authorized overview sequence may exceed this scope's latest event sequence.
      if (!until && BigInt(start) > BigInt(high)) high = start;
      if (BigInt(high) > BigInt(tx.snapshotSeq) || BigInt(start) > BigInt(high)) invalid('until');
      if ((after || raw.afterSequence !== undefined) && BigInt(start) < BigInt(floor)) {
        throw new EventsCursorExpiredError(issue(floor, visibleHigh));
      }
      const rows = await base().andWhere('event.sequence > :start AND event.sequence <= :high',
        { start: sequenceKey(start), high: sequenceKey(high) })
        .andWhere('(event.expiresAt IS NULL OR event.expiresAt > :now)', { now: new Date(tx.now) })
        .orderBy('event.sequence', 'ASC').take(limit + 1).getMany();
      const hasMore = rows.length > limit;
      const scanned = rows.slice(0, limit);
      // Older producers omit toolName. Read only the matching immutable, authorized revision.
      {
        for (const row of scanned) {
          if (!['invocation.completed', 'invocation.reconciled'].includes(row.eventName) || !row.subjectId ||
            !row.runtimeAssetId || row.dimensions?.toolName !== undefined || row.details?.toolName !== undefined) continue;
          const revision = await tx.manager.getRepository(RuntimeInvocationRevisionEntity).createQueryBuilder('revision')
            .select(['revision.id', 'revision.toolName'])
            .where('revision.invocationId = :invocation AND revision.recordVersion = :version',
              { invocation: row.subjectId, version: row.subjectVersion })
            .andWhere('revision.runtimeAssetId = :asset', { asset: row.runtimeAssetId })
            .andWhere('revision.validFromSequence <= :eventSequence', { eventSequence: row.sequence })
            .andWhere('(revision.validUntilSequence IS NULL OR revision.validUntilSequence > :eventSequence)')
            .andWhere('revision.expiresAt > :now', { now: tx.now }).getOne();
          if (revision?.toolName) row.dimensions = { ...row.dimensions, toolName: revision.toolName };
        }
      }
      const items = scanned.filter(row => this.matches(row, filter)).map(row => this.present(row));
      start = hasMore ? publicSequence(scanned[scanned.length - 1].sequence!) : high;
      return observabilitySuccess({ items, nextCursor: issue(start, high), hasMore, highWatermark: high },
        { snapshotSeq: high, dataWatermark: high });
    });
  }

  private matches(row: RuntimeObservabilityEventEntity, filter: ObservabilityFilter): boolean {
    const dimensions = row.dimensions || {}, details = row.details || {};
    const values: Record<string, unknown> = { eventTypes: row.eventName, severities: row.severity,
      spanKinds: details.spanKind ?? dimensions.spanKind, outcomes: details.outcome,
      runtimeAssetId: row.runtimeAssetId, serverType: dimensions.serverType ?? details.serverType,
      origin: dimensions.origin ?? details.origin,
      callerId: dimensions.callerId ?? details.callerId,
      endpointDefinitionId: row.endpointDefinitionId ?? dimensions.endpointDefinitionId,
      toolName: dimensions.toolName ?? details.toolName };
    return Object.entries(filter).every(([key, expected]) => typeof values[key] === 'string' &&
      (['eventTypes', 'severities', 'spanKinds', 'outcomes'].includes(key) ? String(expected).split(',').includes(values[key] as string) : expected === values[key]));
  }

  private present(row: RuntimeObservabilityEventEntity) {
    const details = row.details || {}, dimensions = row.dimensions || {};
    const data: Record<string, unknown> = {};
    // Never spread arbitrary stored details: older producers can contain source identifiers or secrets.
    for (const key of ['spanKind', 'outcome', 'origin', 'callerId', 'completionSource']) {
      if (typeof details[key] === 'string' && (details[key] as string).length <= 240) data[key] = details[key];
    }
    for (const key of ['durationMs', 'httpStatus']) {
      if (typeof details[key] === 'number' && Number.isFinite(details[key])) data[key] = details[key];
    }
    if (typeof details.toolIsError === 'boolean') data.toolIsError = details.toolIsError;
    const toolName = dimensions.toolName ?? details.toolName;
    if (typeof toolName === 'string' && toolName.length > 0 && toolName.length <= 240 &&
      !/[\u0000-\u001f\u007f]/.test(toolName)) data.toolName = toolName;
    if (row.endpointDefinitionId) data.endpointDefinitionId = row.endpointDefinitionId;
    const invocation = ['invocation.completed', 'invocation.reconciled'].includes(row.eventName);
    return { schemaVersion: '1.0', eventId: row.id, sequence: publicSequence(row.sequence!), eventType: row.eventName,
      occurredAt: row.occurredAt.toISOString(), recordedAt: row.createdAt.toISOString(),
      server: { type: ['gateway', 'mcp'].includes(String(dimensions.serverType ?? details.serverType))
        ? dimensions.serverType ?? details.serverType : null, runtimeAssetId: row.runtimeAssetId ?? null },
      subject: { kind: invocation ? 'invocation' : 'runtime', id: row.subjectId ?? null, version: row.subjectVersion ?? null },
      traceId: null, severity: row.severity, data,
      links: invocation && row.subjectId ? {
        invocation: '/api/v1/monitoring/observability/invocations/' + encodeURIComponent(row.subjectId),
      } : {} };
  }
}
