import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { sign } from 'jsonwebtoken';
import request = require('supertest');
import { DataSource } from 'typeorm';
import { EndpointDefinitionEntity, EndpointDefinitionStatus } from '../../database/entities/endpoint-definition.entity';
import { EndpointTestCaseEntity } from '../../database/entities/endpoint-test-case.entity';
import { EndpointTestRunEntity } from '../../database/entities/endpoint-test-run.entity';
import { EndpointTestSampleEntity, EndpointTestSampleStatus } from '../../database/entities/endpoint-test-sample.entity';
import { EndpointTestSampleObjectEntity } from '../../database/entities/endpoint-test-sample-object.entity';
import { AuthService } from '../security/services/auth.service';
import { UserService } from '../security/services/user.service';
import { JwtStrategy } from '../security/strategies/jwt.strategy';
import { readBoundedTestResponse, TrustedBinaryCapture } from '../asset-catalog/services/binary-test-response';
import { EndpointTestingController } from './endpoint-testing.controller';
import { EndpointTestSampleObjectService } from './services/endpoint-test-sample-object.service';
import { EndpointTestingService } from './services/endpoint-testing.service';

const secret = 'binary-sample-management-fixture-secret-'.repeat(2);
const body = Buffer.from([0, 255, 128, 1]);
const entities = [EndpointDefinitionEntity, EndpointTestCaseEntity, EndpointTestRunEntity,
  EndpointTestSampleEntity, EndpointTestSampleObjectEntity];
const binaryParser = (response: any, done: (error: Error | null, bytes?: Buffer) => void) => {
  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  response.on('end', () => done(null, Buffer.concat(chunks)));
  response.on('error', done);
};

