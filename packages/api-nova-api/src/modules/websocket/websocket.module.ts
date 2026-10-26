import { CallObservabilityModule } from '../call-observability/call-observability.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';

import { DocumentsModule } from '../documents/documents.module';
import { MailModule } from '../mail/mail.module';
import { RuntimeAssetsModule } from '../runtime-assets/runtime-assets.module';
import { RuntimeObservabilityModule } from '../runtime-observability/runtime-observability.module';
import { ServersModule } from '../servers/servers.module';

import { MonitoringGateway } from './websocket.gateway';
import { AlertService } from './services/alert.service';
import { NotificationService } from './services/notification.service';
import { WebSocketMetricsService } from './services/websocket-metrics.service';

import { MCPServerEntity } from '../../database/entities/mcp-server.entity';
import { LogEntryEntity } from '../../database/entities/log-entry.entity';
import { User } from '../../database/entities/user.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([MCPServerEntity, LogEntryEntity, User]),
    EventEmitterModule,
    ConfigModule,
    HttpModule,
    MailModule,
    DocumentsModule,
    RuntimeAssetsModule,
    RuntimeObservabilityModule,
    CallObservabilityModule,
    ServersModule,
  ],
  providers: [
    MonitoringGateway,
    AlertService,
    NotificationService,
    WebSocketMetricsService,
  ],
  exports: [
    MonitoringGateway,
    AlertService,
    NotificationService,
    WebSocketMetricsService,
  ],
})
export class WebSocketModule {}
