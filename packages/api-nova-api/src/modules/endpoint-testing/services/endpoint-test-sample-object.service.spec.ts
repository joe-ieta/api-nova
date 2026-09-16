import 'reflect-metadata';
import { DataSource, Repository } from 'typeorm';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import { EndpointTestSampleObjectEntity as ObjectEntity } from '../../../database/entities/endpoint-test-sample-object.entity';
import { EndpointTestSampleObjectService } from './endpoint-test-sample-object.service';

describe('sample binary object primitives (isolated filesystem and SQL.js)', () => {
  let db: DataSource;
  let repo: Repository<ObjectEntity>;
  let root: string;
  let service: EndpointTestSampleObjectService;
  const savedRoot = process.env.ENDPOINT_TEST_SAMPLE_BINARY_DIR;
  const savedLimit = process.env.ENDPOINT_TEST_SAMPLE_MAX_BYTES;
  const bytes = Buffer.from([0, 255, 128, 1]);
  const prepare = () => service.prepare('sample-a', bytes, 'Application/PDF; charset=binary', 'decoded_response_body');
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'api-nova-binary-spec-'));
    process.env.ENDPOINT_TEST_SAMPLE_BINARY_DIR = root;
    process.env.ENDPOINT_TEST_SAMPLE_MAX_BYTES = '4';
    db = new DataSource({ type: 'sqljs', entities: [ObjectEntity], synchronize: true });
    await db.initialize(); repo = db.getRepository(ObjectEntity);
    service = new EndpointTestSampleObjectService(repo);
  });
  afterEach(async () => {
    await db.destroy();
    // Only remove this test's exclusively created absolute temporary root.
    if (resolve(root).startsWith(resolve(tmpdir()) + require('path').sep) && root.includes('api-nova-binary-spec-')) await fs.rm(root, { recursive: true, force: true });
    if (savedRoot === undefined) delete process.env.ENDPOINT_TEST_SAMPLE_BINARY_DIR; else process.env.ENDPOINT_TEST_SAMPLE_BINARY_DIR = savedRoot;
    if (savedLimit === undefined) delete process.env.ENDPOINT_TEST_SAMPLE_MAX_BYTES; else process.env.ENDPOINT_TEST_SAMPLE_MAX_BYTES = savedLimit;
  });
  it('disabled storage records metadata only and creates no objects', async () => {
    delete process.env.ENDPOINT_TEST_SAMPLE_BINARY_DIR;
    service = new EndpointTestSampleObjectService(repo);
    expect(await prepare()).toEqual({ captureState: 'metadata_only', observedBytes: 4, isComplete: true, sha256: createHash('sha256').update(bytes).digest('hex') });
    expect(await repo.count()).toBe(0); expect(await fs.readdir(root)).toEqual([]);
  });
  it('stages then publishes exact non-UTF8 bytes; staged and foreign ownership cannot read', async () => {
    const prepared = await prepare(); const id = (prepared as any).objectId;
    expect(prepared.captureState).toBe('staged');
    await expect(service.read('sample-a', id)).rejects.toThrow('OBJECT_UNAVAILABLE');
    await expect(service.publish('sample-b', id)).rejects.toThrow('OBJECT_UNAVAILABLE');
    await service.publish('sample-a', id);
    expect(await service.read('sample-a', id)).toEqual(bytes);
    await expect(service.read('sample-b', id)).rejects.toThrow('OBJECT_UNAVAILABLE');
    const row = await repo.findOneByOrFail({ id });
    expect(row.mediaType).toBe('application/pdf'); expect(row.objectKey).toMatch(/^[a-f0-9]{64}$/);
    expect((await fs.readdir(root))).toEqual([row.objectKey + '.raw']);
    await expect(prepare()).rejects.toThrow('OBJECT_STORAGE_FAILED');
    expect(await repo.countBy({ sampleId: 'sample-a', side: 'response' })).toBe(1);
    expect(await service.read('sample-a', id)).toEqual(bytes);
    expect((await fs.readdir(root))).toEqual([row.objectKey + '.raw']);
  });
  it('publishes complete bytes while keeping the object staged and unreadable for the caller transaction', async () => {
    const { objectId: id } = await prepare() as any;
    await service.stagePublishedFile('sample-a', id);
    const row = await repo.findOneByOrFail({ id });
    expect(row.state).toBe('staged');
    expect((await fs.readdir(root))).toEqual([row.objectKey + '.raw']);
    await expect(service.read('sample-a', id)).rejects.toThrow('OBJECT_UNAVAILABLE');
    await service.stagePublishedFile('sample-a', id);
    expect((await repo.findOneByOrFail({ id })).state).toBe('staged');
  });
  it('rejects over-limit and non-byte input without a file or reference', async () => {
    expect((await service.prepare('sample-a', Buffer.alloc(5), 'image/png', 'decoded_response_body')).captureState).toBe('too_large');
    await expect(service.prepare('sample-a', { type: 'Buffer', data: [1] } as any, 'image/png', 'decoded_response_body')).rejects.toThrow('OBJECT_BYTES_INVALID');
    expect(await repo.count()).toBe(0); expect(await fs.readdir(root)).toEqual([]);
  });
  it('rejects same-size corruption and invalid persisted traversal keys', async () => {
    const { objectId: id } = await prepare() as any;
    await service.publish('sample-a', id);
    const row = await repo.findOneByOrFail({ id });
    await fs.writeFile(join(root, row.objectKey + '.raw'), Buffer.from([1,2,3,4]));
    await expect(service.read('sample-a', id)).rejects.toThrow('OBJECT_INTEGRITY_FAILED');
    await repo.update(id, { objectKey: '../secret' });
    await expect(service.read('sample-a', id)).rejects.toThrow('OBJECT_UNAVAILABLE');
  });
  it('never publishes corrupt staged content and retains recovery ownership', async () => {
    const { objectId: id } = await prepare() as any;
    const row = await repo.findOneByOrFail({ id });
    await fs.writeFile(join(root, row.objectKey + '.stage'), Buffer.alloc(5));
    await expect(service.publish('sample-a', id)).rejects.toThrow('OBJECT_INTEGRITY_FAILED');
    expect((await repo.findOneByOrFail({ id })).state).toBe('staged');
  });
  it('keeps renamed file inaccessible after DB failure, then safely retries publication', async () => {
    const { objectId: id } = await prepare() as any;
    const update = jest.spyOn(repo, 'update').mockRejectedValueOnce(new Error('simulated DB error'));
    await expect(service.publish('sample-a', id)).rejects.toThrow('OBJECT_STORAGE_FAILED');
    update.mockRestore();
    expect((await repo.findOneByOrFail({ id })).state).toBe('staged');
    await expect(service.read('sample-a', id)).rejects.toThrow('OBJECT_UNAVAILABLE');
    expect((await fs.readdir(root))[0]).toMatch(/\.raw$/);
    await expect(service.publish('sample-b', id)).rejects.toThrow('OBJECT_UNAVAILABLE');
    await service.publish('sample-a', id);
    await service.publish('sample-a', id);
    expect((await repo.findOneByOrFail({ id })).state).toBe('ready');
    expect(await service.read('sample-a', id)).toEqual(bytes);
  });
  it('does not adopt a pre-existing destination or corrupt renamed file', async () => {
    const { objectId: id } = await prepare() as any;
    const row = await repo.findOneByOrFail({ id });
    await fs.writeFile(join(root, row.objectKey + '.raw'), bytes);
    await expect(service.publish('sample-a', id)).rejects.toThrow('OBJECT_DESTINATION_EXISTS');
    expect((await repo.findOneByOrFail({ id })).state).toBe('staged');
    await fs.unlink(join(root, row.objectKey + '.raw'));
    const update = jest.spyOn(repo, 'update').mockRejectedValueOnce(new Error('simulated DB error'));
    await expect(service.publish('sample-a', id)).rejects.toThrow('OBJECT_STORAGE_FAILED');
    update.mockRestore();
    await fs.writeFile(join(root, row.objectKey + '.raw'), Buffer.from([1,2,3,4]));
    await expect(service.publish('sample-a', id)).rejects.toThrow('OBJECT_INTEGRITY_FAILED');
    expect((await repo.findOneByOrFail({ id })).state).toBe('staged');
  });
  it('blocks a reference revoked while the bytes are being read', async () => {
    const { objectId: id } = await prepare() as any;
    await service.publish('sample-a', id);
    const read = (service as any).readFile.bind(service);
    jest.spyOn(service as any, 'readFile').mockImplementation(async (...args: any[]) => {
      const content = await read(...args); await repo.update(id, { state: 'delete_pending' }); return content;
    });
    await expect(service.read('sample-a', id)).rejects.toThrow('OBJECT_UNAVAILABLE');
  });
  it('rejects directory junctions and relative roots', async () => {
    const target = join(root, 'target'); await fs.mkdir(target);
    const link = join(root, 'alias'); await fs.symlink(target, link, 'junction');
    process.env.ENDPOINT_TEST_SAMPLE_BINARY_DIR = link;
    await expect(new EndpointTestSampleObjectService(repo).prepare('sample-a', bytes, 'image/png', 'decoded_response_body')).rejects.toThrow('OBJECT_ROOT_INVALID');
    process.env.ENDPOINT_TEST_SAMPLE_BINARY_DIR = './relative';
    await expect(new EndpointTestSampleObjectService(repo).prepare('sample-a', bytes, 'image/png', 'decoded_response_body')).rejects.toThrow('OBJECT_ROOT_INVALID');
  });

  it('queues the same sample across independent SQL.js stores in one process', async () => {
    const secondDb = await new DataSource({
      type: 'sqljs', entities: [ObjectEntity], synchronize: true,
    }).initialize();
    const other = new EndpointTestSampleObjectService(secondDb.getRepository(ObjectEntity));
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = service.withSampleFence('sample-a', async () => {
      enter();
      await gate;
    });
    await entered;
    let secondEntered = false;
    const second = other.withSampleFence('sample-a', async () => {
      secondEntered = true;
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(secondEntered).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
    await secondDb.destroy();
  });

  it('releases the same-sample queue after a writer exception', async () => {
    const other = new EndpointTestSampleObjectService(repo);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = service.withSampleFence('sample-a', async () => {
      enter();
      await gate;
      throw new Error('simulated writer failure');
    });
    await entered;
    let secondEntered = false;
    const second = other.withSampleFence('sample-a', async () => {
      secondEntered = true;
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(secondEntered).toBe(false);
    release();
    await expect(first).rejects.toThrow('simulated writer failure');
    await second;
    expect(secondEntered).toBe(true);
  });

  it('holds a PostgreSQL advisory session lock and checks that session before release', async () => {
    const runner = {
      isReleased: false,
      connect: jest.fn(async () => {}),
      query: jest.fn(async (sql: string, _args?: number[]) => {
        if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
        if (sql.includes('pg_advisory_unlock')) return [{ unlocked: true }];
        return [{ alive: 1 }];
      }),
      release: jest.fn(async () => { runner.isReleased = true; }),
      releasePostgresConnection: jest.fn(async () => { runner.isReleased = true; }),
    };
    const fake = {
      manager: { connection: {
        options: { type: 'postgres' },
        createQueryRunner: () => runner,
      } },
    } as unknown as Repository<ObjectEntity>;
    const pgService = new EndpointTestSampleObjectService(fake);
    await pgService.withSampleFence('sample-pg', async () => {
      await pgService.assertSampleFence('sample-pg');
      expect(runner.release).not.toHaveBeenCalled();
    });
    expect(runner.query.mock.calls.map(call => call[0])).toEqual([
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      'SELECT 1 AS alive',
      'SELECT 1 AS alive',
      'SELECT pg_advisory_unlock($1, $2) AS unlocked',
    ]);
    expect(runner.query.mock.calls[0][1]).toEqual(runner.query.mock.calls[3][1]);
    expect(runner.release).toHaveBeenCalledTimes(1);
    expect(runner.releasePostgresConnection).not.toHaveBeenCalled();
  });

  it('destroys an uncertain PostgreSQL session instead of returning it to the pool', async () => {
    const runner = {
      isReleased: false,
      connect: jest.fn(async () => {}),
      query: jest.fn(async (sql: string, _args?: number[]) => {
        if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
        if (sql.includes('pg_advisory_unlock')) throw new Error('connection failed during unlock');
        return [{ alive: 1 }];
      }),
      release: jest.fn(async () => { runner.isReleased = true; }),
      releasePostgresConnection: jest.fn(async (_error: Error) => { runner.isReleased = true; }),
    };
    const fake = {
      manager: { connection: {
        options: { type: 'postgres' },
        createQueryRunner: () => runner,
      } },
    } as unknown as Repository<ObjectEntity>;
    const pgService = new EndpointTestSampleObjectService(fake);
    await expect(pgService.withSampleFence('sample-pg-failure', async () => {
      await pgService.assertSampleFence('sample-pg-failure');
    })).rejects.toThrow('OBJECT_FENCE_LOST');
    expect(runner.release).not.toHaveBeenCalled();
    expect(runner.releasePostgresConnection).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the PostgreSQL lock session dies before a file action', async () => {
    const runner = {
      isReleased: false,
      connect: jest.fn(async () => {}),
      query: jest.fn(async (sql: string, _args?: number[]) => {
        if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
        if (sql.includes('pg_advisory_unlock')) return [{ unlocked: true }];
        runner.isReleased = true;
        throw new Error('session lost');
      }),
      release: jest.fn(async () => { runner.isReleased = true; }),
      releasePostgresConnection: jest.fn(async (_error: Error) => { runner.isReleased = true; }),
    };
    const fake = {
      manager: { connection: {
        options: { type: 'postgres' },
        createQueryRunner: () => runner,
      } },
      create: (value: object) => value,
      save: async (value: object) => ({ ...value, id: 'object-pg-lost' }),
    } as unknown as Repository<ObjectEntity>;
    const pgService = new EndpointTestSampleObjectService(fake);
    await expect(pgService.prepare(
      'sample-pg-lost', bytes, 'application/pdf', 'decoded_response_body',
    )).rejects.toThrow('OBJECT_FENCE_LOST');
    expect(await fs.readdir(root)).toEqual([]);
    expect(runner.releasePostgresConnection).toHaveBeenCalledTimes(1);
  });


  it('rejects a one-connection PostgreSQL pool before acquiring a lock', async () => {
    const createQueryRunner = jest.fn();
    const fake = {
      manager: { connection: {
        options: { type: 'postgres', poolSize: 1 },
        createQueryRunner,
      } },
    } as unknown as Repository<ObjectEntity>;
    const pgService = new EndpointTestSampleObjectService(fake);
    await expect(pgService.withSampleFence('sample-pg-small-pool', async () => {
      throw new Error('must not run');
    })).rejects.toThrow('OBJECT_FENCE_UNAVAILABLE');
    expect(createQueryRunner).not.toHaveBeenCalled();
  });


  it('refuses work when another PostgreSQL session owns the advisory key', async () => {
    const runner = {
      isReleased: false,
      connect: jest.fn(async () => {}),
      query: jest.fn(async () => [{ locked: false }]),
      release: jest.fn(async () => { runner.isReleased = true; }),
      releasePostgresConnection: jest.fn(async () => { runner.isReleased = true; }),
    };
    const fake = {
      manager: { connection: {
        options: { type: 'postgres' },
        createQueryRunner: () => runner,
      } },
    } as unknown as Repository<ObjectEntity>;
    const pgService = new EndpointTestSampleObjectService(fake);
    let worked = false;
    await expect(pgService.withSampleFence('sample-pg-busy', async () => {
      worked = true;
    })).rejects.toThrow('OBJECT_BUSY');
    expect(worked).toBe(false);
    expect(runner.release).toHaveBeenCalledTimes(1);
    expect(runner.releasePostgresConnection).not.toHaveBeenCalled();
  });

});
