import { EntityManager } from 'typeorm';
import { RuntimeObservabilityPolicyEntity } from '../../database/entities/runtime-call-observability.entity';
import { ObservabilityApiError } from './call-observability-api.contract';

export const EVENT_RETENTION_POLICY_ID = 'global-event-retention';
export const DEFAULT_EVENT_RETENTION_DAYS = 14;
export const DEFAULT_PAYLOAD_RETENTION_DAYS = 7;

/** Legacy event-only rows remain valid; missing payloadDays means the approved seven-day default. */
export async function readEventRetentionPolicy(manager: EntityManager) {
  const row = await manager.getRepository(RuntimeObservabilityPolicyEntity)
    .findOneBy({ id: EVENT_RETENTION_POLICY_ID });
  if (row && (row.scope?.mode !== 'all' || Object.keys(row.scope).length !== 1 ||
    !Number.isSafeInteger(row.version) || row.version < 2 || row.version > 2147483647 ||
    !row.settings || Object.keys(row.settings).some(key => !['eventDays', 'payloadDays'].includes(key)) ||
    !Number.isSafeInteger(row.settings.eventDays) || row.settings.eventDays < 1 || row.settings.eventDays > 365 ||
    (Object.hasOwnProperty.call(row.settings, 'payloadDays') && (!Number.isSafeInteger(row.settings.payloadDays) ||
      row.settings.payloadDays < 1 || row.settings.payloadDays > 365)) ||
    !Number.isFinite(Date.parse(row.updatedAt)))) {
    throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
  }
  return { id: EVENT_RETENTION_POLICY_ID, version: row?.version ?? 1,
    eventDays: row?.settings.eventDays ?? DEFAULT_EVENT_RETENTION_DAYS,
    payloadDays: row?.settings.payloadDays ?? DEFAULT_PAYLOAD_RETENTION_DAYS, effectiveAt: row?.updatedAt ?? null };
}
