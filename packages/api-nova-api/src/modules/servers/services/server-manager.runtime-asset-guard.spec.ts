import { ServerStatus, TransportType } from '../../../database/entities/mcp-server.entity';
import { ServerManagerService } from './server-manager.service';

describe('ServerManagerService runtime asset guard', () => {
  const serverRepository = {
    findOne: jest.fn(),
  };
  const eventEmitter = { on: jest.fn(), emit: jest.fn() };
  const service = new ServerManagerService(
    serverRepository as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    eventEmitter as any,
    {} as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    serverRepository.findOne.mockResolvedValue({
      id: 'server-1',
      name: 'orders-mcp',
      port: 9022,
      transport: TransportType.STREAMABLE,
      status: ServerStatus.STOPPED,
      config: {
        managedByRuntimeAsset: true,
        runtimeAssetId: 'runtime-1',
        verifiedCandidateRevision: 'revision-1',
      },
    });
  });

  it('rejects direct start of a Runtime Asset managed server', async () => {
    await expect(service.startServer('server-1')).rejects.toThrow(
      'must be started or restarted through Runtime Assets verification',
    );
  });

  it('rejects direct restart of a Runtime Asset managed server', async () => {
    await expect(service.restartServer('server-1')).rejects.toThrow(
      'must be started or restarted through Runtime Assets verification',
    );
  });
});
