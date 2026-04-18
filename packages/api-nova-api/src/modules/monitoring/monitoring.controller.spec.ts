import { Test, TestingModule } from '@nestjs/testing';

import { MonitoringController } from './monitoring.controller';
import { RuntimeObservabilityService } from '../runtime-observability/services/runtime-observability.service';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { PermissionsGuard } from '../security/guards/permissions.guard';

describe('MonitoringController', () => {
  let controller: MonitoringController;

  const runtimeObservabilityService = {
    getManagementOverview: jest.fn(),
    getRecentManagementEvents: jest.fn(),
    getRecentManagementErrorEvents: jest.fn(),
    queryManagementEvents: jest.fn(),
    queryManagementAudit: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MonitoringController],
      providers: [
        { provide: RuntimeObservabilityService, useValue: runtimeObservabilityService },
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
    runtimeObservabilityService.getManagementOverview.mockResolvedValue({
      metrics: { totalRuntimeAssets: 1 },
      health: { status: 'healthy' },
      auditStats: { totalLogs: 2 },
      recentRuntimeEvents: [{ id: 'evt-1' }],
      recentManagementLogs: [{ id: 'evt-2' }],
    });

    await expect(controller.getManagementOverview(7, 10)).resolves.toEqual({
      status: 'success',
      data: {
        metrics: { totalRuntimeAssets: 1 },
        health: { status: 'healthy' },
        auditStats: { totalLogs: 2 },
        recentRuntimeEvents: [{ id: 'evt-1' }],
        recentManagementLogs: [{ id: 'evt-2' }],
      },
    });
  });

  it('returns monitoring metrics from runtime overview', async () => {
    runtimeObservabilityService.getManagementOverview.mockResolvedValue({
      metrics: { totalRuntimeAssets: 3 },
    });

    await expect(controller.getMetrics()).resolves.toEqual({
      status: 'success',
      data: { totalRuntimeAssets: 3 },
    });
  });

  it('returns monitoring health from runtime overview', async () => {
    runtimeObservabilityService.getManagementOverview.mockResolvedValue({
      health: { status: 'healthy' },
    });

    await expect(controller.getHealth()).resolves.toEqual({
      status: 'success',
      data: { status: 'healthy' },
    });
  });

  it('returns management events', async () => {
    runtimeObservabilityService.queryManagementEvents.mockResolvedValue({
      data: [],
      total: 0,
    });

    await expect(controller.getManagementEvents(1, 20, undefined, 'runtime-1')).resolves.toEqual({
      status: 'success',
      data: { data: [], total: 0 },
    });
  });

  it('returns recent runtime events', async () => {
    runtimeObservabilityService.getRecentManagementEvents.mockResolvedValue([
      { id: 'evt-1' },
    ]);

    await expect(controller.getEvents(10)).resolves.toEqual({
      status: 'success',
      data: [{ id: 'evt-1' }],
    });
  });

  it('returns recent runtime error events', async () => {
    runtimeObservabilityService.getRecentManagementErrorEvents.mockResolvedValue([
      { id: 'evt-err-1' },
    ]);

    await expect(controller.getErrorEvents(10)).resolves.toEqual({
      status: 'success',
      data: [{ id: 'evt-err-1' }],
    });
  });

  it('returns management audit stream', async () => {
    runtimeObservabilityService.queryManagementAudit.mockResolvedValue({
      data: [],
      total: 0,
    });

    await expect(controller.getManagementAudit(1, 20, 'success', 'server')).resolves.toEqual({
      status: 'success',
      data: { data: [], total: 0 },
    });
  });
});
