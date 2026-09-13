import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import {
  RuntimeEventDeliveryEntity, RuntimeEventSubscriptionEntity, RuntimeSubscriptionRevisionEntity,
} from '../../database/entities/runtime-call-observability.entity';
import { AuditAction, AuditLevel, AuditStatus } from '../../database/entities/audit-log.entity';
import { AuditService } from '../security/services/audit.service';
import { ObservabilityAuthorization } from './call-observability-access';
import { ObservabilityApiError, observabilitySuccess } from './call-observability-api.contract';
import { ObservabilityCommandStore, observabilityEtag, requireObservabilityIfMatch } from './call-observability-command.store';
import { canonicalJson, publicSequence, sequenceKey } from './call-observability-storage';
import { ObservabilityCursorService } from './call-observability-cursor.service';
import { parseObservabilityQuery } from './call-observability-query';
import { CallObservabilityStore, ObservabilityWriteTransaction } from './call-observability.store';

const FILTER_KEYS = ['runtimeAssetIds', 'serverTypes', 'eventTypes', 'severities', 'spanKinds',
  'outcomes', 'callerIds', 'endpointDefinitionIds', 'toolNames'] as const;
const ENUMS: Record<string, readonly string[]> = {
  serverTypes: ['gateway', 'mcp'],
  eventTypes: ['invocation.completed', 'invocation.reconciled', 'caller.discovered',
    'server.state_changed', 'server.snapshot', 'metrics.bucket_updated', 'pipeline.state_changed'],
  severities: ['debug', 'info', 'warning', 'error', 'critical'],
  spanKinds: ['gateway_request', 'mcp_protocol', 'mcp_tool', 'upstream_api'],
  outcomes: ['success', 'error', 'rejected', 'timeout', 'cancelled', 'incomplete', 'unknown'],
};
type FilterKey = typeof FILTER_KEYS[number];
type SubscriptionFilter = Partial<Record<FilterKey, string[]>>;
type SubscriptionScope = { mode: 'all' } | { mode: 'assets'; runtimeAssetIds: string[] };
interface CreateInput {
  name: string;
  destination: { type: 'webhook'; url: string };
  secretRef: string;
  filter: SubscriptionFilter;
  enabled: boolean;
  reason?: string;
}
type PatchInput = Partial<CreateInput>;
const MAX_SUBSCRIPTION_SCAN = 1000;

function invalid(field = 'body'): never { throw new ObservabilityApiError('INVALID_QUERY', field); }
function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function cleanText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) invalid(field);
  return value.trim();
}
function parseFilter(raw: unknown): SubscriptionFilter {
  if (raw === undefined) return {};
  if (!plainObject(raw) || Object.keys(raw).length > FILTER_KEYS.length) invalid('filter');
  const filter: SubscriptionFilter = {};
  for (const [key, rawValues] of Object.entries(raw)) {
    if (!(FILTER_KEYS as readonly string[]).includes(key) || !Array.isArray(rawValues) ||
      !rawValues.length || rawValues.length > 100) invalid('filter.' + key);
    const values = rawValues.map(value => cleanText(value, 'filter.' + key, 240));
    if (new Set(values).size !== values.length || (ENUMS[key] && values.some(value => !ENUMS[key].includes(value)))) {
      invalid('filter.' + key);
    }
    filter[key as FilterKey] = [...values].sort();
  }
  return filter;
}

@Injectable()
export class CallObservabilitySubscriptionsService {
  constructor(private readonly store: CallObservabilityStore, private readonly commands: ObservabilityCommandStore,
    private readonly config: ConfigService, private readonly audit: AuditService,
    private readonly cursors: ObservabilityCursorService) {}

  async create(raw: unknown, query: Record<string, unknown>, idempotencyKey: unknown,
    authorization: ObservabilityAuthorization, internalRequestId: unknown) {
    parseObservabilityQuery(query, []);
    const input = this.parseCreate(raw);
    const scope = this.scope(input.filter.runtimeAssetIds, authorization);
    this.validateDestination(input.destination.url);
    this.validateSecretRef(input.secretRef);
    const requestId = typeof internalRequestId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(internalRequestId)
      ? internalRequestId : randomUUID();
    const command = await this.commands.execute(authorization, {
      method: 'POST', path: '/api/v1/monitoring/observability/subscriptions',
      ...(idempotencyKey === undefined ? {} : { key: idempotencyKey }), request: input,
    }, async (tx, previous) => {
      if (!previous) return this.assertScope(scope, authorization);
      const subscription = await tx.manager.getRepository(RuntimeEventSubscriptionEntity)
        .findOneBy({ id: previous.resourceId });
      if (!subscription || subscription.deletedAt || !this.scopeVisible(subscription.scope, authorization)) {
        throw new ObservabilityApiError('NOT_FOUND');
      }
    }, tx => this.insert(tx, input, scope, authorization, requestId));
    return this.response(command.result.resourceId, command.result.version!, command.result.operationId!, command.replayed);
  }