describe('binary sample HTTP download (real JWT guards, SQL.js, isolated files)', () => {
  let app: any, db: DataSource, root: string, service: EndpointTestingService;
  let objects: EndpointTestSampleObjectService;
  let sampleId: string, objectId: string, endpointId: string, runId: string;
  let token: string, user: any, permissions: Set<string>;
  const originalRoot = process.env.ENDPOINT_TEST_SAMPLE_BINARY_DIR;
  const originalFlag = process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED;
  const originalLimit = process.env.ENDPOINT_TEST_SAMPLE_MAX_BYTES;
  const url = (id: string) => '/api/v1/endpoint-testing/test-samples/' + encodeURIComponent(id) + '/binary-content';

  async function capture() {
    let trustedBinaryCapture: TrustedBinaryCapture | undefined;
    const responsePayload = await readBoundedTestResponse(
      Readable.from([body], { objectMode: false }),
      { 'content-type': 'application/pdf' }, 4,
      trusted => { trustedBinaryCapture = trusted; },
    );
    return { responsePayload, trustedBinaryCapture };
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'api-nova-binary-http-'));
    process.env.ENDPOINT_TEST_SAMPLE_BINARY_DIR = root;
    process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED = 'true';
    process.env.ENDPOINT_TEST_SAMPLE_MAX_BYTES = '4';
    db = await new DataSource({ type: 'sqljs', entities, synchronize: true }).initialize();
    const endpoint = await db.getRepository(EndpointDefinitionEntity).save({
      sourceServiceAssetId: 'source-a', method: 'GET', path: '/pdf',
      status: EndpointDefinitionStatus.VERIFIED,
    });
    endpointId = endpoint.id;
    objects = new EndpointTestSampleObjectService(db.getRepository(EndpointTestSampleObjectEntity));
    service = new EndpointTestingService(
      db.getRepository(EndpointDefinitionEntity), db.getRepository(EndpointTestCaseEntity),
      db.getRepository(EndpointTestRunEntity), db.getRepository(EndpointTestSampleEntity),
      db.getRepository(EndpointTestSampleObjectEntity), objects,
    );
    const saved = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    sampleId = saved.sample.id;
    runId = saved.run.id;
    objectId = (saved.sample.responsePayload as any).opaqueObjectId;
    user = { id: randomUUID(), isActive: true, isLocked: false, hasRole: () => false };
    permissions = new Set(['server:read', 'server:manage']);
    const module = await Test.createTestingModule({
      imports: [PassportModule], controllers: [EndpointTestingController],
      providers: [
        JwtStrategy,
        { provide: EndpointTestingService, useValue: service },
        { provide: ConfigService, useValue: new ConfigService({ JWT_SECRET: secret }) },
        { provide: UserService, useValue: { findUserById: async (id: string) => id === user.id ? user : null } },
        { provide: AuthService, useValue: {
          checkPermission: async (_id: string, permission: string) => permissions.has(permission),
        } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useLogger(false);
    await app.init();
    token = sign({ sub: user.id, permissions: ['server:read', 'server:manage'] }, secret, { expiresIn: '5m' });
  });

  afterEach(async () => {
    await app?.close();
    await db?.destroy();
    if (resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('api-nova-binary-http-')) {
      await fs.rm(root, { recursive: true, force: true });
    }
    if (originalRoot === undefined) delete process.env.ENDPOINT_TEST_SAMPLE_BINARY_DIR;
    else process.env.ENDPOINT_TEST_SAMPLE_BINARY_DIR = originalRoot;
    if (originalFlag === undefined) delete process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED;
    else process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED = originalFlag;
    if (originalLimit === undefined) delete process.env.ENDPOINT_TEST_SAMPLE_MAX_BYTES;
    else process.env.ENDPOINT_TEST_SAMPLE_MAX_BYTES = originalLimit;
  });

  const authorized = () => request(app.getHttpServer()).get(url(sampleId)).set('Authorization', 'Bearer ' + token);

  it('requires a valid JWT and fresh server:manage permission', async () => {
    await request(app.getHttpServer()).get(url(sampleId)).expect(401);
    await request(app.getHttpServer()).get(url(sampleId))
      .set('Authorization', 'Bearer ' + sign({ sub: user.id }, 'unrelated-secret')).expect(401);
    permissions.delete('server:manage');
    const denied = await authorized().expect(403);
    expect(JSON.stringify(denied.body)).not.toContain(root);
    permissions.add('server:manage');
    const allowed = await authorized().buffer(true).parse(binaryParser).expect(200);
    expect(allowed.body).toEqual(body);
  });

  it('serves exact bytes with fixed headers and rejects Range', async () => {
    const response = await authorized().buffer(true).parse(binaryParser).expect(200);
    expect(response.body).toEqual(body);
    expect(response.headers['content-type']).toMatch(/^application\/octet-stream/);
    expect(response.headers['content-disposition']).toBe('attachment; filename="endpoint-test-sample.bin"');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-length']).toBe(String(body.length));
    expect(JSON.stringify(response.headers)).not.toContain(root);
    await authorized().set('Range', 'bytes=0-1').expect(400);
  });

  it('keeps archived samples readable without a run row', async () => {
    await db.getRepository(EndpointTestSampleEntity).update(sampleId, {
      status: EndpointTestSampleStatus.ARCHIVED, enabled: false,
    });
    await db.getRepository(EndpointTestRunEntity).delete(runId);
    expect((await authorized().buffer(true).parse(binaryParser).expect(200)).body).toEqual(body);
  });

  it('returns 404 for guessed IDs, default-off, staged and missing endpoint', async () => {
    await request(app.getHttpServer()).get(url(randomUUID()))
      .set('Authorization', 'Bearer ' + token).expect(404);
    delete process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED;
    await authorized().expect(404);
    process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED = 'true';
    await db.getRepository(EndpointTestSampleObjectEntity).update(objectId, { state: 'staged' });
    await authorized().expect(404);
    await db.getRepository(EndpointTestSampleObjectEntity).update(objectId, { state: 'ready' });
    await db.getRepository(EndpointDefinitionEntity).delete(endpointId);
    await authorized().expect(404);
  });

  it('returns pending for an authorized DELETE and blocks later binary reads', async () => {
    const sampleUrl = '/api/v1/endpoint-testing/test-samples/' + encodeURIComponent(sampleId);
    await request(app.getHttpServer()).delete(sampleUrl).expect(401);
    permissions.delete('server:manage');
    await request(app.getHttpServer()).delete(sampleUrl)
      .set('Authorization', 'Bearer ' + token).expect(403);
    permissions.add('server:manage');

    const result = await request(app.getHttpServer()).delete(sampleUrl)
      .set('Authorization', 'Bearer ' + token).expect(200);
    expect(result.body).toEqual({ sampleId, deleted: false, pending: true });
    const sample = await db.getRepository(EndpointTestSampleEntity).findOneByOrFail({ id: sampleId });
    const object = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({ id: objectId });
    expect((sample.responsePayload as any).deletionState).toBe('pending');
    expect((sample.responsePayload as any).opaqueObjectId).toBeUndefined();
    expect(object.state).toBe('delete_pending');
    await authorized().expect(410);
    expect((await request(app.getHttpServer()).delete(sampleUrl)
      .set('Authorization', 'Bearer ' + token).expect(200)).body)
      .toEqual({ sampleId, deleted: false, pending: true });
    expect(await fs.readdir(root)).toEqual([object.objectKey + '.raw']);
  });
  it('does not return bytes when DELETE commits while a file read is in flight', async () => {
    const originalRead = objects.read.bind(objects);
    const read = jest.spyOn(objects, 'read').mockImplementation(async (owner, id) => {
      const content = await originalRead(owner, id);
      expect(await service.deleteTestSample(sampleId)).toEqual({
        sampleId, deleted: false, pending: true,
      });
      return content;
    });
    try {
      const response = await authorized().expect(410);
      expect(JSON.stringify(response.body)).not.toContain(root);
      expect(response.headers['content-disposition']).toBeUndefined();
    } finally {
      read.mockRestore();
    }
    const row = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      id: objectId,
    });
    expect(row.state).toBe('delete_pending');
    expect(await fs.readdir(root)).toEqual([row.objectKey + '.raw']);
  });
  it('returns 410 for revoked objects and 503 for corrupt files without private paths', async () => {
    await db.getRepository(EndpointTestSampleObjectEntity).update(objectId, { state: 'delete_pending' });
    const revoked = await authorized().expect(410);
    expect(JSON.stringify(revoked.body)).not.toContain(root);
    await db.getRepository(EndpointTestSampleObjectEntity).update(objectId, { state: 'ready' });
    const row = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({ id: objectId });
    await fs.writeFile(join(root, row.objectKey + '.raw'), Buffer.from([1, 2, 3, 4]));
    const failed = await authorized().expect(503);
    expect(JSON.stringify(failed.body)).not.toContain(root);
  });

  it.each(['sha256', 'measurement'])('returns 503 for %s descriptor/object mismatch', async field => {
    const repo = db.getRepository(EndpointTestSampleEntity);
    const sample = await repo.findOneByOrFail({ id: sampleId });
    const descriptor = { ...(sample.responsePayload as object) } as Record<string, unknown>;
    descriptor[field] = field === 'sha256' ? '0'.repeat(64) : 'encoded_response_body';
    await repo.update(sampleId, { responsePayload: descriptor });
    const response = await authorized().expect(503);
    expect(JSON.stringify(response.body)).not.toContain(root);
  });

  it('returns 503 when a ready object file disappears without exposing its path', async () => {
    const row = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({ id: objectId });
    await fs.rename(join(root, row.objectKey + '.raw'), join(root, row.objectKey + '.hidden'));
    const response = await authorized().expect(503);
    expect(JSON.stringify(response.body)).not.toContain(root);
  });

  it('rejects another sample object ID and rechecks revocation after read', async () => {
    const second = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    const own = await db.getRepository(EndpointTestSampleEntity).findOneByOrFail({ id: sampleId });
    await db.getRepository(EndpointTestSampleEntity).update(sampleId, {
      responsePayload: { ...(own.responsePayload as object),
        opaqueObjectId: (second.sample.responsePayload as any).opaqueObjectId },
    });
    await authorized().expect(404);
    await db.getRepository(EndpointTestSampleEntity).update(sampleId, { responsePayload: own.responsePayload });
    const originalRead = objects.read.bind(objects);
    const read = jest.spyOn(objects, 'read').mockImplementation(async (owner, id) => {
      const bytes = await originalRead(owner, id);
      await db.getRepository(EndpointTestSampleObjectEntity).update(id, { state: 'delete_pending' });
      return bytes;
    });
    try { await authorized().expect(410); } finally { read.mockRestore(); }
  });

  it('exposes explicit object cleanup only to server managers', async () => {
    const cleanupUrl = '/api/v1/endpoint-testing/test-samples/binary-objects/cleanup';
    await request(app.getHttpServer()).post(cleanupUrl).expect(401);
    permissions.delete('server:manage');
    await request(app.getHttpServer()).post(cleanupUrl)
      .set('Authorization', 'Bearer ' + token).expect(403);
    permissions.add('server:manage');
    expect((await request(app.getHttpServer()).post(cleanupUrl)
      .set('Authorization', 'Bearer ' + token).expect(201)).body.scannedCount).toBe(0);
    await service.deleteTestSample(sampleId);
    const repo = db.getRepository(EndpointTestSampleEntity);
    const sample = await repo.findOneByOrFail({ id: sampleId });
    await repo.update(sampleId, {
      responsePayload: {
        ...(sample.responsePayload as Record<string, unknown>),
        deletionRequestedAt: '2020-01-01T00:00:00.000Z',
      },
    });
    const removed = await request(app.getHttpServer()).post(cleanupUrl)
      .set('Authorization', 'Bearer ' + token).expect(201);
    expect(removed.body).toEqual(expect.objectContaining({
      scannedCount: 1, deletedCount: 1, failedCount: 0, batchLimit: 100,
    }));
    expect(JSON.stringify(removed.body)).not.toContain(root);
    expect((await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      id: objectId,
    })).state).toBe('deleted');
    expect(await repo.findOneBy({ id: sampleId })).toBeNull();
    expect(await fs.readdir(root)).toEqual([]);
  });

});
