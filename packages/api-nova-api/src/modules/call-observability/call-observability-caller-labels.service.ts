import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { redactAuditValue } from 'api-nova-parser';
import { RuntimeCallerEntity } from '../../database/entities/runtime-call-observability.entity';
import { AuditAction, AuditLevel, AuditStatus } from '../../database/entities/audit-log.entity';
import { AuditService } from '../security/services/audit.service';
import { UserService } from '../security/services/user.service';
import { authorizeObservability } from './call-observability-access';
import { ObservabilityApiError, observabilitySuccess } from './call-observability-api.contract';
import { requireObservabilityIfMatch } from './call-observability-command.store';
import { canonicalJson, publicSequence } from './call-observability-storage';
import { parseObservabilityQuery } from './call-observability-query';
import { CallObservabilityStore } from './call-observability.store';
import { canManageCallerProfile, callerProfileEtag } from './call-observability-caller-profile';

type Profile = Pick<RuntimeCallerEntity, 'displayName' | 'note' | 'labels'>;
const FIELDS = ['displayName', 'note', 'labels'] as const;
function invalid(field = 'body'): never { throw new ObservabilityApiError('INVALID_QUERY', field); }
function patchInput(raw: unknown): Partial<Profile> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid();
  const entries = Object.entries(raw);
  if (!entries.length || entries.length > 3 || entries.some(([key]) => !FIELDS.includes(key as any))) invalid();
  if (Buffer.byteLength(JSON.stringify(raw)) > 16384) throw new ObservabilityApiError('QUERY_TOO_LARGE', 'body');
  const patch: Partial<Profile> = {};
  for (const [key, value] of entries) {
    if (key === 'labels') {
      if (!Array.isArray(value) || value.length > 32) invalid(key);
      const labels = value.map(item => {
        if (typeof item !== 'string' || item.length > 64 || !item.trim() || /[\u0000-\u001f\u007f]/.test(item)) invalid(key);
        return String(redactAuditValue(item.trim()));
      });
      if (new Set(labels).size !== labels.length) invalid(key);
      patch.labels = labels.sort();
    } else {
      const maximum = key === 'displayName' ? 200 : 2000;
      const controls = key === 'note' ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
      if (value !== null && (typeof value !== 'string' || value.length > maximum || controls.test(value))) invalid(key);
      patch[key as 'displayName' | 'note'] = value === null || !(value as string).trim()
        ? null : String(redactAuditValue((value as string).trim().replace(/\r\n/g, '\n')));
    }
  }
  return patch;
}
function fields(profile: RuntimeCallerEntity): Profile {
  return { displayName: profile.displayName, note: profile.note, labels: profile.labels };
}

@Injectable()
export class CallObservabilityCallerLabelsService {
  constructor(private readonly store: CallObservabilityStore, private readonly audit: AuditService,
    private readonly users: UserService) {}

  async update(id: string, raw: unknown, query: Record<string, unknown>, ifMatch: unknown,
    principalId: string, internalRequestId: unknown) {
    if (typeof id !== 'string' || !id || id.length > 240 || /[\u0000-\u001f\u007f]/.test(id)) invalid('id');
    const requestId = typeof internalRequestId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(internalRequestId)
      ? internalRequestId : randomUUID();
    const result = await this.store.transaction(async tx => {
      // Refresh authorization inside the serialized mutation, not from cached JWT roles.
      let user;
      try { user = await this.users.findUserById(principalId); }
      catch (error) {
        throw new ObservabilityApiError(error?.getStatus?.() === 404 ? 'UNAUTHENTICATED' : 'OBSERVABILITY_UNAVAILABLE');
      }
      const authorization = authorizeObservability(user, ['monitoring:manage']);
      const repository = tx.manager.getRepository(RuntimeCallerEntity);
      const profile = await repository.findOneBy({ callerId: id });
      let permitted = false;
      let patch: Partial<Profile>, next: Profile, changedFields: string[];
      try {
        permitted = !!profile && profile.identitySource === 'authenticated' &&
          await canManageCallerProfile(tx.manager, id, authorization, tx.now);
        if (!permitted) throw new ObservabilityApiError('NOT_FOUND');
        parseObservabilityQuery(query, []);
        patch = patchInput(raw);
        // Validate resource/version only after complete object authorization.
        callerProfileEtag(profile);
        requireObservabilityIfMatch(ifMatch, 'caller-profile:' + id, profile.version);
        next = { ...fields(profile), ...patch };
        changedFields = FIELDS.filter(key => canonicalJson(profile[key]) !== canonicalJson(next[key]));
        if (changedFields.length && profile.version >= 2147483647) throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
      } catch (error) {
        if (!(error instanceof ObservabilityApiError)) throw error;
        await this.audit.log({ action: AuditAction.CONFIG_UPDATED, level: AuditLevel.INFO, status: AuditStatus.FAILED,
          userId: principalId, resource: 'observability_caller', ...(permitted ? { resourceId: id } : {}),
          details: { operation: 'observability.caller.update', requestId, result: 'denied', reasonCode: error.code } }, tx.manager);
        return { error };
      }
      const previousVersion = profile.version;
      if (changedFields.length) {
        Object.assign(profile, next, { version: previousVersion + 1 });
        await repository.save(profile);
      }
      // Free-text values, supplied headers and raw request bodies are not copied
      // into the management audit. The evidence identifies the field/version change.
      const log = await this.audit.log({ action: AuditAction.CONFIG_UPDATED, level: AuditLevel.INFO,
        status: AuditStatus.SUCCESS, userId: principalId, resource: 'observability_caller', resourceId: id,
        details: { operation: 'observability.caller.update', requestId,
          result: changedFields.length ? 'updated' : 'unchanged', changedFields, previousVersion,
          version: profile.version, labelCount: profile.labels.length } }, tx.manager);
      const watermark = publicSequence(tx.currentSequence());
      return { response: observabilitySuccess({ callerId: id, ...fields(profile), profileEtag: callerProfileEtag(profile),
        changed: changedFields.length > 0, changedFields, auditId: log.id },
      { snapshotSeq: watermark, dataWatermark: watermark, lagMs: null, historyCompleteSince: null, isPartial: true }) };
    });
    if (result.error) throw result.error;
    return result.response!;
  }
}