  async list(raw: Record<string, unknown>, authorization: ObservabilityAuthorization) {
    const parsed = this.parseList(raw);
    const binding = { kind: 'query' as const, endpoint: 'obsListSubscriptions',
      sort: 'createdAt:desc,id:desc', authorization };
    const cursor = parsed.cursor ? this.cursors.open(parsed.cursor, binding) : undefined;
    const filter = cursor && raw.state === undefined ? cursor.filter : parsed.filter;
    if (cursor) this.cursors.assertFilter(cursor, filter);
    const state = typeof filter.state === 'string' ? filter.state : undefined;
    return this.store.readSnapshot(async tx => {
      const snapshotSeq = cursor?.snapshotSeq || tx.snapshotSeq;
      if (BigInt(snapshotSeq) > BigInt(tx.snapshotSeq)) throw new ObservabilityApiError('QUERY_CURSOR_EXPIRED');
      const position = cursor?.position;
      if (position && (typeof position.createdAt !== 'string' || typeof position.id !== 'string')) {
        throw new ObservabilityApiError('INVALID_QUERY', 'cursor');
      }
      const repository = tx.manager.getRepository(RuntimeEventSubscriptionEntity);
      const query = repository.createQueryBuilder('subscription')
        .where('subscription.deletedAt IS NULL')
        .andWhere('subscription.effectiveFromSequence <= :snapshot', { snapshot: sequenceKey(snapshotSeq) });
      if (position) query.andWhere('(subscription.createdAt < :createdAt OR ' +
        '(subscription.createdAt = :createdAt AND subscription.id < :id))', position);
      const rows = await query.orderBy('subscription.createdAt', 'DESC').addOrderBy('subscription.id', 'DESC')
        .take(MAX_SUBSCRIPTION_SCAN + 1).getMany();
      const items: any[] = [];
      let scanned = 0;
      for (const row of rows.slice(0, MAX_SUBSCRIPTION_SCAN)) {
        scanned++;
        if (!this.scopeVisible(row.scope, authorization)) continue;
        const revision = await tx.manager.getRepository(RuntimeSubscriptionRevisionEntity)
          .createQueryBuilder('revision').where('revision.subscriptionId = :subscriptionId', { subscriptionId: row.id })
          .andWhere('revision.revoked = :revoked', { revoked: false })
          .andWhere('revision.effectiveFromSequence <= :snapshot', { snapshot: sequenceKey(snapshotSeq) })
          .andWhere('(revision.effectiveUntilSequence IS NULL OR revision.effectiveUntilSequence > :snapshot)',
            { snapshot: sequenceKey(snapshotSeq) }).orderBy('revision.version', 'DESC').take(1).getOne();
        if (!revision) throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
        if (state && revision.config?.state !== state) continue;
        if (!this.scopeVisible(revision.config?.scope, authorization)) continue;
        items.push(this.view(row, revision));
        if (items.length === parsed.limit) break;
      }
      const hasMore = rows.length > scanned;
      const last = scanned ? rows[scanned - 1] : undefined;
      const nextCursor = hasMore && last ? this.cursors.issue(binding, { filter, snapshotSeq,
        position: { createdAt: last.createdAt, id: last.id } }) : null;
      return observabilitySuccess({ items, nextCursor, hasMore, scannedSubscriptions: scanned },
        { snapshotSeq, dataWatermark: snapshotSeq, lagMs: null, historyCompleteSince: null, isPartial: true });
    });
  }

