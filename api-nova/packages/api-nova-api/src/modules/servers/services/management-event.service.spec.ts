import { AuditAction, AuditStatus } from '../../../database/entities/audit-log.entity';
import {
  SystemLogEventType,
  SystemLogStatus,
} from '../../../database/entities/system-log.entity';
import { AuditService } from '../../security/services/audit.service';
import { SystemLogService } from './system-log.service';
import { ManagementEventService } from './management-event.service';

describe('ManagementEventService', () => {
  let service: ManagementEventService;

  const systemLogService = {
    createLog: jest.fn(),
  };

  const auditService = {
    log: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ManagementEventService(
      systemLogService as unknown as SystemLogService,
      auditService as unknown as AuditService,
    );
  });

  it('writes both system log and audit log for mapped actions', async () => {
    await service.record({
      action: 'server.create',
      message: 'Server created',
      source: 'test',
      eventType: SystemLogEventType.SERVER_CREATED,
      serverId: 'server-1',
      actorId: 'user-1',
      status: SystemLogStatus.SUCCESS,
    });

    expect(systemLogService.createLog).toHaveBeenCalledTimes(1);
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.SERVER_CREATED,
        status: AuditStatus.SUCCESS,
        resource: 'server',
        resourceId: 'server-1',
        userId: 'user-1',
      }),
    );
  });

  it('skips audit bridge for unmapped actions', async () => {
    await service.record({
      action: 'monitoring.snapshot.refresh',
      message: 'Snapshot refreshed',
      source: 'test',
      eventType: SystemLogEventType.SYSTEM_STARTUP,
    });

    expect(systemLogService.createLog).toHaveBeenCalledTimes(1);
    expect(auditService.log).not.toHaveBeenCalled();
  });

  it('maps failed status into failed audit entries for server actions', async () => {
    await service.record({
      action: 'server.update',
      message: 'Server update failed',
      source: 'test',
      eventType: SystemLogEventType.SERVER_CONFIG_CHANGED,
      serverId: 'server-2',
      status: SystemLogStatus.FAILED,
    });

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.SERVER_UPDATED,
        status: AuditStatus.FAILED,
        resource: 'server',
      }),
    );
  });
});
