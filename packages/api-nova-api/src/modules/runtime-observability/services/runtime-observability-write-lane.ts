import { DataSource } from 'typeorm';

export const RUNTIME_WRITE_BATCH_SIZE = 16;
export const RUNTIME_WRITE_BATCH_WAIT_MS = 2;

export interface RuntimeWriteJob<C, M> {
  kind: 'request' | 'barrier';
  operation(context: C): Promise<void>;
  request?: M;
}

/** FIFO admission before connection checkout. Only adjacent request results merge.
 * The 16-item limit bounds a transaction, not the number of waiting callers. */
export function createRuntimeWriteScheduler<C, M>() {
  type Job = RuntimeWriteJob<C, M>;
  type Item = { job: Job; execute(jobs: readonly Job[]): Promise<void>; resolve(): void; reject(error: unknown): void };
  type Lane = { queue: Item[]; active: boolean; timer?: ReturnType<typeof setTimeout> };
  const connections = new WeakMap<DataSource, Map<string, Lane>>();
  return (connection: DataSource, asset: string, job: Job,
    execute: (jobs: readonly Job[]) => Promise<void>): Promise<void> => {
    let assets = connections.get(connection);
    if (!assets) { assets = new Map(); connections.set(connection, assets); }
    let lane = assets.get(asset);
    if (!lane) { lane = { queue: [], active: false }; assets.set(asset, lane); }
    const current = lane;
    const drain = async () => {
      if (current.active) return;
      current.active = true;
      if (current.timer) { clearTimeout(current.timer); current.timer = undefined; }
      try {
        while (current.queue.length) {
          const first = current.queue.shift()!;
          const group = [first];
          if (first.job.kind === 'request') {
            while (group.length < RUNTIME_WRITE_BATCH_SIZE && current.queue[0]?.job.kind === 'request') {
              group.push(current.queue.shift()!);
            }
          }
          try {
            await first.execute(group.map(item => item.job));
            for (const item of group) item.resolve();
          } catch (error) {
            for (const item of group) item.reject(error);
          }
        }
      } finally {
        current.active = false;
        // No await between observing an empty queue and cleanup; a completed lane
        // cannot delete a newer lane or poison its successor after a failure.
        if (assets!.get(asset) === current && !current.queue.length) {
          assets!.delete(asset);
          if (!assets!.size) connections.delete(connection);
        }
      }
    };
    const result = new Promise<void>((resolve, reject) => current.queue.push({ job, execute, resolve, reject }));
    if (!current.active) {
      if (job.kind === 'barrier' || current.queue.length >= RUNTIME_WRITE_BATCH_SIZE) void drain();
      else if (!current.timer) current.timer = setTimeout(() => { void drain(); }, RUNTIME_WRITE_BATCH_WAIT_MS);
    }
    return result;
  };
}
