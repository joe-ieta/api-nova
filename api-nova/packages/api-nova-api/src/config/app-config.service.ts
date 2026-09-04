import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditAction, AuditLevel, AuditLog, AuditStatus } from '../database/entities/audit-log.entity';
import {
  ConfigOverrideEntity,
  ConfigOverrideValueType,
} from '../database/entities/config-override.entity';
import { ConfigBackupEntity } from '../database/entities/config-backup.entity';
import {
  ApplicationConfigMetadataDto,
  ApplicationConfigResponseDto,
  ConfigFieldMetadataDto,
} from '../modules/config/dto/config-response.dto';
import { UpdateApplicationConfigDto } from '../modules/config/dto/config-update.dto';
import {
  ConfigBackupSummaryDto,
  ConfigExportDto,
  ConfigImportPreviewDto,
  ConfigImportResultDto,
  ConfigTransferOverrideDto,
  CreateConfigBackupDto,
  ImportApplicationConfigDto,
} from '../modules/config/dto/config-transfer.dto';

type ConfigValueSource = 'env' | 'override' | 'derived';
type ConfigValueSensitivity = 'public' | 'sensitive';

type ConfigSectionKey =
  | 'app'
  | 'cors'
  | 'throttle'
  | 'security'
  | 'logging'
  | 'performance'
  | 'process'
  | 'runtime'
  | 'mcp'
  | 'openapi'
  | 'monitoring'
  | 'development';

interface ConfigFieldSpec {
  envKey?: string;
  section: ConfigSectionKey;
  field: string;
  valueType: ConfigOverrideValueType;
  defaultValue?: string | number | boolean;
  restartRequired: boolean;
  sensitivity: ConfigValueSensitivity;
  description: string;
  editable: boolean;
}

const CONFIG_EXPORT_VERSION = 'config-overrides/v1';

