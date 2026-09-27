import 'reflect-metadata';
import { McpInboundAuthMode, ServerStatus, TransportType } from '../../../database/entities/mcp-server.entity';
import { ServerLifecycleService } from './server-lifecycle.service';
import { ServerManagerService } from './server-manager.service';

const RUNTIME = '00000000-0000-0000-0000-000000000001';

function serverEntity(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    name: 'trusted-fixture',
    port: 9044,
    transport: TransportType.STREAMABLE,
    status: ServerStatus.STOPPED,
    inboundAuthMode: McpInboundAuthMode.PRIVATE_API_KEY,
    openApiData: { openapi: '3.0.3', info: { title: 'fixture', version: '1' }, paths: {} },
    config: { executionMode: 'trusted_ipc_v1', runtimeAssetId: RUNTIME },
    ...overrides,
  } as any;
}

function lifecycleFixture(coordinator?: any) {
  const service: any = Object.create(ServerLifecycleService.prototype);
  service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  service.serverTimeouts = new Map();
  service.preflightInboundAuth = jest.fn(async () => 'private_api_key');
  service.validateOpenApiData = jest.fn().mockResolvedValue(undefined);
  service.resolveManagedCliPath = jest.fn().mockReturnValue('synthetic-cli.js');
  service.configService = { get: jest.fn((_key: string, fallback: unknown) => fallback) };
  service.appConfigService = { port: 3000, apiBaseUrl: 'http://127.0.0.1:3000' };
  service.processManager = { startProcess: jest.fn(async () => ({ pid: 123 })), stopProcess: jest.fn(async () => undefined) };
  service.processHealth = { startHealthCheck: jest.fn().mockResolvedValue(undefined), stopHealthCheck: jest.fn() };
  service.eventEmitter = { emit: jest.fn() };
  service.recordRuntimeLifecycleEvent = jest.fn().mockResolvedValue(undefined);
  service.managedLifecycle = coordinator;
  return service;
}

const coordinator = () => ({
  start: jest.fn(async () => ({ pid: 4242, generation: 3 })),
  stop: jest.fn(async () => ({ status: 'stopped', generation: 3 })),
});

describe('trusted_ipc_v1 ServerLifecycleService routing', () => {
  it('routes a trusted start through the managed coordinator without legacy spawn or health checks', async () => {
    const managed = coordinator();
    const service = lifecycleFixture(managed);
    const result = await service.startServer(serverEntity());
    expect(managed.start).toHaveBeenCalledWith({ serverId: 's1', runtimeAssetId: RUNTIME });
    expect(service.processManager.startProcess).not.toHaveBeenCalled();
    expect(service.processHealth.startHealthCheck).not.toHaveBeenCalled();
    expect(result).toEqual({ mcpServer: null, httpServer: null, endpoint: 'http://127.0.0.1:9044/mcp' });
    expect(service.eventEmitter.emit).toHaveBeenCalledWith('server.lifecycle.started', expect.objectContaining({ pid: 4242 }));
  });

  it('routes a trusted stop through the managed coordinator without the legacy process manager', async () => {
    const managed = coordinator();
    const service = lifecycleFixture(managed);
    await service.stopServer({ id: 's1', entity: serverEntity({ status: ServerStatus.RUNNING }) });
    expect(managed.stop).toHaveBeenCalledWith('s1');
    expect(service.processManager.stopProcess).not.toHaveBeenCalled();
    expect(service.processHealth.stopHealthCheck).toHaveBeenCalledWith('s1');
  });

  it('fails closed for a trusted server when the coordinator is unavailable', async () => {
    const service = lifecycleFixture(undefined);
    await expect(service.startServer(serverEntity())).rejects.toThrow('Managed lifecycle coordinator unavailable');
    expect(service.processManager.startProcess).not.toHaveBeenCalled();
    expect(service.eventEmitter.emit).toHaveBeenCalledWith('server.lifecycle.start_failed', expect.anything());
  });

  it('keeps the legacy CLI path for servers without the explicit trusted_ipc_v1 mode', async () => {
    const managed = coordinator();
    const service = lifecycleFixture(managed);
    await service.startServer(serverEntity({ config: { runtimeAssetId: RUNTIME } }));
    expect(managed.start).not.toHaveBeenCalled();
    expect(service.processManager.startProcess).toHaveBeenCalledTimes(1);
  });

  it('fails closed before spawn when trusted mode still carries legacy bearer credentials', async () => {
    const managed = coordinator();
    const service = lifecycleFixture(managed);
    const failure = await service.startServer(serverEntity({
      authConfig: { type: 'bearer', config: { bearerToken: 'synthetic-legacy-token' } },
    })).then(() => null, (error: Error) => error);
    expect(failure!.message).toBe('MCP_MANAGED_LEGACY_CREDENTIALS_REJECTED');
    expect(JSON.stringify(failure!.message)).not.toContain('synthetic-legacy-token');
    expect(managed.start).not.toHaveBeenCalled();
    expect(service.processManager.startProcess).not.toHaveBeenCalled();
  });

  it('fails closed before spawn when trusted mode still carries legacy custom headers', async () => {
    const managed = coordinator();
    const service = lifecycleFixture(managed);
    await expect(service.startServer(serverEntity({
      config: { executionMode: 'trusted_ipc_v1', runtimeAssetId: RUNTIME,
        customHeaders: { Authorization: 'Bearer synthetic-legacy-header' } },
    }))).rejects.toThrow('MCP_MANAGED_LEGACY_CREDENTIALS_REJECTED');
    expect(managed.start).not.toHaveBeenCalled();
    expect(service.processManager.startProcess).not.toHaveBeenCalled();
  });

  it('allows a trusted server with an explicit none auth config and no custom headers', async () => {
    const managed = coordinator();
    const service = lifecycleFixture(managed);
    await service.startServer(serverEntity({ authConfig: { type: 'none', config: {} } }));
    expect(managed.start).toHaveBeenCalledTimes(1);
  });
});

