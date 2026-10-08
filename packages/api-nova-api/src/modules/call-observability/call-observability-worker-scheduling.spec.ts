import { ConfigService } from '@nestjs/config';
import { CallObservabilityWorker } from './call-observability.worker';
import { CallObservabilityOutboxService } from './call-observability-outbox.service';
import { CallObservabilityDeliveryWorker } from './call-observability-delivery.worker';

const configurations = [
  { name: 'collector', create: (config: ConfigService) => new CallObservabilityWorker({} as any, {} as any, {} as any, config),
    progress: { processedRecords: 16, scanComplete: true, state: 'running', scan: { partialBytes: 0 } },
    idle: { processedRecords: 0, scanComplete: true, state: 'running', scan: { partialBytes: 0 } } },
  { name: 'outbox', create: (config: ConfigService) => new CallObservabilityOutboxService({} as any, config),
    progress: { materializedEvents: 32 }, idle: { materializedEvents: 0 } },
  { name: 'delivery', create: (config: ConfigService) => new CallObservabilityDeliveryWorker({} as any, config, {} as any),
    progress: { claimed: 10 }, idle: { claimed: 0 } },
];

describe.each(configurations)('$name automatic backlog scheduling', ({ create, progress, idle }) => {
  let worker: ReturnType<typeof create>;
  beforeEach(() => { jest.useFakeTimers(); worker = create({ get: () => 'true' } as unknown as ConfigService); });
  afterEach(async () => { await worker.onModuleDestroy(); jest.restoreAllMocks(); jest.useRealTimers(); });

  it('drains finite progress batches without the idle delay, then backs off', async () => {
    const run = jest.spyOn(worker, 'runOnce').mockResolvedValueOnce(progress as any)
      .mockResolvedValueOnce(progress as any).mockResolvedValue(idle as any);
    const timers = jest.spyOn(global, 'setTimeout');
    worker.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(3);
    expect(timers.mock.calls.map(call => call[1])).toEqual([0, 0, 0, 1000]);
    await jest.advanceTimersByTimeAsync(500);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('waits for the active batch and does not reschedule after shutdown', async () => {
    let complete!: (report: any) => void;
    jest.spyOn(worker as any, 'run').mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const run = jest.spyOn(worker, 'runOnce');
    worker.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(1);
    let destroyed = false;
    const shutdown = worker.onModuleDestroy().then(() => { destroyed = true; });
    await jest.advanceTimersByTimeAsync(1);
    expect(destroyed).toBe(false);
    complete(progress);
    await shutdown;
    expect(destroyed).toBe(true);
    await jest.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('backs off after an error instead of spinning the failed batch', async () => {
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const run = jest.spyOn(worker, 'runOnce').mockRejectedValue(new Error('storage unavailable'));
    const timers = jest.spyOn(global, 'setTimeout');
    worker.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(1);
    expect(timers.mock.calls.map(call => call[1])).toEqual([0, 1000]);
  });

  it('preserves disabled-by-default activation', async () => {
    worker = create({ get: () => 'false' } as unknown as ConfigService);
    const run = jest.spyOn(worker, 'runOnce');
    worker.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(10000);
    expect(run).not.toHaveBeenCalled();
  });
});

it('collector advances a bounded directory scan but backs off on a partial source line at EOF', async () => {
  jest.useFakeTimers();
  const worker = new CallObservabilityWorker({} as any, {} as any, {} as any, { get: () => 'true' } as any);
  const run = jest.spyOn(worker, 'runOnce').mockResolvedValueOnce({ processedRecords: 0, scanComplete: false, state: 'running', scan: { partialBytes: 0 } } as any)
    .mockResolvedValue({ processedRecords: 0, scanComplete: false, state: 'running', scan: { partialBytes: 10 } } as any);
  const timers = jest.spyOn(global, 'setTimeout');
  try {
    worker.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(2);
    expect(timers.mock.calls.map(call => call[1])).toEqual([0, 0, 1000]);
  } finally { await worker.onModuleDestroy(); jest.restoreAllMocks(); jest.useRealTimers(); }
});
