import { ApiProperty } from '@nestjs/swagger';
import { RuntimePipelineStateEntity } from '../../database/entities/runtime-call-observability.entity';

export class ObservabilityManagementHeartbeatDto {
  @ApiProperty({ enum: ['management_process_store_roundtrip'] }) evidenceScope: string;
  @ApiProperty({ enum: ['single_lease_holder'] }) coverage: string;
  @ApiProperty({ example: false }) businessServerLivenessEvaluated: boolean;
  @ApiProperty({ enum: ['unknown', 'reporting', 'stopped'] }) reportedState: string;
  @ApiProperty({ enum: ['unknown', 'recent', 'stale'] }) freshnessStatus: string;
  @ApiProperty({ type: String, nullable: true }) processInstanceId: string | null;
  @ApiProperty({ type: String, nullable: true }) lastHeartbeatAt: string | null;
  @ApiProperty({ type: String, nullable: true }) stoppedAt: string | null;
  @ApiProperty({ type: Number, nullable: true }) observationAgeMs: number | null;
  @ApiProperty({ type: Number, nullable: true }) intervalMs: number | null;
  @ApiProperty({ type: Number, nullable: true }) staleAfterMs: number | null;
  @ApiProperty({ type: Number, nullable: true }) stateVersion: number | null;
  @ApiProperty({ type: String, nullable: true }) dataWatermark: string | null;
}
export function managementHeartbeatView(row: RuntimePipelineStateEntity | null, now: number, snapshotSeq?: string): ObservabilityManagementHeartbeatDto {
  const value = row?.value;
  const unknown: ObservabilityManagementHeartbeatDto = { evidenceScope: 'management_process_store_roundtrip',
    coverage: 'single_lease_holder', businessServerLivenessEvaluated: false, reportedState: 'unknown', freshnessStatus: 'unknown',
    processInstanceId: null, lastHeartbeatAt: null, stoppedAt: null, observationAgeMs: null, intervalMs: null,
    staleAfterMs: null, stateVersion: null, dataWatermark: null };
  const time = (text: unknown): number => typeof text === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)
    && Number.isFinite(Date.parse(text)) && new Date(text).toISOString() === text ? Date.parse(text) : NaN;
  if (!value || value.evidenceScope !== unknown.evidenceScope || !['reporting', 'stopped'].includes(value.state) ||
    typeof value.processInstanceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.processInstanceId) ||
    !Number.isSafeInteger(value.intervalMs) || value.intervalMs < 1000 || value.intervalMs > 60000 ||
    value.staleAfterMs !== value.intervalMs * 3 || !Number.isSafeInteger(value.stateVersion) || value.stateVersion < 1 ||
    value.stateVersion > 2147483647 || typeof value.snapshotSeq !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value.snapshotSeq) ||
    (snapshotSeq !== undefined && (/^(0|[1-9][0-9]{0,19})$/.test(snapshotSeq) === false || BigInt(value.snapshotSeq) > BigInt(snapshotSeq))) ||
    !Number.isFinite(time(value.lastHeartbeatAt)) || time(value.lastHeartbeatAt) > now ||
    !Number.isFinite(time(row.updatedAt)) || time(row.updatedAt) > now || time(value.lastHeartbeatAt) > time(row.updatedAt) ||
    (value.state === 'stopped' && (!Number.isFinite(time(value.stoppedAt)) || time(value.stoppedAt) > now ||
      time(value.stoppedAt) < time(value.lastHeartbeatAt) || time(value.stoppedAt) > time(row.updatedAt)))) return unknown;
  const age = now - time(value.lastHeartbeatAt);
  return { ...unknown, reportedState: value.state, processInstanceId: value.processInstanceId,
    lastHeartbeatAt: value.lastHeartbeatAt, stoppedAt: value.state === 'stopped' ? value.stoppedAt : null,
    observationAgeMs: age, intervalMs: value.intervalMs, staleAfterMs: value.staleAfterMs,
    stateVersion: value.stateVersion, dataWatermark: value.snapshotSeq,
    freshnessStatus: age >= value.staleAfterMs ? 'stale' : 'recent' };
}
