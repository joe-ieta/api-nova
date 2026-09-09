import { Injectable } from '@nestjs/common';
import { EntityManager, SelectQueryBuilder } from 'typeorm';
import { CanonicalInvocation, redactAuditValue } from 'api-nova-parser';
import {
  RuntimeInvocationEntity, RuntimeInvocationRevisionEntity, RuntimePayloadEntity,
} from '../../database/entities/runtime-call-observability.entity';
import { ObservabilityAuthorization, intersectObservabilityAssets } from './call-observability-access';
import { ObservabilityApiError, observabilitySuccess } from './call-observability-api.contract';
import { ObservabilityCursor, ObservabilityCursorService } from './call-observability-cursor.service';
import { ObservabilityFilter, parseObservabilityQuery } from './call-observability-query';
import { publicSequence, sequenceKey } from './call-observability-storage';
import { CallObservabilityStore } from './call-observability.store';
import { ObservabilityInvocationDto, ObservabilityPayloadMetadataDto, ObservabilityTraceEdgeDto,
  ObservabilityTraceMissingParentDto, ObservabilityTraceIssueDto } from './call-observability-invocations.dto';

export const MAX_TRACE_NODES = 200;
export const INVOCATION_QUERY_KEYS = [
  'from', 'to', 'timeBasis', 'origin', 'serverType', 'runtimeAssetId', 'callerId', 'sourceId',
  'endpointDefinitionId', 'toolName', 'sourceServiceInstanceId', 'spanKind', 'outcome',
  'traceId', 'requestId', 'errorCategory', 'limit', 'includeTotal', 'cursor',
] as const;
const COLUMNS = [
  'origin', 'serverType', 'runtimeAssetId', 'callerId', 'sourceId', 'endpointDefinitionId',
  'toolName', 'sourceServiceInstanceId', 'spanKind', 'outcome', 'traceId',
] as const;
// The selected time column is part of the signed normalized filter, never raw SQL.
const SORT = 'timeBasis:desc,invocationId:desc';
const BODY_STATES = ['captured', 'omitted', 'incomplete', 'expired', 'unavailable'];
type InvocationRow = RuntimeInvocationEntity | RuntimeInvocationRevisionEntity;
type RevisionQuery = SelectQueryBuilder<RuntimeInvocationRevisionEntity>;

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}
function iso(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function visible(scope: ObservabilityAuthorization | undefined, asset: string | null): boolean {
  return !!scope && (scope.runtimeAssetIds === null || !!asset && scope.runtimeAssetIds.includes(asset));
}
function safeText(value: unknown, maximum = 500): string | null {
  if (typeof value !== 'string' || !value || value.length > maximum) return null;
  return String(redactAuditValue(value)).replace(/[\u0000-\u001f\u007f]/g, '');
}
function bytes(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

@Injectable()
export class CallObservabilityInvocationsService {
  constructor(
    private readonly store: CallObservabilityStore,
    private readonly cursors: ObservabilityCursorService,
  ) {}

  async list(raw: Record<string, unknown>, authorization: ObservabilityAuthorization,
    sourceAuthorization?: ObservabilityAuthorization) {
    const binding = { kind: 'query' as const, endpoint: 'obsListInvocations', sort: SORT, authorization };
    const cursor = raw?.cursor === undefined ? undefined : this.cursors.open(raw.cursor as string, binding);
    if (cursor) this.position(cursor);
    const { filter, page } = parseObservabilityQuery(raw, INVOCATION_QUERY_KEYS,
      { previousFilter: cursor?.filter });
    if (cursor) this.cursors.assertFilter(cursor, filter);
    const basis = filter.timeBasis === 'completedAt' ? 'completedAt' : 'startedAt';
    const limit = page.limit!;
    return this.store.readSnapshot(async tx => {
      const snapshot = cursor?.snapshotSeq || tx.snapshotSeq;
      if (BigInt(snapshot) > BigInt(tx.snapshotSeq)) throw new ObservabilityApiError('INVALID_QUERY', 'cursor');
      if (cursor && Date.parse(cursor.position.expiresAt as string) <= Date.parse(tx.now)) {
        throw new ObservabilityApiError('QUERY_CURSOR_EXPIRED');
      }
      const query = this.revisions(tx.manager, authorization, snapshot, tx.now);
      const requested = filter.runtimeAssetId === undefined ? undefined : [String(filter.runtimeAssetId)];
      this.assets(query, intersectObservabilityAssets(authorization, requested));
      query.andWhere('inv.' + basis + ' >= :from AND inv.' + basis + ' < :to',
        { from: filter.from, to: filter.to });
      for (const key of COLUMNS) {
        if (filter[key] !== undefined) query.andWhere('inv.' + key + ' = :' + key, { [key]: filter[key] });
      }
      for (const key of ['requestId', 'errorCategory'] as const) {
        if (filter[key] !== undefined) {
          query.andWhere(this.jsonText(tx.manager, key) + ' = :' + key, { [key]: filter[key] });
        }
      }
      let total: number | string | undefined;
      if (page.includeTotal) {
        const value = await query.clone().select('CAST(COUNT(*) AS TEXT)', 'count').getRawOne();
        const count = BigInt(value.count);
        total = count <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(count) : count.toString();
      }
      // Expire the whole cursor before the earliest retained fact can disappear.
      // A resumed page never silently skips metadata that expired between pages.
      let expiresAt = cursor?.position.expiresAt as string | undefined;
      if (!expiresAt) {
        const first = await query.clone().select('MIN(inv.expiresAt)', 'expiresAt').getRawOne();
        const retentionEnd = iso(first?.expiresAt) ? Date.parse(first.expiresAt) : Infinity;
        expiresAt = new Date(Math.min(Date.parse(tx.now) + 15 * 60000, retentionEnd)).toISOString();
      }
      if (cursor) {
        query.andWhere('(inv.' + basis + ' < :positionTime OR (inv.' + basis +
          ' = :positionTime AND inv.invocationId < :positionId))',
        { positionTime: cursor.position.time, positionId: cursor.position.id });
      }
      const rows = await query.orderBy('inv.' + basis, 'DESC').addOrderBy('inv.invocationId', 'DESC')
        .take(limit + 1).getMany();
      const hasMore = rows.length > limit;
      const selected = rows.slice(0, limit);
      const items = await this.present(tx.manager, selected, authorization, sourceAuthorization, snapshot, tx.now);
      let nextCursor: string | null = null;
      if (hasMore) {
        const remaining = Date.parse(expiresAt) - Date.now();
        if (remaining < 1000) throw new ObservabilityApiError('QUERY_CURSOR_EXPIRED');
        const last = selected[selected.length - 1];
        nextCursor = this.cursors.issue(binding, { filter, snapshotSeq: snapshot,
          position: { time: last[basis], id: last.invocationId, expiresAt } }, remaining);
      }
      return observabilitySuccess({
        items, nextCursor, hasMore, timeBasis: basis, ...(total === undefined ? {} : { total }),
      }, this.meta(snapshot, tx.snapshotSeq));
    });
  }

  async get(id: string, raw: Record<string, unknown>, authorization: ObservabilityAuthorization,
    sourceAuthorization?: ObservabilityAuthorization) {
    if (!validId(id)) throw new ObservabilityApiError('INVALID_QUERY', 'id');
    const { filter } = parseObservabilityQuery(raw, ['timeBasis']);
    return this.store.readSnapshot(async tx => {
      const query = tx.manager.getRepository(RuntimeInvocationEntity).createQueryBuilder('inv')
        .where('inv.invocationId = :id', { id }).andWhere('inv.expiresAt > :retainedAt', { retainedAt: tx.now });
      this.assets(query, authorization.runtimeAssetIds);
      const row = await query.getOne();
      if (!row) throw new ObservabilityApiError('NOT_FOUND');
      const [item] = await this.present(tx.manager, [row], authorization, sourceAuthorization, tx.snapshotSeq, tx.now);
      return observabilitySuccess({ ...item, timeBasis: filter.timeBasis }, this.meta(tx.snapshotSeq, tx.snapshotSeq));
    });
  }

  async trace(traceId: string, raw: Record<string, unknown>, authorization: ObservabilityAuthorization,
    sourceAuthorization?: ObservabilityAuthorization) {
    if (!validId(traceId)) throw new ObservabilityApiError('INVALID_QUERY', 'traceId');
    const { filter } = parseObservabilityQuery(raw, ['origin']);
    return this.store.readSnapshot(async tx => {
      // Apply visibility before the limit; hidden spans cannot trigger a size oracle.
      const rows = await this.revisions(tx.manager, authorization, tx.snapshotSeq, tx.now)
        .andWhere('inv.traceId = :traceId', { traceId })
        .andWhere('inv.origin = :origin', { origin: filter.origin })
        .orderBy('inv.startedAt', 'ASC').addOrderBy('inv.invocationId', 'ASC')
        .take(MAX_TRACE_NODES + 1).getMany();
      if (!rows.length) throw new ObservabilityApiError('NOT_FOUND');
      if (rows.length > MAX_TRACE_NODES) throw new ObservabilityApiError('QUERY_TOO_LARGE', 'traceId');
      const nodes = await this.present(tx.manager, rows, authorization, sourceAuthorization, tx.snapshotSeq, tx.now);
      const nodeIds = new Set(nodes.map(node => node.invocationId));
      const parents = new Map<string, string>();
      for (const row of rows) {
        if (row.parentInvocationId && nodeIds.has(row.parentInvocationId)) {
          parents.set(row.invocationId, row.parentInvocationId);
        }
      }
      const cycles = this.parentCycles(parents);
      const edges: ObservabilityTraceEdgeDto[] = [];
      const missingParentReferences: ObservabilityTraceMissingParentDto[] = [];
      const structuralIssues: ObservabilityTraceIssueDto[] = [];
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i], row = rows[i];
        const parentOutside = !!row.parentInvocationId && !nodeIds.has(row.parentInvocationId);
        const rootOutside = !nodeIds.has(row.record.rootInvocationId);
        const cyclic = cycles.has(node.invocationId);
        if (parentOutside) {
          missingParentReferences.push({ invocationId: node.invocationId, reason: 'unavailable_or_restricted' });
        }
        if (rootOutside) {
          structuralIssues.push({ invocationId: node.invocationId, reason: 'root_unavailable_or_restricted' });
        }
        if (cyclic) structuralIssues.push({ invocationId: node.invocationId, reason: 'parent_cycle' });
        // A trace response is a closed visible graph, including for global readers.
        // References in another trace/origin are not smuggled into this graph.
        node.parentInvocationId = parentOutside || cyclic ? null : row.parentInvocationId;
        node.rootInvocationId = rootOutside ? null : row.record.rootInvocationId;
        if (parentOutside || rootOutside) {
          node.traceId = null;
          node.linksRestricted = true;
          if ([row.parentInvocationId, row.record.rootInvocationId, row.traceId].includes(node.requestId)) {
            node.requestId = null;
          }
        }
        node.isPartial = node.isPartial || parentOutside || rootOutside || cyclic;
        if (node.parentInvocationId) {
          edges.push({ parentInvocationId: node.parentInvocationId, childInvocationId: node.invocationId });
        }
      }
      return observabilitySuccess({
        origin: filter.origin, nodes, edges, missingParentReferences, structuralIssues,
        relationshipsComplete: missingParentReferences.length === 0 && structuralIssues.length === 0,
        isPartial: nodes.some(node => node.isPartial), maxNodes: MAX_TRACE_NODES,
      }, this.meta(tx.snapshotSeq, tx.snapshotSeq));
    });
  }

  private parentCycles(parents: Map<string, string>): Set<string> {
    const cycles = new Set<string>(), settled = new Set<string>();
    for (const start of parents.keys()) {
      const path: string[] = [], positions = new Map<string, number>();
      let current: string | undefined = start;
      while (current !== undefined && !settled.has(current)) {
        const position = positions.get(current);
        if (position !== undefined) {
          for (let i = position; i < path.length; i++) cycles.add(path[i]);
          break;
        }
        positions.set(current, path.length);
        path.push(current);
        current = parents.get(current);
      }
      for (const id of path) settled.add(id);
    }
    return cycles;
  }

  private position(cursor: ObservabilityCursor): void {
    const value = cursor.position;
    if (Object.keys(value).sort().join(',') !== 'expiresAt,id,time' ||
      !validId(value.id) || !iso(value.time) || !iso(value.expiresAt)) {
      throw new ObservabilityApiError('INVALID_QUERY', 'cursor');
    }
    if (Date.parse(value.expiresAt) <= Date.now()) throw new ObservabilityApiError('QUERY_CURSOR_EXPIRED');
  }

  private revisions(manager: EntityManager, authorization: ObservabilityAuthorization, snapshot: string, now: string): RevisionQuery {
    const query = manager.getRepository(RuntimeInvocationRevisionEntity).createQueryBuilder('inv')
      .where('inv.validFromSequence <= :snapshot', { snapshot: sequenceKey(snapshot) })
      .andWhere('(inv.validUntilSequence IS NULL OR inv.validUntilSequence > :snapshot)')
      .andWhere('inv.expiresAt > :retainedAt', { retainedAt: now });
    this.assets(query, authorization.runtimeAssetIds);
    return query;
  }

  private assets<T extends InvocationRow>(query: SelectQueryBuilder<T>, assets: readonly string[] | null): void {
    if (assets === null) return;
    if (assets.length === 0) query.andWhere('1 = 0');
    else query.andWhere('inv.runtimeAssetId IN (:...visibleAssets)', { visibleAssets: [...assets] });
  }

  private jsonText(manager: EntityManager, key: 'requestId' | 'errorCategory'): string {
    const dialect = manager.connection.options.type;
    if (dialect === 'postgres') return "inv.record ->> '" + key + "'";
    if (dialect === 'sqljs' || dialect === 'sqlite') return "json_extract(inv.record, '$." + key + "')";
    throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
  }

  private meta(snapshot: string, watermark: string) {
    // Scoped pipeline coverage will be supplied by TP-10; absence is not health.
    return { snapshotSeq: publicSequence(snapshot), dataWatermark: publicSequence(watermark),
      lagMs: null, historyCompleteSince: null, isPartial: true };
  }

  private async present(manager: EntityManager, rows: InvocationRow[], authorization: ObservabilityAuthorization,
    sourceAuthorization: ObservabilityAuthorization | undefined, snapshot: string, now: string): Promise<ObservabilityInvocationDto[]> {
    const payloadIds = [...new Set(rows.flatMap(row => [row.requestPayloadId, row.responsePayloadId])
      .filter((id): id is string => !!id))];
    const payloads = payloadIds.length ? await manager.getRepository(RuntimePayloadEntity)
      .createQueryBuilder('payload').where('payload.id IN (:...payloadIds)', { payloadIds }).getMany() : [];
    const byId = new Map(payloads.map(payload => [payload.id, payload]));
    const references = [...new Set(rows.flatMap(row => [row.parentInvocationId, row.record.rootInvocationId])
      .filter((id): id is string => validId(id)))];
    const known = new Set<string>(rows.map(row => row.invocationId));
    if (authorization.runtimeAssetIds !== null && references.length) {
      const found = await this.revisions(manager, authorization, snapshot, now)
        .andWhere('inv.invocationId IN (:...references)', { references })
        .select(['inv.id', 'inv.invocationId']).getMany();
      found.forEach(row => known.add(row.invocationId));
    }
    return rows.map(row => {
      const record = row.record as CanonicalInvocation;
      const canReference = (id: string | null) => !id || authorization.runtimeAssetIds === null || known.has(id);
      const parentVisible = canReference(row.parentInvocationId);
      const rootVisible = canReference(record.rootInvocationId);
      const linksRestricted = !parentVisible || !rootVisible ||
        authorization.runtimeAssetIds !== null && !!row.parentInvocationId && !record.rootInvocationId;
      const sourceVisible = visible(sourceAuthorization, row.runtimeAssetId);
      const request = this.body(byId.get(row.requestPayloadId || ''), row, 'request', now);
      const response = this.body(byId.get(row.responsePayloadId || ''), row, 'response', now);
      const requestBytes = bytes(record.request?.observedBytes);
      const responseBytes = bytes(record.response?.observedBytes);
      const partial = [request, response].some(body => body.state === 'incomplete') ||
        requestBytes === null || responseBytes === null || record.byteMeasurement === 'unavailable';
      const missingFields = [...new Set([...(record.missingFields || [])
        .filter(field => /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(field)), 'publicationSnapshot'])];
      const failed = record.outcome !== null && record.outcome !== 'success';
      return {
        schemaVersion: '1.0', invocationId: row.invocationId, recordVersion: row.recordVersion,
        traceId: linksRestricted ? null : row.traceId,
        parentInvocationId: parentVisible ? row.parentInvocationId : null,
        rootInvocationId: rootVisible ? record.rootInvocationId : null, linksRestricted,
        requestId: linksRestricted && [row.parentInvocationId, record.rootInvocationId].includes(record.requestId)
          ? null : record.requestId,
        spanKind: row.spanKind, origin: row.origin, transport: record.transport, serverType: row.serverType,
        runtimeAssetId: row.runtimeAssetId, serverId: record.serverId,
        endpointDefinitionId: row.endpointDefinitionId, operationId: record.operationId,
        toolName: row.toolName, sourceServiceInstanceId: row.sourceServiceInstanceId,
        publicationSnapshot: null, callerId: row.callerId, sourceId: row.sourceId,
        authState: record.authState, identitySource: record.identitySource, sourceRestricted: !sourceVisible,
        ...(sourceVisible ? { clientIp: record.clientIp, peerIp: record.peerIp,
          ipSource: record.ipSource, proxyTrusted: record.proxyTrusted } : {}),
        startedAt: row.startedAt, completedAt: row.completedAt, durationMs: record.durationMs,
        lifecycle: row.phase === 'finished' ? 'finished' : 'running',
        completionSource: record.completionSource, outcome: row.outcome, httpStatus: record.httpStatus,
        protocolErrorCode: record.protocolErrorCode, toolIsError: record.toolIsError,
        errorCategory: safeText(record.errorCategory), failureStage: safeText(record.failureStage),
        errorSummary: failed ? 'Invocation ended with ' + row.outcome : null,
        upstreamOperationId: record.upstreamOperationId, attemptIndex: record.attemptIndex,
        redirectHopIndex: record.redirectHopIndex, requestBytes, responseBytes,
        byteMeasurement: record.byteMeasurement, measurementStage: record.measurementStage, partial,
        request, response, sourceRecordId: record.sourceEventId, ingestedAt: row.ingestedAt,
        missingFields, isPartial: partial || linksRestricted || missingFields.length > 0 ||
          row.outcome === 'unknown' || record.completionSource === 'reconciled',
      };
    });
  }

  private body(payload: RuntimePayloadEntity | undefined, row: InvocationRow,
    side: 'request' | 'response', now: string): ObservabilityPayloadMetadataDto {
    if (!payload || payload.invocationId !== row.invocationId || payload.side !== side) {
      return { state: 'unavailable', reason: 'payload_metadata_unavailable', expiresAt: null, readLink: null };
    }
    const expired = payload.state === 'expired' || iso(payload.expiresAt) &&
      Date.parse(payload.expiresAt) <= Date.parse(now);
    return {
      state: expired ? 'expired' : BODY_STATES.includes(payload.state) ? payload.state : 'unavailable',
      reason: expired ? 'retention_elapsed' : safeText(payload.reason, 200),
      expiresAt: iso(payload.expiresAt) ? payload.expiresAt : null,
      readLink: '/api/v1/monitoring/observability/invocations/' + encodeURIComponent(row.invocationId) + '/payloads/' + side,
    };
  }
}
