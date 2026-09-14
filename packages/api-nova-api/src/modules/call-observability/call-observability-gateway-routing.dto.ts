import { ApiProperty } from '@nestjs/swagger';
import { RuntimePipelineStateEntity } from '../../database/entities/runtime-call-observability.entity';
import { managementHeartbeatView } from './call-observability-heartbeat.dto';
export const GATEWAY_ROUTING_OBSERVER_ID = 'call-observability:gateway-routing-observer';
export const GATEWAY_ROUTING_OBSERVATION_PREFIX = 'call-observability:gateway-routing:';
export class ObservabilityGatewayRoutingDto {
  @ApiProperty({ enum: ['local_process_routing_registry'] }) evidenceScope: string;
  @ApiProperty({ enum: ['single_lease_holder_process'] }) coverage: string;
  @ApiProperty({ example: true }) isPartial: boolean;
  @ApiProperty({ example: false }) businessServerLivenessEvaluated: boolean;
  @ApiProperty({ enum: ['registered', 'no_registered_routes', 'unknown'] }) registrationStatus: string;
  @ApiProperty({ enum: ['reporting', 'stopped', 'unknown'] }) observerState: string;
  @ApiProperty({ enum: ['recent', 'stale', 'unknown'] }) freshnessStatus: string;
  @ApiProperty({ type: Number, nullable: true }) activeRouteCount: number | null;
  @ApiProperty({ type: String, nullable: true }) processInstanceId: string | null;
  @ApiProperty({ type: String, nullable: true }) observedAt: string | null;
  @ApiProperty({ type: String, nullable: true }) stoppedAt: string | null;
  @ApiProperty({ type: Number, nullable: true }) observationAgeMs: number | null;
  @ApiProperty({ type: Number, nullable: true }) stateVersion: number | null;
  @ApiProperty({ type: String, nullable: true }) dataWatermark: string | null;
}
export function gatewayRoutingView(row: RuntimePipelineStateEntity | null, assetId: string,
  now: number, snapshotSeq: string): ObservabilityGatewayRoutingDto {
  const unknown: ObservabilityGatewayRoutingDto = { evidenceScope: 'local_process_routing_registry', coverage: 'single_lease_holder_process',
    isPartial: true, businessServerLivenessEvaluated: false, registrationStatus: 'unknown', observerState: 'unknown', freshnessStatus: 'unknown',
    activeRouteCount: null, processInstanceId: null, observedAt: null, stoppedAt: null, observationAgeMs: null, stateVersion: null, dataWatermark: null };
  const value = row?.value;
  if (!value || value.runtimeAssetId !== assetId || value.evidenceScope !== unknown.evidenceScope ||
    !Number.isSafeInteger(value.activeRouteCount) || value.activeRouteCount < 0 || value.activeRouteCount > 10000) return unknown;
  const heartbeat = managementHeartbeatView({ ...row, value: { ...value, evidenceScope: 'management_process_store_roundtrip' } } as RuntimePipelineStateEntity, now, snapshotSeq);
  if (heartbeat.reportedState === 'unknown') return unknown;
  return { ...unknown, registrationStatus: value.activeRouteCount > 0 ? 'registered' : 'no_registered_routes',
    observerState: heartbeat.reportedState, freshnessStatus: heartbeat.freshnessStatus, activeRouteCount: value.activeRouteCount,
    processInstanceId: heartbeat.processInstanceId, observedAt: heartbeat.lastHeartbeatAt, stoppedAt: heartbeat.stoppedAt,
    observationAgeMs: heartbeat.observationAgeMs, stateVersion: heartbeat.stateVersion, dataWatermark: heartbeat.dataWatermark };
}
