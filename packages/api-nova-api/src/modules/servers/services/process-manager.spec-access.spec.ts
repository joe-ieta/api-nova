import { EventEmitter } from 'node:events';
import { spawn } from 'child_process';
import { ProcessManagerService } from './process-manager.service';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: jest.fn(),
}));

const mockedSpawn = spawn as jest.MockedFunction<typeof spawn>;

function fixture() {
  const service: any = Object.create(ProcessManagerService.prototype);
  const events = { emit: jest.fn() };
  service.logger = { log: jest.fn(), error: jest.fn(), debug: jest.fn() };
  service.config = {};
  service.appConfigService = { processTimeout: 30000, processMaxRetries: 1, processRestartDelay: 1 };
  service.processes = new Map();
  service.processInfo = new Map();
  service.eventEmitter = events;
  service.logProcess = jest.fn().mockResolvedValue(undefined);
  service.updateProcessStatus = jest.fn().mockResolvedValue(undefined);
  service.resourceMonitor = { startMonitoring: jest.fn() };
  service.logMonitor = { startLogMonitoring: jest.fn() };
  service.setupProcessListeners = jest.fn();
  service.setupProcessOutputMonitoring = jest.fn();
  service.writePidFile = jest.fn().mockResolvedValue(undefined);
  service.processInfoRepository = { create: jest.fn(value => value), save: jest.fn().mockResolvedValue(undefined) };
  const child: any = new EventEmitter();
  child.pid = 12345;
  mockedSpawn.mockReturnValue(child);
  return { service, events };
}

function config(runtimeAssetId?: string) {
  return {
    id: 'server-1', name: 'fixture', scriptPath: 'node', args: ['fixture.js'],
    env: { API_NOVA_RUNTIME_AUTH_MODE: 'anonymous', MCP_MANAGED: 'true' },
    mcpConfig: { transport: 'streamable', managed: true, inboundAuthMode: 'anonymous', runtimeAssetId },
  } as any;
}

describe('managed runtime spec access credential at spawn', () => {
  beforeEach(() => jest.clearAllMocks());

  it('injects a runtime-asset bound spec credential only into the ephemeral child env', async () => {
    const { service, events } = fixture();
    const minted = `apinova-spec-v1.payload.${'a'.repeat(43)}`;
    service.runtimeSpecAccess = { mint: jest.fn(() => minted) };
    const input = config('00000000-0000-0000-0000-0000000000a1');
    const result = await service.startProcess(input);
    expect(service.runtimeSpecAccess.mint).toHaveBeenCalledWith({
      runtimeAssetId: '00000000-0000-0000-0000-0000000000a1', serverId: 'server-1',
    });
    const childEnv = mockedSpawn.mock.calls[0][2]!.env!;
    expect(childEnv.API_NOVA_RUNTIME_SPEC_ACCESS_TOKEN).toBe(minted);
    expect(result.config.env.API_NOVA_RUNTIME_SPEC_ACCESS_TOKEN).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(minted);
    expect(JSON.stringify(events.emit.mock.calls)).not.toContain(minted);
  });

  it('does not mint for preflight-only calls, unmanaged processes or processes without a runtime asset', async () => {
    const { service } = fixture();
    service.runtimeSpecAccess = { mint: jest.fn(() => 'apinova-spec-v1.payload.sig') };
    await service.preflightProcessEnvironment(config('00000000-0000-0000-0000-0000000000a1'));
    expect(service.runtimeSpecAccess.mint).not.toHaveBeenCalled();
    await service.startProcess(config(undefined));
    expect(service.runtimeSpecAccess.mint).not.toHaveBeenCalled();
    const unmanaged = config('00000000-0000-0000-0000-0000000000a1');
    unmanaged.mcpConfig.managed = false;
    await service.preflightProcessEnvironment(unmanaged, true);
    expect(service.runtimeSpecAccess.mint).not.toHaveBeenCalled();
  });

  it('keeps spawning without a spec credential when the access service is not wired; the child then fails closed on its own fetch', async () => {
    const { service } = fixture();
    await service.startProcess(config('00000000-0000-0000-0000-0000000000a1'));
    const childEnv = mockedSpawn.mock.calls[0][2]!.env!;
    expect(childEnv.API_NOVA_RUNTIME_SPEC_ACCESS_TOKEN).toBeUndefined();
  });
});
