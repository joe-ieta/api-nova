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

  function peerServices() {
    const peerObjects = new EndpointTestSampleObjectService(
      db.getRepository(EndpointTestSampleObjectEntity),
    );
    const peerService = new EndpointTestingService(
      db.getRepository(EndpointDefinitionEntity),
      db.getRepository(EndpointTestCaseEntity),
      db.getRepository(EndpointTestRunEntity),
      db.getRepository(EndpointTestSampleEntity),
      db.getRepository(EndpointTestSampleObjectEntity),
      peerObjects,
    );
    return { peerObjects, peerService };
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
    await ageObject(row.id);
    expect(await service.cleanupPendingBinaryObjects()).toEqual(expect.objectContaining({
      deletedCount: 1, orphanDeletedCount: 1,
    }));
    expect((await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      id: row.id,
    })).state).toBe('deleted');
    expect(await fs.readdir(root)).toEqual([]);
  });

  async function stagedOrphan() {
    const sampleId = randomUUID();
    const prepared = await objects.prepare(
      sampleId, bytes, 'application/pdf', 'decoded_response_body',
    );
    if (prepared.captureState !== 'staged') throw new Error('Expected staged fixture');
    return db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      id: prepared.objectId,
    });
  }

  async function ageObject(objectId: string) {
    await db.getRepository(EndpointTestSampleObjectEntity).update(objectId, {
      createdAt: new Date('2020-01-01T00:00:00.000Z'),
    });
  }

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


  it('serializes a publisher and explicit revocation through ready commit', async () => {
    let entered!: (sampleId: string) => void;
    let release!: () => void;
    const staged = new Promise<string>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const originalStage = objects.stagePublishedFile.bind(objects);
    const stage = jest.spyOn(objects, 'stagePublishedFile').mockImplementation(async (sampleId, objectId) => {
      entered(sampleId);
      await gate;
      return originalStage(sampleId, objectId);
    });
    try {
      const recording = service.recordSuccessfulRun({
        endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
      });
      const sampleId = await staged;
      let deletionFinished = false;
      const deleting = service.deleteTestSample(sampleId).then(result => {
        deletionFinished = true;
        return result;
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(deletionFinished).toBe(false);
      release();
      const recorded = await recording;
      expect(recorded.sample.id).toBe(sampleId);
      expect(await deleting).toEqual({ sampleId, deleted: false, pending: true });
      const object = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
        sampleId,
      });
      expect(object.state).toBe('delete_pending');
      await expect(service.readBinaryContent(sampleId)).rejects.toMatchObject({ status: 410 });
      expect(await fs.readdir(root)).toEqual([object.objectKey + '.raw']);
    } finally {
      release();
      stage.mockRestore();
    }
  });

  it('rechecks the first revocation time after waiting for the object fence', async () => {
    const recorded = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    const sampleId = recorded.sample.id;
    const object = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      sampleId,
    });
    await service.deleteTestSample(sampleId);
    await agePending(sampleId);
    let entered!: () => void;
    let release!: () => void;
    const held = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const blocker = objects.withSampleFence(sampleId, async () => {
      entered();
      await gate;
    });
    await held;
    let queued!: () => void;
    const queuedCall = new Promise<void>(resolve => { queued = resolve; });
    const originalFence = objects.withSampleFence.bind(objects);
    const fence = jest.spyOn(objects, 'withSampleFence').mockImplementation(async (owner, work) => {
      if (owner === sampleId) queued();
      return originalFence(owner, work);
    });
    try {
      const cleaning = service.cleanupPendingBinaryObjects();
      await queuedCall;
      const samples = db.getRepository(EndpointTestSampleEntity);
      const sample = await samples.findOneByOrFail({ id: sampleId });
      await samples.update(sampleId, {
        responsePayload: {
          ...(sample.responsePayload as Record<string, unknown>),
          deletionRequestedAt: new Date().toISOString(),
        },
      });
      release();
      expect(await cleaning).toEqual(expect.objectContaining({
        deletedCount: 0, deferredCount: 1,
      }));
      expect((await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
        id: object.id,
      })).state).toBe('delete_pending');
      expect(await fs.readdir(root)).toEqual([object.objectKey + '.raw']);
    } finally {
      release();
      await blocker;
      fence.mockRestore();
    }
  });


  it('holds the fence while the ready transaction is waiting to commit', async () => {
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const manager = db.manager as any;
    const originalTransaction = manager.transaction.bind(manager);
    let firstTransaction = true;
    const transaction = jest.spyOn(manager, 'transaction').mockImplementation(
      async (...args: any[]) => {
        if (firstTransaction) {
          firstTransaction = false;
          entered();
          await gate;
        }
        return originalTransaction(...args);
      },
    );
    try {
      const recording = service.recordSuccessfulRun({
        endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
      });
      await waiting;
      const object = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({});
      expect(object.state).toBe('staged');
      let deletionFinished = false;
      const deleting = service.deleteTestSample(object.sampleId).then(result => {
        deletionFinished = true;
        return result;
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(deletionFinished).toBe(false);
      release();
      const recorded = await recording;
      expect(recorded.sample.id).toBe(object.sampleId);
      expect(await deleting).toEqual({
        sampleId: object.sampleId, deleted: false, pending: true,
      });
      expect((await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
        id: object.id,
      })).state).toBe('delete_pending');
    } finally {
      release();
      transaction.mockRestore();
    }
  });


  it('defers a fresh unowned stage and persists the CAS before controlled unlink', async () => {
    const row = await stagedOrphan();
    expect(await service.cleanupPendingBinaryObjects()).toEqual(expect.objectContaining({
      scannedCount: 1, deferredCount: 1, deletedCount: 0, batchLimit: 100,
    }));
    expect(await fs.readdir(root)).toEqual([row.objectKey + '.stage']);
    await ageObject(row.id);
    const originalUnlink = objects.unlinkPending.bind(objects);
    const unlink = jest.spyOn(objects, 'unlinkPending').mockImplementation(async pending => {
      const claimed = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
        id: row.id,
      });
      expect(claimed.state).toBe('delete_pending');
      expect(claimed.failureCode).toBe('ORPHAN_CLAIMED');
      expect(await fs.readdir(root)).toEqual([row.objectKey + '.stage']);
      return originalUnlink(pending);
    });
    try {
      expect(await service.cleanupPendingBinaryObjects()).toEqual(expect.objectContaining({
        scannedCount: 1, deletedCount: 1, orphanDeletedCount: 1, failedCount: 0,
      }));
      expect(unlink).toHaveBeenCalledTimes(1);
    } finally { unlink.mockRestore(); }
    expect((await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      id: row.id,
    })).state).toBe('deleted');
    expect(await fs.readdir(root)).toEqual([]);
    await restartFromExport();
    expect((await service.cleanupPendingBinaryObjects()).scannedCount).toBe(0);
  });

  it('retains an orphan claim on unlink failure and retries after restart', async () => {
    const row = await stagedOrphan();
    await ageObject(row.id);
    const unlink = jest.spyOn(fs, 'unlink').mockRejectedValueOnce(
      Object.assign(new Error('simulated permission failure'), { code: 'EACCES' }),
    );
    try {
      expect(await service.cleanupPendingBinaryObjects()).toEqual(expect.objectContaining({
        deletedCount: 0, orphanDeletedCount: 0, failedCount: 1,
      }));
    } finally { unlink.mockRestore(); }
    const pending = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      id: row.id,
    });
    expect(pending.state).toBe('delete_pending');
    expect(pending.failureCode).toBe('ORPHAN_UNLINK_FAILED');
    expect(pending.deleteAttempts).toBe(1);
    expect(await fs.readdir(root)).toEqual([row.objectKey + '.stage']);
    await restartFromExport();
    expect(await service.cleanupPendingBinaryObjects()).toEqual(expect.objectContaining({
      deletedCount: 1, orphanDeletedCount: 1,
    }));
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('keeps an orphan tombstone after terminal DB failure and retries ENOENT', async () => {
    const row = await stagedOrphan();
    await ageObject(row.id);
    await db.query(
      "CREATE TRIGGER reject_orphan_finalize BEFORE UPDATE ON endpoint_test_sample_objects " +
      "WHEN NEW.state = 'deleted' BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );
    expect(await service.cleanupPendingBinaryObjects()).toEqual(expect.objectContaining({
      failedCount: 1, deletedCount: 0,
    }));
    expect(await fs.readdir(root)).toEqual([]);
    expect((await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      id: row.id,
    }))).toEqual(expect.objectContaining({
      state: 'delete_pending', failureCode: 'ORPHAN_FINALIZE_FAILED',
    }));
    await restartFromExport();
    await db.query('DROP TRIGGER reject_orphan_finalize');
    expect(await service.cleanupPendingBinaryObjects()).toEqual(expect.objectContaining({
      orphanDeletedCount: 1, deletedCount: 1,
    }));
    expect((await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      id: row.id,
    })).state).toBe('deleted');
  });

  it('rejects stale ready promotion after an orphan CAS without a readable sample', async () => {
    const row = await stagedOrphan();
    await ageObject(row.id);
    let claimed!: () => void;
    let release!: () => void;
    const atClaim = new Promise<void>(resolve => { claimed = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const originalUnlink = objects.unlinkPending.bind(objects);
    const unlink = jest.spyOn(objects, 'unlinkPending').mockImplementation(async pending => {
      expect((await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
        id: row.id,
      })).state).toBe('delete_pending');
      claimed();
      await gate;
      return originalUnlink(pending);
    });
    try {
      const cleaning = service.cleanupPendingBinaryObjects();
      await atClaim;
      await expect(db.manager.transaction(async manager => {
        const samples = manager.getRepository(EndpointTestSampleEntity);
        await samples.save(samples.create({
          id: row.sampleId, endpointDefinitionId: endpointId, testRunId: randomUUID(),
          fingerprint: 'f'.repeat(64), responseStatusCode: 200,
          status: EndpointTestSampleStatus.ACTIVE, enabled: true, capturedAt: new Date(),
          responsePayload: {
            kind: 'binary', schemaVersion: 1, captureState: 'stored',
            opaqueObjectId: row.id,
          },
        }));
        const promoted = await manager.getRepository(EndpointTestSampleObjectEntity).update(
          { id: row.id, sampleId: row.sampleId, side: 'response', state: 'staged' },
          { state: 'ready' },
        );
        if (promoted.affected !== 1) throw new Error('stale ready promotion rejected');
      })).rejects.toThrow('stale ready promotion rejected');
      expect(await db.getRepository(EndpointTestSampleEntity).findOneBy({
        id: row.sampleId,
      })).toBeNull();
      await expect(service.readBinaryContent(row.sampleId)).rejects.toMatchObject({
        status: 404,
      });
      release();
      expect((await cleaning).orphanDeletedCount).toBe(1);
      await expect(objects.publish(row.sampleId, row.id)).rejects.toThrow('OBJECT_UNAVAILABLE');
    } finally {
      release();
      unlink.mockRestore();
    }
  });

  it('reclaims an old storage_failed stage but preserves its sample evidence', async () => {
    const rename = jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('staging failure'));
    let recorded: Awaited<ReturnType<EndpointTestingService['recordSuccessfulRun']>>;
    try {
      recorded = await service.recordSuccessfulRun({
        endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
      });
    } finally { rename.mockRestore(); }
    const row = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      sampleId: recorded.sample.id,
    });
    await ageObject(row.id);
    const samples = db.getRepository(EndpointTestSampleEntity);
    const sample = await samples.findOneByOrFail({ id: row.sampleId });
    for (const opaqueObjectId of [row.id, randomUUID()]) {
      await samples.update(row.sampleId, {
        responsePayload: { ...(sample.responsePayload as object), opaqueObjectId },
      });
      expect((await service.cleanupPendingBinaryObjects()).failedCount).toBe(1);
      expect((await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
        id: row.id,
      })).state).toBe('staged');
      expect(await fs.readdir(root)).toEqual([row.objectKey + '.stage']);
    }
    await samples.update(row.sampleId, { responsePayload: sample.responsePayload });
    expect(await service.cleanupPendingBinaryObjects()).toEqual(expect.objectContaining({
      orphanDeletedCount: 1, deletedCount: 1,
    }));
    const retained = await samples.findOneByOrFail({ id: row.sampleId });
    expect((retained.responsePayload as any).captureState).toBe('storage_failed');
    expect((retained.responsePayload as any).opaqueObjectId).toBeUndefined();
    expect(await fs.readdir(root)).toEqual([]);
    await expect(service.readBinaryContent(row.sampleId)).rejects.toMatchObject({
      status: 404,
    });
    expect(await service.deleteTestSample(row.sampleId)).toEqual({
      sampleId: row.sampleId, deleted: true, pending: false,
    });
  });


  it('uses the explicit deletion grace after a staged orphan warning', async () => {
    const rename = jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('staging failure'));
    let recorded: Awaited<ReturnType<EndpointTestingService['recordSuccessfulRun']>>;
    try {
      recorded = await service.recordSuccessfulRun({
        endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
      });
    } finally { rename.mockRestore(); }
    const objectsRepo = db.getRepository(EndpointTestSampleObjectEntity);
    const samples = db.getRepository(EndpointTestSampleEntity);
    const row = await objectsRepo.findOneByOrFail({ sampleId: recorded.sample.id });
    await ageObject(row.id);
    await samples.update(row.sampleId, {
      responsePayload: {
        ...(recorded.sample.responsePayload as object), opaqueObjectId: row.id,
      },
    });
    expect((await service.cleanupPendingBinaryObjects()).failedCount).toBe(1);
    expect((await objectsRepo.findOneByOrFail({ id: row.id })).failureCode).toBe('ORPHAN_REFERENCED');
    expect(await service.deleteTestSample(row.sampleId)).toEqual({
      sampleId: row.sampleId, deleted: false, pending: true,
    });
    expect((await objectsRepo.findOneByOrFail({ id: row.id })).failureCode).toBeNull();
    expect(await service.cleanupPendingBinaryObjects()).toEqual(expect.objectContaining({
      deletedCount: 0, deferredCount: 1,
    }));
    expect(await fs.readdir(root)).toEqual([row.objectKey + '.stage']);
    await agePending(row.sampleId);
    expect((await service.cleanupPendingBinaryObjects()).deletedCount).toBe(1);
    expect(await fs.readdir(root)).toEqual([]);
  });


  it('refuses an invalid orphan key and keeps its file and pending claim', async () => {
    const row = await stagedOrphan();
    await ageObject(row.id);
    const repo = db.getRepository(EndpointTestSampleObjectEntity);
    await repo.update(row.id, { objectKey: '../outside' });
    expect(await service.cleanupPendingBinaryObjects()).toEqual(expect.objectContaining({
      deletedCount: 0, failedCount: 1,
    }));
    expect(await repo.findOneByOrFail({ id: row.id })).toEqual(expect.objectContaining({
      state: 'delete_pending', failureCode: 'ORPHAN_UNAVAILABLE',
    }));
    expect(await fs.readdir(root)).toEqual([row.objectKey + '.stage']);
    await repo.update(row.id, { objectKey: row.objectKey });
    expect((await service.cleanupPendingBinaryObjects()).orphanDeletedCount).toBe(1);
    expect(await fs.readdir(root)).toEqual([]);
  });


  it('does not unlink before an orphan claim commits and retries a rejected CAS', async () => {
    const row = await stagedOrphan();
    await ageObject(row.id);
    const unlink = jest.spyOn(objects, 'unlinkPending');
    await db.query(
      "CREATE TRIGGER reject_orphan_claim BEFORE UPDATE ON endpoint_test_sample_objects " +
      "WHEN NEW.state = 'delete_pending' BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );
    try {
      expect(await service.cleanupPendingBinaryObjects()).toEqual(expect.objectContaining({
        failedCount: 1, deletedCount: 0,
      }));
      expect(unlink).not.toHaveBeenCalled();
      expect(await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
        id: row.id,
      })).toEqual(expect.objectContaining({
        state: 'staged', failureCode: 'ORPHAN_STORAGE_FAILED',
      }));
      expect(await fs.readdir(root)).toEqual([row.objectKey + '.stage']);
    } finally {
      await db.query('DROP TRIGGER reject_orphan_claim');
      unlink.mockRestore();
    }
    expect((await service.cleanupPendingBinaryObjects()).orphanDeletedCount).toBe(1);
  });

  it('rechecks orphan age after a second service waits for the sample fence', async () => {
    const row = await stagedOrphan();
    await ageObject(row.id);
    const { peerObjects, peerService } = peerServices();
    let entered!: () => void;
    let release!: () => void;
    const held = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const blocker = objects.withSampleFence(row.sampleId, async () => {
      entered();
      await gate;
    });
    await held;
    let queued!: () => void;
    const waiting = new Promise<void>(resolve => { queued = resolve; });
    const originalFence = peerObjects.withSampleFence.bind(peerObjects);
    const fence = jest.spyOn(peerObjects, 'withSampleFence').mockImplementation(async (sampleId, work) => {
      if (sampleId === row.sampleId) queued();
      return originalFence(sampleId, work);
    });
    try {
      const cleaning = peerService.cleanupPendingBinaryObjects();
      await waiting;
      await db.getRepository(EndpointTestSampleObjectEntity).update(row.id, {
        createdAt: new Date(),
      });
      release();
      expect(await cleaning).toEqual(expect.objectContaining({
        deferredCount: 1, deletedCount: 0,
      }));
      expect((await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
        id: row.id,
      })).state).toBe('staged');
      expect(await fs.readdir(root)).toEqual([row.objectKey + '.stage']);
    } finally {
      release();
      await blocker;
      fence.mockRestore();
    }
    await ageObject(row.id);
    expect((await service.cleanupPendingBinaryObjects()).orphanDeletedCount).toBe(1);
  });

  it('rechecks an ambiguous owner inserted while cleanup waits for the fence', async () => {
    const row = await stagedOrphan();
    await ageObject(row.id);
    const { peerObjects, peerService } = peerServices();
    let entered!: () => void;
    let release!: () => void;
    const held = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const blocker = objects.withSampleFence(row.sampleId, async () => {
      entered();
      await gate;
    });
    await held;
    let queued!: () => void;
    const waiting = new Promise<void>(resolve => { queued = resolve; });
    const originalFence = peerObjects.withSampleFence.bind(peerObjects);
    const fence = jest.spyOn(peerObjects, 'withSampleFence').mockImplementation(async (sampleId, work) => {
      if (sampleId === row.sampleId) queued();
      return originalFence(sampleId, work);
    });
    try {
      const cleaning = peerService.cleanupPendingBinaryObjects();
      await waiting;
      const samples = db.getRepository(EndpointTestSampleEntity);
      await samples.save(samples.create({
        id: row.sampleId, endpointDefinitionId: endpointId, testRunId: randomUUID(),
        fingerprint: 'f'.repeat(64), responseStatusCode: 200,
        status: EndpointTestSampleStatus.ACTIVE, enabled: true, capturedAt: new Date(),
        responsePayload: {
          kind: 'binary', schemaVersion: 1, captureState: 'stored',
          opaqueObjectId: row.id,
        },
      }));
      release();
      expect(await cleaning).toEqual(expect.objectContaining({
        failedCount: 1, deletedCount: 0,
      }));
      expect((await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
        id: row.id,
      })).state).toBe('staged');
      expect(await fs.readdir(root)).toEqual([row.objectKey + '.stage']);
      await samples.delete(row.sampleId);
    } finally {
      release();
      await blocker;
      fence.mockRestore();
    }
    expect((await service.cleanupPendingBinaryObjects()).orphanDeletedCount).toBe(1);
  });

  it('serializes two cleanup services and a stale publisher against one orphan', async () => {
    const row = await stagedOrphan();
    await ageObject(row.id);
    const { peerObjects, peerService } = peerServices();
    let entered!: () => void;
    let release!: () => void;
    const atUnlink = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const originalUnlink = objects.unlinkPending.bind(objects);
    const unlink = jest.spyOn(objects, 'unlinkPending').mockImplementation(async pending => {
      entered();
      await gate;
      return originalUnlink(pending);
    });
    let queued = 0;
    let queuedBoth!: () => void;
    const waiting = new Promise<void>(resolve => { queuedBoth = resolve; });
    const originalFence = peerObjects.withSampleFence.bind(peerObjects);
    const fence = jest.spyOn(peerObjects, 'withSampleFence').mockImplementation(async (sampleId, work) => {
      if (sampleId === row.sampleId && ++queued === 2) queuedBoth();
      return originalFence(sampleId, work);
    });
    try {
      const first = service.cleanupPendingBinaryObjects();
      await atUnlink;
      const duplicate = peerService.cleanupPendingBinaryObjects();
      const publisher = peerObjects.publish(row.sampleId, row.id);
      await waiting;
      release();
      const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
      expect(firstResult.orphanDeletedCount).toBe(1);
      expect(duplicateResult).toEqual(expect.objectContaining({
        deletedCount: 0, failedCount: 0,
      }));
      await expect(publisher).rejects.toThrow('OBJECT_UNAVAILABLE');
      expect(unlink).toHaveBeenCalledTimes(1);
      expect((await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
        id: row.id,
      })).state).toBe('deleted');
      expect(await db.getRepository(EndpointTestSampleEntity).findOneBy({
        id: row.sampleId,
      })).toBeNull();
      expect(await fs.readdir(root)).toEqual([]);
    } finally {
      release();
      unlink.mockRestore();
      fence.mockRestore();
    }
  });


  it('does not reclaim an aged staged row while its publisher still holds the fence', async () => {
    const { peerObjects, peerService } = peerServices();
    let entered!: (value: { sampleId: string; objectId: string }) => void;
    let release!: () => void;
    const staged = new Promise<{ sampleId: string; objectId: string }>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const originalStage = objects.stagePublishedFile.bind(objects);
    const stage = jest.spyOn(objects, 'stagePublishedFile').mockImplementation(async (sampleId, objectId) => {
      entered({ sampleId, objectId });
      await gate;
      return originalStage(sampleId, objectId);
    });
    let queued!: () => void;
    const waiting = new Promise<void>(resolve => { queued = resolve; });
    const originalFence = peerObjects.withSampleFence.bind(peerObjects);
    const fence = jest.spyOn(peerObjects, 'withSampleFence').mockImplementation(async (sampleId, work) => {
      queued();
      return originalFence(sampleId, work);
    });
    try {
      const recording = service.recordSuccessfulRun({
        endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
      });
      const { sampleId, objectId } = await staged;
      await ageObject(objectId);
      const cleaning = peerService.cleanupPendingBinaryObjects();
      await waiting;
      release();
      const recorded = await recording;
      expect(recorded.sample.id).toBe(sampleId);
      expect(await cleaning).toEqual(expect.objectContaining({
        deletedCount: 0, failedCount: 0,
      }));
      expect((await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
        id: objectId,
      })).state).toBe('ready');
      expect(await service.readBinaryContent(sampleId)).toEqual(bytes);
      expect((await fs.readdir(root)).length).toBe(1);
    } finally {
      release();
      stage.mockRestore();
      fence.mockRestore();
    }
  });

});