describe('trusted_ipc_v1 managed failure projection', () => {
  function managerHarness(
    start: jest.Mock = jest.fn(async () => ({ endpoint: 'http://127.0.0.1:9044/mcp' })),
    status: ServerStatus = ServerStatus.RUNNING,
  ) {
    const serverRepository = {
      findOne: jest.fn(async () => serverEntity({ status })),
      find: jest.fn(async () => []),
      save: jest.fn(async (value: unknown) => value),
      update: jest.fn(async (..._args: any[]) => ({ affected: 1 })),
    };
    const logRepository = { save: jest.fn(async (value: unknown) => value) };
    const listeners = new Map<string, (event: any) => Promise<void>>();
    const eventEmitter = {
      on: jest.fn((name: string, handler: (event: any) => Promise<void>) => { listeners.set(name, handler); }),
      emit: jest.fn(),
    };
    const lifecycleService = {
      startServer: start,
      stopServer: jest.fn(async () => undefined),
      preflightInboundAuth: jest.fn(async () => 'private_api_key'),
      isPortAvailable: jest.fn(async () => true),
    };
    const systemLogService = { createLog: jest.fn(async () => undefined) };
    const manager = new ServerManagerService(
      serverRepository as any,
      logRepository as any,
      lifecycleService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      eventEmitter as any,
      systemLogService as any,
    );
    return { manager, serverRepository, listeners, eventEmitter };
  }

  const statuses = (repository: { update: jest.Mock }) =>
    repository.update.mock.calls.map(call => (call[1] as any).status);

  it('projects a managed runtime failure to ERROR without any false RUNNING', async () => {
    const h = managerHarness();
    const listener = h.listeners.get('managed.lifecycle.changed');
    expect(listener).toBeDefined();
    await listener!({ serverId: 's1', runtimeAssetId: RUNTIME, generation: 3,
      state: 'failed', reason: 'runtime_failed', code: 'MANAGED_CHILD_EXITED' });
    expect(statuses(h.serverRepository)).toContain(ServerStatus.ERROR);
    expect(statuses(h.serverRepository)).not.toContain(ServerStatus.RUNNING);
    const errorMessage = h.serverRepository.update.mock.calls
      .map(call => (call[1] as any).errorMessage).filter(Boolean).join('|');
    expect(errorMessage).toContain('MANAGED_CHILD_EXITED');
    expect(JSON.stringify(h.serverRepository.update.mock.calls)).not.toContain('openApiData');
  });

  it('projects an abandoned managed generation to ERROR', async () => {
    const h = managerHarness();
    const listener = h.listeners.get('managed.lifecycle.changed')!;
    await listener({ serverId: 's1', runtimeAssetId: RUNTIME, generation: 1,
      state: 'abandoned', reason: 'unverified_discovered_child', code: null });
    expect(statuses(h.serverRepository)).toContain(ServerStatus.ERROR);
  });

  it('projects ERROR and never STARTING/RUNNING when trusted bootstrap fails', async () => {
    const h = managerHarness(jest.fn(async () => { throw new Error('MANAGED_LIFECYCLE_CHANNEL_FAILED'); }),
      ServerStatus.STOPPED);
    await expect(h.manager.startServer('s1')).rejects.toThrow('MANAGED_LIFECYCLE_CHANNEL_FAILED');
    expect(statuses(h.serverRepository)).toContain(ServerStatus.ERROR);
    expect(statuses(h.serverRepository)).not.toContain(ServerStatus.STARTING);
    expect(statuses(h.serverRepository)).not.toContain(ServerStatus.RUNNING);
  });

  it('ignores managed lifecycle notifications while the same server is starting', async () => {
    const h = managerHarness();
    const listener = h.listeners.get('managed.lifecycle.changed')!;
    const internal = h.manager as any;
    internal.startingServers.add('s1');
    try {
      await listener({ serverId: 's1', runtimeAssetId: RUNTIME, generation: 1,
        state: 'failed', reason: 'runtime_failed', code: 'MANAGED_CHILD_EXITED' });
      expect(statuses(h.serverRepository)).not.toContain(ServerStatus.ERROR);
    } finally {
      internal.startingServers.delete('s1');
    }
  });
});

