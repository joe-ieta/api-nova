import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
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

  it('revokes an explicit binary sample without deleting its row, tombstone or file', async () => {
    const result = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    const row = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      sampleId: result.sample.id,
    });
    expect(row.state).toBe('ready');
    expect(row.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(await service.readBinaryContent(result.sample.id)).toEqual(bytes);
    expect((result.run.responsePayload as any).opaqueObjectId).toBeUndefined();

    const pending = { sampleId: result.sample.id, deleted: false, pending: true };
    expect(await service.deleteTestSample(result.sample.id)).toEqual(pending);
    const retained = await db.getRepository(EndpointTestSampleEntity).findOneByOrFail({
      id: result.sample.id,
    });
    const tombstone = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      id: row.id,
    });
    expect(retained.status).toBe(EndpointTestSampleStatus.ARCHIVED);
    expect(retained.enabled).toBe(false);
    expect((retained.responsePayload as any)).toEqual(expect.objectContaining({
      kind: 'binary', captureState: 'unavailable', deletionState: 'pending',
      sha256: row.sha256,
    }));
    expect((retained.responsePayload as any).opaqueObjectId).toBeUndefined();
    expect(tombstone.state).toBe('delete_pending');
    await expect(service.readBinaryContent(result.sample.id)).rejects.toMatchObject({ status: 410 });
    await expect(objects.read(result.sample.id, row.id)).rejects.toThrow('OBJECT_UNAVAILABLE');
    expect(await fs.readdir(root)).toEqual([row.objectKey + '.raw']);
    expect(await db.getRepository(EndpointTestSampleEntity).count()).toBe(1);
    expect(await db.getRepository(EndpointTestSampleObjectEntity).count()).toBe(1);
    expect(await service.deleteTestSample(result.sample.id)).toEqual(pending);

    await restartFromExport();
    expect(await service.deleteTestSample(result.sample.id)).toEqual(pending);
    await expect(service.readBinaryContent(result.sample.id)).rejects.toMatchObject({ status: 410 });
    expect(await fs.readdir(root)).toEqual([row.objectKey + '.raw']);
  });

  it('marks only old archived binary samples pending and keeps active/recent samples', async () => {
    const old = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    const active = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    const recent = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    const samples = db.getRepository(EndpointTestSampleEntity);
    await samples.update(old.sample.id, {
      status: EndpointTestSampleStatus.ARCHIVED,
      capturedAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    await samples.update(active.sample.id, { capturedAt: new Date('2020-01-01T00:00:00.000Z') });
    await samples.update(recent.sample.id, { status: EndpointTestSampleStatus.ARCHIVED });
    const first = await service.cleanupExpiredSamples(30);
    expect(first).toEqual(expect.objectContaining({
      deletedCount: 0, pendingObjectCount: 1, skippedObjectCount: 0,
    }));
    const oldRow = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      sampleId: old.sample.id,
    });
    expect(oldRow.state).toBe('delete_pending');
    expect((await samples.findOneByOrFail({ id: old.sample.id }).then(s => s.responsePayload) as any).deletionState).toBe('pending');
    expect((await samples.findOneByOrFail({ id: active.sample.id })).status).toBe(EndpointTestSampleStatus.ACTIVE);
    expect((await samples.findOneByOrFail({ id: recent.sample.id })).status).toBe(EndpointTestSampleStatus.ARCHIVED);
    expect(await service.readBinaryContent(active.sample.id)).toEqual(bytes);
    expect(await service.readBinaryContent(recent.sample.id)).toEqual(bytes);
    expect(await service.cleanupExpiredSamples(30)).toEqual(expect.objectContaining({
      deletedCount: 0, pendingObjectCount: 1,
    }));
    expect((await fs.readdir(root)).length).toBe(3);
  });

  it('retries retention revocation after an object tombstone write failure', async () => {
    const result = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    await db.getRepository(EndpointTestSampleEntity).update(result.sample.id, {
      status: EndpointTestSampleStatus.ARCHIVED,
      capturedAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    const row = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      sampleId: result.sample.id,
    });
    await db.query(
      "CREATE TRIGGER reject_tombstone BEFORE UPDATE ON endpoint_test_sample_objects " +
      "WHEN NEW.state = 'delete_pending' BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );
    await expect(service.cleanupExpiredSamples(30)).rejects.toThrow();
    expect((await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({ id: row.id })).state).toBe('ready');
    expect((await db.getRepository(EndpointTestSampleEntity).findOneByOrFail({
      id: result.sample.id,
    }).then(s => s.responsePayload) as any).opaqueObjectId).toBe(row.id);
    expect(await service.readBinaryContent(result.sample.id)).toEqual(bytes);
    await db.query('DROP TRIGGER reject_tombstone');
    expect(await service.cleanupExpiredSamples(30)).toEqual(expect.objectContaining({
      deletedCount: 0, pendingObjectCount: 1,
    }));
    await expect(service.readBinaryContent(result.sample.id)).rejects.toMatchObject({ status: 410 });
    expect(await fs.readdir(root)).toEqual([row.objectKey + '.raw']);
  });
  it('rolls back a failed revocation and permits retry without a PATCH revival', async () => {
    const result = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    const row = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      sampleId: result.sample.id,
    });
    await db.query(
      "CREATE TRIGGER reject_sample_revoke BEFORE UPDATE OF responsePayload ON endpoint_test_samples " +
      "BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );
    await expect(service.deleteTestSample(result.sample.id)).rejects.toThrow();
    expect((await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({ id: row.id })).state).toBe('ready');
    expect((await db.getRepository(EndpointTestSampleEntity).findOneByOrFail({
      id: result.sample.id,
    }).then(s => s.responsePayload) as any).opaqueObjectId).toBe(row.id);
    expect(await service.readBinaryContent(result.sample.id)).toEqual(bytes);
    await db.query('DROP TRIGGER reject_sample_revoke');

    expect(await service.deleteTestSample(result.sample.id)).toEqual({
      sampleId: result.sample.id, deleted: false, pending: true,
    });
    await expect(service.updateTestSample(result.sample.id, {
      status: EndpointTestSampleStatus.ACTIVE, enabled: true,
    })).rejects.toMatchObject({ status: 410 });
    const current = await db.getRepository(EndpointTestSampleEntity).findOneByOrFail({
      id: result.sample.id,
    });
    expect(current.enabled).toBe(false);
    expect((current.responsePayload as any).deletionState).toBe('pending');
    await expect(service.readBinaryContent(result.sample.id)).rejects.toMatchObject({ status: 410 });
    expect(await fs.readdir(root)).toEqual([row.objectKey + '.raw']);
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
    expect(await service.deleteTestSample(result.sample.id)).toEqual({
      sampleId: result.sample.id, deleted: false, pending: true,
    });
    expect((await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      id: row.id,
    })).state).toBe('delete_pending');
    expect((await db.getRepository(EndpointTestSampleEntity).findOneByOrFail({
      id: result.sample.id,
    }).then(s => s.responsePayload) as any).deletionState).toBe('pending');
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

  async function agePending(sampleId: string) {
    const repo = db.getRepository(EndpointTestSampleEntity);
    const sample = await repo.findOneByOrFail({ id: sampleId });
    await repo.update(sampleId, {
      responsePayload: {
        ...(sample.responsePayload as Record<string, unknown>),
        deletionRequestedAt: '2020-01-01T00:00:00.000Z',
      },
    });
  }

  it('reclaims a revoked object only after grace and preserves unrelated ready bytes', async () => {
    const removed = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    const ready = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    const row = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      sampleId: removed.sample.id,
    });
    const samples = db.getRepository(EndpointTestSampleEntity);
    const original = await samples.findOneByOrFail({ id: removed.sample.id });
    await samples.update(removed.sample.id, {
      responsePayload: { ...(original.responsePayload as object),
        deletionRequestedAt: '2020-01-01T00:00:00.000Z' },
    });
    await service.deleteTestSample(removed.sample.id);
    const timestamp = (await db.getRepository(EndpointTestSampleEntity).findOneByOrFail({
      id: removed.sample.id,
    }).then(s => s.responsePayload) as any).deletionRequestedAt;
    expect(typeof timestamp).toBe('string');
    expect(timestamp).not.toBe('2020-01-01T00:00:00.000Z');
    await service.deleteTestSample(removed.sample.id);
    expect((await db.getRepository(EndpointTestSampleEntity).findOneByOrFail({
      id: removed.sample.id,
    }).then(s => s.responsePayload) as any).deletionRequestedAt).toBe(timestamp);
    expect(await service.cleanupPendingBinaryObjects()).toEqual(expect.objectContaining({
      scannedCount: 1, deletedCount: 0, deferredCount: 1,
    }));
    expect(await fs.readdir(root)).toContain(row.objectKey + '.raw');
    await agePending(removed.sample.id);
    const [first, concurrent] = await Promise.all([
      service.cleanupPendingBinaryObjects(), service.cleanupPendingBinaryObjects(),
    ]);
    expect(first).toEqual(concurrent);
    expect(first.deletedCount).toBe(1);
    expect(await db.getRepository(EndpointTestSampleEntity).findOneBy({ id: removed.sample.id })).toBeNull();
    expect((await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      id: row.id,
    })).state).toBe('deleted');
    expect(await fs.readdir(root)).not.toContain(row.objectKey + '.raw');
    expect(await service.readBinaryContent(ready.sample.id)).toEqual(bytes);
    await restartFromExport();
    expect((await service.cleanupPendingBinaryObjects()).scannedCount).toBe(0);
    expect(await service.readBinaryContent(ready.sample.id)).toEqual(bytes);
  });

  it('retains the tombstone and retries a real file unlink failure after restart', async () => {
    const result = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    const row = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      sampleId: result.sample.id,
    });
    await service.deleteTestSample(result.sample.id);
    await agePending(result.sample.id);
    const unlink = jest.spyOn(fs, 'unlink').mockRejectedValueOnce(
      Object.assign(new Error('simulated permission failure'), { code: 'EACCES' }),
    );
    try {
      expect(await service.cleanupPendingBinaryObjects()).toEqual(expect.objectContaining({
        deletedCount: 0, failedCount: 1,
      }));
    } finally { unlink.mockRestore(); }
    const pending = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({ id: row.id });
    expect(pending.state).toBe('delete_pending');
    expect(pending.failureCode).toBe('OBJECT_UNLINK_FAILED');
    expect(pending.deleteAttempts).toBe(1);
    expect(await fs.readdir(root)).toEqual([row.objectKey + '.raw']);
    await restartFromExport();
    expect((await service.cleanupPendingBinaryObjects()).deletedCount).toBe(1);
    expect(await db.getRepository(EndpointTestSampleEntity).findOneBy({ id: result.sample.id })).toBeNull();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('keeps revocation after terminal DB failure and finishes an ENOENT retry', async () => {
    const result = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    const row = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      sampleId: result.sample.id,
    });
    await service.deleteTestSample(result.sample.id);
    await agePending(result.sample.id);
    await db.query(
      "CREATE TRIGGER reject_finalize BEFORE DELETE ON endpoint_test_samples " +
      "BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );
    expect(await service.cleanupPendingBinaryObjects()).toEqual(expect.objectContaining({
      deletedCount: 0, failedCount: 1,
    }));
    expect(await fs.readdir(root)).toEqual([]);
    expect((await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      id: row.id,
    })).state).toBe('delete_pending');
    expect((await db.getRepository(EndpointTestSampleEntity).findOneByOrFail({
      id: result.sample.id,
    }).then(s => s.responsePayload) as any).deletionState).toBe('pending');
    await expect(service.readBinaryContent(result.sample.id)).rejects.toMatchObject({ status: 410 });
    await restartFromExport();
    await db.query('DROP TRIGGER reject_finalize');
    expect((await service.cleanupPendingBinaryObjects()).deletedCount).toBe(1);
    expect((await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      id: row.id,
    })).state).toBe('deleted');
    expect(await db.getRepository(EndpointTestSampleEntity).findOneBy({ id: result.sample.id })).toBeNull();
  });

  it('rejects an invalid managed key without unlinking any file', async () => {
    const result = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    const repo = db.getRepository(EndpointTestSampleObjectEntity);
    const row = await repo.findOneByOrFail({ sampleId: result.sample.id });
    await service.deleteTestSample(result.sample.id);
    await agePending(result.sample.id);
    await repo.update(row.id, { objectKey: '../outside' });
    expect((await service.cleanupPendingBinaryObjects()).failedCount).toBe(1);
    expect(await fs.readdir(root)).toEqual([row.objectKey + '.raw']);
    expect((await repo.findOneByOrFail({ id: row.id })).state).toBe('delete_pending');
    await repo.update(row.id, { objectKey: row.objectKey });
    expect((await service.cleanupPendingBinaryObjects()).deletedCount).toBe(1);
  });

  it('reclaims a revoked staged file without touching a live object', async () => {
    const rename = jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('staging failure'));
    let staged: Awaited<ReturnType<EndpointTestingService['recordSuccessfulRun']>>;
    try {
      staged = await service.recordSuccessfulRun({
        endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
      });
    } finally { rename.mockRestore(); }
    const ready = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    const row = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      sampleId: staged.sample.id,
    });
    expect(row.state).toBe('staged');
    await service.deleteTestSample(staged.sample.id);
    await agePending(staged.sample.id);
    expect((await service.cleanupPendingBinaryObjects()).deletedCount).toBe(1);
    expect(await fs.readdir(root)).not.toContain(row.objectKey + '.stage');
    expect(await service.readBinaryContent(ready.sample.id)).toEqual(bytes);
  });


  it('caps a pass at 100 and advances past failed candidates after restart', async () => {
    const samples = db.getRepository(EndpointTestSampleEntity);
    const objectRows = db.getRepository(EndpointTestSampleObjectEntity);
    const timestamp = '2020-01-01T00:00:00.000Z';
    const fixtures = Array.from({ length: 101 }, () => samples.create({
      id: randomUUID(), endpointDefinitionId: endpointId, testRunId: randomUUID(),
      fingerprint: 'f'.repeat(64), responseStatusCode: 200,
      capturedAt: new Date(timestamp), archivedAt: new Date(timestamp),
      status: EndpointTestSampleStatus.ARCHIVED, enabled: false,
      responsePayload: {
        kind: 'binary', schemaVersion: 1, captureState: 'unavailable',
        deletionState: 'pending', deletionRequestedAt: timestamp,
      },
    }));
    await samples.save(fixtures);
    await objectRows.save(fixtures.map((sample, index) => objectRows.create({
      sampleId: sample.id, side: 'response', state: 'delete_pending',
      objectKey: index < 100 ? 'invalid-' + index : index.toString(16).padStart(64, '0'),
      mediaType: 'application/pdf', measurement: 'decoded_response_body',
      observedBytes: 0, sha256: createHash('sha256').update('').digest('hex'),
      createdAt: new Date(index < 100 ? '2020-01-01' : '2021-01-01'),
      updatedAt: new Date(index < 100 ? '2020-01-01' : '2021-01-01'),
    })));
    const first = await service.cleanupPendingBinaryObjects();
    expect(first.batchLimit).toBe(100);
    expect(first.scannedCount).toBe(100);
    expect(first.failedCount).toBe(100);
    expect(first.deletedCount).toBe(0);
    expect(await objectRows.countBy({ state: 'delete_pending' })).toBe(101);
    await restartFromExport();
    const second = await service.cleanupPendingBinaryObjects();
    expect(second.deletedCount).toBe(1);
    expect(await db.getRepository(EndpointTestSampleEntity).findOneBy({ id: fixtures[100].id })).toBeNull();
    expect((await fs.readdir(root))).toEqual([]);
  });


  it('refuses a linked file and keeps the pending tombstone until safe retry', async () => {
    const result = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    const row = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      sampleId: result.sample.id,
    });
    await service.deleteTestSample(result.sample.id);
    await agePending(result.sample.id);
    const alias = join(root, 'unmanaged-alias');
    await fs.link(join(root, row.objectKey + '.raw'), alias);
    expect((await service.cleanupPendingBinaryObjects()).failedCount).toBe(1);
    expect((await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      id: row.id,
    })).failureCode).toBe('OBJECT_INTEGRITY_FAILED');
    expect(await fs.readFile(alias)).toEqual(bytes);
    expect(await fs.readFile(join(root, row.objectKey + '.raw'))).toEqual(bytes);
    await fs.unlink(alias);
    expect((await service.cleanupPendingBinaryObjects()).deletedCount).toBe(1);
  });


  it('stops starting new objects after one file operation crosses the soft budget', async () => {
    const first = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    const second = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    await service.deleteTestSample(first.sample.id);
    await service.deleteTestSample(second.sample.id);
    await agePending(first.sample.id);
    await agePending(second.sample.id);
    const originalUnlink = fs.unlink.bind(fs);
    const start = Date.now();
    let now = start;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const unlink = jest.spyOn(fs, 'unlink').mockImplementationOnce(async path => {
      now = start + 3000;
      return originalUnlink(path);
    });
    let pass: Awaited<ReturnType<EndpointTestingService['cleanupPendingBinaryObjects']>>;
    try { pass = await service.cleanupPendingBinaryObjects(); }
    finally { unlink.mockRestore(); clock.mockRestore(); }
    expect(pass).toEqual(expect.objectContaining({
      scannedCount: 1, deletedCount: 1, timeBudgetExceeded: true,
    }));
    expect(await db.getRepository(EndpointTestSampleObjectEntity).countBy({
      state: 'delete_pending',
    })).toBe(1);
    expect((await service.cleanupPendingBinaryObjects()).deletedCount).toBe(1);
  });

});
