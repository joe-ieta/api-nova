import { DataSource, DataSourceOptions } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { MCPServerEntity } from './entities/mcp-server.entity';
import { AuthConfigEntity } from './entities/auth-config.entity';
import { TestCaseEntity } from './entities/test-case.entity';
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
import { EndpointPublishBindingEntity } from './entities/endpoint-publish-binding.entity';
import { GatewayRouteBindingEntity } from './entities/gateway-route-binding.entity';
import { RuntimeMetricSeriesEntity } from './entities/runtime-metric-series.entity';
import { RuntimeObservabilityEventEntity } from './entities/runtime-observability-event.entity';
import { RuntimeObservabilityStateEntity } from './entities/runtime-observability-state.entity';
import { AiAssistantTemplateEntity } from '../modules/ai-assistant/entities/ai-assistant-template.entity';
import { AiAssistantConfigEntity } from '../modules/ai-assistant/entities/ai-assistant-config.entity';
import { verifySqliteDatabasePath, getDatabaseType } from './db-compat';

const entities = [
  MCPServerEntity,
  AuthConfigEntity,
  TestCaseEntity,
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
  EndpointPublishBindingEntity,
  GatewayRouteBindingEntity,
  RuntimeObservabilityEventEntity,
  RuntimeMetricSeriesEntity,
  RuntimeObservabilityStateEntity,
  AiAssistantTemplateEntity,
  AiAssistantConfigEntity,
];

function buildDataSourceOptions(
  configService?: ConfigService,
): DataSourceOptions {
  const read = <T>(key: string, fallback: T): T => {
    if (configService) {
      return configService.get<T>(key, fallback);
    }

    const raw = process.env[key];
    if (raw === undefined) {
      return fallback;
    }

    if (typeof fallback === 'boolean') {
      return ((raw === 'true') as T);
    }

    if (typeof fallback === 'number') {
      return (Number(raw) as T);
    }

    return raw as T;
  };

  const dbType = getDatabaseType(read<string>('DB_TYPE', 'sqlite'));
  const nodeEnv = String(read<string>('NODE_ENV', 'development'));

  if (dbType === 'sqlite') {
    return {
      type: 'sqljs',
      location: verifySqliteDatabasePath(configService),
      autoSave: true,
      entities,
      migrations: ['dist/database/migrations/*.js'],
      synchronize: read<boolean>('DB_SYNCHRONIZE', nodeEnv !== 'production'),
      logging: read<boolean>('DB_LOGGING', false),
    };
  }

  return {
    type: 'postgres',
    host: read('DB_HOST', 'localhost'),
    port: Number(read('DB_PORT', 5432)),
    username: read('DB_USERNAME', 'postgres'),
    password: read('DB_PASSWORD', 'password'),
    database: String(read('DB_DATABASE', 'api_nova_api')),
    entities,
    migrations: ['dist/database/migrations/*.js'],
    synchronize: read<boolean>('DB_SYNCHRONIZE', nodeEnv === 'development'),
    logging: read<boolean>('DB_LOGGING', false),
    ssl: nodeEnv === 'production' ? { rejectUnauthorized: false } : false,
  };
}

export const AppDataSource = new DataSource(buildDataSourceOptions());

export const createDataSource = (configService: ConfigService): DataSource => {
  return new DataSource(buildDataSourceOptions(configService));
};
