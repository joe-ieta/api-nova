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
import { RuntimeVerificationResultStatus } from '../../database/entities/runtime-verification-result.entity';
import { RuntimeVerificationRunStatus } from '../../database/entities/runtime-verification-run.entity';
import { AuthService } from '../security/services/auth.service';
import { UserService } from '../security/services/user.service';
import { JwtStrategy } from '../security/strategies/jwt.strategy';
import { readBoundedTestResponse, TrustedBinaryCapture } from '../asset-catalog/services/binary-test-response';
import { RuntimeResponseAssertionService } from '../runtime-verification/services/runtime-response-assertion.service';
import { RuntimeVerificationService } from '../runtime-verification/services/runtime-verification.service';
import { EndpointTestingController } from './endpoint-testing.controller';
import { EndpointTestSampleObjectService } from './services/endpoint-test-sample-object.service';
import { EndpointTestingService } from './services/endpoint-testing.service';

const secret = 'binary-delete-recovery-fixture-secret-'.repeat(2);
const bytes = Buffer.from([0, 255, 128, 1]);
const entities = [
  EndpointDefinitionEntity, EndpointTestCaseEntity, EndpointTestRunEntity,
  EndpointTestSampleEntity, EndpointTestSampleObjectEntity,
];
const downloadUrl = (sampleId: string) =>
  '/api/v1/endpoint-testing/test-samples/' + encodeURIComponent(sampleId) + '/binary-content';
const deleteUrl = (sampleId: string) =>
  '/api/v1/endpoint-testing/test-samples/' + encodeURIComponent(sampleId);
const objectCleanupUrl = '/api/v1/endpoint-testing/test-samples/binary-objects/cleanup';
const retentionCleanupUrl = '/api/v1/endpoint-testing/test-samples/cleanup';
const binaryParser = (response: any, done: (error: Error | null, value?: Buffer) => void) => {
  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  response.on('end', () => done(null, Buffer.concat(chunks)));
  response.on('error', done);
};

