import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { redactAuditValue } from 'api-nova-parser';
import { RuntimeObservabilityPolicyEntity } from '../../database/entities/runtime-call-observability.entity';
import { AuditAction, AuditLevel, AuditStatus } from '../../database/entities/audit-log.entity';
import { AuditService } from '../security/services/audit.service';
import { UserService } from '../security/services/user.service';
import { authorizeObservability, ObservabilityAuthorization, requireGlobalObservabilityScope } from './call-observability-access';
import { ObservabilityApiError, observabilitySuccess } from './call-observability-api.contract';
import { observabilityEtag, requireObservabilityIfMatch } from './call-observability-command.store';
import { publicSequence } from './call-observability-storage';
import { parseObservabilityQuery } from './call-observability-query';
import { CallObservabilityStore } from './call-observability.store';
import { EVENT_RETENTION_POLICY_ID, readEventRetentionPolicy } from './call-observability-policy';

function invalid(field = 'body'): never { throw new ObservabilityApiError('INVALID_QUERY', field); }
function patchInput(raw: any): { eventDays?: number; payloadDays?: number; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
    Object.keys(raw).length !== 2 || Object.keys(raw).some(key => !['retention', 'reason'].includes(key))) invalid();
  if (!raw.retention || typeof raw.retention !== 'object' || Array.isArray(raw.retention) ||
    Object.keys(raw.retention).length < 1 ||
    Object.keys(raw.retention).some(key => !['eventDays', 'payloadDays'].includes(key))) invalid('retention');
  for (const [key, days] of Object.entries(raw.retention)) {
    if (!Number.isSafeInteger(days) || Number(days) < 1 || Number(days) > 365) invalid('retention.' + key);
  }
  if (typeof raw.reason !== 'string' || !raw.reason.trim() || raw.reason.length > 500 ||
    /[\u0000-\u001f\u007f]/.test(raw.reason)) invalid('reason');
  return { ...raw.retention, reason: String(redactAuditValue(raw.reason.trim())) };
}
function view(policy: Awaited<ReturnType<typeof readEventRetentionPolicy>>) {
  return { id: policy.id, scope: { mode: 'all' }, revision: policy.version,
    policyEtag: observabilityEtag('policy:' + policy.id, policy.version),
    retention: { eventDays: policy.eventDays, payloadDays: policy.payloadDays }, effectiveAt: policy.effectiveAt,
    retentionImpact: 'new_observability_events_and_payloads_only',
    affectedEventTypes: ['invocation.completed', 'invocation.reconciled', 'metrics.bucket_updated', 'pipeline.state_changed', 'subscription.test'],
    payloadRetentionAnchor: 'completedAt_or_startedAt', existingPayloadExpiryPreserved: true,
    existingRecordsChanged: false, cleanupTriggered: false,
    unsupportedSettings: ['payloadCapture', 'redaction', 'quotas', 'heartbeat', 'deliveryLimits', 'otherRetention'] };
}
function envelope<T>(data: T, sequence: string) {
  return observabilitySuccess(data, { snapshotSeq: sequence, dataWatermark: sequence,
    lagMs: null, historyCompleteSince: null, isPartial: true });
}

@Injectable()
export class CallObservabilityPoliciesService {
  constructor(private readonly store: CallObservabilityStore, private readonly audit: AuditService,
    private readonly users: UserService) {}

  async list(query: Record<string, unknown>, authorization: ObservabilityAuthorization) {
    parseObservabilityQuery(query, []);
    // Global settings are safe to read, but a principal with no visible assets has no effective policy.
    return this.store.readSnapshot(async tx => envelope({ items: authorization.runtimeAssetIds?.length === 0
      ? [] : [view(await readEventRetentionPolicy(tx.manager))] }, tx.snapshotSeq));
  }

  async update(id: string, raw: unknown, query: Record<string, unknown>, ifMatch: unknown,
    principalId: string, internalRequestId: unknown) {
    const requestId = typeof internalRequestId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(internalRequestId)
      ? internalRequestId : randomUUID();
    const result = await this.store.transaction(async tx => {
      let user;
      try { user = await this.users.findUserById(principalId); }
      catch (error) {
        throw new ObservabilityApiError(error?.getStatus?.() === 404 ? 'UNAUTHENTICATED' : 'OBSERVABILITY_UNAVAILABLE');
      }
      const authorization = authorizeObservability(user, ['monitoring:manage']);
      requireGlobalObservabilityScope(authorization);
      if (id !== EVENT_RETENTION_POLICY_ID) throw new ObservabilityApiError('NOT_FOUND');
      parseObservabilityQuery(query, []);
      const patch = patchInput(raw);
      const previous = await readEventRetentionPolicy(tx.manager);
      requireObservabilityIfMatch(ifMatch, 'policy:' + id, previous.version);
      const eventDays = patch.eventDays ?? previous.eventDays, payloadDays = patch.payloadDays ?? previous.payloadDays;
      const changed = eventDays !== previous.eventDays || payloadDays !== previous.payloadDays;
      if (changed && previous.version >= 2147483647) throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
      const next = changed ? { ...previous, version: previous.version + 1,
        eventDays, payloadDays, effectiveAt: tx.now } : previous;
      if (changed) {
        const repository = tx.manager.getRepository(RuntimeObservabilityPolicyEntity);
        await repository.save(repository.create({ id, version: next.version, scope: { mode: 'all' },
          settings: { eventDays: next.eventDays, payloadDays: next.payloadDays }, updatedAt: tx.now, updatedBy: principalId }));
        tx.nextSequence();
      }
      const log = await this.audit.log({ action: AuditAction.CONFIG_UPDATED, level: AuditLevel.INFO,
        status: AuditStatus.SUCCESS, userId: principalId, resource: 'observability_policy', resourceId: id,
        details: { operation: 'observability.policy.update', requestId, reason: patch.reason,
          previousRevision: previous.version, revision: next.version, changed,
          before: { eventDays: previous.eventDays, payloadDays: previous.payloadDays },
          after: { eventDays: next.eventDays, payloadDays: next.payloadDays },
          retentionImpact: 'new_observability_events_and_payloads_only' } }, tx.manager);
      return envelope({ ...view(next), changed, auditId: log.id }, publicSequence(tx.currentSequence()));
    });
    return result;
  }
}