describe('trusted_ipc_v1 ServerManagerService state projection', () => {
  const serverRepository = {
    findOne: jest.fn(),
    find: jest.fn(async () => []),
    save: jest.fn(async (value: unknown) => value),
    update: jest.fn(async (..._args: any[]) => ({ affected: 1 })),
  };
  const logRepository = { save: jest.fn(async (value: unknown) => value) };
  const eventEmitter = { on: jest.fn(), emit: jest.fn() };
  const lifecycleService = {
    startServer: jest.fn(async () => ({ endpoint: 'http://127.0.0.1:9044/mcp' })),
    stopServer: jest.fn(async () => undefined),
    preflightInboundAuth: jest.fn(async () => 'private_api_key'),
    isPortAvailable: jest.fn(async () => true),
  };
  const systemLogService = { createLog: jest.fn(async () => undefined) };
  const manager = new ServerManagerService(
    serverRepository as any,
    logRepository as any,
    lifecycleService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    eventEmitter as any,
    systemLogService as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    serverRepository.findOne.mockResolvedValue(serverEntity({ status: ServerStatus.STOPPED }));
  });

  const statuses = () => serverRepository.update.mock.calls.map(call => (call[1] as any).status);

  it('does not project STARTING before READY and reaches RUNNING only after the coordinator returns', async () => {
    await manager.startServer('s1');
    expect(statuses()).not.toContain(ServerStatus.STARTING);
    expect(statuses()).toContain(ServerStatus.RUNNING);
    expect(lifecycleService.startServer).toHaveBeenCalledTimes(1);
  });

  it('still projects STARTING for the legacy path', async () => {
    serverRepository.findOne.mockResolvedValue(serverEntity({ config: { runtimeAssetId: RUNTIME } }));
    await manager.startServer('s1');
    expect(statuses()).toContain(ServerStatus.STARTING);
    expect(statuses()).toContain(ServerStatus.RUNNING);
  });

  it('stops a discovered trusted server even without an in-memory instance', async () => {
    serverRepository.findOne.mockResolvedValue(serverEntity({ status: ServerStatus.RUNNING }));
    await manager.stopServer('s1');
    expect(lifecycleService.stopServer).toHaveBeenCalledTimes(1);
    expect(statuses()).toContain(ServerStatus.STOPPING);
    expect(statuses()).toContain(ServerStatus.STOPPED);
  });
});