describe('binary deletion recovery (local JWT HTTP, SQL.js export, temporary files)', () => {
  let app: any, db: DataSource, root: string, service: EndpointTestingService;
  let endpointId: string, sampleId: string, runId: string, objectId: string;
  let token: string, user: any, permissions: Set<string>;
  const originalRoot = process.env.ENDPOINT_TEST_SAMPLE_BINARY_DIR;
  const originalFlag = process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED;
  const originalLimit = process.env.ENDPOINT_TEST_SAMPLE_MAX_BYTES;

  async function capture() {
    let trustedBinaryCapture: TrustedBinaryCapture | undefined;
    const responsePayload = await readBoundedTestResponse(
      Readable.from([bytes], { objectMode: false }),
      { 'content-type': 'application/pdf' }, bytes.length,
      trusted => { trustedBinaryCapture = trusted; },
    );
    return { responsePayload, trustedBinaryCapture };
  }

  function bindService() {
    const objects = new EndpointTestSampleObjectService(
      db.getRepository(EndpointTestSampleObjectEntity),
    );
    service = new EndpointTestingService(
      db.getRepository(EndpointDefinitionEntity), db.getRepository(EndpointTestCaseEntity),
      db.getRepository(EndpointTestRunEntity), db.getRepository(EndpointTestSampleEntity),
      db.getRepository(EndpointTestSampleObjectEntity), objects,
    );
  }

  async function startHttp() {
    const module = await Test.createTestingModule({
      imports: [PassportModule], controllers: [EndpointTestingController],
      providers: [
        JwtStrategy,
        { provide: EndpointTestingService, useValue: service },
        { provide: ConfigService, useValue: new ConfigService({ JWT_SECRET: secret }) },
        { provide: UserService, useValue: {
          findUserById: async (id: string) => id === user.id ? user : null,
        } },
        { provide: AuthService, useValue: {
          checkPermission: async (_id: string, permission: string) => permissions.has(permission),
        } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useLogger(false);
    await app.init();
  }

  async function restartFromExport() {
    const database = (db.driver as any).export() as Uint8Array;
    await app.close();
    await db.destroy();
    db = await new DataSource({
      type: 'sqljs', database, entities, synchronize: false,
    }).initialize();
    bindService();
    await startHttp();
  }

  const authorizedGet = (id = sampleId) => request(app.getHttpServer())
    .get(downloadUrl(id)).set('Authorization', 'Bearer ' + token);
  const authorizedDelete = (id = sampleId) => request(app.getHttpServer())
    .delete(deleteUrl(id)).set('Authorization', 'Bearer ' + token);
  const authorizedCleanup = () => request(app.getHttpServer())
    .post(objectCleanupUrl).set('Authorization', 'Bearer ' + token);

  async function allowStatusOnlyReplay() {
    await db.getRepository(EndpointTestSampleEntity).update(sampleId, {
      metadata: { responseAssertion: { mode: 'status' } },
    });
  }

  function plannedGatewayReplay() {
    const run = {
      id: randomUUID(), runtimeAssetId: 'runtime-gateway',
      candidateRevision: 'candidate-revision', previousActiveRevision: 'stable-revision',
      status: RuntimeVerificationRunStatus.PLANNED, blockers: [],
    };
    const result = {
      id: randomUUID(), verificationRunId: run.id,
      runtimeMembershipId: 'membership-1', endpointDefinitionId: endpointId,
      endpointTestSampleId: sampleId, expectedStatusCode: 200,
      status: RuntimeVerificationResultStatus.PENDING, evidence: {},
    };
    const snapshot = { discardCandidate: jest.fn(), activateCandidate: jest.fn() };
    const candidate = { replay: jest.fn().mockResolvedValue({
      statusCode: 200, durationMs: 1, routePath: '/pdf', method: 'GET',
      headers: {}, body: { unrelated: true }, bodyBytes: 4, truncated: false,
    }) };
    const asset = {
      id: 'runtime-gateway', type: 'gateway_service',
      metadata: { activeRevision: 'stable-revision' },
    };
    const runtimeAssets = {
      findOne: jest.fn(async () => asset),
      manager: { transaction: jest.fn(async () => {
        throw new Error('A revoked sample must never activate a candidate');
      }) },
    };
    const runs = {
      findOne: jest.fn(async () => run),
      update: jest.fn(async () => ({ affected: 1 })),
      save: jest.fn(async value => value),
    };
    const results = {
      find: jest.fn(async () => [result]),
      save: jest.fn(async value => value),
    };
    const verifier = new RuntimeVerificationService(
      runtimeAssets as any, {} as any, db.getRepository(EndpointTestSampleEntity),
      runs as any, results as any, {} as any, snapshot as any,
      candidate as any, {} as any, new RuntimeResponseAssertionService(),
    );
    return { verifier, run, result, snapshot, candidate, asset };
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'api-nova-delete-recovery-'));
    process.env.ENDPOINT_TEST_SAMPLE_BINARY_DIR = root;
    process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED = 'true';
    process.env.ENDPOINT_TEST_SAMPLE_MAX_BYTES = String(bytes.length);
    db = await new DataSource({ type: 'sqljs', entities, synchronize: true }).initialize();
    endpointId = (await db.getRepository(EndpointDefinitionEntity).save({
      sourceServiceAssetId: 'source-a', method: 'GET', path: '/pdf',
      status: EndpointDefinitionStatus.VERIFIED,
    })).id;
    bindService();
    const recorded = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    sampleId = recorded.sample.id;
    runId = recorded.run.id;
    objectId = (recorded.sample.responsePayload as any).opaqueObjectId;
    user = { id: randomUUID(), isActive: true, isLocked: false, hasRole: () => false };
    permissions = new Set(['server:read', 'server:manage']);
    token = sign({ sub: user.id, permissions: ['server:read', 'server:manage'] },
      secret, { expiresIn: '5m' });
    await startHttp();
  });

  afterEach(async () => {
    await app?.close();
    await db?.destroy();
    if (resolve(root).startsWith(resolve(tmpdir()) + sep) &&
      root.includes('api-nova-delete-recovery-')) {
      await fs.rm(root, { recursive: true, force: true });
    }
    if (originalRoot === undefined) delete process.env.ENDPOINT_TEST_SAMPLE_BINARY_DIR;
    else process.env.ENDPOINT_TEST_SAMPLE_BINARY_DIR = originalRoot;
    if (originalFlag === undefined) delete process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED;
    else process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED = originalFlag;
    if (originalLimit === undefined) delete process.env.ENDPOINT_TEST_SAMPLE_MAX_BYTES;
    else process.env.ENDPOINT_TEST_SAMPLE_MAX_BYTES = originalLimit;
  });

  it('revokes download and replay, then retries physical cleanup across a restart', async () => {
    const object = await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      id: objectId,
    });
    expect((await authorizedGet().buffer(true).parse(binaryParser).expect(200)).body)
      .toEqual(bytes);
    await allowStatusOnlyReplay();
    const planned = plannedGatewayReplay();
    expect((await authorizedDelete().expect(200)).body).toEqual({
      sampleId, deleted: false, pending: true,
    });
    await authorizedGet().expect(410);
    const blocked = await planned.verifier.executeGatewayCandidate('runtime-gateway', planned.run.id);
    expect(blocked.run.status).toBe(RuntimeVerificationRunStatus.BLOCKED);
    expect(blocked.run.activationStatus).toBe('retained_previous');
    expect(planned.result.status).toBe(RuntimeVerificationResultStatus.BLOCKED);
    expect((planned.result as any).blockerCode).toBe('verification_sample_unavailable');
    expect(planned.candidate.replay).not.toHaveBeenCalled();
    expect(planned.snapshot.activateCandidate).not.toHaveBeenCalled();
    expect(planned.asset.metadata.activeRevision).toBe('stable-revision');
    expect((await authorizedCleanup().expect(201)).body).toEqual(expect.objectContaining({
      deletedCount: 0, deferredCount: 1,
    }));
    expect(await fs.readdir(root)).toEqual([object.objectKey + '.raw']);

    await restartFromExport();
    expect((await authorizedDelete().expect(200)).body).toEqual({
      sampleId, deleted: false, pending: true,
    });
    await authorizedGet().expect(410);
    const samples = db.getRepository(EndpointTestSampleEntity);
    const pending = await samples.findOneByOrFail({ id: sampleId });
    await samples.update(sampleId, { responsePayload: {
      ...(pending.responsePayload as object),
      deletionRequestedAt: '2020-01-01T00:00:00.000Z',
    } });
    const unlink = jest.spyOn(fs, 'unlink').mockRejectedValueOnce(
      Object.assign(new Error('simulated permission failure'), { code: 'EACCES' }),
    );
    try {
      expect((await authorizedCleanup().expect(201)).body).toEqual(expect.objectContaining({
        deletedCount: 0, failedCount: 1,
      }));
    } finally { unlink.mockRestore(); }
    expect((await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      id: objectId,
    })).state).toBe('delete_pending');
    expect(await fs.readdir(root)).toEqual([object.objectKey + '.raw']);
    await authorizedGet().expect(410);

    await restartFromExport();
    expect((await authorizedCleanup().expect(201)).body).toEqual(expect.objectContaining({
      deletedCount: 1, failedCount: 0,
    }));
    expect((await db.getRepository(EndpointTestSampleObjectEntity).findOneByOrFail({
      id: objectId,
    })).state).toBe('deleted');
    expect(await db.getRepository(EndpointTestSampleEntity).findOneBy({ id: sampleId }))
      .toBeNull();
    expect((await db.getRepository(EndpointTestRunEntity).findOneByOrFail({
      id: runId,
    }).then(run => run.responsePayload) as any).opaqueObjectId).toBeUndefined();
    expect(await fs.readdir(root)).toEqual([]);
    await authorizedGet().expect(404);
    expect((await authorizedCleanup().expect(201)).body.scannedCount).toBe(0);
    const removed = plannedGatewayReplay();
    const afterRemoval = await removed.verifier.executeGatewayCandidate(
      'runtime-gateway', removed.run.id,
    );
    expect(afterRemoval.run.status).toBe(RuntimeVerificationRunStatus.BLOCKED);
    expect(removed.candidate.replay).not.toHaveBeenCalled();
    expect(removed.asset.metadata.activeRevision).toBe('stable-revision');
  });


  it('blocks a candidate whose sample is revoked by local HTTP while replay is in flight', async () => {
    await allowStatusOnlyReplay();
    const planned = plannedGatewayReplay();
    planned.candidate.replay.mockImplementation(async () => {
      expect((await authorizedDelete().expect(200)).body).toEqual({
        sampleId, deleted: false, pending: true,
      });
      return {
        statusCode: 200, durationMs: 1, routePath: '/pdf', method: 'GET',
        headers: {}, body: { unrelated: true }, bodyBytes: 4, truncated: false,
      };
    });
    const outcome = await planned.verifier.executeGatewayCandidate(
      'runtime-gateway', planned.run.id,
    );
    expect(outcome.run.status).toBe(RuntimeVerificationRunStatus.BLOCKED);
    expect(outcome.run.activationStatus).toBe('retained_previous');
    expect(planned.result.status).toBe(RuntimeVerificationResultStatus.BLOCKED);
    expect((planned.result as any).blockerCode).toBe('verification_sample_unavailable');
    expect(planned.candidate.replay).toHaveBeenCalledTimes(1);
    expect(planned.snapshot.activateCandidate).not.toHaveBeenCalled();
    expect(planned.asset.metadata.activeRevision).toBe('stable-revision');
    await authorizedGet().expect(410);
  });

  it('keeps active and recent archived samples outside the 90-day retention selection', async () => {
    const active = await db.getRepository(EndpointTestSampleEntity).findOneByOrFail({
      id: sampleId,
    });
    await db.getRepository(EndpointTestSampleEntity).update(sampleId, {
      capturedAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    const oldArchived = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    const recentArchived = await service.recordSuccessfulRun({
      endpointDefinitionId: endpointId, responseStatusCode: 200, ...(await capture()),
    });
    await db.getRepository(EndpointTestSampleEntity).update(oldArchived.sample.id, {
      status: EndpointTestSampleStatus.ARCHIVED,
      capturedAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    await db.getRepository(EndpointTestSampleEntity).update(recentArchived.sample.id, {
      status: EndpointTestSampleStatus.ARCHIVED,
    });
    const cleanup = await request(app.getHttpServer()).post(retentionCleanupUrl)
      .set('Authorization', 'Bearer ' + token).expect(201);
    expect(cleanup.body).toEqual(expect.objectContaining({
      deletedCount: 0, pendingObjectCount: 1, retentionDays: 90,
    }));
    expect((await authorizedGet().buffer(true).parse(binaryParser).expect(200)).body)
      .toEqual(bytes);
    expect((await authorizedGet(recentArchived.sample.id)
      .buffer(true).parse(binaryParser).expect(200)).body).toEqual(bytes);
    await authorizedGet(oldArchived.sample.id).expect(410);
    expect((await db.getRepository(EndpointTestSampleEntity).findOneByOrFail({
      id: sampleId,
    })).responsePayload).toEqual(active.responsePayload);
    expect((await authorizedCleanup().expect(201)).body).toEqual(expect.objectContaining({
      deletedCount: 0, deferredCount: 1,
    }));
    expect((await fs.readdir(root)).length).toBe(3);
  });
});
