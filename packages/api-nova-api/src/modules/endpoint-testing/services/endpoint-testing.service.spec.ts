import { ConflictException } from '@nestjs/common';
import { Readable } from 'node:stream';
import { readBoundedTestResponse, TrustedBinaryCapture } from '../../asset-catalog/services/binary-test-response';
import { EndpointTestSampleObjectEntity } from '../../../database/entities/endpoint-test-sample-object.entity';
import { EndpointDefinitionEntity } from '../../../database/entities/endpoint-definition.entity';
import { EndpointTestCaseEntity } from '../../../database/entities/endpoint-test-case.entity';
import { EndpointTestRunEntity } from '../../../database/entities/endpoint-test-run.entity';
import {
  EndpointTestSampleEntity,
  EndpointTestSampleStatus,
} from '../../../database/entities/endpoint-test-sample.entity';
import { EndpointTestingService } from './endpoint-testing.service';

describe('EndpointTestingService', () => {
  const endpointRepository = {
    findOne: jest.fn(),
  };
  const testCaseRepository = {
    create: jest.fn((value: unknown) => value),
    save: jest.fn(async (value: unknown) => value),
    find: jest.fn(),
    findOne: jest.fn(),
    delete: jest.fn(),
  };
  const testRunRepository = {
    create: jest.fn((value: unknown) => value),
    save: jest.fn(async (value: unknown) => value),
    findAndCount: jest.fn(),
    manager: {
      transaction: jest.fn(),
    },
  };
  const testSampleRepository = {
    create: jest.fn((value: unknown) => value),
    save: jest.fn(async (value: unknown) => value),
    findAndCount: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    delete: jest.fn(),
  };

  const sampleObjectRepository = {
    findOne: jest.fn(),
    update: jest.fn(),
  };
  const sampleObjectService = {
    prepare: jest.fn(),
    stagePublishedFile: jest.fn(),
  };
  const service = new EndpointTestingService(
    endpointRepository as any,
    testCaseRepository as any,
    testRunRepository as any,
    testSampleRepository as any,
    sampleObjectRepository as any,
    sampleObjectService as any,
  );

  let runSequence: number;
  let sampleSequence: number;
  let savedSamples: Array<Record<string, any>>;

  beforeEach(() => {
    jest.clearAllMocks();
    runSequence = 0;
    sampleSequence = 0;
    savedSamples = [];
    endpointRepository.findOne.mockResolvedValue({ id: 'endpoint-1' });
    testCaseRepository.findOne.mockResolvedValue({
      id: 'case-1',
      endpointDefinitionId: 'endpoint-1',
      enabled: true,
    });
    testRunRepository.create.mockImplementation(value => value);
    testRunRepository.save.mockImplementation(async value => ({
      id: `run-${++runSequence}`,
      ...(value as Record<string, unknown>),
    }));
    sampleObjectRepository.findOne.mockResolvedValue(null);
    sampleObjectRepository.update.mockResolvedValue({ affected: 1 });
    sampleObjectService.prepare.mockResolvedValue({ captureState: 'metadata_only' });
    sampleObjectService.stagePublishedFile.mockResolvedValue(undefined);
    testSampleRepository.create.mockImplementation(value => value);
    testSampleRepository.save.mockImplementation(async value => {
      const saved = {
        ...(value as Record<string, unknown>),
        id: `sample-${++sampleSequence}`,
      };
      savedSamples.push(saved);
      return saved;
    });
    testRunRepository.manager.transaction.mockImplementation(
      async (callback: (manager: any) => Promise<unknown>) =>
        callback({
          getRepository: (entity: unknown) => {
            if (entity === EndpointTestRunEntity) {
              return testRunRepository;
            }
            if (entity === EndpointTestSampleEntity) {
              return testSampleRepository;
            }
            if (entity === EndpointTestSampleObjectEntity) {
              return sampleObjectRepository;
            }
            throw new Error('Unexpected entity');
          },
        }),
    );
  });

  it('automatically stores every successful execution as a distinct sanitized sample', async () => {
    const input = {
      endpointDefinitionId: 'endpoint-1',
      testCaseId: 'case-1',
      requestHeaders: {
        Authorization: 'Bearer secret-token',
        Accept: 'application/json',
      },
      requestPayload: {
        customerId: 'customer-1',
        password: 'plain-text',
      },
      responseStatusCode: 200,
      responseHeaders: {
        'set-cookie': 'session=secret',
      },
      responsePayload: {
        result: 'ok',
        accessToken: 'response-secret',
      },
      durationMs: 12,
      metadata: {
        traceId: 'trace-1',
        apiKey: 'metadata-secret',
      },
      executedAt: new Date('2026-07-21T08:00:00.000Z'),
    };

    const first = await service.recordSuccessfulRun(input);
    const second = await service.recordSuccessfulRun(input);

    expect(savedSamples).toHaveLength(2);
    expect(first.sample.id).toBe('sample-1');
    expect(second.sample.id).toBe('sample-2');
    expect(first.sample.testRunId).toBe('run-1');
    expect(second.sample.testRunId).toBe('run-2');
    expect(first.sample.fingerprint).toBe(second.sample.fingerprint);
    expect(first.sample.requestHeaders).toEqual({
      Authorization: '[REDACTED]',
      Accept: 'application/json',
    });
    expect(first.sample.requestPayload).toEqual({
      customerId: 'customer-1',
      password: '[REDACTED]',
    });
    expect(first.sample.responseHeaders).toEqual({
      'set-cookie': '[REDACTED]',
    });
    expect(first.sample.responsePayload).toEqual({
      result: 'ok',
      accessToken: '[REDACTED]',
    });
    expect(first.sample.metadata).toEqual({
      traceId: 'trace-1',
      apiKey: '[REDACTED]',
    });
  });

  it('records failed executions without creating samples', async () => {
    testRunRepository.save.mockResolvedValue({ id: 'run-failed' });

    const result = await service.recordFailedRun({
      endpointDefinitionId: 'endpoint-1',
      requestHeaders: { authorization: 'Bearer secret-token' },
      requestPayload: { password: 'plain-text' },
      errorMessage: 'Connection refused',
      durationMs: 1000,
    });

    expect(result).toEqual({ id: 'run-failed' });
    expect(testRunRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        requestHeaders: { authorization: '[REDACTED]' },
        requestPayload: { password: '[REDACTED]' },
        errorMessage: 'Connection refused',
      }),
    );
    expect(testSampleRepository.save).not.toHaveBeenCalled();
  });

  it('stores a bounded metadata summary for oversized payloads', async () => {
    const result = await service.recordSuccessfulRun({
      endpointDefinitionId: 'endpoint-1',
      requestPayload: 'x'.repeat(300 * 1024),
      responseStatusCode: 200,
    });

    expect(result.sample.requestPayload).toEqual(expect.objectContaining({
      truncated: true,
      byteLength: expect.any(Number),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      preview: expect.any(String),
    }));
  });

  it('deletes only archived samples outside the configured retention window', async () => {
    testSampleRepository.find.mockResolvedValue([
      { id: 'sample-old' },
      { id: 'sample-old-2' },
    ]);
    testSampleRepository.delete.mockResolvedValue({ affected: 1 });

    await expect(service.cleanupExpiredSamples(30)).resolves.toEqual(
      expect.objectContaining({ deletedCount: 2, retentionDays: 30 }),
    );
    expect(testSampleRepository.find).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: EndpointTestSampleStatus.ARCHIVED }),
    }));
    expect(testSampleRepository.delete).toHaveBeenCalledTimes(2);
  });

  it('rejects execution of a disabled test case', async () => {
    testCaseRepository.findOne.mockResolvedValue({
      id: 'case-1',
      endpointDefinitionId: 'endpoint-1',
      enabled: false,
    });

    await expect(
      service.recordSuccessfulRun({
        endpointDefinitionId: 'endpoint-1',
        testCaseId: 'case-1',
        responseStatusCode: 200,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(testRunRepository.manager.transaction).not.toHaveBeenCalled();
  });

  it('supports sample maintenance, archive and deletion', async () => {
    const sample = {
      id: 'sample-1',
      endpointDefinitionId: 'endpoint-1',
      enabled: true,
      status: EndpointTestSampleStatus.ACTIVE,
      metadata: {},
    };
    testSampleRepository.findOne.mockResolvedValue(sample);
    testSampleRepository.save.mockImplementation(async value => value);
    testSampleRepository.delete.mockResolvedValue({ affected: 1 });

    const updated = await service.updateTestSample('sample-1', {
      title: 'Known good response',
      tags: ['smoke'],
      metadata: { apiKey: 'should-not-persist' },
    });
    expect(updated).toEqual(
      expect.objectContaining({
        title: 'Known good response',
        tags: ['smoke'],
        metadata: { apiKey: '[REDACTED]' },
      }),
    );

    const archived = await service.archiveTestSample('sample-1');
    expect(archived).toEqual(
      expect.objectContaining({
        enabled: false,
        status: EndpointTestSampleStatus.ARCHIVED,
        archivedAt: expect.any(Date),
      }),
    );

    await expect(service.deleteTestSample('sample-1')).resolves.toEqual({
      sampleId: 'sample-1',
      deleted: true,
    });
    expect(testSampleRepository.delete).toHaveBeenCalledWith({ id: 'sample-1' });
  });
  it('stores only a stream-authenticated binary response with a server-owned object reference', async () => {
    const previous = process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED;
    process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED = 'true';
    try {
      const bytes = Buffer.from([0, 255, 128, 1]);
      let trustedBinaryCapture: TrustedBinaryCapture | undefined;
      const responsePayload = await readBoundedTestResponse(
        Readable.from([bytes], { objectMode: false }),
        { 'content-type': 'application/pdf' },
        4,
        capture => { trustedBinaryCapture = capture; },
      );
      sampleObjectService.prepare.mockResolvedValue({
        captureState: 'staged', objectId: 'object-1',
        observedBytes: 4, isComplete: true,
      });
      testSampleRepository.save.mockImplementation(async value => {
        const saved = { ...(value as Record<string, unknown>) };
        savedSamples.push(saved);
        return saved;
      });
      const result = await service.recordSuccessfulRun({
        endpointDefinitionId: 'endpoint-1',
        responseStatusCode: 200,
        responsePayload,
        trustedBinaryCapture,
      });
      const ownerId = sampleObjectService.prepare.mock.calls[0][0];
      expect(ownerId).toBe(result.sample.id);
      expect(sampleObjectService.prepare.mock.calls[0][1]).toEqual(bytes);
      expect(sampleObjectService.stagePublishedFile).toHaveBeenCalledWith(ownerId, 'object-1');
      expect(sampleObjectRepository.update).toHaveBeenCalledWith(
        { id: 'object-1', sampleId: ownerId, side: 'response', state: 'staged' },
        { state: 'ready' },
      );
      expect(result.run.responsePayload).toEqual(expect.objectContaining({
        kind: 'binary', captureState: 'stored', observedBytes: 4,
      }));
      expect((result.run.responsePayload as any).opaqueObjectId).toBeUndefined();
      expect(result.sample.responsePayload).toEqual(expect.objectContaining({
        captureState: 'stored', opaqueObjectId: 'object-1',
      }));
      expect(result.sample.metadata).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED;
      else process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED = previous;
    }
  });

  it('does not reconstruct binary bytes from a forged descriptor or user metadata', async () => {
    const previous = process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED;
    process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED = 'true';
    try {
      const descriptor = {
        kind: 'binary', schemaVersion: 1, mediaType: 'application/pdf',
        measurement: 'decoded_response_body', observedBytes: 4, isComplete: true,
        sha256: 'a'.repeat(64), captureState: 'metadata_only',
      };
      const result = await service.recordSuccessfulRun({
        endpointDefinitionId: 'endpoint-1', responseStatusCode: 200,
        responsePayload: descriptor,
        metadata: { bytes: [0, 255, 128, 1], opaqueObjectId: 'forged' },
      });
      expect(sampleObjectService.prepare).not.toHaveBeenCalled();
      expect(result.sample.responsePayload).toEqual(descriptor);
      expect((result.sample.responsePayload as any).opaqueObjectId).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED;
      else process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED = previous;
    }
  });

  it('preserves HTTP success as storage_failed when object publication fails', async () => {
    const previous = process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED;
    process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED = 'true';
    try {
      let trustedBinaryCapture: TrustedBinaryCapture | undefined;
      const responsePayload = await readBoundedTestResponse(
        Readable.from([Buffer.from([0, 255])], { objectMode: false }),
        { 'content-type': 'image/png' }, 2,
        capture => { trustedBinaryCapture = capture; },
      );
      sampleObjectService.prepare.mockResolvedValue({
        captureState: 'staged', objectId: 'object-2',
        observedBytes: 2, isComplete: true,
      });
      sampleObjectService.stagePublishedFile.mockRejectedValue(new Error('disk failed'));
      const result = await service.recordSuccessfulRun({
        endpointDefinitionId: 'endpoint-1', responseStatusCode: 200,
        responsePayload, trustedBinaryCapture,
      });
      expect(result.run.status).toBe('success');
      expect(result.sample.responsePayload).toEqual(expect.objectContaining({
        captureState: 'storage_failed',
      }));
      expect((result.sample.responsePayload as any).opaqueObjectId).toBeUndefined();
      expect(sampleObjectRepository.update).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED;
      else process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED = previous;
    }
  });

  it('falls back to a storage_failed success when promotion affects no staged row', async () => {
    const previous = process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED;
    process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED = 'true';
    try {
      let trustedBinaryCapture: TrustedBinaryCapture | undefined;
      const responsePayload = await readBoundedTestResponse(
        Readable.from([Buffer.from([0, 255])], { objectMode: false }),
        { 'content-type': 'application/pdf' }, 2,
        capture => { trustedBinaryCapture = capture; },
      );
      sampleObjectService.prepare.mockResolvedValue({
        captureState: 'staged', objectId: 'object-3',
        observedBytes: 2, isComplete: true,
      });
      sampleObjectRepository.update.mockResolvedValue({ affected: 0 });
      const result = await service.recordSuccessfulRun({
        endpointDefinitionId: 'endpoint-1', responseStatusCode: 200,
        responsePayload, trustedBinaryCapture,
      });
      expect(result.run.status).toBe('success');
      expect(result.sample.responsePayload).toEqual(expect.objectContaining({
        captureState: 'storage_failed',
      }));
      expect((result.sample.responsePayload as any).opaqueObjectId).toBeUndefined();
      expect(testRunRepository.manager.transaction).toHaveBeenCalledTimes(2);
    } finally {
      if (previous === undefined) delete process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED;
      else process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED = previous;
    }
  });

  it.each(['ready', 'staged'])('protects %s object samples from direct and retention deletion', async state => {
    testSampleRepository.findOne.mockResolvedValue({
      id: 'sample-1', endpointDefinitionId: 'endpoint-1',
    });
    testSampleRepository.find.mockResolvedValue([{ id: 'sample-1' }]);
    sampleObjectRepository.findOne.mockResolvedValue({ id: 'object-1', state });
    await expect(service.deleteTestSample('sample-1')).rejects.toBeInstanceOf(ConflictException);
    expect(testSampleRepository.delete).not.toHaveBeenCalled();
    await expect(service.cleanupExpiredSamples(30)).resolves.toEqual(
      expect.objectContaining({ deletedCount: 0, skippedObjectCount: 1 }),
    );
    expect(testSampleRepository.delete).not.toHaveBeenCalled();
  });
});
