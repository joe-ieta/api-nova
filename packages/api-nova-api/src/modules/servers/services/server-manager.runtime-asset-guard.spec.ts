import { McpInboundAuthMode, ServerStatus, TransportType } from '../../../database/entities/mcp-server.entity';
import { ServerManagerService } from './server-manager.service';

describe('ServerManagerService runtime asset guard', () => {
  const serverRepository = {
    findOne: jest.fn(),
    save: jest.fn(async value => value),
  };
  const logRepository = { save: jest.fn(async value => value) };
  const eventEmitter = { on: jest.fn(), emit: jest.fn() };
  const service = new ServerManagerService(
    serverRepository as any,
    logRepository as any,
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

  it('does not let a generic update relabel a running legacy server', async () => {
    const legacy = {
      id: 'server-1', name: 'legacy-mcp', status: ServerStatus.RUNNING,
      transport: TransportType.STREAMABLE,
    };
    serverRepository.findOne.mockResolvedValue(legacy);
    await expect(service.updateServer('server-1', {
      inboundAuthMode: McpInboundAuthMode.PRIVATE_API_KEY,
    })).rejects.toThrow('Cannot change inbound authentication mode while server is running');
    expect((legacy as any).inboundAuthMode).toBeUndefined();
  });

  it('keeps unrelated updates to a running legacy server available without changing its mode', async () => {
    const legacy = {
      id: 'server-1', name: 'legacy-mcp', status: ServerStatus.RUNNING,
      transport: TransportType.STREAMABLE,
    };
    serverRepository.findOne.mockResolvedValue(legacy);
    await expect(service.updateServer('server-1', { description: 'updated' })).resolves.toMatchObject({
      description: 'updated', inboundAuthMode: 'unknown', effectiveInboundAuthMode: 'unknown',
      status: ServerStatus.RUNNING,
    });
    expect((legacy as any).inboundAuthMode).toBeUndefined();
    expect(serverRepository.save).toHaveBeenCalledWith(legacy);
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
