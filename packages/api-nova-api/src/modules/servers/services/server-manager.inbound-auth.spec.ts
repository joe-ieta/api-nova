import { McpInboundAuthMode, ServerStatus, TransportType } from '../../../database/entities/mcp-server.entity';
import { ServerLifecycleService } from './server-lifecycle.service';
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

// The repository and launch side effects are isolated; both public server start and
// onModuleInit use the real lifecycle credential preflight (not a rejecting mock).
describe('SEC-A2-01B persisted mode server start and startup recovery matrix', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('API_NOVA_RUNTIME_') || key === 'API_NOVA_MCP_RESOURCE') delete process.env[key];
    }
    process.env.NODE_ENV = 'development';
    // A permissive global environment must never fill a missing persisted mode.
    process.env.API_NOVA_RUNTIME_AUTH_MODE = 'anonymous';
    process.env.API_NOVA_MCP_RESOURCE = 'https://matrix.example/mcp';
  });
  afterAll(() => { process.env = saved; });

  function matrixFixture(mode: unknown) {
    const f = fixture(ServerStatus.STOPPED, mode as McpInboundAuthMode);
    const service = f.service as any;
    service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    f.server.autoStart = true;
    f.lifecycle.preflightInboundAuth.mockImplementation(server =>
      ServerLifecycleService.prototype.preflightInboundAuth.call({}, server));
    f.lifecycle.startServer.mockResolvedValue({ endpoint: 'http://127.0.0.1:9022/mcp' });
    (f.repository as any).find = jest.fn().mockResolvedValue([f.server]);
    jest.spyOn(service, 'checkAndCleanDuplicateServers').mockResolvedValue(undefined);
    const statuses: string[] = [];
    jest.spyOn(service, 'updateServerStatus').mockImplementation(async (...args: any[]) => {
      statuses.push(args[1]);
    });
    jest.spyOn(service, 'logInfo').mockResolvedValue(undefined);
    const errors = jest.spyOn(service, 'logError').mockResolvedValue(undefined);
    return { ...f, statuses, errors };
  }

  const rejected: Array<[string, unknown, string]> = [
    ['legacy missing', undefined, 'mode is required'],
    ['legacy null', null, 'mode is required'],
    ['unknown', 'unknown', 'mode is required'],
    ['invalid', 'public', 'mode is required'],
    ['private API key without credentials', McpInboundAuthMode.PRIVATE_API_KEY, 'API key configuration'],
    ['private JWT without credentials', McpInboundAuthMode.PRIVATE_JWT, 'JWK set are required'],
  ];
  it.each(rejected)('server start rejects %s before state or launch', async (_label, mode, message) => {
    const f = matrixFixture(mode);
    await expect(f.service.startServer(f.server.id)).rejects.toThrow(message);
    expect(f.lifecycle.startServer).not.toHaveBeenCalled();
    expect(f.lifecycle.isPortAvailable).not.toHaveBeenCalled();
    expect(f.statuses).toEqual([]);
  });

  it.each(rejected)('application startup recovery rejects %s and records failure', async (_label, mode, message) => {
    const f = matrixFixture(mode);
    await f.service.onModuleInit();
    expect(f.lifecycle.preflightInboundAuth).toHaveBeenCalledWith(f.server);
    expect(f.lifecycle.startServer).not.toHaveBeenCalled();
    expect(f.statuses).not.toContain(ServerStatus.STARTING);
    expect(f.statuses).not.toContain(ServerStatus.RUNNING);
    expect(f.errors).toHaveBeenCalledWith(f.server.id, 'Auto-start failed', expect.objectContaining({ message: expect.stringContaining(message) }));
    expect(f.server.inboundAuthMode).toBe(mode);
  });

  it.each(['server start', 'recovery'])('%s accepts only explicitly persisted development anonymous', async entry => {
    const f = matrixFixture(McpInboundAuthMode.ANONYMOUS);
    if (entry === 'server start') await f.service.startServer(f.server.id);
    else await f.service.onModuleInit();
    expect(f.lifecycle.startServer).toHaveBeenCalledWith(expect.objectContaining({ inboundAuthMode: McpInboundAuthMode.ANONYMOUS }));
    expect(f.lifecycle.preflightInboundAuth.mock.results[0].value).toBe('anonymous');
    expect(f.statuses).toEqual([ServerStatus.STARTING, ServerStatus.RUNNING]);
    expect(f.server.inboundAuthMode).toBe('anonymous');
  });
});
