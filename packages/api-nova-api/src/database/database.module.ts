import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import {
  getDatabaseType,
  verifySqliteDatabasePath,
} from './db-compat';
import { MCPServerEntity } from './entities/mcp-server.entity';
import { AuthConfigEntity } from './entities/auth-config.entity';
import { LogEntryEntity } from './entities/log-entry.entity';
import { User } from './entities/user.entity';
import { Role } from './entities/role.entity';
import { Permission } from './entities/permission.entity';
import { AuditLog } from './entities/audit-log.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { SystemLogEntity } from './entities/system-log.entity';
import { AiAssistantTemplateEntity } from '../modules/ai-assistant/entities/ai-assistant-template.entity';
import { AiAssistantConfigEntity } from '../modules/ai-assistant/entities/ai-assistant-config.entity';
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
import { ConfigOverrideEntity } from './entities/config-override.entity';
import { ConfigBackupEntity } from './entities/config-backup.entity';
import { SourceServiceInstanceEntity } from './entities/source-service-instance.entity';
import { EndpointTestCaseEntity } from './entities/endpoint-test-case.entity';
import { EndpointTestRunEntity } from './entities/endpoint-test-run.entity';
import { EndpointTestSampleEntity } from './entities/endpoint-test-sample.entity';
import { RuntimeUpstreamBindingEntity } from './entities/runtime-upstream-binding.entity';
import { RuntimeUpstreamBindingInstanceEntity } from './entities/runtime-upstream-binding-instance.entity';
import { RuntimeVerificationRunEntity } from './entities/runtime-verification-run.entity';
import { RuntimeVerificationResultEntity } from './entities/runtime-verification-result.entity';
import { SeedService } from './seed.service';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService): TypeOrmModuleOptions => {
        const dbType = getDatabaseType(configService.get<string>('DB_TYPE'));
        const nodeEnv = String(configService.get<string>('NODE_ENV', 'development'));
        const sslEnabled = configService.get<boolean>(
          'DB_SSL',
          nodeEnv === 'production',
        );
        const sslRejectUnauthorized = configService.get<boolean>(
          'DB_SSL_REJECT_UNAUTHORIZED',
          false,
        );
        const entities = [
          MCPServerEntity,
          AuthConfigEntity,
          LogEntryEntity,
          User,
          Role,
          Permission,
          AuditLog,
          RefreshToken,
          SystemLogEntity,
          AiAssistantTemplateEntity,
          AiAssistantConfigEntity,
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
          ConfigOverrideEntity,
          ConfigBackupEntity,
          SourceServiceInstanceEntity,
          EndpointTestCaseEntity,
          EndpointTestRunEntity,
          EndpointTestSampleEntity,
          RuntimeUpstreamBindingEntity,
          RuntimeUpstreamBindingInstanceEntity,
          RuntimeVerificationRunEntity,
          RuntimeVerificationResultEntity,
        ];

        if (dbType === 'sqlite') {
          const sqlitePath = verifySqliteDatabasePath(configService);

          return {
            type: 'sqljs' as const,
            location: sqlitePath,
            autoSave: true,
            entities,
            synchronize: configService.get(
              'DB_SYNCHRONIZE',
              nodeEnv !== 'production',
            ),
            logging: configService.get('DB_LOGGING', false),
            autoLoadEntities: true,
            keepConnectionAlive: true,
          };
        }

        return {
          type: 'postgres' as const,
          host: configService.get('DB_HOST', 'localhost'),
          port: configService.get('DB_PORT', 5432),
          username: configService.get('DB_USERNAME', 'postgres'),
          password: configService.get('DB_PASSWORD', 'password'),
          database: String(configService.get('DB_DATABASE', 'api_nova_api')),
          entities,
          synchronize: configService.get(
            'DB_SYNCHRONIZE',
            nodeEnv === 'development',
          ),
          logging: configService.get('DB_LOGGING', false),
          ssl: sslEnabled ? { rejectUnauthorized: sslRejectUnauthorized } : false,
          retryAttempts: 3,
          retryDelay:9000,
          autoLoadEntities: true,
          keepConnectionAlive: true,
        };
      },
      inject: [ConfigService],
    }),
    
    // 导出实体模块供其他模块使用
    TypeOrmModule.forFeature([
      MCPServerEntity,
      AuthConfigEntity,
      LogEntryEntity,
      User,
      Role,
      Permission,
      AuditLog,
      RefreshToken,
      SystemLogEntity,
      AiAssistantTemplateEntity,
      AiAssistantConfigEntity,
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
      GatewayAccessLogEntity,
      GatewayConsumerCredentialEntity,
      RuntimeObservabilityEventEntity,
      RuntimeMetricSeriesEntity,
      RuntimeObservabilityStateEntity,
      ConfigOverrideEntity,
      ConfigBackupEntity,
      SourceServiceInstanceEntity,
      EndpointTestCaseEntity,
      EndpointTestRunEntity,
      EndpointTestSampleEntity,
      RuntimeUpstreamBindingEntity,
      RuntimeUpstreamBindingInstanceEntity,
      RuntimeVerificationRunEntity,
      RuntimeVerificationResultEntity,
    ]),
  ],
  providers: [
    SeedService,
  ],
  exports: [
    TypeOrmModule,
    SeedService,
  ],
})
export class DatabaseModule {}
