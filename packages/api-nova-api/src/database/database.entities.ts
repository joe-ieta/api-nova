import { ConfigOverrideEntity } from './entities/config-override.entity';
import { ConfigBackupEntity } from './entities/config-backup.entity';
import { MCPServerEntity } from './entities/mcp-server.entity';
import { AuthConfigEntity } from './entities/auth-config.entity';
import { LogEntryEntity } from './entities/log-entry.entity';
import { User } from './entities/user.entity';
import { Role } from './entities/role.entity';
import { Permission } from './entities/permission.entity';
import { AuditLog } from './entities/audit-log.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { SystemLogEntity } from './entities/system-log.entity';
import { OpenAPIDocument } from './entities/openapi-document.entity';
import { SourceServiceAssetEntity } from './entities/source-service-asset.entity';
import { EndpointDefinitionEntity } from './entities/endpoint-definition.entity';
import { RuntimeAssetEntity } from './entities/runtime-asset.entity';
import { RuntimeAssetEndpointBindingEntity } from './entities/runtime-asset-endpoint-binding.entity';
import { PublicationProfileEntity } from './entities/publication-profile.entity';
import { PublicationProfileHistoryEntity } from './entities/publication-profile-history.entity';
import { PublicationBatchRunEntity } from './entities/publication-batch-run.entity';
import { PublicationAuditEventEntity } from './entities/publication-audit-event.entity';
import { EndpointPublishBindingEntity } from './entities/endpoint-publish-binding.entity';
import { GatewayRouteBindingEntity } from './entities/gateway-route-binding.entity';
import { GatewayRouteSnapshotEntity } from './entities/gateway-route-snapshot.entity';
import { GatewayAccessLogEntity } from './entities/gateway-access-log.entity';
import { GatewayConsumerCredentialEntity } from './entities/gateway-consumer-credential.entity';
import { RuntimeMetricSeriesEntity } from './entities/runtime-metric-series.entity';
import { RuntimeObservabilityEventEntity } from './entities/runtime-observability-event.entity';
import { RuntimeObservabilityStateEntity } from './entities/runtime-observability-state.entity';
import { AiAssistantTemplateEntity } from '../modules/ai-assistant/entities/ai-assistant-template.entity';
import { AiAssistantConfigEntity } from '../modules/ai-assistant/entities/ai-assistant-config.entity';
import { SourceServiceInstanceEntity } from './entities/source-service-instance.entity';
import { EndpointTestCaseEntity } from './entities/endpoint-test-case.entity';
import { EndpointTestRunEntity } from './entities/endpoint-test-run.entity';
import { EndpointTestSampleEntity } from './entities/endpoint-test-sample.entity';
import { RuntimeUpstreamBindingEntity } from './entities/runtime-upstream-binding.entity';
import { RuntimeUpstreamBindingInstanceEntity } from './entities/runtime-upstream-binding-instance.entity';
import { RuntimeVerificationRunEntity } from './entities/runtime-verification-run.entity';
import { RuntimeVerificationResultEntity } from './entities/runtime-verification-result.entity';
import { ProcessInfoEntity } from '../modules/servers/entities/process-info.entity';
import { ProcessLogEntity } from '../modules/servers/entities/process-log.entity';
import { HealthCheckResultEntity } from '../modules/servers/entities/health-check-result.entity';

export const DATABASE_ENTITIES = [
  ConfigOverrideEntity,
  ConfigBackupEntity,
  MCPServerEntity,
  AuthConfigEntity,
  LogEntryEntity,
  User,
  Role,
  Permission,
  AuditLog,
  RefreshToken,
  SystemLogEntity,
  OpenAPIDocument,
  SourceServiceAssetEntity,
  EndpointDefinitionEntity,
  RuntimeAssetEntity,
  RuntimeAssetEndpointBindingEntity,
  PublicationProfileEntity,
  PublicationProfileHistoryEntity,
  PublicationBatchRunEntity,
  PublicationAuditEventEntity,
  EndpointPublishBindingEntity,
  GatewayRouteBindingEntity,
  GatewayRouteSnapshotEntity,
  GatewayAccessLogEntity,
  GatewayConsumerCredentialEntity,
  RuntimeObservabilityEventEntity,
  RuntimeMetricSeriesEntity,
  RuntimeObservabilityStateEntity,
  AiAssistantTemplateEntity,
  AiAssistantConfigEntity,
  SourceServiceInstanceEntity,
  EndpointTestCaseEntity,
  EndpointTestRunEntity,
  EndpointTestSampleEntity,
  RuntimeUpstreamBindingEntity,
  RuntimeUpstreamBindingInstanceEntity,
  RuntimeVerificationRunEntity,
  RuntimeVerificationResultEntity,
  ProcessInfoEntity,
  ProcessLogEntity,
  HealthCheckResultEntity,
];
