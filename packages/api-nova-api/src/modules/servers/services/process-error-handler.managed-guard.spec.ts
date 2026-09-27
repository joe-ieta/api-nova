import 'reflect-metadata';
import { ProcessErrorHandlerService } from './process-error-handler.service';
import { ProcessErrorEvent, ProcessErrorType } from '../interfaces/process.interface';

interface Harness {
  service: ProcessErrorHandlerService;
  savedLogs: any[];
  processInfoUpdates: any[];
  processManager: { getProcessInfo: jest.Mock; restartProcess: jest.Mock };
  emitted: Array<{ name: string; payload: any }>;
  serverRepository: { findOne: jest.Mock };
}

function harness(server: unknown, repository = true): Harness {
  const savedLogs: any[] = [];
  const processInfoUpdates: any[] = [];
  const logRepository = {
    create: jest.fn((value: any) => value),
    save: jest.fn(async (value: any) => { savedLogs.push(value); return value; }),
    find: jest.fn(async () => []),
  };
  const processInfoRepository = {
    update: jest.fn(async (...args: any[]) => { processInfoUpdates.push(args); return { affected: 1 }; }),
  };
  const processManager = {
    getProcessInfo: jest.fn(() => ({ id: 'server-1', restartCount: 0, config: {
      mcpConfig: { managed: true, runtimeAssetId: 'asset-1',
        authConfig: { type: 'bearer', bearerToken: 'synthetic-legacy-token' },
        customHeaders: { Authorization: 'Bearer synthetic-legacy-header' } },
    } })),
    restartProcess: jest.fn(async () => ({ pid: 4321 })),
  };
  const emitted: Array<{ name: string; payload: any }> = [];
  const eventEmitter = { emit: jest.fn((name: string, payload: any) => { emitted.push({ name, payload }); }) };
  const configService = { get: jest.fn((_key: string, fallback: any) => fallback) };
  const serverRepository = { findOne: jest.fn(async () => server) };
  const service = new ProcessErrorHandlerService(logRepository as any, processInfoRepository as any,
    processManager as any, eventEmitter as any, configService as any,
    repository ? serverRepository as any : undefined);
  return { service, savedLogs, processInfoUpdates, processManager, emitted, serverRepository };
}

const errorEvent = (): ProcessErrorEvent => ({
  processId: 'server-1',
  errorType: ProcessErrorType.PROCESS_EXIT,
  error: new Error('synthetic-crash-message'),
  timestamp: new Date('2026-09-27T00:00:00.000Z'),
});

describe('process error handler trusted-managed guard', () => {
  afterEach(() => { jest.useRealTimers(); });

  it('suppresses legacy restart for trusted_ipc_v1 and never rebuilds secret argv', async () => {
    jest.useFakeTimers();
    const h = harness({ id: 'server-1', config: { executionMode: 'trusted_ipc_v1' } });

    await h.service.handleProcessError(errorEvent());
    await jest.advanceTimersByTimeAsync(60_000);

    expect(h.processManager.restartProcess).not.toHaveBeenCalled();
    expect(h.emitted.some(entry => entry.name === 'process.managed_restart_rejected')).toBe(true);
    expect(h.emitted.some(entry => entry.name === 'process.restart_success')).toBe(false);
    const serialized = JSON.stringify({ logs: h.savedLogs, updates: h.processInfoUpdates });
    expect(serialized).not.toContain('synthetic-legacy-token');
    expect(serialized).not.toContain('synthetic-legacy-header');
  });

  it('cancels an already scheduled legacy restart for a trusted server', async () => {
    jest.useFakeTimers();
    const h = harness({ id: 'server-1', config: { executionMode: 'trusted_ipc_v1' } });
    const cancelSpy = jest.spyOn(h.service, 'cancelRestart');

    await h.service.handleProcessError(errorEvent());
    await jest.advanceTimersByTimeAsync(60_000);

    expect(cancelSpy).toHaveBeenCalledWith('server-1');
    expect(h.processManager.restartProcess).not.toHaveBeenCalled();
  });

  it('keeps the legacy restart path unchanged for non-trusted servers', async () => {
    jest.useFakeTimers();
    const h = harness({ id: 'server-1', config: {} });

    await h.service.handleProcessError(errorEvent());
    expect(h.processManager.restartProcess).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2_000);

    expect(h.processManager.restartProcess).toHaveBeenCalledTimes(1);
    expect(h.emitted.some(entry => entry.name === 'process.restart_success')).toBe(true);
  });

  it('keeps legacy behavior when the server lookup is unavailable', async () => {
    jest.useFakeTimers();
    const h = harness(undefined);
    h.serverRepository.findOne.mockRejectedValue(new Error('store unavailable'));

    await h.service.handleProcessError(errorEvent());
    await jest.advanceTimersByTimeAsync(2_000);

    expect(h.processManager.restartProcess).toHaveBeenCalledTimes(1);
  });

  it('treats a server without trusted_ipc_v1 as legacy even under managed runtime config', async () => {
    jest.useFakeTimers();
    const h = harness({ id: 'server-1', config: { runtimeAssetId: 'asset-1', managedByRuntimeAsset: true } });

    await h.service.handleProcessError(errorEvent());
    await jest.advanceTimersByTimeAsync(2_000);

    expect(h.processManager.restartProcess).toHaveBeenCalledTimes(1);
  });
});
