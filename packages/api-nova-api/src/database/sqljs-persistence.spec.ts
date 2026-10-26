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

  it('reduces 16 real read-only SERIALIZABLE commits from 16 exports to zero without changing disk data', async () => {
    await open(false);
    const stockExports = jest.spyOn((db.driver as any).databaseConnection, 'export');
    for (let index = 0; index < 16; index++) await db.transaction('SERIALIZABLE', async manager => {
      expect(await manager.query('SELECT COUNT(*) AS total FROM sample')).toEqual([{ total: 0 }]);
    });
    expect(stockExports).toHaveBeenCalledTimes(16);
    await db.destroy();
    db = await createApplicationDataSource({ type: 'sqljs', location, autoSave: true, entities: [Sample] }).initialize();
    const optimizedExports = jest.spyOn((db.driver as any).databaseConnection, 'export');
    for (let index = 0; index < 16; index++) await db.transaction('SERIALIZABLE', async manager => {
      expect(await manager.query('SELECT COUNT(*) AS total FROM sample')).toEqual([{ total: 0 }]);
    });
    expect(optimizedExports).not.toHaveBeenCalled(); expect(await persistedCount()).toBe(0);
    console.log(JSON.stringify({ fixture: '16 read-only SERIALIZABLE transactions', stockExports: 16, optimizedExports: 0 }));
  });

  it('keeps read-only nested savepoints and rollback clean but persists DDL, DML and unknown PRAGMA setters', async () => {
    await open(); const exports = jest.spyOn((db.driver as any).databaseConnection, 'export');
    await db.transaction('READ UNCOMMITTED', async manager => {
      await manager.transaction(async nested => { await nested.query('SELECT * FROM sample'); });
      await expect(manager.transaction(async nested => {
        await nested.query('SELECT * FROM sample'); throw new Error('read-only nested rollback');
      })).rejects.toThrow('read-only nested rollback');
    });
    await expect(db.transaction(async manager => {
      await manager.query('SELECT * FROM sample'); throw new Error('read-only outer rollback');
    })).rejects.toThrow('read-only outer rollback');
    expect(exports).not.toHaveBeenCalled();
    await db.query('PRAGMA user_version = 17');
    await db.query('CREATE INDEX sample_value ON sample(value)');
    await db.query("WITH seed(id, value) AS (SELECT 1, 'one') INSERT INTO sample SELECT * FROM seed");
    expect(exports).toHaveBeenCalledTimes(3);
    const reader = await new DataSource({ type: 'sqljs', location, autoSave: false }).initialize();
    try {
      expect(await reader.query('PRAGMA user_version')).toEqual([{ user_version: 17 }]);
      expect(await reader.query("SELECT name FROM sqlite_master WHERE type='index'")).toEqual([{ name: 'sample_value' }]);
      expect(await reader.query('SELECT * FROM sample')).toEqual([{ id: 1, value: 'one' }]);
    } finally { await reader.destroy(); }
  });

  it('joins a captured write during a read-only transaction without making another export after it completes', async () => {
    await open(); const exports = gate();
    const write = db.query("INSERT INTO sample VALUES (1, 'one')");
    await until(() => blocked.length === 1); let committed = false;
    const read = db.transaction('SERIALIZABLE', async manager => {
      expect(await manager.query('SELECT * FROM sample')).toEqual([{ id: 1, value: 'one' }]);
    }).then(() => { committed = true; });
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(committed).toBe(false); expect(exports).toHaveBeenCalledTimes(1);
    blocked[0].resolve(); await Promise.all([write, read]);
    await db.transaction(async manager => { await manager.query('SELECT * FROM sample'); });
    expect(exports).toHaveBeenCalledTimes(1); expect(peak).toBe(1); expect(await persistedCount()).toBe(1);
  });

  it('retains failed dirty data when a read-only transaction retries persistence before BEGIN', async () => {
    await open(); const exports = gate();
    const write = db.query("INSERT INTO sample VALUES (1, 'one')").then(() => 'unexpected', error => String(error));
    await until(() => blocked.length === 1); blocked[0].reject(new Error('failed disk write'));
    expect(await write).toContain('failed disk write'); expect(await persistedCount()).toBe(0);
    let entered = false, completed = false;
    const retry = db.transaction('SERIALIZABLE', async manager => {
      entered = true; expect(await manager.query('SELECT * FROM sample')).toHaveLength(1);
    }).then(() => { completed = true; });
    await until(() => blocked.length === 2);
    expect(entered).toBe(false); expect(completed).toBe(false);
    blocked[1].resolve(); await retry;
    expect(exports).toHaveBeenCalledTimes(2); expect(await persistedCount()).toBe(1);
    await db.query('SELECT * FROM sample'); expect(exports).toHaveBeenCalledTimes(2);
  });

  it('does not erase failed persistence when an awaited isolation control resumes after the failure', async () => {
    await open(); const exports = gate();
    const write = db.query("INSERT INTO sample VALUES (1, 'one')").then(() => 'unexpected', error => String(error));
    await until(() => blocked.length === 1);
    const runner = db.createQueryRunner(), controlEntered = deferred(), continueControl = deferred();
    const broadcast = runner.broadcaster.broadcast.bind(runner.broadcaster);
    jest.spyOn(runner.broadcaster, 'broadcast').mockImplementation(async (...args: any[]) => {
      if (args[0] === 'BeforeQuery' && args[1] === 'PRAGMA read_uncommitted = false') {
        controlEntered.resolve(); await continueControl.promise;
      }
      return broadcast(...args as Parameters<typeof broadcast>);
    });
    let committed = false;
    const read = db.transaction('SERIALIZABLE', async manager => { await manager.query('SELECT * FROM sample'); })
      .then(() => { committed = true; });
    await controlEntered.promise; blocked[0].reject(new Error('failed while isolation control awaits'));
    expect(await write).toContain('failed while isolation control awaits');
    expect(await persistedCount()).toBe(0);
    continueControl.resolve(); await until(() => blocked.length === 2);
    expect(committed).toBe(false); blocked[1].resolve(); await read;
    expect(await persistedCount()).toBe(1); expect(exports).toHaveBeenCalledTimes(2); expect(peak).toBe(1);
  });

  it('treats commented and multi-statement PRAGMA text conservatively, rather than matching only a clean prefix', async () => {
    await open(); const exports = jest.spyOn((db.driver as any).databaseConnection, 'export');
    await db.query('PRAGMA read_uncommitted = false /* conservative unknown suffix */');
    expect(exports).toHaveBeenCalledTimes(1);
    // TypeORM prepares one statement, but the adapter must not infer that arbitrary
    // SQL following a known prefix is non-persistent if that driver detail changes.
    await db.query('PRAGMA read_uncommitted = false; SELECT 1');
    expect(exports).toHaveBeenCalledTimes(2);
    await db.transaction('SERIALIZABLE', async manager => { await manager.query('SELECT * FROM sample'); });
    expect(exports).toHaveBeenCalledTimes(2);
  });

});
