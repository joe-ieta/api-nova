import { ExecutionContext, Injectable } from '@nestjs/common';
import { RuntimeObservabilityEventEntity } from '../../database/entities/runtime-observability-event.entity';
import { ObservabilityAccessGuard, getObservabilityAuthorization } from './call-observability-access.guard';
import { ObservabilityApiError } from './call-observability-api.contract';
import { ObservabilityCursorService } from './call-observability-cursor.service';
import { hasEventDeletionGap } from './call-observability-event-gaps';
import { ObservabilityFilter } from './call-observability-query';
import { CallObservabilityServerStateSnapshotAuthorizer } from './call-observability-server-state-snapshot-authorizer.service';
import { contentHash, publicSequence, sequenceKey } from './call-observability-storage';
import { CallObservabilityStore } from './call-observability.store';

export const SERVER_STATE_DELTA_SCAN_LIMIT = 1000;
export interface ServerStateDeltaInput {
  token: string;
  sequence: string;
  filter: ObservabilityFilter;
  after?: string;
  limit?: number;
}
const expired = () => new ObservabilityApiError('EVENT_CURSOR_EXPIRED', undefined, { resnapshotRequired: true });

/** Standalone bounded reader. No controller, WebSocket registration or ACK state is installed here. */
@Injectable()
export class CallObservabilityServerStateDeltaReader {
  constructor(private readonly store: CallObservabilityStore, private readonly cursors: ObservabilityCursorService,
    private readonly grants: CallObservabilityServerStateSnapshotAuthorizer, private readonly access: ObservabilityAccessGuard) {}

