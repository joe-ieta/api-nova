import { Injectable, Logger } from '@nestjs/common';
import {
  AuditAction,
  AuditLevel,
  AuditStatus,
} from '../../../database/entities/audit-log.entity';

import {
  SystemLogEventType,
  SystemLogLevel,
  SystemLogStatus,
} from '../../../database/entities/system-log.entity';
import { AuditService } from '../../security/services/audit.service';
import { SystemLogService } from './system-log.service';

export interface RecordManagementEventInput {
  action: string;
  message: string;
  source: string;
  eventType: SystemLogEventType;
  serverId?: string;
  serverName?: string;
  serverPort?: number;
  actorId?: string;
  requestId?: string;
  traceId?: string;
  status?: SystemLogStatus;
  level?: SystemLogLevel;
  details?: Record<string, any>;
}

@Injectable()
export class ManagementEventService {
  private readonly logger = new Logger(ManagementEventService.name);

  constructor(
    private readonly systemLogService: SystemLogService,
    private readonly auditService: AuditService,
  ) {}

  async record(input: RecordManagementEventInput): Promise<void> {
    try {
      await this.systemLogService.createLog({
        serverId: input.serverId,
        eventType: input.eventType,
        description: input.message,
        level: input.level ?? SystemLogLevel.INFO,
        status: input.status ?? SystemLogStatus.SUCCESS,
        source: input.source,
        userId: input.actorId,
        serverName: input.serverName,
        serverPort: input.serverPort,
        details: {
          action: input.action,
          actorId: input.actorId,
          traceId: input.traceId,
          requestId: input.requestId,
          telemetryMode: 'derived',
          ...input.details,
        },
        metadata: {
          requestId: input.requestId,
          correlationId: input.traceId,
          category: 'management-operation',
          action: input.action,
        },
      });
    } catch (error) {
      this.logger.warn(`Failed to persist management event ${input.action}: ${error.message}`);
    }

    const auditAction = this.toAuditAction(input.action);
    if (!auditAction) {
      return;
    }

    try {
      await this.auditService.log({
        action: auditAction,
        level: this.toAuditLevel(input.level),
        status: this.toAuditStatus(input.status),
        userId: input.actorId,
        resource: this.toAuditResource(input.action),
        resourceId: input.serverId,
        details: {
          message: input.message,
          source: input.source,
          requestId: input.requestId,
          traceId: input.traceId,
          eventType: input.eventType,
          ...input.details,
        },
        metadata: {
          category: 'management-operation',
          serverName: input.serverName,
          serverPort: input.serverPort,
        },
      });
    } catch (error) {
      this.logger.warn(`Failed to persist management audit ${input.action}: ${error.message}`);
    }
  }

  private toAuditAction(action: string): AuditAction | null {
    switch (action) {
      case 'server.create':
        return AuditAction.SERVER_CREATED;
      case 'server.update':
        return AuditAction.SERVER_UPDATED;
      case 'server.delete':
        return AuditAction.SERVER_DELETED;
      case 'server.start':
        return AuditAction.SERVER_STARTED;
      case 'server.stop':
        return AuditAction.SERVER_STOPPED;
      case 'server.restart':
        return AuditAction.SERVER_RESTARTED;
      default:
        return null;
    }
  }

  private toAuditLevel(level?: SystemLogLevel): AuditLevel {
    switch (level) {
      case SystemLogLevel.CRITICAL:
        return AuditLevel.CRITICAL;
      case SystemLogLevel.ERROR:
        return AuditLevel.ERROR;
      case SystemLogLevel.WARNING:
        return AuditLevel.WARNING;
      default:
        return AuditLevel.INFO;
    }
  }

  private toAuditStatus(status?: SystemLogStatus): AuditStatus {
    switch (status) {
      case SystemLogStatus.FAILED:
        return AuditStatus.FAILED;
      case SystemLogStatus.IN_PROGRESS:
        return AuditStatus.PENDING;
      default:
        return AuditStatus.SUCCESS;
    }
  }

  private toAuditResource(action: string): string {
    if (action.startsWith('server.')) {
      return 'server';
    }
    return 'management';
  }
}
