import { AsyncLocalStorage } from 'async_hooks';
import { DataSource, DataSourceOptions } from 'typeorm';

/** TypeORM SQL.js has one shared runner. Its stock flush clears dirty only after
 * asynchronous file I/O, so concurrent reader release() calls export/write the
 * entire database again. Keep one save in flight and fence completion by query
 * generation, rather than allowing an old flush to clear a newer commit. */
export function createApplicationDataSource(options: DataSourceOptions): DataSource {
  const source = new DataSource(options);
  if (options.type !== 'sqljs' || options.autoSave !== true) return source;
  // SQL.js owns one connection/runner. Independent manager transactions must
  // not become each other's savepoints, while same-operation nested transactions
  // retain TypeORM's savepoint behavior. Keep the entire operation in this lane.
  const context = new AsyncLocalStorage<object>();
  let owner: object | undefined;
  let tail = Promise.resolve();
  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    if (owner && context.getStore() === owner) return operation();
    const result = tail.then(async () => {
      const token = {};
      owner = token;
      try { return await context.run(token, operation); }
      finally { if (owner === token) owner = undefined; }
    });
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const managers = new WeakSet<object>();
  const protectManager = (manager: any) => {
    if (managers.has(manager)) return manager;
    managers.add(manager);
    for (const method of ['transaction', 'save', 'remove', 'softRemove', 'recover']) {
      const original = manager[method].bind(manager);
      manager[method] = (...args: unknown[]) => exclusive(() => original(...args));
    }
    return manager;
  };
  protectManager(source.manager);
  const createManager = source.createEntityManager.bind(source);
  source.createEntityManager = runner => protectManager(createManager(runner));
  // Instance-local adapter; installed before initialize/migrations create a runner.
  // These are the SQL.js driver's existing internal methods, covered by real-driver tests.
  const driver = source.driver as any;
  const createRunner = driver.createQueryRunner.bind(driver);
  const installed = new WeakSet<object>();
  driver.createQueryRunner = (...args: unknown[]) => {
    const runner = createRunner(...args);
    if (installed.has(runner)) return runner;
    installed.add(runner);
    let generation = 0;
    let durableGeneration = 0;
    let saving: { generation: number; promise: Promise<void> } | undefined;
    const query = runner.query.bind(runner);
    runner.query = (sql: string, ...parameters: unknown[]) => exclusive(async () => {
      const result = await query(sql, ...parameters);
      // Match the driver's conservative dirty classification, including transaction
      // controls. SELECT alone never creates another persistence generation.
      if (sql.trim().split(' ', 1)[0] !== 'SELECT') generation++;
      return result;
    });
    runner.flush = async () => {
      const target = generation;
      // Join an existing write even for read-only release(), but do not wait for
      // unbounded later traffic once this caller's target is durably covered.
      for (;;) {
        if (!saving) {
          if (!runner.isDirty || runner.isTransactionActive) return;
          const captured = generation;
          runner.isDirty = false;
          const flight = { generation: captured, promise: undefined as unknown as Promise<void> };
          saving = flight;
          try {
            // autoSave checks transaction state and synchronously exports before
            // its first I/O await. Never export while a transaction is active.
            flight.promise = Promise.resolve(driver.autoSave()).then(() => {
              durableGeneration = captured;
            }, error => {
              runner.isDirty = true;
              throw error;
            }).finally(() => {
              if (generation > captured) runner.isDirty = true;
              if (saving === flight) saving = undefined;
            });
          } catch (error) {
            runner.isDirty = true;
            saving = undefined;
            throw error;
          }
        }
        await saving.promise;
        if (durableGeneration >= target) return;
        // New writes during the previous save remain dirty. A transaction that
        // is still open owns their eventual commit; exporting now would end it.
        if (runner.isTransactionActive) return;
      }
    };
    const startTransaction = runner.startTransaction.bind(runner);
    runner.startTransaction = async (...parameters: unknown[]) => {
      // A new outer transaction must not hide an older committed generation
      // behind its active-transaction guard. An already captured snapshot may
      // finish concurrently, but uncaptured committed data is saved before BEGIN.
      while (!runner.isTransactionActive && generation > (saving?.generation ?? durableGeneration)) {
        await runner.flush();
      }
      return startTransaction(...parameters);
    };
    return runner;
  };
  return source;
}
