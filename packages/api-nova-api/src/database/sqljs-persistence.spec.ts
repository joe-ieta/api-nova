import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { DataSource, EntitySchema } from 'typeorm';
const Sample = new EntitySchema<{ id: number; value: string }>({ name: 'Sample', tableName: 'sample',
  columns: { id: { type: Number, primary: true }, value: { type: String } } });
import { PlatformTools } from 'typeorm/platform/PlatformTools';
import { createApplicationDataSource } from './sqljs-persistence';

const deferred = () => {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('timed out waiting for persistence'); await new Promise(resolve => setTimeout(resolve, 2)); }
};

describe('SQL.js single-flight durable persistence', () => {
  let directory: string, location: string, db: DataSource;
  let blocked: ReturnType<typeof deferred>[], peak: number, active: number;
  beforeEach(async () => {
    const root = resolve(process.cwd(), '../../.tmp/sqljs-persistence-tests');
    await fs.mkdir(root, { recursive: true }); directory = await fs.mkdtemp(join(root, 'run-')); location = join(directory, 'database.sqlite');
    blocked = []; peak = active = 0;
  });
  afterEach(async () => {
    blocked.forEach(item => item.resolve()); jest.restoreAllMocks();
    if (db?.isInitialized) await db.destroy();
  });
  const open = async (patched = true, autoSave = true) => {
    const options = { type: 'sqljs' as const, location, autoSave, entities: [Sample] };
    db = await (patched ? createApplicationDataSource(options) : new DataSource(options)).initialize();
    await db.query('CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT)');
  };
  const gate = () => {
    const write = PlatformTools.writeFile.bind(PlatformTools);
    jest.spyOn(PlatformTools, 'writeFile').mockImplementation(async (...args) => {
      active++; peak = Math.max(peak, active); const block = deferred(); blocked.push(block);
      try { await block.promise; await write(...args); } finally { active--; }
    });
    return jest.spyOn((db.driver as any).databaseConnection, 'export');
  };
  const persistedCount = async () => {
    const reader = await new DataSource({ type: 'sqljs', location, autoSave: false }).initialize();
    try { return Number((await reader.query('SELECT COUNT(*) AS total FROM sample'))[0].total); }
    finally { await reader.destroy(); }
  };
  it('reproduces 17 overlapping exports/writes from one stock insert and 16 concurrent readers', async () => {
    await open(false); const exports = gate(); const insert = db.query("INSERT INTO sample VALUES (1, 'one')");
    await until(() => blocked.length === 1);
    const reads = Array.from({ length: 16 }, () => db.query('SELECT * FROM sample'));
    await until(() => blocked.length === 17);
    expect(exports).toHaveBeenCalledTimes(17); expect(peak).toBe(17);
    blocked.forEach(item => item.resolve()); await Promise.all([insert, ...reads]);
  });
  it('coalesces the same reader burst into one durable write and waits before returning', async () => {
    await open(); const exports = gate(); let insertDone = false;
    const insert = db.query("INSERT INTO sample VALUES (1, 'one')").then(() => { insertDone = true; });
    await until(() => blocked.length === 1);
    let completedReads = 0;
    const reads = Array.from({ length: 16 }, () => db.query('SELECT * FROM sample').then(() => { completedReads++; }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(blocked).toHaveLength(1); expect(exports).toHaveBeenCalledTimes(1); expect(peak).toBe(1);
    expect(insertDone).toBe(false); expect(completedReads).toBe(0);
    blocked[0].resolve(); await Promise.all([insert, ...reads]); expect(await persistedCount()).toBe(1);
  });
  it('makes a newer commit await its own snapshot while the already-durable first caller returns', async () => {
    await open(); const exports = gate(); let firstDone = false, commitDone = false;
    const first = db.query("INSERT INTO sample VALUES (1, 'one')").then(() => { firstDone = true; });
    await until(() => blocked.length === 1);
    const runner = db.createQueryRunner(); await runner.startTransaction();
    await runner.query("INSERT INTO sample VALUES (2, 'two')");
    const commit = runner.commitTransaction().then(() => { commitDone = true; });
    await new Promise(resolve => setTimeout(resolve, 10)); expect(blocked).toHaveLength(1);
    blocked[0].resolve(); await first; await until(() => blocked.length === 2);
    expect(firstDone).toBe(true); expect(commitDone).toBe(false); expect(await persistedCount()).toBe(1);
    blocked[1].resolve(); await commit;
    expect(exports).toHaveBeenCalledTimes(2); expect(peak).toBe(1); expect(await persistedCount()).toBe(2);
  });
  it('does not export or end a transaction that opens while a prior snapshot is being saved', async () => {
    await open(); const exports = gate(); const first = db.query("INSERT INTO sample VALUES (1, 'one')");
    await until(() => blocked.length === 1);
    const runner = db.createQueryRunner(); await runner.startTransaction(); await runner.query("INSERT INTO sample VALUES (2, 'two')");
    const read = db.query('SELECT * FROM sample'); blocked[0].resolve(); await Promise.all([first, read]);
    expect(runner.isTransactionActive).toBe(true); expect(exports).toHaveBeenCalledTimes(1);
    expect(await persistedCount()).toBe(1);
    const commit = runner.commitTransaction(); await until(() => blocked.length === 2);
    blocked[1].resolve(); await commit; expect(await persistedCount()).toBe(2);
  });
  it('rejects all affected waiters on save failure, retains dirty data and retries successfully', async () => {
    await open(); gate(); const first = db.query("INSERT INTO sample VALUES (1, 'one')");
    const firstOutcome = first.then(() => 'unexpected success', error => String(error));
    await until(() => blocked.length === 1);
    const readOutcome = db.query('SELECT * FROM sample').then(() => 'unexpected success', error => String(error));
    await new Promise(resolve => setTimeout(resolve, 10)); blocked[0].reject(new Error('injected disk failure'));
    expect(await firstOutcome).toContain('injected disk failure'); expect(await readOutcome).toContain('injected disk failure');
    expect(await persistedCount()).toBe(0);
    const retry = db.query('SELECT * FROM sample'); await until(() => blocked.length === 2);
    blocked[1].resolve(); await retry; expect(await persistedCount()).toBe(1); expect(peak).toBe(1);
  });
  it('leaves explicitly non-persistent SQL.js data sources unchanged', async () => {
    await open(true, false); const exports = gate();
    await Promise.all(Array.from({ length: 16 }, () => db.query('SELECT * FROM sample')));
    expect(Object.prototype.hasOwnProperty.call(db.driver, 'createQueryRunner')).toBe(false);
    expect(exports).not.toHaveBeenCalled(); expect(blocked).toHaveLength(0);
  });
  it('holds a third BEGIN behind an uncaptured committed generation and does not commit its later rollback', async () => {
    await open(); gate(); const first = db.query("INSERT INTO sample VALUES (1, 'one')");
    await until(() => blocked.length === 1);
    const runner = db.createQueryRunner(); await runner.startTransaction(); await runner.query("INSERT INTO sample VALUES (2, 'two')");
    let secondCommitted = false, thirdStarted = false;
    const second = runner.commitTransaction().then(() => { secondCommitted = true; });
    await until(() => !runner.isTransactionActive);
    const third = runner.startTransaction().then(() => { thirdStarted = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(thirdStarted).toBe(false); expect(secondCommitted).toBe(false);
    blocked[0].resolve(); await first; await until(() => blocked.length === 2);
    expect(secondCommitted).toBe(false);
    expect(thirdStarted).toBe(false);
    blocked[1].resolve(); await second; expect(await persistedCount()).toBe(2);
    await third; await runner.query("INSERT INTO sample VALUES (3, 'three')");
    expect(runner.isTransactionActive).toBe(true);
    await runner.rollbackTransaction(); const released = runner.release(); await until(() => blocked.length === 3);
    blocked[2].resolve(); await released; expect(await persistedCount()).toBe(2); expect(peak).toBe(1);
  });

  it('serializes independent transactions so one rollback cannot erase another successful commit', async () => {
    await open(); const entered = deferred(), finish = deferred(); let secondEntered = false;
    const first = db.transaction(async manager => {
      await manager.query("INSERT INTO sample VALUES (1, 'A')"); entered.resolve(); await finish.promise;
    });
    await entered.promise;
    const second = db.transaction(async manager => {
      secondEntered = true; await manager.query("INSERT INTO sample VALUES (2, 'B')"); throw new Error('rollback B');
    }).then(() => 'unexpected success', error => String(error));
    await new Promise(resolve => setTimeout(resolve, 10)); expect(secondEntered).toBe(false);
    finish.resolve(); await first; expect(await second).toContain('rollback B');
    expect(await db.query('SELECT id FROM sample ORDER BY id')).toEqual([{ id: 1 }]);
    expect(await persistedCount()).toBe(1);
  });
  it('preserves sequential nested savepoint rollback and reentrant root repository access', async () => {
    await open();
    await db.transaction(async manager => {
      await db.getRepository(Sample).save({ id: 1, value: 'outer' });
      await expect(manager.transaction(async nested => {
        await nested.query("INSERT INTO sample VALUES (2, 'nested')"); throw new Error('nested rollback');
      })).rejects.toThrow('nested rollback');
      await manager.query("INSERT INTO sample VALUES (3, 'outer after nested')");
    });
    expect(await db.query('SELECT id FROM sample ORDER BY id')).toEqual([{ id: 1 }, { id: 3 }]);
    expect(await persistedCount()).toBe(2);
  });
  it('keeps an independent repository save and ordinary reader outside another operation transaction', async () => {
    await open(); const entered = deferred(), finish = deferred(); let saved = false, read = false;
    const first = db.transaction(async manager => {
      await manager.query("INSERT INTO sample VALUES (1, 'rolled back')"); entered.resolve(); await finish.promise;
      throw new Error('rollback first');
    }).catch(error => String(error));
    await entered.promise;
    const second = db.getRepository(Sample).save({ id: 2, value: 'independent' }).then(() => { saved = true; });
    const reader = db.query('SELECT id FROM sample ORDER BY id').then(rows => { read = true; return rows; });
    await new Promise(resolve => setTimeout(resolve, 10)); expect(saved).toBe(false); expect(read).toBe(false);
    finish.resolve(); await first; await second;
    expect(await reader).toEqual([{ id: 2 }]); expect(await persistedCount()).toBe(1);
  });
  it('does not let a detached callback inherit ownership after its transaction has finished', async () => {
    await open(); const trigger = deferred(), entered = deferred(), finish = deferred(); let late!: Promise<unknown>, lateDone = false;
    await db.transaction(async manager => {
      await manager.query("INSERT INTO sample VALUES (1, 'first')");
      late = trigger.promise.then(() => db.query("INSERT INTO sample VALUES (3, 'late')")).then(() => { lateDone = true; });
    });
    const next = db.transaction(async manager => {
      await manager.query("INSERT INTO sample VALUES (2, 'second')"); entered.resolve(); await finish.promise;
    });
    await entered.promise; trigger.resolve(); await new Promise(resolve => setTimeout(resolve, 10));
    expect(lateDone).toBe(false); finish.resolve(); await next; await late; expect(await persistedCount()).toBe(3);
  });

});
