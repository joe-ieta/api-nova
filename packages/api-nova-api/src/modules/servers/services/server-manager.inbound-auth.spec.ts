import { McpInboundAuthMode, ServerStatus, TransportType } from '../../../database/entities/mcp-server.entity';
import { ServerManagerService } from './server-manager.service';

function fixture(status: ServerStatus, mode?: McpInboundAuthMode) {
  const server: any = {
    id: 'server-1', name: 'fixture', status, port: 9022,
    transport: TransportType.STREAMABLE, inboundAuthMode: mode,
  };
  const repository = {
    findOne: jest.fn().mockResolvedValue(server),
    save: jest.fn(async value => value),
  };
  const lifecycle = {
    preflightInboundAuth: jest.fn(),
    isPortAvailable: jest.fn().mockResolvedValue(true),
    startServer: jest.fn(),
  };
  const eventEmitter = { on: jest.fn(), emit: jest.fn() };
  const service = new ServerManagerService(
    repository as any, {} as any, lifecycle as any, {} as any, {} as any,
    {} as any, {} as any, eventEmitter as any,
    { createLog: jest.fn().mockResolvedValue(undefined) } as any,
  );
  return { service, lifecycle, repository, server };
}

describe('ServerManager MCP inbound preflight', () => {
  it('rejects an unknown mode before changing start state or checking port', async () => {
    const { service, lifecycle, repository } = fixture(ServerStatus.STOPPED);
    lifecycle.preflightInboundAuth.mockImplementation(() => { throw new Error('mode is required'); });
    await expect(service.startServer('server-1')).rejects.toThrow('mode is required');
    expect(lifecycle.isPortAvailable).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('checks credentials before stopping an existing process for restart', async () => {
    const { service, lifecycle } = fixture(ServerStatus.RUNNING, McpInboundAuthMode.PRIVATE_JWT);
    lifecycle.preflightInboundAuth.mockImplementation(() => { throw new Error('JWK set is required'); });
    const stop = jest.spyOn(service, 'stopServer').mockResolvedValue(undefined);
    await expect(service.restartServer('server-1')).rejects.toThrow('JWK set is required');
    expect(stop).not.toHaveBeenCalled();
  });

  it('retains the persisted mode through restart preflight and delegated start', async () => {
    const { service, lifecycle, server } = fixture(ServerStatus.RUNNING, McpInboundAuthMode.PRIVATE_API_KEY);
    const stop = jest.spyOn(service, 'stopServer').mockResolvedValue(undefined);
    const start = jest.spyOn(service, 'startServer').mockResolvedValue(undefined);
    await service.restartServer('server-1');
    expect(lifecycle.preflightInboundAuth).toHaveBeenCalledWith(server);
    expect(lifecycle.preflightInboundAuth.mock.invocationCallOrder[0]).toBeLessThan(stop.mock.invocationCallOrder[0]);
    expect(stop).toHaveBeenCalledWith('server-1');
    expect(start).toHaveBeenCalledWith('server-1', undefined);
  });
});
