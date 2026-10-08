import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { CallObservabilityWorker } from './call-observability.worker';

const report = (extra: Record<string, unknown> = {}) => ({ processedRecords: 0, quarantinedRecords: 0,
  bytesRead: 0, partialBytes: 0, hasMore: false, ...extra });

describe('collector bounded file continuations and maintenance fairness', () => {
  let directory: string, worker: CallObservabilityWorker, collector: any, store: any, clock: number;
  beforeEach(async () => {
    const root = resolve(process.cwd(), '../../.tmp/collector-fairness');
    await fs.mkdir(root, { recursive: true }); directory = await fs.mkdtemp(join(root, 'run-'));
    collector = { sourceDirectory: directory, initialize: jest.fn().mockResolvedValue({ eventLiveSince: new Date().toISOString() }),
      collectFile: jest.fn().mockResolvedValue(report()) };
    store = { watermark: jest.fn().mockResolvedValue('0'), recomputePendingBuckets: jest.fn().mockResolvedValue({ recomputed: 1, failed: 0 }) };
    worker = new CallObservabilityWorker(collector, { project: jest.fn() } as any, store, { get: () => 'false' } as any);
    jest.spyOn(worker as any, 'persist').mockImplementation(async value => value);
    jest.spyOn(worker as any, 'recover').mockResolvedValue(0);
    clock = 0; jest.spyOn(worker as any, 'recomputeClock').mockImplementation(() => clock);
  });
  afterEach(async () => { await worker.onModuleDestroy(); jest.restoreAllMocks(); });
  const file = async (name: string) => fs.writeFile(join(directory, name), 'fixture\n');

  it('drains 128 records in two file visits without a directory rescan or larger total record budget', async () => {
    await file('calls-v2-hot.jsonl');
    collector.collectFile.mockImplementation(async (_name: string, limits: any) => report({ processedRecords: limits.maxRecords, hasMore: true }));
    const open = jest.spyOn(fs, 'opendir');
    const first = await worker.runOnce();
    expect(first.processedRecords).toBe(128); expect(first.scanComplete).toBe(false);
    expect(collector.collectFile).toHaveBeenCalledTimes(2);
    expect(collector.collectFile.mock.calls.map((call: any[]) => call[1].maxRecords)).toEqual([64, 64]);
    expect(collector.collectFile.mock.calls.every((call: any[]) => call[1].batchFacts === true)).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    const second = await worker.runOnce();
    expect(second.scanComplete).toBe(true); expect(second.processedRecords).toBe(0);
    expect(open).toHaveBeenCalledTimes(1);
    expect(store.recomputePendingBuckets.mock.calls).toEqual([[1]]);
    expect((worker as any).recover).not.toHaveBeenCalled();
  });

  it('bounds each growing file to two quanta so other discovered files get a turn and scans finish', async () => {
    await file('calls-v2-a.jsonl'); await file('calls-v2-b.jsonl');
    collector.collectFile.mockImplementation(async (_name: string, limits: any) => report({ processedRecords: limits.maxRecords, hasMore: true }));
    const reports = [];
    for (let index = 0; index < 5; index++) { const next = await worker.runOnce(); reports.push(next); if (next.scanComplete) break; }
    expect(reports.at(-1)?.scanComplete).toBe(true);
    const calls = collector.collectFile.mock.calls.map((call: any[]) => call[0]);
    expect(calls.filter((name: string) => name === 'calls-v2-a.jsonl')).toHaveLength(2);
    expect(calls.filter((name: string) => name === 'calls-v2-b.jsonl')).toHaveLength(2);
    expect(reports.every(item => item.processedRecords <= 128)).toBe(true);
    expect(store.recomputePendingBuckets).toHaveBeenCalledTimes(1);
    expect((worker as any).recover).not.toHaveBeenCalled();
  });

  it('retains unfinished-line progress while still giving bucket recomputation a bounded turn', async () => {
    await file('calls-v2-large.jsonl');
    collector.collectFile.mockResolvedValueOnce(report({ bytesRead: 1024, partialBytes: 1024, hasMore: true }))
      .mockResolvedValueOnce(report({ processedRecords: 1, bytesRead: 512 }));
    const first = await worker.runOnce({ maxReadBytes: 1024 });
    expect(first.processedRecords).toBe(0); expect(first.scanComplete).toBe(false);
    expect(store.recomputePendingBuckets).toHaveBeenLastCalledWith(1);
    const next = await worker.runOnce({ maxReadBytes: 1024 });
    expect(next.processedRecords).toBe(1); expect(next.scanComplete).toBe(true);
    expect(collector.collectFile.mock.calls.map((call: any[]) => call[0])).toEqual(['calls-v2-large.jsonl', 'calls-v2-large.jsonl']);
  });

  it('keeps maintenance alive when the source directory is missing and reports its failure', async () => {
    await fs.rmdir(directory); store.recomputePendingBuckets.mockResolvedValue({ recomputed: 1, failed: 0 });
    const result = await worker.runOnce();
    expect(result.state).toBe('waiting_for_source'); expect(result.scanComplete).toBe(false);
    expect(result.recomputedBuckets).toBe(1); expect(store.recomputePendingBuckets).toHaveBeenCalledWith(8);
    expect((worker as any).recover).not.toHaveBeenCalled();
  });

  it('retains a continuation after a transient store error and retries it before another source', async () => {
    await file('calls-v2-source.jsonl');
    collector.collectFile.mockResolvedValueOnce(report({ processedRecords: 64, hasMore: true }))
      .mockRejectedValueOnce(new Error('injected database outage')).mockResolvedValueOnce(report({ processedRecords: 1 }));
    await expect(worker.runOnce()).rejects.toThrow('injected database outage');
    const result = await worker.runOnce();
    expect(result.processedRecords).toBe(1);
    expect(collector.collectFile.mock.calls.map((call: any[]) => call[0])).toEqual(Array(3).fill('calls-v2-source.jsonl'));
  });

  const maintenanceReport = (idle = false): any => ({ state: 'running', scanComplete: idle,
    recomputedBuckets: 0, recomputeFailures: 0,
    scan: { partialBytes: 0, backlogFiles: idle ? 0 : 1, quarantinedRecords: 0, errors: {} } });

  it('admits busy maintenance by elapsed cost instead of every ingest turn, then resumes at the deadline', async () => {
    store.recomputePendingBuckets.mockImplementationOnce(async () => {
      clock += 200; return { recomputed: 1, failed: 0 };
    });
    await (worker as any).recompute(maintenanceReport());
    clock = 1999; const skipped = maintenanceReport();
    await (worker as any).recompute(skipped);
    expect(skipped.recomputedBuckets).toBe(0);
    expect(store.recomputePendingBuckets.mock.calls).toEqual([[1]]);
    clock = 2000; await (worker as any).recompute(maintenanceReport());
    expect(store.recomputePendingBuckets.mock.calls).toEqual([[1], [1]]);
  });

  it('uses a one-second minimum and caps slow-bucket cooldown so persistent backlog cannot starve maintenance', async () => {
    await (worker as any).recompute(maintenanceReport());
    clock = 999; await (worker as any).recompute(maintenanceReport());
    expect(store.recomputePendingBuckets).toHaveBeenCalledTimes(1);
    clock = 1000;
    store.recomputePendingBuckets.mockImplementationOnce(async () => {
      clock += 2000; return { recomputed: 0, failed: 1 };
    });
    const failed = maintenanceReport(); await (worker as any).recompute(failed);
    expect(failed.recomputeFailures).toBe(1);
    clock = 12999; await (worker as any).recompute(maintenanceReport());
    expect(store.recomputePendingBuckets).toHaveBeenCalledTimes(2);
    clock = 13000; await (worker as any).recompute(maintenanceReport());
    expect(store.recomputePendingBuckets).toHaveBeenCalledTimes(3);
  });

  it('lets a clean idle scan and missing source drain eight buckets despite a busy cooldown', async () => {
    await (worker as any).recompute(maintenanceReport());
    await (worker as any).recompute(maintenanceReport(true));
    const missing = maintenanceReport(); missing.state = 'waiting_for_source';
    await (worker as any).recompute(missing);
    expect(store.recomputePendingBuckets.mock.calls).toEqual([[1], [8], [8]]);
    // Merely reaching directory EOF with an observed backlog is still busy.
    const backlog = maintenanceReport(); backlog.scanComplete = true;
    await (worker as any).recompute(backlog);
    expect(store.recomputePendingBuckets).toHaveBeenCalledTimes(3);
  });

  it('applies busy cooldown after a rejected recompute without swallowing the error', async () => {
    store.recomputePendingBuckets.mockRejectedValueOnce(new Error('database failure'));
    await expect((worker as any).recompute(maintenanceReport())).rejects.toThrow('database failure');
    await (worker as any).recompute(maintenanceReport());
    expect(store.recomputePendingBuckets).toHaveBeenCalledTimes(1);
    clock = 1000; await (worker as any).recompute(maintenanceReport());
    expect(store.recomputePendingBuckets).toHaveBeenCalledTimes(2);
  });

});
