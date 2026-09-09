import { Injectable } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { isIP } from 'net';
import { redactAuditValue } from 'api-nova-parser';
import { RuntimeInvocationRevisionEntity, RuntimeCallerEntity, RuntimeAccessSourceEntity }
  from '../../database/entities/runtime-call-observability.entity';
import { ObservabilityAuthorization, intersectObservabilityAssets } from './call-observability-access';
import { ObservabilityApiError, observabilitySuccess } from './call-observability-api.contract';
import { ObservabilityCursor, ObservabilityCursorService } from './call-observability-cursor.service';
import { ObservabilityFilter, parseObservabilityQuery } from './call-observability-query';
import { sequenceKey } from './call-observability-storage';
import { CallObservabilityStore } from './call-observability.store';
import { ObservabilityCallerDto, ObservabilitySourceDto, ObservabilityVisitorMeasureDto,
  ObservabilityVisitorSummaryDto } from './call-observability-visitors.dto';

export const MAX_VISITOR_QUERY_INVOCATIONS = 5000;
const COMMON_KEYS = ['from', 'to', 'timeBasis', 'origin', 'serverType', 'runtimeAssetId', 'sourceId'] as const;
export const CALLER_DETAIL_QUERY_KEYS = [...COMMON_KEYS] as const;
export const CALLER_QUERY_KEYS = [...COMMON_KEYS, 'callerId', 'limit', 'includeTotal', 'cursor'] as const;
export const SOURCE_QUERY_KEYS = [...CALLER_QUERY_KEYS, 'authState'] as const;
const SORT = 'lastSeenAt:desc,visitorId:desc';
type Kind = 'caller' | 'source';
type Row = RuntimeInvocationRevisionEntity;
type Group = { id: string; firstSeenAt: string; lastSeenAt: string; rows: Row[] };
const OUTCOMES = ['success', 'error', 'rejected', 'timeout', 'cancelled', 'incomplete', 'unknown'];
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\u0000-\u001f\u007f]/.test(value);
}
function iso(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function safeText(value: unknown, maximum = 500): string | null {
  return typeof value === 'string' && value.length <= maximum
    ? String(redactAuditValue(value)).replace(/[\u0000-\u001f\u007f]/g, '') : null;
}
function visible(scope: ObservabilityAuthorization | undefined, asset: string | null): boolean {
  return !!scope && (scope.runtimeAssetIds === null || !!asset && scope.runtimeAssetIds.includes(asset));
}
function publicBytes(value: bigint): number | string {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

@Injectable()
export class CallObservabilityVisitorsService {
  constructor(private readonly store: CallObservabilityStore, private readonly cursors: ObservabilityCursorService) {}

  callers(raw: Record<string, unknown>, authorization: ObservabilityAuthorization) {
    return this.list('caller', raw, authorization);
  }
  sources(raw: Record<string, unknown>, authorization: ObservabilityAuthorization,
    sourceAuthorization?: ObservabilityAuthorization) {
    return this.list('source', raw, authorization, sourceAuthorization);
  }
  async caller(id: string, raw: Record<string, unknown>, authorization: ObservabilityAuthorization) {
    if (!validId(id)) throw new ObservabilityApiError('INVALID_QUERY', 'id');
    const { filter } = parseObservabilityQuery(raw, CALLER_DETAIL_QUERY_KEYS);
    this.external(filter);
    return this.store.readSnapshot(async tx => {
      const rows = await this.rows(tx.manager, 'caller', { ...filter, callerId: id }, authorization, tx.snapshotSeq, tx.now);
      const group = this.group(rows, 'caller')[0];
      if (!group) throw new ObservabilityApiError('NOT_FOUND');
      const profile = await tx.manager.getRepository(RuntimeCallerEntity).findOneBy({ callerId: id });
      if (!profile) throw new ObservabilityApiError('NOT_FOUND');
      const credentialIds = [...new Set(rows.map(row => safeText(row.record?.credentialId, 240)).filter(Boolean))].sort() as string[];
      return observabilitySuccess({ ...this.callerItem(group, profile), note: safeText(profile.note, 2000),
        credentialIds, window: this.window(filter) }, this.meta(tx.snapshotSeq, tx.snapshotSeq));
    });
  }

  private async list(kind: Kind, raw: Record<string, unknown>, authorization: ObservabilityAuthorization,
    sourceAuthorization?: ObservabilityAuthorization) {
    const binding = { kind: 'query' as const, endpoint: kind === 'caller' ? 'obsListCallers' : 'obsListSources',
      sort: SORT, authorization };
    const cursor = raw?.cursor === undefined ? undefined : this.cursors.open(raw.cursor as string, binding);
    if (cursor) this.position(cursor);
    const { filter, page } = parseObservabilityQuery(raw, kind === 'caller' ? CALLER_QUERY_KEYS : SOURCE_QUERY_KEYS,
      { previousFilter: cursor?.filter });
    this.external(filter);
    if (cursor) this.cursors.assertFilter(cursor, filter);
    return this.store.readSnapshot(async tx => {
      const snapshot = cursor?.snapshotSeq || tx.snapshotSeq;
      if (BigInt(snapshot) > BigInt(tx.snapshotSeq)) throw new ObservabilityApiError('INVALID_QUERY', 'cursor');
      if (cursor && Date.parse(cursor.position.expiresAt as string) <= Date.parse(tx.now)) {
        throw new ObservabilityApiError('QUERY_CURSOR_EXPIRED');
      }
      const rows = await this.rows(tx.manager, kind, filter, authorization, snapshot, tx.now);
      const groups = this.group(rows, kind);
      const expiry = cursor?.position.expiresAt as string || new Date(Math.min(Date.parse(tx.now) + 900000,
        ...rows.map(row => Date.parse(row.expiresAt)))).toISOString();
      const remaining = cursor ? groups.filter(group => group.lastSeenAt < (cursor.position.time as string) ||
        group.lastSeenAt === cursor.position.time && group.id < (cursor.position.id as string)) : groups;
      const selected = remaining.slice(0, page.limit);
      const hasMore = remaining.length > page.limit!;
      let items: ObservabilityCallerDto[] | ObservabilitySourceDto[] = [];
      if (selected.length && kind === 'caller') {
        const profiles = await tx.manager.getRepository(RuntimeCallerEntity).findBy({ callerId: In(selected.map(group => group.id)) });
        const byId = new Map(profiles.map(profile => [profile.callerId, profile]));
        items = selected.map(group => this.callerItem(group, byId.get(group.id)!));
      } else if (selected.length) {
        const sources = await tx.manager.getRepository(RuntimeAccessSourceEntity).findBy({ sourceId: In(selected.map(group => group.id)) });
        const byId = new Map(sources.map(source => [source.sourceId, source]));
        items = selected.map(group => this.sourceItem(group, byId.get(group.id)!, sourceAuthorization));
      }
      let nextCursor: string | null = null;
      if (hasMore) {
        const ttl = Date.parse(expiry) - Date.now();
        if (ttl < 1000) throw new ObservabilityApiError('QUERY_CURSOR_EXPIRED');
        const last = selected[selected.length - 1];
        nextCursor = this.cursors.issue(binding, { snapshotSeq: snapshot, filter,
          position: { time: last.lastSeenAt, id: last.id, expiresAt: expiry } }, ttl);
      }
      return observabilitySuccess({ items, nextCursor, hasMore, ...(page.includeTotal ? { total: groups.length } : {}),
        window: this.window(filter), maxQueryInvocations: MAX_VISITOR_QUERY_INVOCATIONS }, this.meta(snapshot, tx.snapshotSeq));
    });
  }

  private async rows(manager: EntityManager, kind: Kind, filter: ObservabilityFilter,
    authorization: ObservabilityAuthorization, snapshot: string, now: string): Promise<Row[]> {
    const query = manager.getRepository(RuntimeInvocationRevisionEntity).createQueryBuilder('inv')
      .where('inv.validFromSequence <= :snapshot', { snapshot: sequenceKey(snapshot) })
      .andWhere('(inv.validUntilSequence IS NULL OR inv.validUntilSequence > :snapshot)')
      .andWhere('inv.expiresAt > :now', { now })
      .andWhere('inv.origin = :origin', { origin: 'external' })
      .andWhere('inv.spanKind IN (:...kinds)', { kinds: ['gateway_request', 'mcp_protocol', 'mcp_tool'] });
    const assets = intersectObservabilityAssets(authorization,
      filter.runtimeAssetId === undefined ? undefined : [String(filter.runtimeAssetId)]);
    if (assets !== null) {
      if (!assets.length) query.andWhere('1 = 0');
      else query.andWhere('inv.runtimeAssetId IN (:...assets)', { assets: [...assets] });
    }
    const basis = filter.timeBasis === 'completedAt' ? 'completedAt' : 'startedAt';
    query.andWhere('inv.' + basis + ' >= :from AND inv.' + basis + ' < :to', { from: filter.from, to: filter.to });
    for (const key of ['serverType', 'callerId', 'sourceId'] as const) {
      if (filter[key] !== undefined) query.andWhere('inv.' + key + ' = :' + key, { [key]: filter[key] });
    }
    if (kind === 'caller') {
      query.innerJoin(RuntimeCallerEntity, 'profile', 'profile.callerId = inv.callerId')
        .andWhere('profile.identitySource = :trusted', { trusted: 'authenticated' });
    } else {
      query.innerJoin(RuntimeAccessSourceEntity, 'source', 'source.sourceId = inv.sourceId AND ' +
        '(source.runtimeAssetId = inv.runtimeAssetId OR (source.runtimeAssetId IS NULL AND inv.runtimeAssetId IS NULL))');
      if (filter.authState !== undefined) query.andWhere('source.authState = :authState', { authState: filter.authState });
    }
    // Never promote self-reported caller IDs on failed or anonymous observations.
    if (kind === 'caller' || filter.callerId !== undefined) {
      query.andWhere(this.jsonText(manager, 'identitySource') + ' = :authenticated', { authenticated: 'authenticated' })
        .andWhere(this.jsonText(manager, 'authState') + ' = :authenticated');
    }
    const rows = await query.orderBy('inv.invocationId', 'ASC').limit(MAX_VISITOR_QUERY_INVOCATIONS + 1).getMany();
    if (rows.length > MAX_VISITOR_QUERY_INVOCATIONS) throw new ObservabilityApiError('QUERY_TOO_LARGE', 'from');
    return rows;
  }

  private jsonText(manager: EntityManager, key: 'identitySource' | 'authState'): string {
    const type = manager.connection.options.type;
    if (type === 'postgres') return "inv.record ->> '" + key + "'";
    if (type === 'sqljs' || type === 'sqlite') return "json_extract(inv.record, '$." + key + "')";
    throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
  }
  private group(rows: Row[], kind: Kind): Group[] {
    const groups = new Map<string, Group>();
    for (const row of rows) {
      const id = (kind === 'caller' ? row.callerId : row.sourceId)!;
      const last = row.completedAt || row.startedAt;
      let group = groups.get(id);
      if (!group) { group = { id, firstSeenAt: row.startedAt, lastSeenAt: last, rows: [] }; groups.set(id, group); }
      if (row.startedAt < group.firstSeenAt) group.firstSeenAt = row.startedAt;
      if (last > group.lastSeenAt) group.lastSeenAt = last;
      group.rows.push(row);
    }
    return [...groups.values()].sort((a, b) => a.lastSeenAt === b.lastSeenAt
      ? a.id < b.id ? 1 : a.id > b.id ? -1 : 0 : a.lastSeenAt < b.lastSeenAt ? 1 : -1);
  }
  private callerItem(group: Group, profile: RuntimeCallerEntity): ObservabilityCallerDto {
    const assets = new Set(group.rows.map(row => row.runtimeAssetId).filter(Boolean));
    return { callerId: group.id, identitySource: 'authenticated', displayName: safeText(profile.displayName, 200),
      labels: Array.isArray(profile.labels) ? profile.labels.slice(0, 32)
        .map((value: unknown) => safeText(value, 64)).filter((value: string | null): value is string => value !== null) : [],
      profileSnapshot: 'current', firstSeenAt: group.firstSeenAt, lastSeenAt: group.lastSeenAt,
      serverTypes: [...new Set(group.rows.map(row => row.serverType))].sort(),
      observedServerCount: assets.size, unassignedInvocationCount: group.rows.filter(row => !row.runtimeAssetId).length,
      summary: this.summary(group.rows) };
  }
  private sourceItem(group: Group, source: RuntimeAccessSourceEntity,
    authorization?: ObservabilityAuthorization): ObservabilitySourceDto {
    const allowed = visible(authorization, source.runtimeAssetId);
    return { sourceId: group.id, runtimeAssetId: source.runtimeAssetId, authState: source.authState, day: source.day,
      firstSeenAt: group.firstSeenAt, lastSeenAt: group.lastSeenAt,
      serverTypes: [...new Set(group.rows.map(row => row.serverType))].sort(),
      sourceOverflow: source.ipSource === 'overflow', sourceRestricted: !allowed,
      ...(allowed ? { clientIp: source.clientIp && isIP(source.clientIp) ? source.clientIp : null,
        peerIp: source.peerIp && isIP(source.peerIp) ? source.peerIp : null,
        ipSource: source.ipSource, proxyTrusted: source.proxyTrusted } : {}),
      summary: this.summary(group.rows) };
  }
  private summary(rows: Row[]): ObservabilityVisitorSummaryDto {
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const key = JSON.stringify([row.spanKind, row.record?.byteMeasurement || 'unknown',
        row.record?.measurementStage || 'unknown']);
      const group = groups.get(key) || [];
      group.push(row); groups.set(key, group);
    }
    const measures: ObservabilityVisitorMeasureDto[] = [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, observations]) => {
        const [spanKind, byteMeasurement, measurementStage] = JSON.parse(key);
        const measure: ObservabilityVisitorMeasureDto = { spanKind, byteMeasurement, measurementStage,
          invocationCount: observations.length, runningCount: 0,
          outcomeCounts: Object.fromEntries(OUTCOMES.map(outcome => [outcome, 0])),
          requestObservedBytes: null, responseObservedBytes: null,
          requestMissingMeasurements: 0, responseMissingMeasurements: 0,
          requestIncompleteMeasurements: 0, responseIncompleteMeasurements: 0 };
        let requestTotal = 0n, responseTotal = 0n;
        for (const row of observations) {
          if (row.phase !== 'finished') measure.runningCount++;
          else measure.outcomeCounts[OUTCOMES.includes(row.outcome!) ? row.outcome! : 'unknown']++;
          for (const side of ['request', 'response'] as const) {
            const body = row.record?.[side];
            if (!Number.isSafeInteger(body?.observedBytes) || body.observedBytes < 0) measure[side === 'request' ? 'requestMissingMeasurements' : 'responseMissingMeasurements']++;
            else if (side === 'request') requestTotal += BigInt(body.observedBytes);
            else responseTotal += BigInt(body.observedBytes);
            if (body?.state === 'incomplete' || body?.digestScope === 'partial') measure[side === 'request' ? 'requestIncompleteMeasurements' : 'responseIncompleteMeasurements']++;
          }
        }
        if (measure.requestMissingMeasurements < observations.length) measure.requestObservedBytes = publicBytes(requestTotal);
        if (measure.responseMissingMeasurements < observations.length) measure.responseObservedBytes = publicBytes(responseTotal);
        return measure;
      });
    return { invocationCount: rows.length, groups: measures, historyCompleteSince: null, isPartial: true };
  }
  private position(cursor: ObservabilityCursor): void {
    const p = cursor.position;
    if (Object.keys(p).sort().join(',') !== 'expiresAt,id,time' || !iso(p.time) || !iso(p.expiresAt) || !validId(p.id)) {
      throw new ObservabilityApiError('INVALID_QUERY', 'cursor');
    }
  }
  private external(filter: ObservabilityFilter): void {
    if (filter.origin !== 'external') throw new ObservabilityApiError('INVALID_QUERY', 'origin');
  }
  private window(filter: ObservabilityFilter) {
    return { from: String(filter.from), to: String(filter.to), timeBasis: String(filter.timeBasis), origin: 'external' };
  }
  private meta(snapshotSeq: string, dataWatermark: string) {
    return { snapshotSeq, dataWatermark, lagMs: null, historyCompleteSince: null, isPartial: true };
  }
}