  async get(id: string, query: Record<string, unknown>, authorization: ObservabilityAuthorization) {
    this.validateId(id); parseObservabilityQuery(query, []);
    return this.store.readSnapshot(async tx => {
      const subscription = await tx.manager.getRepository(RuntimeEventSubscriptionEntity).findOneBy({ id });
      if (!subscription || subscription.deletedAt || !this.scopeVisible(subscription.scope, authorization)) {
        throw new ObservabilityApiError('NOT_FOUND');
      }
      const revision = await tx.manager.getRepository(RuntimeSubscriptionRevisionEntity)
        .findOneBy({ subscriptionId: id, version: subscription.version });
      if (!revision) throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
      return observabilitySuccess(this.view(subscription, revision), { snapshotSeq: tx.snapshotSeq,
        dataWatermark: tx.snapshotSeq, lagMs: null, historyCompleteSince: null, isPartial: true });
    });
  }

  async update(id: string, raw: unknown, query: Record<string, unknown>, ifMatch: unknown,
    authorization: ObservabilityAuthorization, internalRequestId: unknown) {
    this.validateId(id); parseObservabilityQuery(query, []);
    const patch = this.parsePatch(raw);
    if (patch.destination) this.validateDestination(patch.destination.url);
    if (patch.secretRef) this.validateSecretRef(patch.secretRef);
    const requestId = this.requestId(internalRequestId);
    const result = await this.store.transaction(async tx => {
      const subscription = await this.locked(tx, id);
      if (!subscription || subscription.deletedAt || !this.scopeVisible(subscription.scope, authorization)) {
        throw new ObservabilityApiError('NOT_FOUND');
      }
      requireObservabilityIfMatch(ifMatch, 'subscription:' + id, subscription.version);
      const revisions = tx.manager.getRepository(RuntimeSubscriptionRevisionEntity);
      const current = await revisions.findOneBy({ subscriptionId: id, version: subscription.version });
      if (!current) throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
      const currentConfig = current.config || {};
      const nextFilter = patch.filter === undefined ? subscription.filter : patch.filter;
      const nextScope = patch.filter === undefined ? subscription.scope : this.scope(patch.filter.runtimeAssetIds, authorization);
      this.assertScope(nextScope, authorization);
      const nextState = patch.enabled === undefined ? subscription.state : patch.enabled ? 'enabled' : 'paused';
      const nextDestination = patch.destination || currentConfig.destination;
      const nextSecretRef = patch.secretRef || subscription.secretRef;
      const nextName = patch.name || subscription.name;
      const nextConfig = { name: nextName, state: nextState, destination: nextDestination, secretRef: nextSecretRef,
        filter: nextFilter, scope: nextScope };
      const changed = canonicalJson({ name: subscription.name, config: currentConfig }) !==
        canonicalJson({ name: nextName, config: nextConfig });
      let pausedGapRange: { from: string; to: string } | undefined;
      if (changed) {
        if (subscription.version >= 2147483647) throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
        const sequence = tx.nextSequence();
        current.effectiveUntilSequence = sequence;
        await revisions.save(current);
        const nextVersion = subscription.version + 1;
        await revisions.insert(revisions.create({ id: randomUUID(), subscriptionId: id, version: nextVersion,
          effectiveFromSequence: sequence, effectiveUntilSequence: null, config: nextConfig,
          revoked: false, createdAt: tx.now }));
        if (subscription.state !== 'paused' && nextState === 'paused') subscription.pausedFromSequence = sequence;
        if (subscription.state === 'paused' && nextState === 'enabled' && subscription.pausedFromSequence) {
          pausedGapRange = { from: publicSequence(subscription.pausedFromSequence), to: publicSequence(sequence) };
          subscription.pausedFromSequence = null;
        }
        Object.assign(subscription, { name: nextName, version: nextVersion, state: nextState,
          destination: canonicalJson(nextDestination), secretRef: nextSecretRef, filter: nextFilter,
          scope: nextScope, updatedAt: tx.now });
        await tx.manager.getRepository(RuntimeEventSubscriptionEntity).save(subscription);
      }
      const log = await this.audit.log({ action: AuditAction.CONFIG_UPDATED, level: AuditLevel.INFO,
        status: AuditStatus.SUCCESS, userId: authorization.principalId,
        resource: 'observability_subscription', resourceId: id,
        details: { operation: 'observability.subscription.update', requestId,
          result: changed ? 'updated' : 'unchanged', version: subscription.version,
          state: subscription.state, reasonProvided: !!patch.reason } }, tx.manager);
      const revision = changed ? await revisions.findOneByOrFail({ subscriptionId: id, version: subscription.version }) : current;
      return { data: { ...this.view(subscription, revision), changed, auditId: log.id,
        ...(pausedGapRange ? { pausedGapRange } : {}) }, snapshotSeq: publicSequence(tx.currentSequence()) };
    });
    return observabilitySuccess(result.data, { snapshotSeq: result.snapshotSeq, dataWatermark: result.snapshotSeq,
      lagMs: null, historyCompleteSince: null, isPartial: true });
  }

