import { Inject, Injectable, Optional } from '@nestjs/common';
import { RuntimeEventSubscriptionEntity, RuntimeSubscriptionRevisionEntity } from '../../database/entities/runtime-call-observability.entity';
import { ObservabilityApiError, observabilitySuccess } from './call-observability-api.contract';
import { observabilityEtag } from './call-observability-command.store';
import { EVENTS_DISPATCH_AUTHORIZER } from './call-observability-events.dispatcher';
import type { EventsDispatchAuthorizer } from './call-observability-events.dispatcher';
import type { ObservabilityAuthorization } from './call-observability-access';
import { CallObservabilityStore } from './call-observability.store';
import { publicSequence } from './call-observability-storage';

const FILTER_KEYS = ['runtimeAssetIds', 'serverTypes', 'eventTypes', 'severities', 'spanKinds', 'outcomes',
  'callerIds', 'endpointDefinitionIds', 'toolNames'];
export interface ObservabilitySubscriptionSafeView {
  id: string;
  name: string;
  version: number;
  etag: string;
  state: 'active' | 'paused';
  destination: { type: 'webhook'; origin: string | null };
  signingKeyId: string | null;
  /** Only indicates a configured reference. Does not attest key resolution or backend availability. */
  secretConfigured: boolean;
  secretConfigurationMeaning: 'reference_only';
  scope: { mode: 'all' } | { mode: 'assets'; runtimeAssetIds: string[] };
  filter: Record<string, string[]>;
  effectiveFromSequence: string;
  createdAt: string;
  updatedAt: string;
  pausedFromSequence: string | null;
}

/** Detail-only internal query. No list is advertised until mutable subscription views have stable pagination. */
@Injectable()
export class CallObservabilitySubscriptionsQueryService {
  constructor(private readonly store: CallObservabilityStore,
    @Optional() @Inject(EVENTS_DISPATCH_AUTHORIZER) private readonly owners?: EventsDispatchAuthorizer) {}

  async detail(id: string, principalId: string): Promise<ReturnType<typeof observabilitySuccess<ObservabilitySubscriptionSafeView>>> {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/.test(id)) {
      throw new ObservabilityApiError('INVALID_QUERY', 'id');
    }
    if (typeof principalId !== 'string' || !principalId || principalId.length > 500) {
      throw new ObservabilityApiError('UNAUTHENTICATED');
    }
    if (!this.owners) throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
    return this.store.readSnapshot(async tx => {
      // Ownership is an SQL predicate, never an in-memory filter after unbounded enumeration.
      const row = await tx.manager.getRepository(RuntimeEventSubscriptionEntity).createQueryBuilder('subscription')
        .where('subscription.id = :id AND subscription.ownerId = :owner', { id, owner: principalId })
        .andWhere('subscription.deletedAt IS NULL')
        .andWhere('subscription.state IN (:...states)', { states: ['active', 'paused'] }).getOne();
      const authorization = await this.owners!.resolve(principalId, tx.manager);
      if (!authorization || authorization.principalId !== principalId ||
        !authorization.requiredPermissions.includes('monitoring:read') ||
        !authorization.requiredPermissions.includes('monitoring:subscription:manage')) {
        throw new ObservabilityApiError('FORBIDDEN');
      }
      if (!row) throw new ObservabilityApiError('NOT_FOUND');
      const scope = this.visibleScope(row.scope, authorization);
      if (!Number.isInteger(row.version) || row.version < 1 || row.version > 2147483647) {
        throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
      }
      const revision = await tx.manager.getRepository(RuntimeSubscriptionRevisionEntity).findOneBy({
        subscriptionId: row.id, version: row.version,
      });
      if (!revision || revision.revoked || revision.effectiveUntilSequence !== null ||
        revision.effectiveFromSequence !== row.effectiveFromSequence) {
        throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
      }
      const config = revision.config;
      if (!config || typeof config !== 'object' || Array.isArray(config) ||
        config.enabled !== (row.state === 'active')) throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
      // Both the mutable resource and current revision must be fully covered by fresh permissions.
      this.visibleScope(config.scope, authorization);
      const filter = this.safeFilter(config.filter);
      // An explicit resource filter is also a scope claim; no hidden asset IDs may leak via a filter.
      if (filter.runtimeAssetIds) this.visibleScope({ mode: 'assets', runtimeAssetIds: filter.runtimeAssetIds }, authorization);
      const signingKeyId = typeof config.signingKeyId === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/.test(config.signingKeyId) ? config.signingKeyId : null;
      const data: ObservabilitySubscriptionSafeView = {
        id: row.id, name: row.name, version: row.version, etag: observabilityEtag('subscription:' + row.id, row.version),
        state: row.state as 'active' | 'paused', destination: { type: 'webhook', origin: this.safeOrigin(config.destination) },
        signingKeyId, secretConfigured: typeof config.secretRef === 'string' && config.secretRef.trim().length > 0,
        secretConfigurationMeaning: 'reference_only', scope, filter,
        effectiveFromSequence: publicSequence(row.effectiveFromSequence), createdAt: row.createdAt, updatedAt: row.updatedAt,
        pausedFromSequence: row.pausedFromSequence === null ? null : publicSequence(row.pausedFromSequence),
      };
      return observabilitySuccess(data);
    });
  }

  private visibleScope(value: any, authorization: ObservabilityAuthorization): ObservabilitySubscriptionSafeView['scope'] {
    if (!value || !['all', 'assets'].includes(value.mode) || (value.mode === 'assets' &&
      (!Array.isArray(value.runtimeAssetIds) || value.runtimeAssetIds.length > 100 ||
        value.runtimeAssetIds.some((id: unknown) => typeof id !== 'string' || !id || id.length > 500)))) {
      throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
    }
    if (authorization.runtimeAssetIds !== null && (value.mode === 'all' ||
      value.runtimeAssetIds.some((id: string) => !authorization.runtimeAssetIds!.includes(id)))) {
      throw new ObservabilityApiError('NOT_FOUND');
    }
    return value.mode === 'all' ? { mode: 'all' } : { mode: 'assets', runtimeAssetIds: [...value.runtimeAssetIds] };
  }

  private safeFilter(value: unknown): Record<string, string[]> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
    const filter: Record<string, string[]> = {};
    for (const [key, items] of Object.entries(value)) {
      if (!FILTER_KEYS.includes(key) || !Array.isArray(items) || items.length > 100 ||
        items.some(item => typeof item !== 'string' || !item || item.length > 500 || /[\u0000-\u001f\u007f]/.test(item))) {
        throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
      }
      filter[key] = [...items];
    }
    return filter;
  }

  private safeOrigin(value: unknown): string | null {
    if (typeof value !== 'string' || !value || value.length > 4096) return null;
    try {
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.origin === 'null') return null;
      return url.origin; // Never return path, query, fragment, or user information.
    } catch { return null; }
  }
}
