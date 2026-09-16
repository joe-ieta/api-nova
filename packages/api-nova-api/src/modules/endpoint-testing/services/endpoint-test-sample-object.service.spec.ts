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
});