  async remove(id: string, query: Record<string, unknown>, ifMatch: unknown,
    authorization: ObservabilityAuthorization, internalRequestId: unknown): Promise<void> {
    this.validateId(id); parseObservabilityQuery(query, []);
    const requestId = this.requestId(internalRequestId);
    await this.store.transaction(async tx => {
      const subscriptions = tx.manager.getRepository(RuntimeEventSubscriptionEntity);
      const subscription = await this.locked(tx, id);
      if (!subscription || subscription.deletedAt || !this.scopeVisible(subscription.scope, authorization)) {
        throw new ObservabilityApiError('NOT_FOUND');
      }
      requireObservabilityIfMatch(ifMatch, 'subscription:' + id, subscription.version);
      if (subscription.version >= 2147483647) throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
      const sequence = tx.nextSequence();
      const revisions = tx.manager.getRepository(RuntimeSubscriptionRevisionEntity);
      const current = await revisions.findOneBy({ subscriptionId: id, version: subscription.version });
      if (!current) throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
      current.effectiveUntilSequence = sequence;
      await revisions.save(current);
      await revisions.update({ subscriptionId: id }, { revoked: true });
      const nextVersion = subscription.version + 1;
      await revisions.insert(revisions.create({ id: randomUUID(), subscriptionId: id, version: nextVersion,
        effectiveFromSequence: sequence, effectiveUntilSequence: null,
        config: { ...current.config, state: 'deleted' }, revoked: true, createdAt: tx.now }));
      Object.assign(subscription, { version: nextVersion, state: 'deleted', deletedAt: tx.now, updatedAt: tx.now,
        pausedFromSequence: null });
      await subscriptions.save(subscription);
      await tx.manager.getRepository(RuntimeEventDeliveryEntity).createQueryBuilder().update()
        .set({ status: 'cancelled', version: () => '"version" + 1', leaseOwner: null as any,
          leaseUntil: null as any, updatedAt: tx.now, lastError: { category: 'subscription_deleted' } as any })
        .where('subscriptionId = :id', { id })
        .andWhere('status IN (:...statuses)', { statuses: ['pending', 'in_flight', 'retry_wait'] }).execute();
      await this.audit.log({ action: AuditAction.CONFIG_UPDATED, level: AuditLevel.INFO,
        status: AuditStatus.SUCCESS, userId: authorization.principalId,
        resource: 'observability_subscription', resourceId: id,
        details: { operation: 'observability.subscription.delete', requestId,
          result: 'deleted', version: nextVersion } }, tx.manager);
    });
  }

