import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';

import { OpenAPIService } from '../openapi/services/openapi.service';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { PermissionsGuard } from '../security/guards/permissions.guard';
import { ServersLifecycleController } from './controllers/servers-lifecycle.controller';
import { ManagementEventService } from './services/management-event.service';
import { ServerManagerService } from './services/server-manager.service';

describe('Servers controllers', () => {
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

  beforeEach(async () => {
    jest.clearAllMocks();

    const builder = Test.createTestingModule({
      controllers: [ServersLifecycleController],
      providers: [
        { provide: ServerManagerService, useValue: serverManager },
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

    lifecycleController = module.get<ServersLifecycleController>(ServersLifecycleController);
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