  async read(input: ServerStateDeltaInput, context: ExecutionContext) {
    // The adapter owns the context. Never accept a scope or asset array from the request body.
    await this.access.canActivate(context);
    const authorization = getObservabilityAuthorization(context.switchToHttp().getRequest());
    if (!input || Object.keys(input).some(key => !['token', 'sequence', 'filter', 'after', 'limit'].includes(key)) ||
      typeof input.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.token) ||
      typeof input.sequence !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(input.sequence) ||
      !input.filter || typeof input.filter !== 'object' || Array.isArray(input.filter) ||
      (input.after !== undefined && (typeof input.after !== 'string' || input.after.length > 8192)) ||
      (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200))) {
      throw new ObservabilityApiError('INVALID_QUERY');
    }
    const token = input.token, sequence = input.sequence, filter = { ...input.filter }, limit = input.limit ?? 50;
    const grant = this.grants.resolve(token, sequence, authorization, filter);
    if (!grant) throw expired();
    const cursorFilter = { ...filter, serverStateGrant: contentHash(token) };
    const binding = { kind: 'event' as const, endpoint: 'obsServerStateDeltas', sort: 'server_state_v1:sequence:asc', authorization };
    let after;
    try { after = input.after ? this.cursors.open(input.after, binding) : undefined; }
    catch (error) { if (error instanceof ObservabilityApiError && error.code === 'EVENT_CURSOR_EXPIRED') throw expired(); throw error; }
    if (after) this.cursors.assertFilter(after, cursorFilter);
    const start = after ? String(after.position.sequence) : sequence;
    if (!/^(0|[1-9][0-9]{0,19})$/.test(start) || BigInt(start) < BigInt(sequence) ||
      (after && (!['true', 'false'].includes(String(after.position.complete)) || BigInt(start) > BigInt(after.snapshotSeq)))) {
      throw new ObservabilityApiError('CURSOR_SCOPE_MISMATCH');
    }
    const result = await this.store.readSnapshot(async tx => {
      const high = after && after.position.complete !== 'true' ? after.snapshotSeq : tx.snapshotSeq;
      if (BigInt(high) > BigInt(tx.snapshotSeq) || BigInt(start) > BigInt(high)) throw new ObservabilityApiError('CURSOR_SCOPE_MISMATCH');
      if (BigInt(high) > BigInt(start) && await hasEventDeletionGap(tx, grant.assetIds, String(BigInt(start) + BigInt(1)), high)) throw expired();
      const repository = tx.manager.getRepository(RuntimeObservabilityEventEntity);
      const range = () => {
        const query = repository.createQueryBuilder('event').where('event.schemaVersion = :schema', { schema: '1.0' })
          .andWhere('event.eventName = :name', { name: 'server.state_changed' })
          .andWhere('event.sequence > :start AND event.sequence <= :high', { start: sequenceKey(start), high: sequenceKey(high) });
        return grant.assetIds.length ? query.andWhere('event.runtimeAssetId IN (:...assets)', { assets: [...grant.assetIds] }) : query.andWhere('1 = 0');
      };
      const now = tx.manager.connection.driver.preparePersistentValue(new Date(tx.now), repository.metadata.findColumnWithPropertyName('expiresAt')!);
      if (await range().andWhere('(event.expiresAt IS NULL OR event.expiresAt <= :now)', { now }).getExists()) throw expired();
      const earliest = await range().orderBy('event.expiresAt', 'ASC').take(1).getOne();
      const deadline = Math.min(grant.expiresAt, after?.expiresAt ?? Infinity, earliest?.expiresAt?.getTime() ?? Infinity);
      const rows = await range().orderBy('event.sequence', 'ASC').take(SERVER_STATE_DELTA_SCAN_LIMIT + 1).getMany();
      const items = []; let scanned = start, consumed = 0;
      for (const row of rows.slice(0, SERVER_STATE_DELTA_SCAN_LIMIT)) {
        consumed++; scanned = publicSequence(row.sequence);
        const view = this.view(row, filter);
        if (view) items.push(view);
        if (items.length === limit) break;
      }
      const hasMore = consumed < rows.length;
      if (!hasMore) scanned = high;
      const ttl = Math.floor(deadline - Date.now()) - 1;
      if (ttl < 1000) throw expired();
      const nextCursor = this.cursors.issue(binding, { filter: cursorFilter, snapshotSeq: high,
        position: { sequence: scanned, complete: String(!hasMore) } }, ttl);
      return { scope: 'server_state_v1' as const, items, nextCursor, highWatermark: high,
        scannedEvents: consumed, hasMore, refreshRequired: true, historyComplete: false };
    });
    // A revocation or grant expiry during the database read suppresses the entire page.
    await this.access.canActivate(context);
    if (!this.grants.resolve(token, sequence, getObservabilityAuthorization(context.switchToHttp().getRequest()), filter)) throw expired();
    return result;
  }

  private view(row: RuntimeObservabilityEventEntity, filter: ObservabilityFilter) {
    if (filter.serverType !== undefined && row.dimensions?.serverType !== filter.serverType) return null;
    const details = row.details ?? {}, scope = details.evidenceScope;
    if (!['managed_server_process_lifecycle', 'retained_business_in_flight'].includes(String(scope))) throw expired();
    if (typeof row.subjectId !== 'string' || !row.subjectId || row.subjectId.length > 240 || /[\u0000-\u001f\u007f]/.test(row.subjectId) ||
      !Number.isSafeInteger(row.subjectVersion) || row.subjectVersion < 1 || row.subjectVersion > 2147483647) throw expired();
    const common = { eventId: row.id, sequence: publicSequence(row.sequence), runtimeAssetId: row.runtimeAssetId,
      subjectId: row.subjectId, subjectVersion: row.subjectVersion, evidenceScope: scope, refreshRequired: true };
    if (scope === 'managed_server_process_lifecycle') {
      if (row.subjectId !== row.runtimeAssetId || !['started', 'stopped', 'unexpected_exit', 'lost'].includes(String(details.state)) ||
        typeof details.generation !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(details.generation)) throw expired();
      // Lifecycle has no business origin/window dimension. It only prompts a status refresh.
      return { ...common, subjectKind: 'server', state: details.state, generation: details.generation };
    }
    if (scope === 'retained_business_in_flight') {
      if (row.dimensions?.origin !== filter.origin) return null;
      if (![1, -1].includes(details.delta as number) || details.invocationId !== row.subjectId ||
        typeof details.revisionSequence !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(details.revisionSequence) ||
        BigInt(details.revisionSequence) > BigInt(row.sequence)) throw expired();
      return { ...common, subjectKind: 'in_flight_member', delta: details.delta, invocationId: details.invocationId,
        revisionSequence: details.revisionSequence };
    }
    return null;
  }
}