const CONFIG_FIELD_SPECS: ConfigFieldSpec[] = [
  {
    envKey: 'NODE_ENV',
    section: 'app',
    field: 'nodeEnv',
    valueType: 'string',
    defaultValue: 'development',
    restartRequired: true,
    sensitivity: 'public',
    description: 'Current NestJS runtime environment name.',
    editable: false,
  },
  {
    envKey: 'PORT',
    section: 'app',
    field: 'port',
    valueType: 'number',
    defaultValue: 9001,
    restartRequired: true,
    sensitivity: 'public',
    description: 'Primary HTTP port used by the API service.',
    editable: false,
  },
  {
    envKey: 'MCP_PORT',
    section: 'app',
    field: 'mcpPort',
    valueType: 'number',
    defaultValue: 9022,
    restartRequired: true,
    sensitivity: 'public',
    description: 'Port reserved for the MCP runtime listener.',
    editable: false,
  },
  {
    envKey: 'CORS_ORIGINS',
    section: 'cors',
    field: 'origins',
    valueType: 'string',
    defaultValue: 'http://localhost:5173,http://localhost:9000,http://127.0.0.1:9000',
    restartRequired: true,
    sensitivity: 'public',
    description: 'Allowed browser origins for cross-origin requests.',
    editable: false,
  },
  {
    envKey: 'THROTTLE_TTL',
    section: 'throttle',
    field: 'ttlSeconds',
    valueType: 'number',
    defaultValue: 60,
    restartRequired: true,
    sensitivity: 'public',
    description: 'Throttle window duration for global API request limiting.',
    editable: false,
  },
  {
    envKey: 'THROTTLE_LIMIT',
    section: 'throttle',
    field: 'limit',
    valueType: 'number',
    defaultValue: 10,
    restartRequired: true,
    sensitivity: 'public',
    description: 'Maximum requests allowed per throttle window.',
    editable: false,
  },
  {
    envKey: 'JWT_EXPIRES_IN',
    section: 'security',
    field: 'accessTokenExpiresIn',
    valueType: 'string',
    defaultValue: '15m',
    restartRequired: true,
    sensitivity: 'public',
    description: 'Access token lifetime used by the auth module.',
    editable: false,
  },
  {
    envKey: 'LOG_LEVEL',
    section: 'logging',
    field: 'level',
    valueType: 'string',
    defaultValue: 'info',
    restartRequired: false,
    sensitivity: 'public',
    description: 'Application log verbosity threshold.',
    editable: true,
  },
  {
    envKey: 'LOG_FORMAT',
    section: 'logging',
    field: 'format',
    valueType: 'string',
    defaultValue: 'pretty',
    restartRequired: false,
    sensitivity: 'public',
    description: 'Structured or human-readable log output format.',
    editable: true,
  },
  {
    envKey: 'LOG_DIRECTORY',
    section: 'logging',
    field: 'logDirectory',
    valueType: 'string',
    defaultValue: 'logs',
    restartRequired: true,
    sensitivity: 'public',
    description: 'Filesystem directory used for persisted process logs.',
    editable: false,
  },
  {
    envKey: 'REQUEST_TIMEOUT',
    section: 'performance',
    field: 'requestTimeout',
    valueType: 'number',
    defaultValue: 30000,
    restartRequired: false,
    sensitivity: 'public',
    description: 'Default upstream request timeout in milliseconds.',
    editable: true,
  },
  {
    envKey: 'CACHE_TTL',
    section: 'performance',
    field: 'cacheTtl',
    valueType: 'number',
    defaultValue: 300,
    restartRequired: false,
    sensitivity: 'public',
    description: 'Default cache time-to-live in seconds.',
    editable: true,
  },
  {
    envKey: 'MAX_PAYLOAD_SIZE',
    section: 'performance',
    field: 'maxPayloadSize',
    valueType: 'string',
    defaultValue: '10mb',
    restartRequired: true,
    sensitivity: 'public',
    description: 'Maximum accepted inbound request payload size.',
    editable: false,
  },
  {
    envKey: 'PROCESS_TIMEOUT',
    section: 'process',
    field: 'timeout',
    valueType: 'number',
    defaultValue: 30000,
    restartRequired: false,
    sensitivity: 'public',
    description: 'Timeout for managed process operations in milliseconds.',
    editable: true,
  },
  {
    envKey: 'PROCESS_MAX_RETRIES',
    section: 'process',
    field: 'maxRetries',
    valueType: 'number',
    defaultValue: 3,
    restartRequired: false,
    sensitivity: 'public',
    description: 'Maximum automatic retries for managed process actions.',
    editable: true,
  },
  {
    envKey: 'PROCESS_RESTART_DELAY',
    section: 'process',
    field: 'restartDelay',
    valueType: 'number',
    defaultValue: 1000,
    restartRequired: false,
    sensitivity: 'public',
    description: 'Delay between process restart attempts in milliseconds.',
    editable: true,
  },
  {
    envKey: 'PID_DIRECTORY',
    section: 'process',
    field: 'pidDirectory',
    valueType: 'string',
    defaultValue: 'pids',
    restartRequired: true,
    sensitivity: 'public',
    description: 'Filesystem directory used to persist PID files.',
    editable: false,
  },
  {
    envKey: 'API_BASE_URL',
    section: 'runtime',
    field: 'apiBaseUrl',
    valueType: 'string',
    defaultValue: '',
    restartRequired: false,
    sensitivity: 'public',
    description: 'Base URL used by runtime components for internal callbacks.',
    editable: true,
  },
  {
    envKey: 'MCP_SERVER_HEALTH_CHECK_INTERVAL',
    section: 'mcp',
    field: 'healthCheckInterval',
    valueType: 'number',
    defaultValue: 30000,
    restartRequired: false,
    sensitivity: 'public',
    description: 'Polling interval for MCP runtime health checks in milliseconds.',
    editable: true,
  },
  {
    envKey: 'MCP_SERVER_TIMEOUT',
    section: 'mcp',
    field: 'serverTimeout',
    valueType: 'number',
    defaultValue: 300000,
    restartRequired: false,
    sensitivity: 'public',
    description: 'Execution timeout for MCP server operations in milliseconds.',
    editable: true,
  },
  {
    envKey: 'DEFAULT_OPENAPI_BASE_URL',
    section: 'openapi',
    field: 'defaultBaseUrl',
    valueType: 'string',
    defaultValue: '',
    restartRequired: false,
    sensitivity: 'public',
    description: 'Default upstream base URL suggested for imported OpenAPI specs.',
    editable: true,
  },
  {
    envKey: 'MAX_OPENAPI_FILE_SIZE',
    section: 'openapi',
    field: 'maxFileSize',
    valueType: 'string',
    defaultValue: '5mb',
    restartRequired: true,
    sensitivity: 'public',
    description: 'Maximum supported OpenAPI file import size.',
    editable: false,
  },
  {
    envKey: 'OPENAPI_CACHE_TTL',
    section: 'openapi',
    field: 'cacheTtl',
    valueType: 'number',
    defaultValue: 600,
    restartRequired: false,
    sensitivity: 'public',
    description: 'OpenAPI parse and fetch cache retention in seconds.',
    editable: true,
  },
  {
    envKey: 'METRICS_ENABLED',
    section: 'monitoring',
    field: 'metricsEnabled',
    valueType: 'boolean',
    defaultValue: true,
    restartRequired: false,
    sensitivity: 'public',
    description: 'Enables server metrics collection and exposure.',
    editable: true,
  },
  {
    envKey: 'METRICS_HISTORY_MAX_AGE',
    section: 'monitoring',
    field: 'metricsHistoryMaxAge',
    valueType: 'number',
    defaultValue: 7 * 24 * 60 * 60 * 1000,
    restartRequired: false,
    sensitivity: 'public',
    description: 'Maximum retained age for metrics history in milliseconds.',
    editable: true,
  },
  {
    envKey: 'HEALTH_CHECK_ENABLED',
    section: 'monitoring',
    field: 'healthCheckEnabled',
    valueType: 'boolean',
    defaultValue: true,
    restartRequired: false,
    sensitivity: 'public',
    description: 'Enables periodic health checking for managed services.',
    editable: true,
  },
  {
    envKey: 'HEALTH_CHECK_INTERVAL',
    section: 'monitoring',
    field: 'healthCheckInterval',
    valueType: 'number',
    defaultValue: 30000,
    restartRequired: false,
    sensitivity: 'public',
    description: 'Polling interval for health checks in milliseconds.',
    editable: true,
  },
  {
    envKey: 'HEALTH_CHECK_TIMEOUT',
    section: 'monitoring',
    field: 'healthCheckTimeout',
    valueType: 'number',
    defaultValue: 5000,
    restartRequired: false,
    sensitivity: 'public',
    description: 'Timeout for individual health checks in milliseconds.',
    editable: true,
  },
  {
    envKey: 'HEALTH_CHECK_HISTORY_MAX_AGE',
    section: 'monitoring',
    field: 'healthCheckHistoryMaxAge',
    valueType: 'number',
    defaultValue: 24 * 60 * 60 * 1000,
    restartRequired: false,
    sensitivity: 'public',
    description: 'Maximum retained age for health check history in milliseconds.',
    editable: true,
  },
  {
    envKey: 'AUTO_RESTART_UNHEALTHY_SERVERS',
    section: 'monitoring',
    field: 'autoRestartUnhealthyServers',
    valueType: 'boolean',
    defaultValue: false,
    restartRequired: false,
    sensitivity: 'public',
    description: 'Whether unhealthy managed services should be restarted automatically.',
    editable: true,
  },
  {
    envKey: 'HOT_RELOAD',
    section: 'development',
    field: 'hotReload',
    valueType: 'boolean',
    defaultValue: false,
    restartRequired: true,
    sensitivity: 'public',
    description: 'Whether hot reload mode is enabled for local development.',
    editable: false,
  },
  {
    envKey: 'WATCH_FILES',
    section: 'development',
    field: 'watchFiles',
    valueType: 'boolean',
    defaultValue: false,
    restartRequired: true,
    sensitivity: 'public',
    description: 'Whether file watching is enabled for development workflows.',
    editable: false,
  },
  {
    envKey: 'DEBUG_MODE',
    section: 'development',
    field: 'debugMode',
    valueType: 'boolean',
    defaultValue: false,
    restartRequired: false,
    sensitivity: 'public',
    description: 'Whether additional debug behavior is enabled.',
    editable: false,
  },
];

