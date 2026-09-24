import type { CallObservabilityServerStateSnapshotAuthorizer } from './call-observability-server-state-snapshot-authorizer.service';
import { ObservabilityGatewayRoutingDto } from './call-observability-gateway-routing.dto';
import { ObservabilityManagementHeartbeatDto } from './call-observability-heartbeat.dto';
import { ApiProperty } from '@nestjs/swagger';
import { ObservabilityMetaDto } from './call-observability-api.contract';
import { ObservabilityOverviewWindowDto } from './call-observability-overview-query';

export class ObservabilityReportedStateDto {
  @ApiProperty({ enum: ['runtime_observability_states'] }) source: string;
  @ApiProperty({ description: 'Last persisted report, not a current process-liveness assertion.' }) lifecycleStatus: string;
  @ApiProperty({ description: 'Historical reported health; no freshness or heartbeat guarantee.' }) healthStatus: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) updatedAt: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) lastEventAt: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) lastSuccessAt: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) lastFailureAt: string | null;
}
export class ObservabilityManagedProcessLifecycleDto {
  @ApiProperty({ enum: ['managed_server_process_lifecycle'] }) evidenceScope: string;
  @ApiProperty({ example: false, description: 'A durable host event observation, not a continuous business-process heartbeat.' }) businessProcessLivenessEvaluated: boolean;
  @ApiProperty() runtimeAssetId: string;
  @ApiProperty() serverId: string;
  @ApiProperty({ description: 'Opaque identity for one managed child-process generation.' }) generation: string;
  @ApiProperty() pid: number;
  @ApiProperty({ enum: ['started', 'stopped', 'unexpected_exit', 'lost'] }) observedEvent: string;
  @ApiProperty({ format: 'date-time' }) startedAt: string;
  @ApiProperty({ format: 'date-time' }) observedAt: string;
  @ApiProperty({ type: Number, nullable: true }) exitCode: number | null;
  @ApiProperty({ type: String, nullable: true }) signal: string | null;
  @ApiProperty({ type: String, nullable: true }) error: string | null;
  @ApiProperty() stateVersion: number;
}

