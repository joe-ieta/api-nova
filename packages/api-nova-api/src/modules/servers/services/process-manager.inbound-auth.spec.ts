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
    delete process.env.API_NOVA_RUNTIME_ACCESS_CREDENTIALS;
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

  it('passes executable and arguments containing spaces directly without a shell', async () => {
    const { service } = fixture();
    const input = config('anonymous');
    input.scriptPath = 'C:\\Program Files\\nodejs\\node.exe';
    input.args = ['C:\\Api Nova\\cli.js', '--openapi', 'C:\\fixture specs\\openapi.json'];
    await service.startProcess(input);
    expect(mockedSpawn).toHaveBeenCalledWith(input.scriptPath, input.args,
      expect.objectContaining({ shell: false, windowsHide: true }));
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

describe('managed unified credential runtime ownership at start and restart', () => {
  const saved = { ...process.env };
  function envelope(runtimeAssetId: string) {
    return JSON.stringify({ version: 1, runtimeAssetId, credentials: [{ version: 1, id: 'unified-id', keyId: 'unified_key',
      secretHash: 'b'.repeat(64), status: 'active', subject: 'worker', protocols: ['mcp'], runtimeAssetId,
      toolScopes: ['*'], scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 120 }] });
  }
  beforeEach(() => { jest.clearAllMocks(); process.env.API_NOVA_RUNTIME_ACCESS_CREDENTIALS = envelope('runtime-1'); });
  afterEach(() => { process.env = { ...saved }; });
  it.each([undefined, 'runtime-2'])('rejects missing/mismatched owner %s before changing any process', async runtimeAssetId => {
    const { service } = fixture(); const input = config('api_key'); input.mcpConfig!.runtimeAssetId = runtimeAssetId;
    service.stopProcess = jest.fn(); service.processes.set('server-1', { pid: 123 });
    await expect(service.startProcess(input)).rejects.toThrow('unified MCP');
    await expect(service.restartProcess('server-1', input)).rejects.toThrow('unified MCP');
    expect(mockedSpawn).not.toHaveBeenCalled(); expect(service.stopProcess).not.toHaveBeenCalled();
    expect(service.updateProcessStatus).not.toHaveBeenCalled();
  });
  it('retains only owner identity in process state and exports credentials only to the child', async () => {
    const { service, events } = fixture(); const input = config('api_key'); input.mcpConfig!.runtimeAssetId = 'runtime-1';
    const result = await service.startProcess(input);
    expect(mockedSpawn.mock.calls[0][2]!.env!.API_NOVA_RUNTIME_ACCESS_CREDENTIALS).toContain('unified-id');
    expect(result.config.mcpConfig.runtimeAssetId).toBe('runtime-1');
    expect(JSON.stringify(result)).not.toContain('unified-id');
    expect(JSON.stringify(events.emit.mock.calls)).not.toContain('unified-id');
  });
  it('rechecks a changed inherited runtime envelope after stopping and before restart spawn', async () => {
    const { service } = fixture(); const input = config('api_key'); input.mcpConfig!.runtimeAssetId = 'runtime-1';
    service.processes.set('server-1', { pid: 123 });
    service.stopProcess = jest.fn(async () => { service.processes.delete('server-1'); process.env.API_NOVA_RUNTIME_ACCESS_CREDENTIALS = envelope('runtime-2'); });
    await expect(service.restartProcess('server-1', input)).rejects.toThrow('unified MCP');
    expect(service.stopProcess).toHaveBeenCalledTimes(1); expect(mockedSpawn).not.toHaveBeenCalled();
  });
});

describe('resolver capabilities follow the actual child lifetime', () => {
  function listeners() {
    const { service } = fixture();
    service.resourceMonitor.stopMonitoring = jest.fn();
    service.logMonitor.stopLogMonitoring = jest.fn();
    service.credentialResolver = { releaseServer: jest.fn() };
    service.cleanupProcess = jest.fn(async () => {});
    const child = new EventEmitter();
    service.processes.set('server-1', child);
    (ProcessManagerService.prototype as any).setupProcessListeners.call(service, 'server-1', child, config('api_key'));
    return { service, child };
  }
  it.each(['exit', 'error'])('releases current child capability on %s', async event => {
    const { service, child } = listeners();
    const callback = child.listeners(event)[0] as any;
    await callback(event === 'exit' ? 0 : new Error('fixture failure'));
    expect(service.credentialResolver.releaseServer).toHaveBeenCalledTimes(1);
    expect(service.credentialResolver.releaseServer).toHaveBeenCalledWith('server-1');
  });
  it.each(['exit', 'error'])('ignores an old child %s after replacement', async event => {
    const { service, child } = listeners();
    service.processes.set('server-1', new EventEmitter());
    await (child.listeners(event)[0] as any)(event === 'exit' ? 0 : new Error('fixture failure'));
    expect(service.credentialResolver.releaseServer).not.toHaveBeenCalled();
    expect(service.cleanupProcess).not.toHaveBeenCalled();
    expect(service.updateProcessStatus).not.toHaveBeenCalled();
  });
  it('does not clean up a replacement installed while an old exit is awaiting its log', async () => {
    const { service, child } = listeners();
    service.logProcess = jest.fn(async () => { service.processes.set('server-1', new EventEmitter()); });
    await (child.listeners('exit')[0] as any)(0);
    expect(service.credentialResolver.releaseServer).toHaveBeenCalledTimes(1);
    expect(service.cleanupProcess).not.toHaveBeenCalled();
    expect(service.resourceMonitor.stopMonitoring).not.toHaveBeenCalled();
  });
});
