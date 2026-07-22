import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { Repository } from 'typeorm';
import { EndpointDefinitionEntity } from '../../../database/entities/endpoint-definition.entity';
import { EndpointTestCaseEntity } from '../../../database/entities/endpoint-test-case.entity';
import {
  EndpointTestRunEntity,
  EndpointTestRunStatus,
} from '../../../database/entities/endpoint-test-run.entity';
import {
  EndpointTestSampleEntity,
  EndpointTestSampleStatus,
} from '../../../database/entities/endpoint-test-sample.entity';
import {
  CreateEndpointTestCaseDto,
  EndpointTestRunQueryDto,
  EndpointTestSampleQueryDto,
  UpdateEndpointTestCaseDto,
  UpdateEndpointTestSampleDto,
} from '../dto/endpoint-testing.dto';

export interface RecordEndpointTestSuccessInput {
  endpointDefinitionId: string;
  testCaseId?: string;
  sourceServiceInstanceId?: string;
  requestHeaders?: Record<string, unknown>;
  requestPayload?: unknown;
  responseStatusCode: number;
  responseHeaders?: Record<string, unknown>;
  responsePayload?: unknown;
  durationMs?: number;
  executedAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface RecordEndpointTestFailureInput {
  endpointDefinitionId: string;
  testCaseId?: string;
  sourceServiceInstanceId?: string;
  requestHeaders?: Record<string, unknown>;
  requestPayload?: unknown;
  responseStatusCode?: number;
  responseHeaders?: Record<string, unknown>;
  responsePayload?: unknown;
  durationMs?: number;
  errorMessage: string;
  executedAt?: Date;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class EndpointTestingService {
  private readonly sensitiveKeyPattern =
    /authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|passwd|credential|session/i;

  constructor(
    @InjectRepository(EndpointDefinitionEntity)
    private readonly endpointRepository: Repository<EndpointDefinitionEntity>,
    @InjectRepository(EndpointTestCaseEntity)
    private readonly testCaseRepository: Repository<EndpointTestCaseEntity>,
    @InjectRepository(EndpointTestRunEntity)
    private readonly testRunRepository: Repository<EndpointTestRunEntity>,
    @InjectRepository(EndpointTestSampleEntity)
    private readonly testSampleRepository: Repository<EndpointTestSampleEntity>,
  ) {}

  async createTestCase(
    endpointDefinitionId: string,
    dto: CreateEndpointTestCaseDto,
  ) {
    await this.requireEndpoint(endpointDefinitionId);
    return this.testCaseRepository.save(
      this.testCaseRepository.create({
        ...dto,
        endpointDefinitionId,
        enabled: dto.enabled ?? true,
        requestTemplate: this.sanitizeRecord(dto.requestTemplate),
        metadata: this.sanitizeRecord(dto.metadata),
      }),
    );
  }

  async listTestCases(endpointDefinitionId: string) {
    await this.requireEndpoint(endpointDefinitionId);
    const data = await this.testCaseRepository.find({
      where: { endpointDefinitionId },
      order: { updatedAt: 'DESC' },
    });
    return { total: data.length, data };
  }

  async updateTestCase(testCaseId: string, dto: UpdateEndpointTestCaseDto) {
    const testCase = await this.requireTestCase(testCaseId);
    Object.assign(testCase, dto);
    if (dto.requestTemplate !== undefined) {
      testCase.requestTemplate = this.sanitizeRecord(dto.requestTemplate);
    }
    if (dto.metadata !== undefined) {
      testCase.metadata = this.sanitizeRecord(dto.metadata);
    }
    return this.testCaseRepository.save(testCase);
  }

  async deleteTestCase(testCaseId: string) {
    await this.requireTestCase(testCaseId);
    await this.testCaseRepository.delete({ id: testCaseId });
    return { testCaseId, deleted: true };
  }

  async listTestRuns(
    endpointDefinitionId: string,
    query: EndpointTestRunQueryDto = {},
  ) {
    await this.requireEndpoint(endpointDefinitionId);
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const where: Record<string, unknown> = { endpointDefinitionId };
    if (query.status) {
      where.status = query.status;
    }
    const [data, total] = await this.testRunRepository.findAndCount({
      where,
      order: { executedAt: 'DESC', createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return this.toPage(data, total, page, limit);
  }

  async listTestSamples(
    endpointDefinitionId: string,
    query: EndpointTestSampleQueryDto = {},
  ) {
    await this.requireEndpoint(endpointDefinitionId);
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const where: Record<string, unknown> = { endpointDefinitionId };
    if (query.status) {
      where.status = query.status;
    }
    if (query.fingerprint) {
      where.fingerprint = query.fingerprint;
    }
    if (query.enabled !== undefined) {
      where.enabled = query.enabled;
    }
    const [data, total] = await this.testSampleRepository.findAndCount({
      where,
      order: { capturedAt: 'DESC', createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return this.toPage(data, total, page, limit);
  }

  async updateTestSample(
    sampleId: string,
    dto: UpdateEndpointTestSampleDto,
  ) {
    const sample = await this.requireTestSample(sampleId);
    Object.assign(sample, dto);
    if (dto.metadata !== undefined) {
      sample.metadata = this.sanitizeRecord(dto.metadata);
    }
    if (dto.status === EndpointTestSampleStatus.ARCHIVED) {
      sample.archivedAt = new Date();
      sample.enabled = false;
    } else if (dto.status === EndpointTestSampleStatus.ACTIVE) {
      sample.archivedAt = null as unknown as Date;
    }
    return this.testSampleRepository.save(sample);
  }

  async archiveTestSample(sampleId: string) {
    return this.updateTestSample(sampleId, {
      status: EndpointTestSampleStatus.ARCHIVED,
      enabled: false,
    });
  }

  async deleteTestSample(sampleId: string) {
    await this.requireTestSample(sampleId);
    await this.testSampleRepository.delete({ id: sampleId });
    return { sampleId, deleted: true };
  }

  async recordSuccessfulRun(input: RecordEndpointTestSuccessInput) {
    await this.validateRunReferences(input.endpointDefinitionId, input.testCaseId);
    const executedAt = input.executedAt ?? new Date();
    const evidence = this.sanitizeEvidence(input);
    const fingerprint = this.createEvidenceFingerprint({
      requestHeaders: evidence.requestHeaders,
      requestPayload: evidence.requestPayload,
      responseStatusCode: input.responseStatusCode,
      responsePayload: evidence.responsePayload,
    });

    return this.testRunRepository.manager.transaction(async manager => {
      const runRepository = manager.getRepository(EndpointTestRunEntity);
      const sampleRepository = manager.getRepository(EndpointTestSampleEntity);
      const run = await runRepository.save(
        runRepository.create({
          endpointDefinitionId: input.endpointDefinitionId,
          testCaseId: input.testCaseId,
          sourceServiceInstanceId: input.sourceServiceInstanceId,
          status: EndpointTestRunStatus.SUCCESS,
          ...evidence,
          responseStatusCode: input.responseStatusCode,
          durationMs: input.durationMs,
          executedAt,
        }),
      );
      const sample = await sampleRepository.save(
        sampleRepository.create({
          endpointDefinitionId: input.endpointDefinitionId,
          testCaseId: input.testCaseId,
          testRunId: run.id,
          sourceServiceInstanceId: input.sourceServiceInstanceId,
          fingerprint,
          enabled: true,
          status: EndpointTestSampleStatus.ACTIVE,
          ...evidence,
          responseStatusCode: input.responseStatusCode,
          durationMs: input.durationMs,
          capturedAt: executedAt,
        }),
      );

      return { run, sample };
    });
  }

  async recordFailedRun(input: RecordEndpointTestFailureInput) {
    await this.validateRunReferences(input.endpointDefinitionId, input.testCaseId);
    const evidence = this.sanitizeEvidence(input);
    return this.testRunRepository.save(
      this.testRunRepository.create({
        endpointDefinitionId: input.endpointDefinitionId,
        testCaseId: input.testCaseId,
        sourceServiceInstanceId: input.sourceServiceInstanceId,
        status: EndpointTestRunStatus.FAILED,
        ...evidence,
        responseStatusCode: input.responseStatusCode,
        durationMs: input.durationMs,
        errorMessage: input.errorMessage,
        executedAt: input.executedAt ?? new Date(),
      }),
    );
  }

  private sanitizeEvidence(input: {
    requestHeaders?: Record<string, unknown>;
    requestPayload?: unknown;
    responseHeaders?: Record<string, unknown>;
    responsePayload?: unknown;
    metadata?: Record<string, unknown>;
  }) {
    return {
      requestHeaders: this.sanitizeRecord(input.requestHeaders),
      requestPayload: this.sanitizeValue(input.requestPayload),
      responseHeaders: this.sanitizeRecord(input.responseHeaders),
      responsePayload: this.sanitizeValue(input.responsePayload),
      metadata: this.sanitizeRecord(input.metadata),
    };
  }

  private sanitizeRecord(value?: Record<string, unknown>) {
    return value === undefined
      ? undefined
      : (this.sanitizeValue(value) as Record<string, unknown>);
  }

  private sanitizeValue(value: unknown, seen = new WeakSet<object>()): unknown {
    if (value === null || value === undefined) {
      return value;
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) {
        return '[REDACTED:CIRCULAR]';
      }
      seen.add(value);
      return value.map(item => this.sanitizeValue(item, seen));
    }
    if (typeof value === 'object') {
      if (seen.has(value as object)) {
        return '[REDACTED:CIRCULAR]';
      }
      seen.add(value as object);
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          this.sensitiveKeyPattern.test(key)
            ? '[REDACTED]'
            : this.sanitizeValue(item, seen),
        ]),
      );
    }
    return value;
  }

  private createEvidenceFingerprint(value: Record<string, unknown>) {
    return createHash('sha256')
      .update(this.stableStringify(value))
      .digest('hex');
  }

  private stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map(item => this.stableStringify(item)).join(',')}]`;
    }
    if (value && typeof value === 'object') {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(
          ([key, item]) =>
            `${JSON.stringify(key)}:${this.stableStringify(item)}`,
        )
        .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'undefined';
  }

  private async validateRunReferences(
    endpointDefinitionId: string,
    testCaseId?: string,
  ) {
    await this.requireEndpoint(endpointDefinitionId);
    if (!testCaseId) {
      return;
    }
    const testCase = await this.requireTestCase(testCaseId);
    if (testCase.endpointDefinitionId !== endpointDefinitionId) {
      throw new ConflictException(
        `Test case '${testCaseId}' does not belong to endpoint '${endpointDefinitionId}'`,
      );
    }
    if (!testCase.enabled) {
      throw new ConflictException(`Test case '${testCaseId}' is disabled`);
    }
  }

  private async requireEndpoint(id: string) {
    const endpoint = await this.endpointRepository.findOne({ where: { id } });
    if (!endpoint) {
      throw new NotFoundException(`Endpoint definition '${id}' not found`);
    }
    return endpoint;
  }

  private async requireTestCase(id: string) {
    const testCase = await this.testCaseRepository.findOne({ where: { id } });
    if (!testCase) {
      throw new NotFoundException(`Endpoint test case '${id}' not found`);
    }
    return testCase;
  }

  private async requireTestSample(id: string) {
    const sample = await this.testSampleRepository.findOne({ where: { id } });
    if (!sample) {
      throw new NotFoundException(`Endpoint test sample '${id}' not found`);
    }
    return sample;
  }

  private toPage<T>(data: T[], total: number, page: number, limit: number) {
    const totalPages = Math.max(1, Math.ceil(total / limit));
    return {
      data,
      total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }
}
