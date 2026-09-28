import { RuntimeCredentialResolverService } from './services/runtime-credential-resolver.service';
import { Module } from '@nestjs/common';
import { ManagedMcpHandoffPreparationService } from './services/managed-mcp-handoff-preparation.service';
import { ManagedMcpLifecycleCoordinator } from './services/managed-mcp-lifecycle-coordinator.service';
import { ManagedChildSecurityLeaseCoordinator } from './services/managed-child-security-lease-coordinator';
import { DataSourceManagedMcpLifecycleStore } from './services/managed-mcp-lifecycle.store';
import { createConfigManagedLifecycleApprovalProvider } from './services/managed-mcp-lifecycle-approval';
import { startManagedMcpChannel } from './services/managed-mcp-channel';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { ServersLifecycleController } from './controllers/servers-lifecycle.controller';
import { ServersObservabilityController } from './controllers/servers-observability.controller';
import { ServersProcessController } from './controllers/servers-process.controller';
import { ServerManagerService } from './services/server-manager.service';
import { ServerLifecycleService } from './services/server-lifecycle.service';
import { ServerHealthService } from './services/server-health.service';
import { ServerMetricsService } from './services/server-metrics.service';
import { ProcessManagerService } from './services/process-manager.service';
import { ProcessHealthService } from './services/process-health.service';
import { ProcessErrorHandlerService } from './services/process-error-handler.service';
import { ProcessResourceMonitorService } from './services/process-resource-monitor.service';
import { ProcessLogMonitorService } from './services/process-log-monitor.service';
import { SystemLogService } from './services/system-log.service';
import { ManagementEventService } from './services/management-event.service';

import { MCPServerEntity } from '../../database/entities/mcp-server.entity';
import { AuthConfigEntity } from '../../database/entities/auth-config.entity';
import { LogEntryEntity } from '../../database/entities/log-entry.entity';
import { ProcessInfoEntity } from './entities/process-info.entity';
import { HealthCheckResultEntity } from './entities/health-check-result.entity';
import { ProcessLogEntity } from './entities/process-log.entity';
import { SystemLogEntity } from '../../database/entities/system-log.entity';

// 导入其他模块的服务
import { MCPModule } from '../mcp/mcp.module';
import { OpenAPIModule } from '../openapi/openapi.module';
import { DocumentsModule } from '../documents/documents.module';
import { AssetCatalogModule } from '../asset-catalog/asset-catalog.module';
import { RuntimeAssetsModule } from '../runtime-assets/runtime-assets.module';
import { RuntimeObservabilityModule } from '../runtime-observability/runtime-observability.module';
import { SecurityModule } from '../security/security.module';
import { CallObservabilityModule } from '../call-observability/call-observability.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MCPServerEntity,
      AuthConfigEntity,
      LogEntryEntity,
      ProcessInfoEntity,
      HealthCheckResultEntity,
      ProcessLogEntity,
      SystemLogEntity,
    ]),
    EventEmitterModule,
    HttpModule.register({
      timeout: 30000,
      maxRedirects: 5,
    }),
    ConfigModule,
    ScheduleModule.forRoot(),
    MCPModule,
    OpenAPIModule,
    DocumentsModule,
    AssetCatalogModule,
    RuntimeAssetsModule,
    RuntimeObservabilityModule,
    SecurityModule,
    CallObservabilityModule,
  ],
  controllers: [
    ServersObservabilityController,
    ServersProcessController,
    ServersLifecycleController,
  ],
  providers: [
    RuntimeCredentialResolverService,
    ManagedMcpHandoffPreparationService,
    {
      provide: ManagedMcpLifecycleCoordinator,
      useFactory: (dataSource: DataSource, preparation: ManagedMcpHandoffPreparationService, config: ConfigService,
        events: EventEmitter2) =>
        new ManagedMcpLifecycleCoordinator({
          store: new DataSourceManagedMcpLifecycleStore(dataSource),
          capture: (runtimeAssetId: string, serverId: string) => preparation.captureForManagedLifecycle(runtimeAssetId, serverId),
          approval: createConfigManagedLifecycleApprovalProvider(config),
          channel: input => startManagedMcpChannel(input),
          onStateChange: change => events.emit('managed.lifecycle.changed', change),
          // Trusted-only running-update barrier; explicitly default-off and
          // never constructed unless the operator enables the lease.
          lease: config.get<boolean>('managedMcp.securityLease.enabled') === true ? new ManagedChildSecurityLeaseCoordinator() : undefined,
        }),
      inject: [DataSource, ManagedMcpHandoffPreparationService, ConfigService, EventEmitter2],
    },
    ServerManagerService,
    ServerLifecycleService,
    ServerHealthService,
    ServerMetricsService,
    ProcessManagerService,
    ProcessHealthService,
    ProcessErrorHandlerService,
    ProcessResourceMonitorService,
    ProcessLogMonitorService,
    SystemLogService,
    ManagementEventService,
  ],
  exports: [
    ServerManagerService,
    ServerLifecycleService,
    ManagedMcpLifecycleCoordinator,
    ServerHealthService,
    ServerMetricsService,
    ProcessManagerService,
    ProcessHealthService,
    ProcessErrorHandlerService,
    ProcessResourceMonitorService,
    ProcessLogMonitorService,
    SystemLogService,
    ManagementEventService,
  ],
})
export class ServersModule {}
