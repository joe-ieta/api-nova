import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ConfigFieldMetadataDto {
  @ApiProperty({
    description: 'Where the effective value comes from',
    enum: ['env', 'override', 'derived'],
  })
  source: 'env' | 'override' | 'derived';

  @ApiProperty({
    description: 'Whether changing the underlying value requires a restart',
  })
  restartRequired: boolean;

  @ApiProperty({
    description: 'Sensitivity level of the underlying configuration value',
    enum: ['public', 'sensitive'],
  })
  sensitivity: 'public' | 'sensitive';

  @ApiProperty({
    description: 'Human-readable explanation of the configuration field',
  })
  description: string;

  @ApiProperty({
    description: 'Whether the field is editable in the configuration center',
  })
  editable: boolean;
}

export class AppConfigSectionDto {
  @ApiProperty()
  nodeEnv: string;

  @ApiProperty()
  port: number;

  @ApiProperty()
  mcpPort: number;
}

export class AppConfigSectionMetadataDto {
  @ApiProperty({ type: ConfigFieldMetadataDto })
  nodeEnv: ConfigFieldMetadataDto;

  @ApiProperty({ type: ConfigFieldMetadataDto })
  port: ConfigFieldMetadataDto;

  @ApiProperty({ type: ConfigFieldMetadataDto })
  mcpPort: ConfigFieldMetadataDto;
}

export class CorsConfigSectionDto {
  @ApiProperty({ type: [String] })
  origins: string[];
}

export class CorsConfigSectionMetadataDto {
  @ApiProperty({ type: ConfigFieldMetadataDto })
  origins: ConfigFieldMetadataDto;
}

export class ThrottleConfigSectionDto {
  @ApiProperty()
  ttlSeconds: number;

  @ApiProperty()
  limit: number;
}

export class ThrottleConfigSectionMetadataDto {
  @ApiProperty({ type: ConfigFieldMetadataDto })
  ttlSeconds: ConfigFieldMetadataDto;

  @ApiProperty({ type: ConfigFieldMetadataDto })
  limit: ConfigFieldMetadataDto;
}

export class SecurityConfigSectionDto {
  @ApiProperty()
  jwtEnabled: boolean;

  @ApiProperty()
  refreshTokenEnabled: boolean;

  @ApiProperty()
  accessTokenExpiresIn: string;
}

export class SecurityConfigSectionMetadataDto {
  @ApiProperty({ type: ConfigFieldMetadataDto })
  jwtEnabled: ConfigFieldMetadataDto;

  @ApiProperty({ type: ConfigFieldMetadataDto })
  refreshTokenEnabled: ConfigFieldMetadataDto;

  @ApiProperty({ type: ConfigFieldMetadataDto })
  accessTokenExpiresIn: ConfigFieldMetadataDto;
}

export class LoggingConfigSectionDto {
  @ApiProperty()
  level: string;

  @ApiProperty()
  format: string;

  @ApiProperty()
  logDirectory: string;
}

export class LoggingConfigSectionMetadataDto {
  @ApiProperty({ type: ConfigFieldMetadataDto })
  level: ConfigFieldMetadataDto;

  @ApiProperty({ type: ConfigFieldMetadataDto })
  format: ConfigFieldMetadataDto;

  @ApiProperty({ type: ConfigFieldMetadataDto })
  logDirectory: ConfigFieldMetadataDto;
}

export class PerformanceConfigSectionDto {
  @ApiProperty()
  requestTimeout: number;

  @ApiProperty()
  cacheTtl: number;

  @ApiProperty()
  maxPayloadSize: string;
}

export class PerformanceConfigSectionMetadataDto {
  @ApiProperty({ type: ConfigFieldMetadataDto })
  requestTimeout: ConfigFieldMetadataDto;

  @ApiProperty({ type: ConfigFieldMetadataDto })
  cacheTtl: ConfigFieldMetadataDto;

  @ApiProperty({ type: ConfigFieldMetadataDto })
  maxPayloadSize: ConfigFieldMetadataDto;
}

export class ProcessConfigSectionDto {
  @ApiProperty()
  timeout: number;

  @ApiProperty()
  maxRetries: number;

  @ApiProperty()
  restartDelay: number;

  @ApiProperty()
  pidDirectory: string;
}

