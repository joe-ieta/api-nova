import { Test, TestingModule } from '@nestjs/testing';

import { MonitoringController } from './monitoring.controller';
import { MCPMonitoringService } from '../../services/monitoring.service';
import { AuditService } from '../security/services/audit.service';
import { SystemLogService } from '../servers/services/system-log.service';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { PermissionsGuard } from '../security/guards/permissions.guard';

describe('MonitoringController', () => {
  let controller: MonitoringController;

  const monitoringService = {
    getMetrics: jest.fn(),
    getHealthStatus: jest.fn(),
    getRecentEvents: jest.fn(),
    getEventsByType: jest.fn(),
  };

  const auditService = {
    getAuditStats: jest.fn(),
    findLogs: jest.fn(),
  };

  const systemLogService = {
    queryLogs: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MonitoringController],
      providers: [
        { provide: MCPMonitoringService, useValue: monitoringService },
        { provide: AuditService, useValue: auditService },
        { provide: SystemLogService, useValue: systemLogService },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: jest.fn().mockReturnValue(true) })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: jest.fn().mockReturnValue(true) })
      .compile();

    controller = module.get<MonitoringController>(MonitoringController);
  });

  it('returns management overview', async () => {
    monitoringService.getMetrics.mockReturnValue({ apiCalls: 1 });
    monitoringService.getHealthStatus.mockReturnValue({ status: 'healthy' });
    monitoringService.getRecentEvents.mockReturnValue([{ type: 'api_call' }]);
    auditService.getAuditStats.mockResolvedValue({ totalLogs: 2 });
    systemLogService.queryLogs.mockResolvedValue({ logs: [{ id: 'log-1' }] });

    await expect(controller.getManagementOverview(7, 10)).resolves.toEqual({
      status: 'success',
      data: {
        metrics: { apiCalls: 1 },
        health: { status: 'healthy' },
        auditStats: { totalLogs: 2 },
        recentRuntimeEvents: [{ type: 'api_call' }],
        recentManagementLogs: [{ id: 'log-1' }],
      },
    });
  });

  it('returns management events', async () => {
    systemLogService.queryLogs.mockResolvedValue({ logs: [], total: 0 });

    await expect(controller.getManagementEvents(1, 20, undefined, 'server-1')).resolves.toEqual({
      status: 'success',
      data: { logs: [], total: 0 },
    });
  });

  it('returns management audit stream', async () => {
    auditService.findLogs.mockResolvedValue({ data: [], total: 0 });

    await expect(controller.getManagementAudit(1, 20, 'success', 'server')).resolves.toEqual({
      status: 'success',
      data: { data: [], total: 0 },
    });
  });
});
