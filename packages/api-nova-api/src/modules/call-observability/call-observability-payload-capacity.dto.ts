import { ApiProperty } from '@nestjs/swagger';
import { RuntimePipelineStateEntity } from '../../database/entities/runtime-call-observability.entity';
export class ObservabilityPayloadCapacityDto {
  @ApiProperty({ enum: ['retention_worker_payload_scan'] }) evidenceSource: string;
  @ApiProperty({ enum: ['recognized_payload_objects_and_temporary_files'] }) scope: string;
  @ApiProperty({ enum: ['logical_file_length_before_cleanup'] }) measurement: string;
  @ApiProperty({ enum: ['complete', 'partial', 'unknown'], description: 'Single scan coverage only; never an atomic whole-disk snapshot.' }) scanCoverage: string;
  @ApiProperty({ enum: ['recent', 'stale', 'unknown'] }) freshnessStatus: string;
  @ApiProperty({ type: String, nullable: true }) scanStartedAt: string | null;
  @ApiProperty({ type: String, nullable: true }) scanCompletedAt: string | null;
  @ApiProperty({ type: Number, nullable: true }) observationAgeMs: number | null;
  @ApiProperty() staleAfterMs: number;
  @ApiProperty({ type: Number, nullable: true, description: 'Logical lengths measured in this scan batch before any cleanup; excludes filesystem allocation overhead.' }) observedBytes: number | null;
  @ApiProperty({ type: Number, nullable: true }) observedFiles: number | null;
  @ApiProperty({ type: Number, nullable: true }) scannedEntries: number | null;
  @ApiProperty({ type: Number, nullable: true }) traversedShards: number | null;
  @ApiProperty({ type: Number, nullable: true }) missingShards: number | null;
  @ApiProperty({ type: Number, nullable: true }) unmeasuredEntries: number | null;
  @ApiProperty({ type: Boolean, nullable: true }) truncated: boolean | null;
  @ApiProperty({ type: Boolean, nullable: true }) startedAtShardBoundary: boolean | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Unknown; scan samples are never a current filesystem total.' }) currentTotalBytes: null;
  @ApiProperty({ type: Number, nullable: true }) filesystemAvailableBytes: null;
  @ApiProperty({ example: false }) quotaEnforced: boolean;
}
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const time = (value: unknown): number => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? Date.parse(value) : NaN;
export function payloadCapacityView(row: RuntimePipelineStateEntity | null, now: number): ObservabilityPayloadCapacityDto {
  const value = object(row?.value) ? row.value : null;
  const interval = count(value?.intervalMs, 86400000) && value.intervalMs >= 1000 ? value.intervalMs : 0;
  const unknown: ObservabilityPayloadCapacityDto = { evidenceSource: 'retention_worker_payload_scan',
    scope: 'recognized_payload_objects_and_temporary_files', measurement: 'logical_file_length_before_cleanup',
    scanCoverage: 'unknown', freshnessStatus: 'unknown', scanStartedAt: null, scanCompletedAt: null, observationAgeMs: null,
    staleAfterMs: Math.max(15000, interval * 2), observedBytes: null, observedFiles: null, scannedEntries: null,
    missingShards: null, traversedShards: null, unmeasuredEntries: null, truncated: null, startedAtShardBoundary: null,
    currentTotalBytes: null, filesystemAvailableBytes: null, quotaEnforced: false };
  const report = object(value?.lastReport) ? value.lastReport : null;
  const scan = object(report?.scanUsage) ? report.scanUsage : null;
  if (value?.currentAttemptComplete !== true || report?.status !== 'completed' || !scan ||
    scan.measurement !== unknown.measurement || !['complete', 'partial'].includes(scan.scanCoverage) ||
    !count(scan.observedBytes) || !count(scan.observedFiles, 1000) || !count(scan.scannedEntries, 1000) ||
    !count(scan.traversedShards, 256) || !count(scan.missingShards, 256) || scan.missingShards > scan.traversedShards || !count(scan.unmeasuredEntries, 1000) ||
    scan.observedFiles + scan.unmeasuredEntries !== scan.scannedEntries ||
    (scan.observedFiles === 0 && scan.observedBytes !== 0) || typeof scan.truncated !== 'boolean' || typeof scan.startedAtShardBoundary !== 'boolean' ||
    !Number.isFinite(time(scan.scanStartedAt)) || !Number.isFinite(time(scan.scanCompletedAt)) ||
    !Number.isFinite(time(value.lastReportAt)) || !Number.isFinite(time(row.updatedAt)) ||
    time(scan.scanStartedAt) > time(scan.scanCompletedAt) || time(scan.scanCompletedAt) > time(value.lastReportAt) ||
    time(value.lastReportAt) > time(row.updatedAt) || time(row.updatedAt) > now ||
    (scan.scanCoverage === 'complete' && (scan.traversedShards !== 256 || scan.truncated || !scan.startedAtShardBoundary || scan.missingShards !== 0 || scan.unmeasuredEntries !== 0))) return unknown;
  const age = now - time(scan.scanCompletedAt);
  return { ...unknown, scanCoverage: scan.scanCoverage, freshnessStatus: age > unknown.staleAfterMs ? 'stale' : 'recent',
    scanStartedAt: scan.scanStartedAt, scanCompletedAt: scan.scanCompletedAt, observationAgeMs: age,
    observedBytes: scan.observedBytes, observedFiles: scan.observedFiles, scannedEntries: scan.scannedEntries,
    missingShards: scan.missingShards, traversedShards: scan.traversedShards, unmeasuredEntries: scan.unmeasuredEntries, truncated: scan.truncated,
    startedAtShardBoundary: scan.startedAtShardBoundary };
}
