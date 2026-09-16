import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { DataSource } from 'typeorm';
import { EndpointDefinitionEntity, EndpointDefinitionStatus } from '../../../database/entities/endpoint-definition.entity';
import { EndpointTestCaseEntity } from '../../../database/entities/endpoint-test-case.entity';
import { EndpointTestRunEntity } from '../../../database/entities/endpoint-test-run.entity';
import { EndpointTestSampleEntity, EndpointTestSampleStatus } from '../../../database/entities/endpoint-test-sample.entity';
import { EndpointTestSampleObjectEntity } from '../../../database/entities/endpoint-test-sample-object.entity';
import { readBoundedTestResponse, TrustedBinaryCapture } from '../../asset-catalog/services/binary-test-response';
import { EndpointTestSampleObjectService } from './endpoint-test-sample-object.service';
import { EndpointTestingService } from './endpoint-testing.service';

describe('binary success sample transaction (isolated SQL.js and filesystem)', () => {
  let db: DataSource;
  let root: string;
  let service: EndpointTestingService;
  let objects: EndpointTestSampleObjectService;
  let endpointId: string;
  const bytes = Buffer.from([0, 255, 128, 1]);
  const entities = [
    EndpointDefinitionEntity, EndpointTestCaseEntity, EndpointTestRunEntity,
    EndpointTestSampleEntity, EndpointTestSampleObjectEntity,
  ];
  const originalRoot = process.env.ENDPOINT_TEST_SAMPLE_BINARY_DIR;
  const originalFlag = process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED;
  const originalLimit = process.env.ENDPOINT_TEST_SAMPLE_MAX_BYTES;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'api-nova-binary-tx-'));
    process.env.ENDPOINT_TEST_SAMPLE_BINARY_DIR = root;
    process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED = 'true';
    process.env.ENDPOINT_TEST_SAMPLE_MAX_BYTES = '4';
    db = new DataSource({
      type: 'sqljs', entities, synchronize: true,
    });
    await db.initialize();
    const endpoint = await db.getRepository(EndpointDefinitionEntity).save({
      sourceServiceAssetId: 'source-a', method: 'GET', path: '/pdf',
      status: EndpointDefinitionStatus.VERIFIED,
    });
    endpointId = endpoint.id;
    bindServices();
  });

  function bindServices() {
    objects = new EndpointTestSampleObjectService(db.getRepository(EndpointTestSampleObjectEntity));
    service = new EndpointTestingService(
      db.getRepository(EndpointDefinitionEntity),
      db.getRepository(EndpointTestCaseEntity),
      db.getRepository(EndpointTestRunEntity),
      db.getRepository(EndpointTestSampleEntity),
      db.getRepository(EndpointTestSampleObjectEntity),
      objects,
    );
  }

  async function restartFromExport() {
    const database = (db.driver as any).export() as Uint8Array;
    await db.destroy();
    db = await new DataSource({
      type: 'sqljs', database, entities, synchronize: false,
    }).initialize();
    bindServices();
  }

  afterEach(async () => {
    await db.destroy();
    if (resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('api-nova-binary-tx-')) {
      await fs.rm(root, { recursive: true, force: true });
    }
    if (originalRoot === undefined) delete process.env.ENDPOINT_TEST_SAMPLE_BINARY_DIR;
    else process.env.ENDPOINT_TEST_SAMPLE_BINARY_DIR = originalRoot;
    if (originalFlag === undefined) delete process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED;
    else process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED = originalFlag;
    if (originalLimit === undefined) delete process.env.ENDPOINT_TEST_SAMPLE_MAX_BYTES;
    else process.env.ENDPOINT_TEST_SAMPLE_MAX_BYTES = originalLimit;
  });

  async function capture() {
    let trustedBinaryCapture: TrustedBinaryCapture | undefined;
    const responsePayload = await readBoundedTestResponse(
      Readable.from([bytes], { objectMode: false }),
      { 'content-type': 'application/pdf' },
      4,
      trusted => { trustedBinaryCapture = trusted; },
    );
    return { responsePayload, trustedBinaryCapture };
  }

  it('commits one run, one sample and one ready object; deletion paths fail closed', async () => {
    const result = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    const row = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      sampleId: result.sample.id,
    });
    expect(row.state).toBe('ready');
    expect(row.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(await objects.read(result.sample.id, row.id)).toEqual(bytes);
    expect((result.run.responsePayload as any).opaqueObjectId).toBeUndefined();
    expect((result.sample.responsePayload as any).opaqueObjectId).toBe(row.id);
    expect(await db.getRepository(EndpointTestRunEntity).count()).toBe(1);
    expect(await db.getRepository(EndpointTestSampleEntity).count()).toBe(1);
    await expect(service.deleteTestSample(result.sample.id)).rejects.toThrow(
      'Binary sample object requires explicit reference revocation',
    );
    await db.getRepository(EndpointTestSampleEntity).update(result.sample.id, {
      status: EndpointTestSampleStatus.ARCHIVED,
      capturedAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    expect(await service.cleanupExpiredSamples(30)).toEqual(
      expect.objectContaining({ deletedCount: 0, skippedObjectCount: 1 }),
    );
    expect(await db.getRepository(EndpointTestSampleEntity).count()).toBe(1);
  });

  it('rolls back a failed object promotion and saves a success with storage_failed only', async () => {
    await db.query(
      "CREATE TRIGGER reject_object_ready BEFORE UPDATE ON endpoint_test_sample_objects " +
      "WHEN NEW.state = 'ready' BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );
    const result = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    expect(result.run.status).toBe('success');
    expect((result.sample.responsePayload as any).captureState).toBe('storage_failed');
    expect((result.sample.responsePayload as any).opaqueObjectId).toBeUndefined();
    expect(await db.getRepository(EndpointTestRunEntity).count()).toBe(1);
    expect(await db.getRepository(EndpointTestSampleEntity).count()).toBe(1);
    const row = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      sampleId: result.sample.id,
    });
    expect(row.state).toBe('staged');
    await expect(objects.read(result.sample.id, row.id)).rejects.toThrow('OBJECT_UNAVAILABLE');
    expect((await fs.readdir(root))).toEqual([row.objectKey + '.raw']);
    await restartFromExport();
    const persisted = await db.getRepository(EndpointTestSampleEntity).findOneByOrFail({
      id: result.sample.id,
    });
    const restartedRow = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      id: row.id,
    });
    expect((persisted.responsePayload as any).captureState).toBe('storage_failed');
    expect(restartedRow.state).toBe('staged');
    await expect(objects.read(restartedRow.sampleId, restartedRow.id)).rejects.toThrow('OBJECT_UNAVAILABLE');
    expect((await fs.readdir(root))).toEqual([row.objectKey + '.raw']);
  });

  it('keeps a successful HTTP result when object staging persistence fails', async () => {
    await db.query(
      "CREATE TRIGGER reject_object_insert BEFORE INSERT ON endpoint_test_sample_objects " +
      "BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );
    const result = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    expect(result.run.status).toBe('success');
    expect((result.sample.responsePayload as any).captureState).toBe('storage_failed');
    expect(await db.getRepository(EndpointTestSampleObjectEntity).count()).toBe(0);
    expect(await db.getRepository(EndpointTestRunEntity).count()).toBe(1);
    expect(await db.getRepository(EndpointTestSampleEntity).count()).toBe(1);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('keeps repeated successful samples and object keys independent', async () => {
    const first = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    const second = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    const repo = db.getRepository(EndpointTestSampleObjectEntity);
    const firstObject = await repo.findOneByOrFail({ sampleId: first.sample.id });
    const secondObject = await repo.findOneByOrFail({ sampleId: second.sample.id });
    expect(first.sample.id).not.toBe(second.sample.id);
    expect(first.run.id).not.toBe(second.run.id);
    expect(firstObject.id).not.toBe(secondObject.id);
    expect(firstObject.objectKey).not.toBe(secondObject.objectKey);
    expect(first.sample.fingerprint).toBe(second.sample.fingerprint);
    expect(await objects.read(first.sample.id, firstObject.id)).toEqual(bytes);
    expect(await objects.read(second.sample.id, secondObject.id)).toEqual(bytes);
    await expect(objects.read(first.sample.id, secondObject.id)).rejects.toThrow('OBJECT_UNAVAILABLE');
    expect((await fs.readdir(root)).sort()).toEqual(
      [firstObject.objectKey + '.raw', secondObject.objectKey + '.raw'].sort(),
    );
    expect(await db.getRepository(EndpointTestRunEntity).count()).toBe(2);
    expect(await db.getRepository(EndpointTestSampleEntity).count()).toBe(2);
  });

  it('keeps an old staged tombstone isolated from a later successful sample', async () => {
    await db.query(
      "CREATE TRIGGER reject_object_ready BEFORE UPDATE ON endpoint_test_sample_objects " +
      "WHEN NEW.state = 'ready' BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );
    const failedStorage = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    const oldObject = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      sampleId: failedStorage.sample.id,
    });
    expect(oldObject.state).toBe('staged');
    await db.query('DROP TRIGGER reject_object_ready');
    const next = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    const nextObject = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      sampleId: next.sample.id,
    });
    expect(nextObject.state).toBe('ready');
    expect(nextObject.id).not.toBe(oldObject.id);
    expect(nextObject.objectKey).not.toBe(oldObject.objectKey);
    expect((failedStorage.sample.responsePayload as any).captureState).toBe('storage_failed');
    await expect(objects.read(oldObject.sampleId, oldObject.id)).rejects.toThrow('OBJECT_UNAVAILABLE');
    expect(await objects.read(next.sample.id, nextObject.id)).toEqual(bytes);
    expect((await fs.readdir(root)).sort()).toEqual(
      [oldObject.objectKey + '.raw', nextObject.objectKey + '.raw'].sort(),
    );
  });

  it('keeps a staged tombstone without a file when exclusive file open fails', async () => {
    const open = jest.spyOn(fs, 'open').mockRejectedValueOnce(new Error('simulated open failure'));
    let result: Awaited<ReturnType<EndpointTestingService['recordSuccessfulRun']>>;
    try {
      result = await service.recordSuccessfulRun({
        endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
      });
    } finally {
      open.mockRestore();
    }
    expect(result.run.status).toBe('success');
    expect((result.sample.responsePayload as any).captureState).toBe('storage_failed');
    const row = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      sampleId: result.sample.id,
    });
    expect(row.state).toBe('staged');
    expect(await fs.readdir(root)).toEqual([]);
    await expect(objects.read(row.sampleId, row.id)).rejects.toThrow('OBJECT_UNAVAILABLE');
  });

  it('keeps a staged temporary file unreadable when rename fails', async () => {
    const rename = jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('simulated rename failure'));
    let result: Awaited<ReturnType<EndpointTestingService['recordSuccessfulRun']>>;
    try {
      result = await service.recordSuccessfulRun({
        endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
      });
    } finally {
      rename.mockRestore();
    }
    expect(result.run.status).toBe('success');
    expect((result.sample.responsePayload as any).captureState).toBe('storage_failed');
    const row = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      sampleId: result.sample.id,
    });
    expect(row.state).toBe('staged');
    expect(await fs.readdir(root)).toEqual([row.objectKey + '.stage']);
    await expect(objects.read(row.sampleId, row.id)).rejects.toThrow('OBJECT_UNAVAILABLE');
  });

  it('reads a committed object after SQL.js export and service restart', async () => {
    const first = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    const objectId = (first.sample.responsePayload as any).opaqueObjectId;
    await restartFromExport();
    const persisted = await db.getRepository(EndpointTestSampleEntity).findOneByOrFail({
      id: first.sample.id,
    });
    const row = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      id: objectId,
    });
    expect(row.state).toBe('ready');
    expect((persisted.responsePayload as any).opaqueObjectId).toBe(objectId);
    expect(await objects.read(persisted.id, objectId)).toEqual(bytes);
  });

  it('rolls back both run and sample when the sample transaction itself fails', async () => {
    await db.query(
      "CREATE TRIGGER reject_sample BEFORE INSERT ON endpoint_test_samples " +
      "BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );
    await expect(service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    })).rejects.toThrow();
    expect(await db.getRepository(EndpointTestRunEntity).count()).toBe(0);
    expect(await db.getRepository(EndpointTestSampleEntity).count()).toBe(0);
    const row = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({});
    expect(row.state).toBe('staged');
    await expect(objects.read(row.sampleId, row.id)).rejects.toThrow('OBJECT_UNAVAILABLE');
    await restartFromExport();
    expect(await db.getRepository(EndpointTestRunEntity).count()).toBe(0);
    expect(await db.getRepository(EndpointTestSampleEntity).count()).toBe(0);
    const restartedRow = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      id: row.id,
    });
    expect(restartedRow.state).toBe('staged');
    await expect(objects.read(restartedRow.sampleId, restartedRow.id)).rejects.toThrow('OBJECT_UNAVAILABLE');
    expect((await fs.readdir(root))).toEqual([row.objectKey + '.raw']);
  });
});