  private parseList(raw: Record<string, unknown>) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['state','cursor','limit'].includes(key))) {
      invalid('query');
    }
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value !== 'string' || !value || value.length > (key === 'cursor' ? 8192 : 32)) invalid(key);
    }
    const state = raw.state === undefined ? undefined : String(raw.state);
    if (state && !['enabled', 'paused'].includes(state)) invalid('state');
    const limit = raw.limit === undefined ? 50 : Number(raw.limit);
    if (raw.limit !== undefined && (!/^[1-9]\d{0,2}$/.test(String(raw.limit)) || limit > 200)) invalid('limit');
    return { state, limit, cursor: raw.cursor === undefined ? undefined : String(raw.cursor),
      filter: state ? { state } : {} };
  }

  private parsePatch(raw: unknown): PatchInput {
    if (!plainObject(raw) || !Object.keys(raw).length || Buffer.byteLength(JSON.stringify(raw)) > 65536) invalid();
    const allowed = ['name', 'destination', 'secretRef', 'filter', 'enabled', 'reason'];
    if (Object.keys(raw).some(key => !allowed.includes(key)) ||
      !Object.keys(raw).some(key => key !== 'reason')) invalid();
    const patch: PatchInput = {};
    if (raw.name !== undefined) patch.name = cleanText(raw.name, 'name', 200);
    if (raw.destination !== undefined) {
      if (!plainObject(raw.destination) || Object.keys(raw.destination).some(key => !['type','url'].includes(key)) ||
        raw.destination.type !== 'webhook') invalid('destination');
      patch.destination = { type: 'webhook', url: cleanText(raw.destination.url, 'destination.url', 2048) };
    }
    if (raw.secretRef !== undefined) patch.secretRef = cleanText(raw.secretRef, 'secretRef', 128);
    if (raw.filter !== undefined) patch.filter = parseFilter(raw.filter);
    if (raw.enabled !== undefined) {
      if (typeof raw.enabled !== 'boolean') invalid('enabled');
      patch.enabled = raw.enabled;
    }
    if (raw.reason !== undefined) patch.reason = cleanText(raw.reason, 'reason', 500);
    return patch;
  }

  private validateId(id: string): void {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/.test(id)) invalid('id');
  }

  private requestId(value: unknown): string {
    return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      ? value : randomUUID();
  }

  private async locked(tx: ObservabilityWriteTransaction, id: string) {
    const query = tx.manager.getRepository(RuntimeEventSubscriptionEntity)
      .createQueryBuilder('subscription').where('subscription.id = :id', { id });
    if (tx.manager.connection.options.type === 'postgres') query.setLock('pessimistic_write');
    return query.getOne();
  }

  private view(subscription: RuntimeEventSubscriptionEntity, revision: RuntimeSubscriptionRevisionEntity) {
    const config = revision.config || {};
    return { id: subscription.id, version: revision.version, state: config.state,
      name: config.name || subscription.name, destination: config.destination, filter: config.filter,
      effectiveFromSeq: publicSequence(revision.effectiveFromSequence),
      signingKeyId: subscription.secretRef, secretConfigured: true,
      editEtag: observabilityEtag('subscription:' + subscription.id, revision.version),
      createdAt: subscription.createdAt, updatedAt: subscription.updatedAt,
      health: { state: 'not_started', lastAttemptAt: null, lastSuccessAt: null, lastFailureAt: null } };
  }

  private parseCreate(raw: unknown): CreateInput {
    if (!plainObject(raw) || Buffer.byteLength(JSON.stringify(raw)) > 65536) invalid();
    const allowed = ['name', 'destination', 'secretRef', 'filter', 'enabled', 'reason'];
    if (Object.keys(raw).some(key => !allowed.includes(key))) invalid();
    if (!plainObject(raw.destination) || Object.keys(raw.destination).some(key => !['type', 'url'].includes(key)) ||
      raw.destination.type !== 'webhook') invalid('destination');
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') invalid('enabled');
    const reason = raw.reason === undefined ? undefined : cleanText(raw.reason, 'reason', 500);
    return {
      name: cleanText(raw.name, 'name', 200),
      destination: { type: 'webhook', url: cleanText(raw.destination.url, 'destination.url', 2048) },
      secretRef: cleanText(raw.secretRef, 'secretRef', 128), filter: parseFilter(raw.filter),
      enabled: raw.enabled !== false, ...(reason ? { reason } : {}),
    };
  }

  private scope(requested: string[] | undefined, authorization: ObservabilityAuthorization): SubscriptionScope {
    if (requested) {
      if (authorization.runtimeAssetIds !== null && requested.some(id => !authorization.runtimeAssetIds!.includes(id))) {
        throw new ObservabilityApiError('FORBIDDEN');
      }
      return { mode: 'assets', runtimeAssetIds: [...requested] };
    }
    if (authorization.runtimeAssetIds === null) return { mode: 'all' };
    if (!authorization.runtimeAssetIds.length) throw new ObservabilityApiError('FORBIDDEN');
    return { mode: 'assets', runtimeAssetIds: [...authorization.runtimeAssetIds] };
  }

  private assertScope(scope: SubscriptionScope, authorization: ObservabilityAuthorization): void {
    if (!this.scopeVisible(scope, authorization)) throw new ObservabilityApiError('FORBIDDEN');
  }

  private scopeVisible(scope: any, authorization: ObservabilityAuthorization): boolean {
    if (scope?.mode === 'all') return authorization.runtimeAssetIds === null;
    return scope?.mode === 'assets' && Array.isArray(scope.runtimeAssetIds) &&
      (authorization.runtimeAssetIds === null || scope.runtimeAssetIds.every(id => authorization.runtimeAssetIds!.includes(id)));
  }

  private validateDestination(raw: string): void {
    let destination: URL;
    try { destination = new URL(raw); } catch { invalid('destination.url'); }
    if (destination.username || destination.password || destination.search || destination.hash ||
      !['https:', 'http:'].includes(destination.protocol)) invalid('destination.url');
    const allowHttp = this.config.get<string>('API_NOVA_OBSERVABILITY_WEBHOOK_ALLOW_HTTP') === 'true';
    if (destination.protocol !== 'https:' && !allowHttp) invalid('destination.url');
    const host = destination.host.toLowerCase();
    if (!host || ['169.254.169.254', '[fd00:ec2::254]'].includes(host)) invalid('destination.url');
    const allowed = (this.config.get<string>('API_NOVA_OBSERVABILITY_WEBHOOK_ALLOWED_HOSTS') || '')
      .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
    if (!allowed.length) throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
    if (!allowed.includes(host)) throw new ObservabilityApiError('FORBIDDEN');
  }

  private validateSecretRef(secretRef: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(secretRef)) invalid('secretRef');
    const allowed = (this.config.get<string>('API_NOVA_OBSERVABILITY_WEBHOOK_SECRET_REFS') || '')
      .split(',').map(value => value.trim()).filter(Boolean);
    if (!allowed.length) throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
    if (!allowed.includes(secretRef)) throw new ObservabilityApiError('FORBIDDEN');
  }

  private async insert(tx: ObservabilityWriteTransaction, input: CreateInput, scope: SubscriptionScope,
    authorization: ObservabilityAuthorization, requestId: string) {
    const id = randomUUID();
    const sequence = tx.nextSequence();
    const state = input.enabled ? 'enabled' : 'paused';
    const subscription = tx.manager.getRepository(RuntimeEventSubscriptionEntity).create({
      id, ownerId: authorization.principalId, name: input.name, version: 1, state,
      destination: canonicalJson(input.destination), secretRef: input.secretRef, filter: input.filter, scope,
      effectiveFromSequence: sequence, createdAt: tx.now, updatedAt: tx.now,
      pausedFromSequence: input.enabled ? null : sequence, deletedAt: null,
    });
    await tx.manager.getRepository(RuntimeEventSubscriptionEntity).insert(subscription);
    const revisions = tx.manager.getRepository(RuntimeSubscriptionRevisionEntity);
    await revisions.insert(revisions.create({
      id: randomUUID(), subscriptionId: id, version: 1, effectiveFromSequence: sequence,
      effectiveUntilSequence: null, config: { name: input.name, state, destination: input.destination,
        secretRef: input.secretRef, filter: input.filter, scope }, revoked: false, createdAt: tx.now,
    }));
    const log = await this.audit.log({ action: AuditAction.CONFIG_UPDATED, level: AuditLevel.INFO,
      status: AuditStatus.SUCCESS, userId: authorization.principalId,
      resource: 'observability_subscription', resourceId: id,
      details: { operation: 'observability.subscription.create', requestId, result: 'created', version: 1,
        state, scopeMode: scope.mode, assetCount: scope.mode === 'assets' ? scope.runtimeAssetIds.length : null,
        filterFields: Object.keys(input.filter).sort(), reasonProvided: !!input.reason } }, tx.manager);
    return { statusCode: 201 as const, resourceId: id, version: 1, operationId: log.id };
  }

  private async response(id: string, version: number, auditId: string, replayed: boolean) {
    return this.store.readSnapshot(async tx => {
      const subscription = await tx.manager.getRepository(RuntimeEventSubscriptionEntity).findOneBy({ id });
      const revision = await tx.manager.getRepository(RuntimeSubscriptionRevisionEntity)
        .findOneBy({ subscriptionId: id, version });
      if (!subscription || !revision) throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
      return observabilitySuccess({ ...this.view(subscription, revision),
        health: { state: 'not_started', lastAttemptAt: null, lastSuccessAt: null, lastFailureAt: null },
        replayed, auditId }, { snapshotSeq: tx.snapshotSeq, dataWatermark: tx.snapshotSeq,
        lagMs: null, historyCompleteSince: null, isPartial: true });
    });
  }
}