export class ObservabilityPersistedInFlightDto {
  @ApiProperty({ enum: ['runtime_invocation_revisions'] }) source: string;
  @ApiProperty({ enum: ['observed', 'unknown', 'unavailable'] }) status: string;
  @ApiProperty({ type: Number, nullable: true, description: 'Retained started, unfinished business facts at snapshotSeq across all start times. Not verified live requests; zero never establishes no traffic.' }) count: number | null;
  @ApiProperty({ type: String, nullable: true }) reason: string | null;
  @ApiProperty() dataWatermark: string;
  @ApiProperty() origin: string;
  @ApiProperty({ enum: ['all_retained_starts'] }) timeScope: string;
  @ApiProperty({ example: false }) livenessEvaluated: boolean;
  @ApiProperty({ enum: ['unknown'] }) coverage: string;
}
export class ObservabilityManagedLifecycleHistoryDto {
  @ApiProperty({ enum: ['runtime_pipeline_states'] }) source: string;
  @ApiProperty({ enum: ['observed', 'unknown', 'unavailable'] }) status: string;
  @ApiProperty({ enum: ['latest_generation_only'] }) scope: string;
  @ApiProperty({ type: String, nullable: true }) reason: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Null: managed lifecycle evidence does not share the invocation sequence.' }) dataWatermark: string | null;
  @ApiProperty({ type: String, nullable: true }) generation: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) startedAt: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) terminalAt: string | null;
  @ApiProperty({ type: String, nullable: true }) terminalEvent: string | null;
  @ApiProperty({ example: false }) historyComplete: boolean;
}
export class ObservabilityServerStatusDto {
  @ApiProperty({ type: ObservabilityPersistedInFlightDto }) persistedInFlight: ObservabilityPersistedInFlightDto;
  @ApiProperty({ type: ObservabilityManagedLifecycleHistoryDto }) managedLifecycleHistory: ObservabilityManagedLifecycleHistoryDto;
  @ApiProperty({ type: ObservabilityManagedProcessLifecycleDto, nullable: true, description: 'Last durable managed-child event for this asset; absence or started does not prove current liveness.' }) managedProcessLifecycle: ObservabilityManagedProcessLifecycleDto | null;
  @ApiProperty({ type: ObservabilityGatewayRoutingDto, nullable: true, description: 'This observer process registry only; not listener, dependency or whole-cluster health.' }) gatewayRoutingObservation: ObservabilityGatewayRoutingDto | null;
  @ApiProperty() runtimeAssetId: string;
  @ApiProperty({ enum: ['gateway', 'mcp'] }) serverType: string;
  @ApiProperty({ description: 'Persisted runtime_assets status, not a process heartbeat.' }) lifecycleStatus: string;
  @ApiProperty({ enum: ['runtime_assets'] }) lifecycleSource: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) lifecycleUpdatedAt: string | null;
  @ApiProperty({ enum: ['unknown'] }) healthStatus: string;
  @ApiProperty({ enum: ['unknown'] }) dependencyHealth: string;
  @ApiProperty({ enum: ['unknown'] }) freshnessStatus: string;
  @ApiProperty({ type: String, nullable: true, description: 'Unknown: legacy state updates are not heartbeats.' }) lastHeartbeatAt: string | null;
  @ApiProperty({ type: String, nullable: true }) processInstanceId: string | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Unknown until producer liveness is verified.' }) activeInvocations: number | null;
  @ApiProperty({ description: 'Unfinished business invocations observed within the selected start window; not all active requests.' }) unknownInFlight: number;
  @ApiProperty({ description: 'Observed business invocations in the selected window; zero does not prove no traffic.' }) observedBusinessRequests: number;
  @ApiProperty({ enum: ['observed', 'not_observed'], description: 'Selected retained business evidence only; not_observed does not mean idle or offline.' }) businessObservationStatus: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time', description: 'Latest observed business success completion among selected starts.' }) lastSuccessAt: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time', description: 'Latest observed error/timeout/incomplete completion among selected business starts.' }) lastFailureAt: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Unknown: legacy state has no version tied to the call-event sequence.' }) stateVersion: string | null;
  @ApiProperty({ type: ObservabilityReportedStateDto, nullable: true }) reportedState: ObservabilityReportedStateDto | null;
}
export class ObservabilityServerCoverageDto {
  @ApiProperty({ enum: ['authorized_assets_and_selected_business_invocations'] }) scope: string;
  @ApiProperty({ description: 'Number of authorized server assets matching the asset and serverType filters.' }) registeredServers: number;
  @ApiProperty({ description: 'Registered servers with matching asset ID and serverType in the selected retained business facts.' }) serversWithBusinessObservations: number;
  @ApiProperty({ description: 'Registered servers with a persisted asset-scope report; reports need not be recent or valid heartbeats.' }) serversWithReportedState: number;
  @ApiProperty({ description: 'Distinct observed (asset ID, serverType) pairs absent from the matching authorized server directory, including type mismatches. No resource identifiers are exposed.' }) unrepresentedBusinessServers: number;
  @ApiProperty({ description: 'Selected business invocations without an asset ID. Visible only when permitted by the invocation query scope.' }) unattributedBusinessInvocations: number;
  @ApiProperty({ type: String, nullable: true, description: 'Unknown: retained invocation facts cannot establish complete historical collection.' }) historyCompleteSince: string | null;
  @ApiProperty({ type: [String], description: 'Evidence gaps within the authorized selection. No hidden asset counts or global pipeline state.' }) gaps: string[];
  @ApiProperty() isPartial: boolean;
}
export class ObservabilityServerStatusesDto {
  @ApiProperty({ nullable: true, type: Object, description: 'Process-local server_state_v1 read grant for durable lifecycle and retained in-flight evidence only; excludes directory, legacy state and heartbeat. Not a completeness or global liveness claim.' })
  serverStateSnapshot: ReturnType<CallObservabilityServerStateSnapshotAuthorizer['issue']> | null;
  @ApiProperty({ type: ObservabilityManagementHeartbeatDto, nullable: true, description: 'Global-scope only; management process store roundtrip evidence, never Gateway/MCP liveness.' }) managementHeartbeat: ObservabilityManagementHeartbeatDto | null;
  @ApiProperty({ type: ObservabilityServerCoverageDto }) coverage: ObservabilityServerCoverageDto;
  @ApiProperty({ type: ObservabilityOverviewWindowDto }) window: ObservabilityOverviewWindowDto;
  @ApiProperty({ type: [ObservabilityServerStatusDto] }) items: ObservabilityServerStatusDto[];
  @ApiProperty() maxServers: number;
  @ApiProperty() maxQueryInvocations: number;
  @ApiProperty() maxStateRows: number;
  @ApiProperty({ enum: ['current_database_snapshot'] }) stateBasis: string;
  @ApiProperty({ type: String, nullable: true, description: 'Null: current asset and legacy state updates do not advance the invocation sequence.' }) dataWatermark: string | null;
  @ApiProperty({ description: 'Watermark for invocation-derived counts only.' }) invocationDataWatermark: string;
  @ApiProperty({ format: 'date-time' }) readAt: string;
  @ApiProperty() livenessEvaluated: boolean;
  @ApiProperty() isPartial: boolean;
  @ApiProperty({ description: 'True for asset-scoped grants; never reports hidden asset counts.' }) restricted: boolean;
}
export class ObservabilityServerStatusesEnvelopeDto {
  @ApiProperty({ enum: ['success'] }) status: string;
  @ApiProperty({ type: ObservabilityServerStatusesDto }) data: ObservabilityServerStatusesDto;
  @ApiProperty({ type: ObservabilityMetaDto }) meta: ObservabilityMetaDto;
}
