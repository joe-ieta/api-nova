import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { DataSource } from 'typeorm';
import { createApplicationDataSource } from '../../database/sqljs-persistence';
import { CALL_OBSERVABILITY_ENTITIES, RuntimePipelineStateEntity } from '../../database/entities/runtime-call-observability.entity';
import { RuntimeObservabilityEventEntity } from '../../database/entities/runtime-observability-event.entity';
import { CallObservabilityStore } from './call-observability.store';
import { CallObservabilityPayloadStore } from './call-observability-payload.store';
import { PreparedPayloadWriter, PAYLOAD_COORDINATION_ID } from './call-observability-payload.coordinator';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };

describe('prepared payload writer transaction boundaries', () => {
  let db: DataSource, store: CallObservabilityStore, payloads: CallObservabilityPayloadStore;
  const oldDirectory = process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  beforeEach(async () => {
    const root = resolve(process.cwd(), '../../.tmp/prepared-writer-tests'); await fs.mkdir(root, { recursive: true });
    const directory = await fs.mkdtemp(join(root, 'run-'));
    process.env.API_NOVA_OBSERVABILITY_DATA_DIR = join(directory, 'payloads');
    db = await createApplicationDataSource({ type: 'sqljs', location: join(directory, 'db.sqlite'), autoSave: true,
      entities: [...CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity], synchronize: true }).initialize();
    payloads = new CallObservabilityPayloadStore(); store = new CallObservabilityStore(db, payloads); await store.ensurePayloadStorage();
  });
  afterEach(async () => {
    jest.restoreAllMocks(); await payloads.onModuleDestroy(); if (db.isInitialized) await db.destroy();
    if (oldDirectory === undefined) delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
    else process.env.API_NOVA_OBSERVABILITY_DATA_DIR = oldDirectory;
  });
  const coordination = () => db.getRepository(RuntimePipelineStateEntity).findOneBy({ id: PAYLOAD_COORDINATION_ID });

  it('uses exactly two durable transactions, keeps preparation outside SQL, and checks one cached fence plus a fresh final fence', async () => {
    const coordinator = store.payloadCoordination;
    const states = jest.spyOn(coordinator as any, 'state');
    const saves = jest.spyOn(db.driver as any, 'autoSave');
    await coordinator.withPreparedWriter(async tx => {
      expect(tx.manager.queryRunner!.isTransactionActive).toBe(true); return 42;
    }, async session => {
      expect(session.prepared).toBe(42); expect(db.createQueryRunner().isTransactionActive).toBe(false);
      return session.commit(async tx => {
        for (let index = 0; index < 16; index++) await coordinator.assertWriter(tx, session.lease);
        await tx.manager.getRepository(RuntimePipelineStateEntity).insert({ id: 'fact', value: { done: true }, updatedAt: tx.now } as RuntimePipelineStateEntity);
      });
    });
    expect(states).toHaveBeenCalledTimes(3); expect(saves).toHaveBeenCalledTimes(2);
    expect(Object.keys((await coordination())!.value.writers)).toHaveLength(0);
    expect((await db.getRepository(RuntimePipelineStateEntity).findOneByOrFail({ id: 'fact' })).value.done).toBe(true);
  });

  it('consumes a session once and rejects both concurrent and after-return commit reuse', async () => {
    const gate = deferred(), entered = deferred(); let retained!: PreparedPayloadWriter<number>;
    await store.payloadCoordination.withPreparedWriter(async () => 1, async session => {
      retained = session;
      const first = session.commit(async () => { entered.resolve(); await gate.promise; return 'committed'; });
      await entered.promise;
      await expect(session.commit(async () => 'second')).rejects.toThrow('PAYLOAD_WRITE_SESSION_CLOSED');
      gate.resolve(); expect(await first).toBe('committed');
    });
    await expect(retained.commit(async () => 'late')).rejects.toThrow('PAYLOAD_WRITE_SESSION_CLOSED');
    expect(Object.keys((await coordination())!.value.writers)).toHaveLength(0);
  });

  it('rolls back acquisition if its metadata reader fails without starting a heartbeat or body preparation', async () => {
    const timer = jest.spyOn(global, 'setInterval'), body = jest.fn();
    await expect(store.payloadCoordination.withPreparedWriter(async () => { throw new Error('policy read failed'); }, body))
      .rejects.toThrow('policy read failed');
    expect(body).not.toHaveBeenCalled(); expect(timer).not.toHaveBeenCalled();
    expect(await coordination()).toBeNull();
    const next = await store.payloadCoordination.acquireGc(); expect(next.lease).not.toBeNull();
    await store.payloadCoordination.releaseGc(next.lease!);
  });

  it('checks real time again on cached assertions and rolls back writes before fallback cleanup', async () => {
    const coordinator = store.payloadCoordination;
    await expect(coordinator.withPreparedWriter(async () => null, async session => session.commit(async tx => {
      await coordinator.assertWriter(tx, session.lease);
      await tx.manager.getRepository(RuntimePipelineStateEntity).insert({ id: 'expired-fact', value: {}, updatedAt: tx.now });
      const future = Date.now() + 61_000, clock = jest.spyOn(Date, 'now').mockReturnValue(future);
      try { await coordinator.assertWriter(tx, session.lease); } finally { clock.mockRestore(); }
    }))).rejects.toThrow('PAYLOAD_WRITE_LEASE_LOST');
    expect(await db.getRepository(RuntimePipelineStateEntity).findOneBy({ id: 'expired-fact' })).toBeNull();
    expect(Object.keys((await coordination())!.value.writers)).toHaveLength(0);
  });

  it('rereads final coordination rather than accepting a hook-mutated generation through its transaction cache', async () => {
    const coordinator = store.payloadCoordination;
    await expect(coordinator.withPreparedWriter(async () => null, async session => session.commit(async tx => {
      await coordinator.assertWriter(tx, session.lease);
      const repository = tx.manager.getRepository(RuntimePipelineStateEntity);
      const state = await repository.findOneByOrFail({ id: PAYLOAD_COORDINATION_ID }); state.value.generation = '999';
      await repository.save(state);
      await repository.insert({ id: 'wrong-generation-fact', value: {}, updatedAt: tx.now });
    }))).rejects.toThrow('PAYLOAD_WRITE_LEASE_LOST');
    expect(await db.getRepository(RuntimePipelineStateEntity).findOneBy({ id: 'wrong-generation-fact' })).toBeNull();
    expect((await coordination())!.value.generation).toBe('0');
    expect(Object.keys((await coordination())!.value.writers)).toHaveLength(0);
  });
  it('joins an in-flight heartbeat before commit consumes the writer lease', async () => {
    const coordinator = store.payloadCoordination, entered = deferred(), finishRenewal = deferred();
    const originalRenew = coordinator.renewWriter.bind(coordinator);
    const renew = jest.spyOn(coordinator, 'renewWriter').mockImplementation(async lease => {
      entered.resolve(); await finishRenewal.promise; await originalRenew(lease);
    });
    const originalInterval = global.setInterval; let tick!: () => void;
    jest.spyOn(global, 'setInterval').mockImplementation(((callback: () => void, delay: number) => {
      tick = callback; return originalInterval(callback, delay);
    }) as typeof setInterval);
    const commit = jest.spyOn(coordinator as any, 'commitPreparedWriter');
    await coordinator.withPreparedWriter(async () => null, async session => {
      tick(); await entered.promise;
      const pending = session.commit(async () => 'done');
      await new Promise(resolve => setImmediate(resolve)); expect(commit).not.toHaveBeenCalled();
      finishRenewal.resolve(); expect(await pending).toBe('done');
    });
    expect(renew).toHaveBeenCalledTimes(1); expect(commit).toHaveBeenCalledTimes(1);
    expect(Object.keys((await coordination())!.value.writers)).toHaveLength(0);
  });

});