export class ProcessConfigSectionMetadataDto {
  @ApiProperty({ type: ConfigFieldMetadataDto })
  timeout: ConfigFieldMetadataDto;

  @ApiProperty({ type: ConfigFieldMetadataDto })
  maxRetries: ConfigFieldMetadataDto;

  @ApiProperty({ type: ConfigFieldMetadataDto })
  restartDelay: ConfigFieldMetadataDto;

  @ApiProperty({ type: ConfigFieldMetadataDto })
  pidDirectory: ConfigFieldMetadataDto;
}

export class RuntimeConfigSectionDto {
  @ApiPropertyOptional()
  apiBaseUrl?: string;
}

export class RuntimeConfigSectionMetadataDto {
  @ApiProperty({ type: ConfigFieldMetadataDto })
  apiBaseUrl: ConfigFieldMetadataDto;
}

export class McpConfigSectionDto {
  @ApiProperty()
  serverUrl: string;

  @ApiProperty()
  healthCheckInterval: number;

  @ApiProperty()
  serverTimeout: number;
}

export class McpConfigSectionMetadataDto {
  @ApiProperty({ type: ConfigFieldMetadataDto })
  serverUrl: ConfigFieldMetadataDto;

  @ApiProperty({ type: ConfigFieldMetadataDto })
  healthCheckInterval: ConfigFieldMetadataDto;

  @ApiProperty({ type: ConfigFieldMetadataDto })
  serverTimeout: ConfigFieldMetadataDto;
}

export class OpenApiConfigSectionDto {
  @ApiPropertyOptional()
  defaultBaseUrl?: string;

  @ApiProperty()
  maxFileSize: string;

  @ApiProperty()
  cacheTtl: number;
}

export class OpenApiConfigSectionMetadataDto {
  @ApiProperty({ type: ConfigFieldMetadataDto })
  defaultBaseUrl: ConfigFieldMetadataDto;

  @ApiProperty({ type: ConfigFieldMetadataDto })
  maxFileSize: ConfigFieldMetadataDto;

  @ApiProperty({ type: ConfigFieldMetadataDto })
  cacheTtl: ConfigFieldMetadataDto;
}

export class MonitoringConfigSectionDto {
  @ApiProperty()
  metricsEnabled: boolean;

  @ApiProperty()
  metricsHistoryMaxAge: number;

  @ApiProperty()
  healthCheckEnabled: boolean;

  @ApiProperty()
  healthCheckInterval: number;

  @ApiProperty()
  healthCheckTimeout: number;

  @ApiProperty()
  healthCheckHistoryMaxAge: number;

  @ApiProperty()
  autoRestartUnhealthyServers: boolean;
}

export class MonitoringConfigSectionMetadataDto {
  @ApiProperty({ type: ConfigFieldMetadataDto })
  metricsEnabled: ConfigFieldMetadataDto;

  @ApiProperty({ type: ConfigFieldMetadataDto })
  metricsHistoryMaxAge: ConfigFieldMetadataDto;

  @ApiProperty({ type: ConfigFieldMetadataDto })
  healthCheckEnabled: ConfigFieldMetadataDto;

  @ApiProperty({ type: ConfigFieldMetadataDto })
  healthCheckInterval: ConfigFieldMetadataDto;

  @ApiProperty({ type: ConfigFieldMetadataDto })
  healthCheckTimeout: ConfigFieldMetadataDto;

  @ApiProperty({ type: ConfigFieldMetadataDto })
  healthCheckHistoryMaxAge: ConfigFieldMetadataDto;

  @ApiProperty({ type: ConfigFieldMetadataDto })
  autoRestartUnhealthyServers: ConfigFieldMetadataDto;
}

export class DevelopmentConfigSectionDto {
  @ApiProperty()
  hotReload: boolean;

  @ApiProperty()
  watchFiles: boolean;

  @ApiProperty()
  debugMode: boolean;
}

export class DevelopmentConfigSectionMetadataDto {
  @ApiProperty({ type: ConfigFieldMetadataDto })
  hotReload: ConfigFieldMetadataDto;

  @ApiProperty({ type: ConfigFieldMetadataDto })
  watchFiles: ConfigFieldMetadataDto;

  @ApiProperty({ type: ConfigFieldMetadataDto })
  debugMode: ConfigFieldMetadataDto;
}

