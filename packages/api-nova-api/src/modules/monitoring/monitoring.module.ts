import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MCPMonitoringService } from '../../services/monitoring.service';
import { MonitoringController } from './monitoring.controller';
import { SecurityModule } from '../security/security.module';
import { ServersModule } from '../servers/servers.module';

@Module({
  imports: [EventEmitterModule, SecurityModule, ServersModule],
  controllers: [MonitoringController],
  providers: [MCPMonitoringService],
  exports: [MCPMonitoringService],
})
export class MonitoringModule {}
