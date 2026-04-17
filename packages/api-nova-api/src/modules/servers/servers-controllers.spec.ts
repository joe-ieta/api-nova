import { HttpException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';

import { OpenAPIService } from '../openapi/services/openapi.service';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { PermissionsGuard } from '../security/guards/permissions.guard';
import { ServersApiCenterController } from './controllers/servers-api-center.controller';
import { ServersLifecycleController } from './controllers/servers-lifecycle.controller';
import { ManagementEventService } from './services/management-event.service';
import { ApiManagementCenterService } from './services/api-management-center.service';
import { ServerManagerService } from './services/server-manager.service';

describe('Servers controllers', () => {
  let apiCenterController: ServersApiCenterController;
  let lifecycleController: ServersLifecycleController;

  const serverManager = {
    createServer: jest.fn(),
    getAllServers: jest.fn(),
    getServerById: jest.fn(),
    updateServer: jest.fn(),
    deleteServer: jest.fn(),
    getServerInstance: jest.fn(),
    startServer: jest.fn(),
    stopServer: jest.fn(),
    restartServer: jest.fn(),
  };

  const apiManagementCenter = {
    getOverview: jest.fn(),
    updateProfile: jest.fn(),
    probeEndpoint: jest.fn(),
    getPublishReadiness: jest.fn(),
    getProbeHistory: jest.fn(),
    registerManualEndpoint: jest.fn(),
    changeEndpointState: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const builder = Test.createTestingModule({
      controllers: [ServersApiCenterController, ServersLifecycleController],
      providers: [
        { provide: ServerManagerService, useValue: serverManager },
        { provide: ApiManagementCenterService, useValue: apiManagementCenter },
        { provide: ManagementEventService, useValue: { record: jest.fn() } },
        { provide: EventEmitter2, useValue: { emit: jest.fn(), once: jest.fn() } },
        { provide: OpenAPIService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: jest.fn().mockReturnValue(true) })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: jest.fn().mockReturnValue(true) });

    const module: TestingModule = await builder.compile();

    apiCenterController = module.get<ServersApiCenterController>(ServersApiCenterController);
    lifecycleController = module.get<ServersLifecycleController>(ServersLifecycleController);
  });

  it('should block publish when readiness check fails', async () => {
    apiManagementCenter.changeEndpointState.mockRejectedValue(
      new Error('Publish blocked: publishEnabled=false'),
    );

    await expect(
      apiCenterController.changeEndpointState('server-1', { action: 'publish' } as any, {} as any),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('returns API center overview', async () => {
    apiManagementCenter.getOverview.mockResolvedValue({
      total: 1,
      data: [{ id: 'server-1', name: 'health-endpoint' }],
    });

    await expect(apiCenterController.getApiCenterOverview({ sourceType: 'manual' } as any)).resolves.toEqual({
      total: 1,
      data: [{ id: 'server-1', name: 'health-endpoint' }],
    });
  });

  it('registers a manual endpoint', async () => {
    apiManagementCenter.registerManualEndpoint.mockResolvedValue({
      serverId: 'server-1',
      name: 'health-endpoint',
    });

    await expect(
      apiCenterController.registerManualEndpoint({
        name: 'health-endpoint',
        baseUrl: 'http://localhost:9001',
        method: 'GET',
        path: '/health',
      } as any, {} as any),
    ).resolves.toEqual({
      serverId: 'server-1',
      name: 'health-endpoint',
    });
  });

  it('returns probe result for an endpoint', async () => {
    apiManagementCenter.probeEndpoint.mockResolvedValue({
      serverId: 'server-1',
      probe: { status: 'healthy' },
    });

    await expect(apiCenterController.probeEndpoint('server-1', { path: '/health' } as any, {} as any)).resolves.toEqual({
      serverId: 'server-1',
      probe: { status: 'healthy' },
    });
    expect(apiManagementCenter.probeEndpoint).toHaveBeenCalledWith('server-1', { path: '/health' });
  });

  it('returns publish readiness', async () => {
    apiManagementCenter.getPublishReadiness.mockResolvedValue({
      serverId: 'server-1',
      ready: true,
      reasons: [],
    });

    await expect(apiCenterController.getPublishReadiness('server-1')).resolves.toEqual({
      serverId: 'server-1',
      ready: true,
      reasons: [],
    });
  });

  it('returns server details with openapi data for endpoint editing flows', async () => {
    serverManager.getServerById.mockResolvedValue({
      id: 'server-1',
      name: 'health-endpoint',
      openApiData: {
        openapi: '3.0.3',
        paths: {
          '/health': {
            get: {},
          },
        },
      },
      config: {
        management: {
          sourceType: 'manual',
          probeUrl: 'http://localhost:9001/health',
        },
      },
    });

    await expect(lifecycleController.getServerById('server-1')).resolves.toEqual({
      id: 'server-1',
      name: 'health-endpoint',
      openApiData: {
        openapi: '3.0.3',
        paths: {
          '/health': {
            get: {},
          },
        },
      },
      config: {
        management: {
          sourceType: 'manual',
          probeUrl: 'http://localhost:9001/health',
        },
      },
    });
  });

  it('updates a manual endpoint through the existing server update flow', async () => {
    serverManager.updateServer.mockResolvedValue({
      id: 'server-1',
      name: 'health-endpoint',
      description: 'updated',
    });

    await expect(
      lifecycleController.updateServer('server-1', {
        name: 'health-endpoint',
        description: 'updated',
        openApiData: {
          openapi: '3.0.3',
        },
        config: {
          management: {
            sourceType: 'manual',
          },
        },
      } as any, {} as any),
    ).resolves.toEqual({
      id: 'server-1',
      name: 'health-endpoint',
      description: 'updated',
    });
  });

  it('deletes a manual endpoint through the server delete flow', async () => {
    serverManager.deleteServer.mockResolvedValue(undefined);

    await expect(lifecycleController.deleteServer('server-1', {} as any)).resolves.toEqual({
      success: true,
      message: 'Server deleted successfully',
    });
  });
});
