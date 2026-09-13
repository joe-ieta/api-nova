import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import {
  RuntimeEventSubscriptionEntity, RuntimeSubscriptionRevisionEntity,
} from '../../database/entities/runtime-call-observability.entity';
import { AuditAction, AuditLevel, AuditStatus } from '../../database/entities/audit-log.entity';
import { AuditService } from '../security/services/audit.service';
import { ObservabilityAuthorization } from './call-observability-access';
import { ObservabilityApiError, observabilitySuccess } from './call-observability-api.contract';
import { ObservabilityCommandStore, observabilityEtag } from './call-observability-command.store';
import { canonicalJson, publicSequence } from './call-observability-storage';
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
    private readonly config: ConfigService, private readonly audit: AuditService) {}

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
      effectiveUntilSequence: null, config: { state, destination: input.destination,
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
      const config = revision.config || {};
      return observabilitySuccess({ id, version, state: config.state, name: subscription.name,
        destination: config.destination, filter: config.filter, effectiveFromSeq: publicSequence(revision.effectiveFromSequence),
        signingKeyId: subscription.secretRef, secretConfigured: true,
        editEtag: observabilityEtag('subscription:' + id, subscription.version),
        createdAt: subscription.createdAt, updatedAt: subscription.updatedAt,
        health: { state: 'not_started', lastAttemptAt: null, lastSuccessAt: null, lastFailureAt: null },
        replayed, auditId }, { snapshotSeq: tx.snapshotSeq, dataWatermark: tx.snapshotSeq,
        lagMs: null, historyCompleteSince: null, isPartial: true });
    });
  }
}
