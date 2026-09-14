import { ObservabilityPayloadCapacityDto, payloadCapacityView } from './call-observability-payload-capacity.dto';
import { ApiProperty } from '@nestjs/swagger';
import { RuntimePipelineStateEntity } from '../../database/entities/runtime-call-observability.entity';

export class ObservabilityRetentionRunDto {
  @ApiProperty({ nullable: true, enum: ['completed', 'busy'] }) status: string | null;
  @ApiProperty({ nullable: true }) scanned: number | null;
  @ApiProperty({ nullable: true }) deleted: number | null;
  @ApiProperty({ nullable: true }) missing: number | null;
  @ApiProperty({ nullable: true }) changed: number | null;
  @ApiProperty({ nullable: true }) protected: number | null;
  @ApiProperty({ nullable: true }) danglingReferences: number | null;
  @ApiProperty({ nullable: true }) hasMore: boolean | null;
}
export class ObservabilityPipelineRetentionDto {
  @ApiProperty({ type: ObservabilityPayloadCapacityDto }) scanUsage: ObservabilityPayloadCapacityDto;
  @ApiProperty({ enum: ['payload_retention_worker_last_report'] }) evidenceSource: string;
  @ApiProperty({ enum: ['payload_objects_only'] }) cleanupScope: string;
  @ApiProperty({ enum: ['unknown', 'disabled', 'idle', 'running', 'waiting', 'degraded', 'stopped'] }) state: string;
  @ApiProperty({ nullable: true, description: 'Last reported configuration, not current process enablement.' }) workerConfigured: boolean | null;
  @ApiProperty({ nullable: true }) observedAt: string | null;
  @ApiProperty({ nullable: true }) observationAgeMs: number | null;
  @ApiProperty({ enum: ['unknown', 'recent', 'stale'] }) freshnessStatus: string;
  @ApiProperty() staleAfterMs: number;
  @ApiProperty({ nullable: true }) intervalMs: number | null;
  @ApiProperty({ nullable: true }) stateVersion: number | null;
  @ApiProperty({ nullable: true }) lastAttemptAt: string | null;
  @ApiProperty({ nullable: true }) lastSuccessAt: string | null;
  @ApiProperty({ nullable: true }) lastFailureAt: string | null;
  @ApiProperty({ nullable: true }) errorCode: string | null;
  @ApiProperty({ nullable: true, description: 'Time of the retained complete report; may precede a more recent failed attempt.' }) lastReportAt: string | null;
  @ApiProperty({ nullable: true, description: 'False means the latest attempt did not complete; partial deletions cannot be inferred from the previous report.' }) currentAttemptComplete: boolean | null;
  @ApiProperty({ type: ObservabilityRetentionRunDto, nullable: true }) lastReport: ObservabilityRetentionRunDto | null;
}
const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const time = (v: unknown, ceiling: number): string | null => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)) return null;
  const n = Date.parse(v);
  return Number.isFinite(n) && n <= ceiling && new Date(n).toISOString() === v ? v : null;
};
export function retentionPipelineView(row: RuntimePipelineStateEntity | null, now: number,
  allowedErrors: readonly string[]): ObservabilityPipelineRetentionDto {
  const value = record(row?.value), report = record(value?.lastReport);
  const observedAt = time(row?.updatedAt, now);
  const observationAgeMs = observedAt === null ? null : now - Date.parse(observedAt);
  const rawInterval = count(value?.intervalMs);
  const intervalMs = rawInterval !== null && rawInterval >= 1000 && rawInterval <= 86400000 ? rawInterval : null;
  const staleAfterMs = Math.max(15000, (intervalMs ?? 0) * 2);
  const reportTime = observedAt === null ? now : Date.parse(observedAt);
  return {
    scanUsage: payloadCapacityView(row, now),
    evidenceSource: 'payload_retention_worker_last_report', cleanupScope: 'payload_objects_only',
    state: ['disabled', 'idle', 'running', 'waiting', 'degraded', 'stopped'].includes(String(value?.state)) ? String(value.state) : 'unknown',
    workerConfigured: typeof value?.workerConfigured === 'boolean' ? value.workerConfigured : null,
    observedAt, observationAgeMs, freshnessStatus: observationAgeMs === null ? 'unknown' :
      observationAgeMs > staleAfterMs ? 'stale' : 'recent', staleAfterMs, intervalMs,
    stateVersion: count(value?.stateVersion), lastAttemptAt: time(value?.lastAttemptAt, reportTime),
    lastSuccessAt: time(value?.lastSuccessAt, reportTime), lastFailureAt: time(value?.lastFailureAt, reportTime),
    errorCode: typeof value?.errorCode === 'string' && allowedErrors.includes(value.errorCode) ? value.errorCode : null,
    lastReportAt: time(value?.lastReportAt, reportTime),
    currentAttemptComplete: typeof value?.currentAttemptComplete === 'boolean' ? value.currentAttemptComplete : null,
    lastReport: report ? {
      status: ['completed', 'busy'].includes(String(report.status)) ? String(report.status) : null,
      scanned: count(report.scanned), deleted: count(report.deleted), missing: count(report.missing),
      changed: count(report.changed), protected: count(report.protected), danglingReferences: count(report.danglingReferences),
      hasMore: typeof report.hasMore === 'boolean' ? report.hasMore : null,
    } : null,
  };
}
