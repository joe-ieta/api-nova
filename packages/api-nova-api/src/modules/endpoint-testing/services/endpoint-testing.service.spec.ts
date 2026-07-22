import { ConflictException } from '@nestjs/common';
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
    findOne: jest.fn(),
    delete: jest.fn(),
  };

  const service = new EndpointTestingService(
    endpointRepository as any,
    testCaseRepository as any,
    testRunRepository as any,
    testSampleRepository as any,
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
    testSampleRepository.create.mockImplementation(value => value);
    testSampleRepository.save.mockImplementation(async value => {
      const saved = {
        id: `sample-${++sampleSequence}`,
        ...(value as Record<string, unknown>),
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
});