export class ApplicationConfigMetadataDto {
  @ApiProperty({ type: AppConfigSectionMetadataDto })
  app: AppConfigSectionMetadataDto;

  @ApiProperty({ type: CorsConfigSectionMetadataDto })
  cors: CorsConfigSectionMetadataDto;

  @ApiProperty({ type: ThrottleConfigSectionMetadataDto })
  throttle: ThrottleConfigSectionMetadataDto;

  @ApiProperty({ type: SecurityConfigSectionMetadataDto })
  security: SecurityConfigSectionMetadataDto;

  @ApiProperty({ type: LoggingConfigSectionMetadataDto })
  logging: LoggingConfigSectionMetadataDto;

  @ApiProperty({ type: PerformanceConfigSectionMetadataDto })
  performance: PerformanceConfigSectionMetadataDto;

  @ApiProperty({ type: ProcessConfigSectionMetadataDto })
  process: ProcessConfigSectionMetadataDto;

  @ApiProperty({ type: RuntimeConfigSectionMetadataDto })
  runtime: RuntimeConfigSectionMetadataDto;

  @ApiProperty({ type: McpConfigSectionMetadataDto })
  mcp: McpConfigSectionMetadataDto;

  @ApiProperty({ type: OpenApiConfigSectionMetadataDto })
  openapi: OpenApiConfigSectionMetadataDto;

  @ApiProperty({ type: MonitoringConfigSectionMetadataDto })
  monitoring: MonitoringConfigSectionMetadataDto;

  @ApiProperty({ type: DevelopmentConfigSectionMetadataDto })
  development: DevelopmentConfigSectionMetadataDto;
}

export class ApplicationConfigResponseDto {
  @ApiProperty({ type: AppConfigSectionDto })
  app: AppConfigSectionDto;

  @ApiProperty({ type: CorsConfigSectionDto })
  cors: CorsConfigSectionDto;

  @ApiProperty({ type: ThrottleConfigSectionDto })
  throttle: ThrottleConfigSectionDto;

  @ApiProperty({ type: SecurityConfigSectionDto })
  security: SecurityConfigSectionDto;

  @ApiProperty({ type: LoggingConfigSectionDto })
  logging: LoggingConfigSectionDto;

  @ApiProperty({ type: PerformanceConfigSectionDto })
  performance: PerformanceConfigSectionDto;

  @ApiProperty({ type: ProcessConfigSectionDto })
  process: ProcessConfigSectionDto;

  @ApiProperty({ type: RuntimeConfigSectionDto })
  runtime: RuntimeConfigSectionDto;

  @ApiProperty({ type: McpConfigSectionDto })
  mcp: McpConfigSectionDto;

  @ApiProperty({ type: OpenApiConfigSectionDto })
  openapi: OpenApiConfigSectionDto;

  @ApiProperty({ type: MonitoringConfigSectionDto })
  monitoring: MonitoringConfigSectionDto;

  @ApiProperty({ type: DevelopmentConfigSectionDto })
  development: DevelopmentConfigSectionDto;

  @ApiProperty({
    type: ApplicationConfigMetadataDto,
    description: 'Metadata about configuration origins and runtime behavior',
  })
  metadata: ApplicationConfigMetadataDto;
}

export class UpdateApplicationConfigResponseDto {
  @ApiProperty({
    type: ApplicationConfigResponseDto,
    description: 'Latest effective configuration snapshot after the update',
  })
  config: ApplicationConfigResponseDto;

  @ApiProperty({
    type: [String],
    description: 'Configuration keys that were updated in this request',
  })
  updatedKeys: string[];

  @ApiProperty({
    type: [String],
    description: 'Updated configuration keys that require restart to fully take effect',
  })
  restartRequiredKeys: string[];

  @ApiProperty({
    type: [String],
    description: 'Recommended services or subsystems to restart after the update',
  })
  restartPlan: string[];
}

export class EnvironmentInfoResponseDto {
  @ApiProperty()
  nodeEnv: string;

  @ApiProperty()
  port: number;

  @ApiProperty()
  mcpPort: number;

  @ApiProperty()
  isDevelopment: boolean;

  @ApiProperty()
  isProduction: boolean;

  @ApiProperty()
  isTest: boolean;

  @ApiProperty()
  timestamp: string;
}