const SPEC_BY_FIELD = new Map<string, ConfigFieldSpec>(
  CONFIG_FIELD_SPECS.map((spec) => [`${spec.section}.${spec.field}`, spec]),
);

const SPEC_BY_ENV_KEY = new Map<string, ConfigFieldSpec>(
  CONFIG_FIELD_SPECS.filter((spec) => spec.envKey).map((spec) => [spec.envKey!, spec]),
);

@Injectable()
export class AppConfigService implements OnModuleInit {
  private readonly logger = new Logger(AppConfigService.name);
  private readonly overrides = new Map<string, string | number | boolean>();

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(ConfigOverrideEntity)
    private readonly configOverrideRepository: Repository<ConfigOverrideEntity>,
    @InjectRepository(ConfigBackupEntity)
    private readonly configBackupRepository: Repository<ConfigBackupEntity>,
    @InjectRepository(AuditLog)
    private readonly auditLogRepository: Repository<AuditLog>,
  ) {}

  async onModuleInit() {
    await this.reloadOverrides();
  }

  async reloadOverrides(): Promise<void> {
    const overrides = await this.configOverrideRepository.find();
    this.overrides.clear();
    for (const override of overrides) {
      this.overrides.set(override.envKey, override.value);
    }
  }

  private buildOverrideRecord(
    spec: ConfigFieldSpec,
    value: string | number | boolean,
  ): ConfigTransferOverrideDto {
    return {
      envKey: spec.envKey!,
      section: spec.section,
      field: spec.field,
      valueType: spec.valueType,
      value,
      restartRequired: spec.restartRequired,
      description: spec.description,
    };
  }

  private getCurrentOverrideRecords(): ConfigTransferOverrideDto[] {
    const records: ConfigTransferOverrideDto[] = [];

    for (const spec of CONFIG_FIELD_SPECS) {
      if (!spec.envKey || !this.overrides.has(spec.envKey)) {
        continue;
      }

      const value = this.overrides.get(spec.envKey);
      if (value === undefined) {
        continue;
      }

      records.push(
        this.buildOverrideRecord(spec, value as string | number | boolean),
      );
    }

    return records.sort((left, right) =>
      `${left.section}.${left.field}`.localeCompare(`${right.section}.${right.field}`),
    );
  }

  private async replaceOverrides(records: ConfigTransferOverrideDto[]): Promise<string[]> {
    const restartRequiredKeys = new Set<string>();
    const knownEnvKeys = CONFIG_FIELD_SPECS.map((spec) => spec.envKey).filter(Boolean) as string[];

    if (knownEnvKeys.length > 0) {
      await this.configOverrideRepository.delete(knownEnvKeys.map((envKey) => ({ envKey })));
    }
    this.overrides.clear();

    for (const record of records) {
      const spec = SPEC_BY_FIELD.get(`${record.section}.${record.field}`);
      if (!spec || !spec.editable || !spec.envKey) {
        continue;
      }

      const normalizedValue = this.normalizeOverrideValue(spec, record.value);
      if (normalizedValue === undefined) {
        continue;
      }

      this.validateOverrideValue(spec, normalizedValue);

      await this.configOverrideRepository.save(
        this.configOverrideRepository.create({
          envKey: spec.envKey,
          section: spec.section,
          field: spec.field,
          valueType: spec.valueType,
          value: normalizedValue,
          restartRequired: spec.restartRequired,
          description: spec.description,
        }),
      );

      this.overrides.set(spec.envKey, normalizedValue);
      if (spec.restartRequired) {
        restartRequiredKeys.add(`${spec.section}.${spec.field}`);
      }
    }

    return Array.from(restartRequiredKeys);
  }

  private buildRestartPlan(restartRequiredKeys: string[]): string[] {
    const plan = new Set<string>();

    for (const key of restartRequiredKeys) {
      if (key.startsWith('app.') || key.startsWith('cors.') || key.startsWith('security.')) {
        plan.add('api-service');
      }
      if (key.startsWith('process.') || key.startsWith('runtime.')) {
        plan.add('managed-server-processes');
      }
      if (key.startsWith('mcp.')) {
        plan.add('mcp-runtime');
      }
      if (key.startsWith('monitoring.')) {
        plan.add('health-monitoring-workers');
      }
      if (key.startsWith('openapi.')) {
        plan.add('openapi-cache-consumers');
      }
      if (key.startsWith('logging.')) {
        plan.add('log-pipeline');
      }
    }

    return Array.from(plan);
  }

  previewImportConfig(dto: ImportApplicationConfigDto): ConfigImportPreviewDto {
    const currentOverrides = new Map(
      this.getCurrentOverrideRecords().map((record) => [`${record.section}.${record.field}`, record]),
    );
    const incomingOverrides = new Map(
      (dto.overrides || []).map((record) => [`${record.section}.${record.field}`, record]),
    );

    const conflicts: ConfigImportPreviewDto['conflicts'] = [];
    const restartRequired = new Set<string>();
    const allKeys = new Set([...currentOverrides.keys(), ...incomingOverrides.keys()]);

    for (const key of allKeys) {
      const currentRecord = currentOverrides.get(key);
      const incomingRecord = incomingOverrides.get(key);

      if (!currentRecord && incomingRecord) {
        conflicts.push({
          key,
          incomingValue: incomingRecord.value,
          kind: 'add',
        });
      } else if (currentRecord && !incomingRecord) {
        conflicts.push({
          key,
          currentValue: currentRecord.value,
          kind: 'remove',
        });
        if (currentRecord.restartRequired) {
          restartRequired.add(key);
        }
      } else if (
        currentRecord &&
        incomingRecord &&
        currentRecord.value !== incomingRecord.value
      ) {
        conflicts.push({
          key,
          currentValue: currentRecord.value,
          incomingValue: incomingRecord.value,
          kind: 'change',
        });
        if (currentRecord.restartRequired || incomingRecord.restartRequired) {
          restartRequired.add(key);
        }
      }
    }

    return {
      formatVersion: dto.formatVersion,
      compatible: dto.formatVersion === CONFIG_EXPORT_VERSION,
      migrationRequired: dto.formatVersion !== CONFIG_EXPORT_VERSION,
      conflicts,
      restartRequiredKeys: Array.from(restartRequired),
      restartPlan: this.buildRestartPlan(Array.from(restartRequired)),
    };
  }

  exportConfig(): ConfigExportDto {
    const overrides = this.getCurrentOverrideRecords();
    return {
      formatVersion: CONFIG_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      overrides,
      overrideCount: overrides.length,
    };
  }

  async importConfig(dto: ImportApplicationConfigDto): Promise<ConfigImportResultDto> {
    if (dto.formatVersion !== CONFIG_EXPORT_VERSION) {
      throw new Error(`Unsupported configuration export format: ${dto.formatVersion}`);
    }

    const restartRequiredKeys = await this.replaceOverrides(dto.overrides || []);
    const importedCount = (dto.overrides || []).length;

    await this.auditLogRepository.save(
      this.auditLogRepository.create({
        action: AuditAction.CONFIG_IMPORTED,
        description: `Imported ${importedCount} configuration overrides`,
        level: AuditLevel.INFO,
        status: AuditStatus.SUCCESS,
        resource: 'config',
        details: {
          after: {
            importedCount,
            restartRequiredKeys,
          },
        },
        metadata: {
          count: importedCount,
          tags: ['config', 'p2', 'import'],
        },
      }),
    );

    return {
      importedCount,
      restartRequiredKeys,
      restartPlan: this.buildRestartPlan(restartRequiredKeys),
      config: this.getAllConfig(),
    };
  }

  async createBackup(dto: CreateConfigBackupDto = {}): Promise<ConfigBackupSummaryDto> {
    const snapshot = this.exportConfig();
    const backupEntity = this.configBackupRepository.create({
      name: dto.name?.trim() || `config-backup-${new Date().toISOString()}`,
      description: dto.description?.trim() || undefined,
      overrideCount: snapshot.overrideCount,
      snapshot,
    });
    const backup = await this.configBackupRepository.save(backupEntity);

    await this.auditLogRepository.save(
      this.auditLogRepository.create({
        action: AuditAction.SYSTEM_BACKUP,
        description: `Created configuration backup ${backup.name}`,
        level: AuditLevel.INFO,
        status: AuditStatus.SUCCESS,
        resource: 'config-backup',
        resourceId: backup.id,
        metadata: {
          count: snapshot.overrideCount,
          tags: ['config', 'p2', 'backup'],
        },
      }),
    );

    return {
      id: backup.id,
      name: backup.name,
      description: backup.description,
      overrideCount: backup.overrideCount,
      createdAt: backup.createdAt.toISOString(),
      updatedAt: backup.updatedAt.toISOString(),
    };
  }

  async listBackups(): Promise<ConfigBackupSummaryDto[]> {
    const backups = await this.configBackupRepository.find({
      order: { createdAt: 'DESC' },
    });

    return backups.map((backup) => ({
      id: backup.id,
      name: backup.name,
      description: backup.description,
      overrideCount: backup.overrideCount,
      createdAt: backup.createdAt.toISOString(),
      updatedAt: backup.updatedAt.toISOString(),
    }));
  }

  async restoreBackup(id: string): Promise<ConfigImportResultDto> {
    const backup = await this.configBackupRepository.findOne({ where: { id } });
    if (!backup) {
      throw new Error(`Configuration backup not found: ${id}`);
    }

    const snapshot = backup.snapshot as unknown as ConfigExportDto;
    const result = await this.importConfig({
      formatVersion: snapshot.formatVersion,
      overrides: snapshot.overrides || [],
    });

    await this.auditLogRepository.save(
      this.auditLogRepository.create({
        action: AuditAction.SYSTEM_RESTORE,
        description: `Restored configuration backup ${backup.name}`,
        level: AuditLevel.INFO,
        status: AuditStatus.SUCCESS,
        resource: 'config-backup',
        resourceId: backup.id,
        metadata: {
          count: result.importedCount,
          tags: ['config', 'p2', 'restore'],
        },
      }),
    );

    return result;
  }

  async deleteBackup(id: string): Promise<void> {
    const backup = await this.configBackupRepository.findOne({ where: { id } });
    if (!backup) {
      return;
    }

    await this.configBackupRepository.delete({ id });
  }

  private createMetadata(
    source: ConfigValueSource,
    restartRequired: boolean,
    sensitivity: ConfigValueSensitivity,
    description: string,
    editable: boolean,
  ): ConfigFieldMetadataDto {
    return {
      source,
      restartRequired,
      sensitivity,
      description,
      editable,
    };
  }

  private getConfigValue<T extends string | number | boolean | undefined>(
    envKey: string,
    defaultValue: T,
  ): T {
    if (this.overrides.has(envKey)) {
      return this.overrides.get(envKey) as T;
    }
    return this.configService.get<T>(envKey, defaultValue);
  }

  private getEffectiveSourceForEnvKey(envKey: string): ConfigValueSource {
    return this.overrides.has(envKey) ? 'override' : 'env';
  }

  private getSpecMetadata(section: ConfigSectionKey, field: string): ConfigFieldMetadataDto {
    const spec = SPEC_BY_FIELD.get(`${section}.${field}`);
    if (!spec) {
      return this.createMetadata('derived', false, 'public', '', false);
    }

    return this.createMetadata(
      spec.envKey ? this.getEffectiveSourceForEnvKey(spec.envKey) : 'derived',
      spec.restartRequired,
      spec.sensitivity,
      spec.description,
      spec.editable,
    );
  }

  get<T = any>(key: string, defaultValue?: T): T {
    if (this.overrides.has(key)) {
      return this.overrides.get(key) as T;
    }
    return this.configService.get<T>(key, defaultValue);
  }

  get nodeEnv(): string {
    return this.getConfigValue('NODE_ENV', 'development');
  }

  get port(): number {
    return this.getConfigValue('PORT', 9001);
  }

  get mcpPort(): number {
    return this.getConfigValue('MCP_PORT', 9022);
  }

  get isDevelopment(): boolean {
    return this.nodeEnv === 'development';
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  get isTest(): boolean {
    return this.nodeEnv === 'test';
  }

  get corsOrigins(): string[] {
    return this.getConfigValue(
      'CORS_ORIGINS',
      'http://localhost:5173,http://localhost:9000,http://127.0.0.1:9000',
    )
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean);
  }

  get jwtSecret(): string | undefined {
    return this.configService.get<string>('JWT_SECRET');
  }

  get jwtRefreshSecret(): string | undefined {
    return this.configService.get<string>('JWT_REFRESH_SECRET');
  }

  get jwtExpiresIn(): string {
    return this.getConfigValue('JWT_EXPIRES_IN', '15m');
  }

  get throttleTtl(): number {
    return this.getConfigValue('THROTTLE_TTL', 60);
  }

  get throttleLimit(): number {
    return this.getConfigValue('THROTTLE_LIMIT', 10);
  }

  get logLevel(): string {
    return this.getConfigValue('LOG_LEVEL', 'info');
  }

  get logFormat(): string {
    return this.getConfigValue('LOG_FORMAT', 'pretty');
  }

  get logDirectory(): string {
    return this.getConfigValue('LOG_DIRECTORY', 'logs');
  }

  get requestTimeout(): number {
    return this.getConfigValue('REQUEST_TIMEOUT', 30000);
  }

  get cacheTtl(): number {
    return this.getConfigValue('CACHE_TTL', 300);
  }

  get maxPayloadSize(): string {
    return this.getConfigValue('MAX_PAYLOAD_SIZE', '10mb');
  }

  get apiBaseUrl(): string | undefined {
    const value = this.getConfigValue('API_BASE_URL', '');
    return value || undefined;
  }

  get mcpServerHost(): string {
    return this.getConfigValue('MCP_SERVER_HOST', 'localhost');
  }

  get mcpServerPort(): number {
    return this.getConfigValue('MCP_SERVER_PORT', 9022);
  }

  get mcpServerUrl(): string {
    return `http://${this.mcpServerHost}:${this.mcpServerPort}`;
  }

  get mcpServerHealthCheckInterval(): number {
    return this.getConfigValue('MCP_SERVER_HEALTH_CHECK_INTERVAL', 30000);
  }

  get mcpServerTimeout(): number {
    return this.getConfigValue('MCP_SERVER_TIMEOUT', 300000);
  }

  get defaultOpenAPIBaseUrl(): string | undefined {
    const value = this.getConfigValue('DEFAULT_OPENAPI_BASE_URL', '');
    return value || undefined;
  }

  get maxOpenAPIFileSize(): string {
    return this.getConfigValue('MAX_OPENAPI_FILE_SIZE', '5mb');
  }

  get openAPIcacheTtl(): number {
    return this.getConfigValue('OPENAPI_CACHE_TTL', 600);
  }

  get metricsEnabled(): boolean {
    return this.getConfigValue('METRICS_ENABLED', true);
  }

  get metricsHistoryMaxAge(): number {
    return this.getConfigValue('METRICS_HISTORY_MAX_AGE', 7 * 24 * 60 * 60 * 1000);
  }

  get healthCheckEnabled(): boolean {
    return this.getConfigValue('HEALTH_CHECK_ENABLED', true);
  }

  get healthCheckTimeout(): number {
    return this.getConfigValue('HEALTH_CHECK_TIMEOUT', 5000);
  }

  get healthCheckInterval(): number {
    return this.getConfigValue('HEALTH_CHECK_INTERVAL', 30000);
  }

  get healthCheckHistoryMaxAge(): number {
    return this.getConfigValue('HEALTH_CHECK_HISTORY_MAX_AGE', 24 * 60 * 60 * 1000);
  }

  get autoRestartUnhealthyServers(): boolean {
    return this.getConfigValue('AUTO_RESTART_UNHEALTHY_SERVERS', false);
  }

  get processTimeout(): number {
    return this.getConfigValue('PROCESS_TIMEOUT', 30000);
  }

  get processMaxRetries(): number {
    return this.getConfigValue('PROCESS_MAX_RETRIES', 3);
  }

  get processRestartDelay(): number {
    return this.getConfigValue('PROCESS_RESTART_DELAY', 1000);
  }

  get pidDirectory(): string {
    return this.getConfigValue('PID_DIRECTORY', 'pids');
  }

  get hotReload(): boolean {
    return this.getConfigValue('HOT_RELOAD', false);
  }

  get watchFiles(): boolean {
    return this.getConfigValue('WATCH_FILES', false);
  }

  get debugMode(): boolean {
    return this.getConfigValue('DEBUG_MODE', false);
  }

  getConfigMetadata(): ApplicationConfigMetadataDto {
    return {
      app: {
        nodeEnv: this.getSpecMetadata('app', 'nodeEnv'),
        port: this.getSpecMetadata('app', 'port'),
        mcpPort: this.getSpecMetadata('app', 'mcpPort'),
      },
      cors: {
        origins: this.getSpecMetadata('cors', 'origins'),
      },
      throttle: {
        ttlSeconds: this.getSpecMetadata('throttle', 'ttlSeconds'),
        limit: this.getSpecMetadata('throttle', 'limit'),
      },
      security: {
        jwtEnabled: this.createMetadata(
          this.jwtSecret ? 'derived' : 'derived',
          true,
          'sensitive',
          'Indicates whether a JWT signing secret is configured.',
          false,
        ),
        refreshTokenEnabled: this.createMetadata(
          this.jwtRefreshSecret ? 'derived' : 'derived',
          true,
          'sensitive',
          'Indicates whether a refresh token secret is configured.',
          false,
        ),
        accessTokenExpiresIn: this.getSpecMetadata('security', 'accessTokenExpiresIn'),
      },
      logging: {
        level: this.getSpecMetadata('logging', 'level'),
        format: this.getSpecMetadata('logging', 'format'),
        logDirectory: this.getSpecMetadata('logging', 'logDirectory'),
      },
      performance: {
        requestTimeout: this.getSpecMetadata('performance', 'requestTimeout'),
        cacheTtl: this.getSpecMetadata('performance', 'cacheTtl'),
        maxPayloadSize: this.getSpecMetadata('performance', 'maxPayloadSize'),
      },
      process: {
        timeout: this.getSpecMetadata('process', 'timeout'),
        maxRetries: this.getSpecMetadata('process', 'maxRetries'),
        restartDelay: this.getSpecMetadata('process', 'restartDelay'),
        pidDirectory: this.getSpecMetadata('process', 'pidDirectory'),
      },
      runtime: {
        apiBaseUrl: this.getSpecMetadata('runtime', 'apiBaseUrl'),
      },
      mcp: {
        serverUrl: this.createMetadata(
          'derived',
          true,
          'public',
          'Derived MCP runtime base URL composed from host and port.',
          false,
        ),
        healthCheckInterval: this.getSpecMetadata('mcp', 'healthCheckInterval'),
        serverTimeout: this.getSpecMetadata('mcp', 'serverTimeout'),
      },
      openapi: {
        defaultBaseUrl: this.getSpecMetadata('openapi', 'defaultBaseUrl'),
        maxFileSize: this.getSpecMetadata('openapi', 'maxFileSize'),
        cacheTtl: this.getSpecMetadata('openapi', 'cacheTtl'),
      },
      monitoring: {
        metricsEnabled: this.getSpecMetadata('monitoring', 'metricsEnabled'),
        metricsHistoryMaxAge: this.getSpecMetadata('monitoring', 'metricsHistoryMaxAge'),
        healthCheckEnabled: this.getSpecMetadata('monitoring', 'healthCheckEnabled'),
        healthCheckInterval: this.getSpecMetadata('monitoring', 'healthCheckInterval'),
        healthCheckTimeout: this.getSpecMetadata('monitoring', 'healthCheckTimeout'),
        healthCheckHistoryMaxAge: this.getSpecMetadata('monitoring', 'healthCheckHistoryMaxAge'),
        autoRestartUnhealthyServers: this.getSpecMetadata('monitoring', 'autoRestartUnhealthyServers'),
      },
      development: {
        hotReload: this.getSpecMetadata('development', 'hotReload'),
        watchFiles: this.getSpecMetadata('development', 'watchFiles'),
        debugMode: this.getSpecMetadata('development', 'debugMode'),
      },
    };
  }

  getAllConfig(): ApplicationConfigResponseDto {
    return {
      app: {
        nodeEnv: this.nodeEnv,
        port: this.port,
        mcpPort: this.mcpPort,
      },
      cors: {
        origins: this.corsOrigins,
      },
      throttle: {
        ttlSeconds: this.throttleTtl,
        limit: this.throttleLimit,
      },
      security: {
        jwtEnabled: !!this.jwtSecret,
        refreshTokenEnabled: !!this.jwtRefreshSecret,
        accessTokenExpiresIn: this.jwtExpiresIn,
      },
      logging: {
        level: this.logLevel,
        format: this.logFormat,
        logDirectory: this.logDirectory,
      },
      performance: {
        requestTimeout: this.requestTimeout,
        cacheTtl: this.cacheTtl,
        maxPayloadSize: this.maxPayloadSize,
      },
      process: {
        timeout: this.processTimeout,
        maxRetries: this.processMaxRetries,
        restartDelay: this.processRestartDelay,
        pidDirectory: this.pidDirectory,
      },
      runtime: {
        apiBaseUrl: this.apiBaseUrl,
      },
      mcp: {
        serverUrl: this.mcpServerUrl,
        healthCheckInterval: this.mcpServerHealthCheckInterval,
        serverTimeout: this.mcpServerTimeout,
      },
      openapi: {
        defaultBaseUrl: this.defaultOpenAPIBaseUrl,
        maxFileSize: this.maxOpenAPIFileSize,
        cacheTtl: this.openAPIcacheTtl,
      },
      monitoring: {
        metricsEnabled: this.metricsEnabled,
        metricsHistoryMaxAge: this.metricsHistoryMaxAge,
        healthCheckEnabled: this.healthCheckEnabled,
        healthCheckInterval: this.healthCheckInterval,
        healthCheckTimeout: this.healthCheckTimeout,
        healthCheckHistoryMaxAge: this.healthCheckHistoryMaxAge,
        autoRestartUnhealthyServers: this.autoRestartUnhealthyServers,
      },
      development: {
        hotReload: this.hotReload,
        watchFiles: this.watchFiles,
        debugMode: this.debugMode,
      },
      metadata: this.getConfigMetadata(),
    };
  }

  private normalizeOverrideValue(spec: ConfigFieldSpec, value: unknown) {
    if (value === '') {
      return undefined;
    }

    if (spec.valueType === 'number') {
      return Number(value);
    }
    if (spec.valueType === 'boolean') {
      return Boolean(value);
    }
    return String(value);
  }

  private validateOverrideValue(spec: ConfigFieldSpec, value: string | number | boolean) {
    if (spec.field === 'apiBaseUrl' || spec.field === 'defaultBaseUrl') {
      if (typeof value === 'string' && value.trim()) {
        new URL(value);
      }
    }
  }

  async updateConfig(dto: UpdateApplicationConfigDto): Promise<{
    config: ApplicationConfigResponseDto;
    updatedKeys: string[];
    restartRequiredKeys: string[];
    restartPlan: string[];
  }> {
    const updates = Object.entries(dto)
      .flatMap(([section, fields]) =>
        Object.entries(fields || {}).map(([field, value]) => ({
          section: section as ConfigSectionKey,
          field,
          value,
        })),
      );

    const updatedKeys: string[] = [];
    const restartRequiredKeys: string[] = [];

    for (const update of updates) {
      const spec = SPEC_BY_FIELD.get(`${update.section}.${update.field}`);
      if (!spec || !spec.editable || !spec.envKey) {
        continue;
      }

      const normalizedValue = this.normalizeOverrideValue(spec, update.value);

      if (normalizedValue === undefined) {
        await this.configOverrideRepository.delete({ envKey: spec.envKey });
        this.overrides.delete(spec.envKey);
        updatedKeys.push(`${update.section}.${update.field}`);
        if (spec.restartRequired) {
          restartRequiredKeys.push(`${update.section}.${update.field}`);
        }
        continue;
      }

      this.validateOverrideValue(spec, normalizedValue);

      await this.configOverrideRepository.save(
        this.configOverrideRepository.create({
          envKey: spec.envKey,
          section: spec.section,
          field: spec.field,
          valueType: spec.valueType,
          value: normalizedValue,
          restartRequired: spec.restartRequired,
          description: spec.description,
        }),
      );

      this.overrides.set(spec.envKey, normalizedValue);
      updatedKeys.push(`${update.section}.${update.field}`);
      if (spec.restartRequired) {
        restartRequiredKeys.push(`${update.section}.${update.field}`);
      }
    }

    if (updatedKeys.length > 0) {
      await this.auditLogRepository.save(
        this.auditLogRepository.create({
          action: AuditAction.CONFIG_UPDATED,
          description: `Updated ${updatedKeys.length} configuration fields`,
          level: AuditLevel.INFO,
          status: AuditStatus.SUCCESS,
          resource: 'config',
          details: {
            after: {
              updatedKeys,
              restartRequiredKeys,
            },
          },
          metadata: {
            count: updatedKeys.length,
            tags: ['config', 'p1'],
          },
        }),
      );
    }

    return {
      config: this.getAllConfig(),
      updatedKeys,
      restartRequiredKeys,
      restartPlan: this.buildRestartPlan(restartRequiredKeys),
    };
  }
}
