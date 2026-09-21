import { EventEmitter } from 'node:events';
import { spawn } from 'child_process';
import { ProcessManagerService } from './process-manager.service';
import { ProcessConfig } from '../interfaces/process.interface';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: jest.fn(),
}));

const mockedSpawn = spawn as jest.MockedFunction<typeof spawn>;
const secret = 'real-api-key-secret';
const resource = 'https://runtime.example/mcp';

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
  service.processInfoRepository = {
    create: jest.fn(value => value),
    save: jest.fn().mockResolvedValue(undefined),
  };
  const child: any = new EventEmitter();
  child.pid = 12345;
  mockedSpawn.mockReturnValue(child);
  return { service, events };
}

function config(mode: 'api_key' | 'jwt' | 'anonymous', envMode = mode): ProcessConfig {
  return {
    id: 'server-1', name: 'fixture', scriptPath: 'node', args: ['fixture.js'],
    env: { API_NOVA_RUNTIME_AUTH_MODE: envMode, MCP_MANAGED: 'true' },
    mcpConfig: { transport: 'streamable', managed: true, inboundAuthMode: mode },
  };
}

describe('managed MCP child process inbound environment', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.API_NOVA_RUNTIME_AUTH_MODE = 'jwt';
    process.env.API_NOVA_MCP_RESOURCE = resource;
    process.env.API_NOVA_RUNTIME_API_KEYS = JSON.stringify([{
      id: 'key-1', subject: 'consumer',
      secretHash: 'a'.repeat(64), expiresAt: Math.floor(Date.now() / 1000) + 120,
      resources: [resource], scopes: [],
    }]);
    process.env.API_NOVA_RUNTIME_ISSUER = 'https://issuer.example';
    process.env.API_NOVA_RUNTIME_JWKS_JSON = '{"keys":[{"kty":"RSA"}]}';
  });
  afterAll(() => { process.env = saved; });

  it('spawns with selected mode and credential only in ephemeral child env', async () => {
    const { service, events } = fixture();
    const result = await service.startProcess(config('api_key'));
    const childEnv = mockedSpawn.mock.calls[0][2]!.env!;
    expect(childEnv.API_NOVA_RUNTIME_AUTH_MODE).toBe('api_key');
    expect(childEnv.API_NOVA_RUNTIME_API_KEYS).toContain('key-1');
    expect(childEnv.API_NOVA_RUNTIME_JWKS_JSON).toBeUndefined();
    expect(result.config.env).toEqual({ API_NOVA_RUNTIME_AUTH_MODE: 'api_key', MCP_MANAGED: 'true' });
    const event = events.emit.mock.calls.find(([name]) => name === 'process.info.updated')![1];
    expect(JSON.stringify(event)).not.toContain('key-1');
    expect(JSON.stringify(event)).not.toContain(secret);
  });

  it('rejects missing or mismatched controlled mode before spawn', async () => {
    const { service } = fixture();
    const missing = config('api_key');
    delete missing.env!.API_NOVA_RUNTIME_AUTH_MODE;
    await expect(service.startProcess(missing)).rejects.toThrow('matching inbound authentication mode');
    expect(mockedSpawn).not.toHaveBeenCalled();
    expect(service.updateProcessStatus).not.toHaveBeenCalled();
    await expect(service.startProcess(config('api_key', 'jwt'))).rejects.toThrow('matching inbound authentication mode');
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it.each(['missing', 'unknown', 'mismatch', 'credentials'])('rejects %s recovery before stop or state change', async defect => {
    const { service } = fixture();
    const input = config('api_key');
    if (defect === 'missing') delete input.mcpConfig!.inboundAuthMode;
    if (defect === 'unknown') {
      input.mcpConfig!.inboundAuthMode = 'unknown' as any;
      input.env!.API_NOVA_RUNTIME_AUTH_MODE = 'unknown';
    }
    if (defect === 'mismatch') input.env!.API_NOVA_RUNTIME_AUTH_MODE = 'anonymous';
    if (defect === 'credentials') delete process.env.API_NOVA_RUNTIME_API_KEYS;
    await expect(service.startProcess(input)).rejects.toThrow();
    expect(service.updateProcessStatus).not.toHaveBeenCalled();
    expect(mockedSpawn).not.toHaveBeenCalled();
    service.processes.set('server-1', { pid: 123 });
    service.stopProcess = jest.fn();
    await expect(service.restartProcess('server-1', input)).rejects.toThrow();
    expect(service.stopProcess).not.toHaveBeenCalled();
    expect(service.updateProcessStatus).not.toHaveBeenCalled();
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('rechecks credentials after restart delay before launching', async () => {
    const { service } = fixture();
    service.processes.set('server-1', { pid: 123 });
    service.stopProcess = jest.fn(async () => {
      service.processes.delete('server-1');
      delete process.env.API_NOVA_RUNTIME_API_KEYS;
    });
    await expect(service.restartProcess('server-1', config('api_key'))).rejects.toThrow();
    expect(service.stopProcess).toHaveBeenCalledTimes(1);
    expect(service.updateProcessStatus).not.toHaveBeenCalled();
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('does not pass inherited protected credentials to anonymous child', async () => {
    const { service } = fixture();
    await service.startProcess(config('anonymous'));
    const childEnv = mockedSpawn.mock.calls[0][2]!.env!;
    expect(childEnv.API_NOVA_RUNTIME_AUTH_MODE).toBe('anonymous');
    expect(childEnv.API_NOVA_RUNTIME_API_KEYS).toBeUndefined();
    expect(childEnv.API_NOVA_RUNTIME_JWKS_JSON).toBeUndefined();
    expect(childEnv.API_NOVA_RUNTIME_ISSUER).toBeUndefined();
  });
});
