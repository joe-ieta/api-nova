import {
  ConflictException,
  GoneException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { LessThan } from 'typeorm';
import { EndpointDefinitionEntity } from '../../../database/entities/endpoint-definition.entity';
import { EndpointTestCaseEntity } from '../../../database/entities/endpoint-test-case.entity';
import { EndpointTestSampleObjectEntity } from '../../../database/entities/endpoint-test-sample-object.entity';
import {
  BinaryResponseDescriptor,
  binaryCaptureEnabled,
  isTrustedBinaryCapture,
  TrustedBinaryCapture,
} from '../../asset-catalog/services/binary-test-response';
import {
  EndpointTestSampleObjectService,
  SampleObjectError,
} from './endpoint-test-sample-object.service';
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
  /** Supplied only by the bounded HTTP stream reader, never by request JSON. */
  trustedBinaryCapture?: TrustedBinaryCapture;
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

class BinaryObjectPromotionError extends Error {}

@Injectable()
export class EndpointTestingService {
  private readonly sensitiveKeyPattern =
    /authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|passwd|credential|session/i;
  private readonly sampleMaxBytes = this.readPositiveInt(
    process.env.ENDPOINT_TEST_SAMPLE_MAX_BYTES,
    256 * 1024,
  );
  private readonly sampleRetentionDays = this.readPositiveInt(
    process.env.ENDPOINT_TEST_SAMPLE_RETENTION_DAYS,
    90,
  );

  constructor(
    @InjectRepository(EndpointDefinitionEntity)
    private readonly endpointRepository: Repository<EndpointDefinitionEntity>,
    @InjectRepository(EndpointTestCaseEntity)
    private readonly testCaseRepository: Repository<EndpointTestCaseEntity>,
    @InjectRepository(EndpointTestRunEntity)
    private readonly testRunRepository: Repository<EndpointTestRunEntity>,
    @InjectRepository(EndpointTestSampleEntity)
    private readonly testSampleRepository: Repository<EndpointTestSampleEntity>,
    @InjectRepository(EndpointTestSampleObjectEntity)
    private readonly sampleObjectRepository: Repository<EndpointTestSampleObjectEntity>,
    private readonly sampleObjectService: EndpointTestSampleObjectService,
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

  async readBinaryContent(sampleId: string): Promise<Buffer> {
    const unavailable = () => new NotFoundException('Binary sample content unavailable');
    const revoked = () => new GoneException('Binary sample content revoked');
    const failed = () => new ServiceUnavailableException('Binary sample content unavailable');
    try {
      if (!binaryCaptureEnabled()) throw unavailable();
      const sample = await this.requireTestSample(sampleId);
      if (sample.status !== EndpointTestSampleStatus.ACTIVE &&
        sample.status !== EndpointTestSampleStatus.ARCHIVED) throw unavailable();
      await this.requireEndpoint(sample.endpointDefinitionId);

      const descriptor = sample.responsePayload as BinaryResponseDescriptor | undefined;
      if (!descriptor || typeof descriptor !== 'object' ||
        descriptor.kind !== 'binary' || descriptor.schemaVersion !== 1 ||
        descriptor.captureState !== 'stored' || !descriptor.isComplete ||
        typeof descriptor.opaqueObjectId !== 'string' ||
        !/^[0-9a-f-]{36}$/.test(descriptor.opaqueObjectId)) throw unavailable();
      const objectId = descriptor.opaqueObjectId;
      const object = await this.sampleObjectRepository.findOne({
        where: { id: objectId, sampleId, side: 'response' },
      });
      if (!object) throw unavailable();
      if (object.state === 'delete_pending' || object.state === 'deleted') throw revoked();
      if (object.state !== 'ready') throw unavailable();
      if (descriptor.mediaType !== object.mediaType ||
        descriptor.measurement !== object.measurement ||
        descriptor.observedBytes !== object.observedBytes ||
        descriptor.sha256 !== object.sha256) throw failed();

      let bytes: Buffer;
      try {
        bytes = await this.sampleObjectService.read(sampleId, objectId);
      } catch (error) {
        if (!(error instanceof SampleObjectError) || error.code !== 'OBJECT_UNAVAILABLE') {
          throw error;
        }
        const current = await this.sampleObjectRepository.findOne({
          where: { id: objectId, sampleId, side: 'response' },
        });
        if (current?.state === 'delete_pending' || current?.state === 'deleted') throw revoked();
        if (!current || current.state === 'staged') throw unavailable();
        throw failed();
      }
      // The file read closes before these final checks. No bytes are returned
      // after a completed sample-reference or object-state change.
      const currentSample = await this.testSampleRepository.findOne({
        where: { id: sampleId },
      });
      const currentObject = await this.sampleObjectRepository.findOne({
        where: { id: objectId, sampleId, side: 'response' },
      });
      if (currentObject?.state === 'delete_pending' || currentObject?.state === 'deleted') {
        throw revoked();
      }
      const currentDescriptor = currentSample?.responsePayload as BinaryResponseDescriptor | undefined;
      if (!currentSample || currentSample.endpointDefinitionId !== sample.endpointDefinitionId ||
        (currentSample.status !== EndpointTestSampleStatus.ACTIVE &&
          currentSample.status !== EndpointTestSampleStatus.ARCHIVED) ||
        currentDescriptor?.captureState !== 'stored' ||
        currentDescriptor.opaqueObjectId !== objectId ||
        currentObject?.state !== 'ready') throw unavailable();
      if (currentDescriptor.sha256 !== object.sha256 ||
        currentDescriptor.observedBytes !== object.observedBytes ||
        currentDescriptor.mediaType !== object.mediaType ||
        currentDescriptor.measurement !== object.measurement ||
        currentObject.sha256 !== object.sha256 ||
        currentObject.observedBytes !== object.observedBytes ||
        currentObject.objectKey !== object.objectKey) throw failed();
      await this.requireEndpoint(sample.endpointDefinitionId);
      return bytes;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw failed();
    }
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
    await this.assertNoSampleObject(sampleId);
    await this.testSampleRepository.delete({ id: sampleId });
    return { sampleId, deleted: true };
  }

  async cleanupExpiredSamples(retentionDays = this.sampleRetentionDays) {
    const days = this.readPositiveInt(String(retentionDays), this.sampleRetentionDays);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const expired = await this.testSampleRepository.find({
      where: {
        status: EndpointTestSampleStatus.ARCHIVED,
        capturedAt: LessThan(cutoff),
      },
      select: { id: true },
    });
    let deletedCount = 0;
    let skippedObjectCount = 0;
    for (const sample of expired) {
      if (await this.hasSampleObject(sample.id)) {
        skippedObjectCount++;
        continue;
      }
      await this.testSampleRepository.delete({ id: sample.id });
      deletedCount++;
    }
    return { deletedCount, skippedObjectCount, retentionDays: days, cutoff };
  }

  async recordSuccessfulRun(input: RecordEndpointTestSuccessInput) {
    await this.validateRunReferences(input.endpointDefinitionId, input.testCaseId);
    const executedAt = input.executedAt ?? new Date();
    const evidence = this.sanitizeEvidence(input);
    const sampleId = randomUUID();
    const binary = await this.prepareBinaryEvidence(input, sampleId);

    const persist = (
      runResponsePayload: unknown,
      sampleResponsePayload: unknown,
      objectId?: string,
    ) => {
      const fingerprint = this.createEvidenceFingerprint({
        requestHeaders: evidence.requestHeaders,
        requestPayload: evidence.requestPayload,
        responseStatusCode: input.responseStatusCode,
        responsePayload: runResponsePayload,
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
            responsePayload: runResponsePayload,
            responseStatusCode: input.responseStatusCode,
            durationMs: input.durationMs,
            executedAt,
          }),
        );
        const sample = await sampleRepository.save(
          sampleRepository.create({
            id: sampleId,
            endpointDefinitionId: input.endpointDefinitionId,
            testCaseId: input.testCaseId,
            testRunId: run.id,
            sourceServiceInstanceId: input.sourceServiceInstanceId,
            fingerprint,
            enabled: true,
            status: EndpointTestSampleStatus.ACTIVE,
            ...evidence,
            responsePayload: sampleResponsePayload,
            responseStatusCode: input.responseStatusCode,
            durationMs: input.durationMs,
            capturedAt: executedAt,
          }),
        );
        if (objectId) {
          try {
            const promoted = await manager.getRepository(EndpointTestSampleObjectEntity).update(
              { id: objectId, sampleId, side: 'response', state: 'staged' },
              { state: 'ready' },
            );
            if (promoted.affected !== 1) throw new Error('Object was not staged');
          } catch {
            throw new BinaryObjectPromotionError();
          }
        }
        return { run, sample };
      });
    };

    try {
      return await persist(
        binary?.runPayload ?? evidence.responsePayload,
        binary?.samplePayload ?? evidence.responsePayload,
        binary?.objectId,
      );
    } catch (error) {
      if (!(error instanceof BinaryObjectPromotionError) || !binary?.objectId) throw error;
      // The failed transaction rolled back run/sample and the object promotion.
      // The published file remains staged, so retry only the metadata-only result.
      const payload: BinaryResponseDescriptor = {
        ...binary.runPayload, captureState: 'storage_failed',
      };
      return persist(payload, payload);
    }
  }

  private async prepareBinaryEvidence(
    input: RecordEndpointTestSuccessInput,
    sampleId: string,
  ): Promise<{
    runPayload: BinaryResponseDescriptor;
    samplePayload: BinaryResponseDescriptor;
    objectId?: string;
  } | undefined> {
    const capture = input.trustedBinaryCapture;
    if (!binaryCaptureEnabled() || !isTrustedBinaryCapture(capture) ||
      capture.descriptor !== input.responsePayload) return undefined;
    const descriptor = capture.descriptor;
    const bytes = Buffer.from(capture.bytes);
    if (descriptor.kind !== 'binary' || descriptor.schemaVersion !== 1 ||
      descriptor.captureState !== 'metadata_only' || !descriptor.isComplete ||
      descriptor.measurement !== 'decoded_response_body' ||
      descriptor.observedBytes !== bytes.length ||
      descriptor.sha256 !== createHash('sha256').update(bytes).digest('hex')) {
      return undefined;
    }
    try {
      const prepared = await this.sampleObjectService.prepare(
        sampleId, bytes, descriptor.mediaType, descriptor.measurement,
      );
      if (prepared.captureState === 'staged') {
        await this.sampleObjectService.stagePublishedFile(sampleId, prepared.objectId);
        const runPayload: BinaryResponseDescriptor = {
          ...descriptor, captureState: 'stored',
        };
        return {
          runPayload,
          samplePayload: { ...runPayload, opaqueObjectId: prepared.objectId },
          objectId: prepared.objectId,
        };
      }
      const payload: BinaryResponseDescriptor = {
        ...descriptor,
        captureState: prepared.captureState,
        ...(prepared.captureState === 'too_large' ? { sha256: null } : {}),
      };
      return { runPayload: payload, samplePayload: payload };
    } catch {
      const payload: BinaryResponseDescriptor = {
        ...descriptor, captureState: 'storage_failed',
      };
      return { runPayload: payload, samplePayload: payload };
    }
  }

  private async hasSampleObject(sampleId: string): Promise<boolean> {
    return !!await this.sampleObjectRepository.findOne({
      where: { sampleId, side: 'response' },
      select: { id: true },
    });
  }

  private async assertNoSampleObject(sampleId: string): Promise<void> {
    if (await this.hasSampleObject(sampleId)) {
      throw new ConflictException('Binary sample object requires explicit reference revocation');
    }
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
      requestHeaders: this.boundCapturedValue(this.sanitizeRecord(input.requestHeaders)),
      requestPayload: this.boundCapturedValue(this.sanitizeValue(input.requestPayload)),
      responseHeaders: this.boundCapturedValue(this.sanitizeRecord(input.responseHeaders)),
      responsePayload: this.boundCapturedValue(this.sanitizeValue(input.responsePayload)),
      metadata: this.sanitizeRecord(input.metadata),
    };
  }

  private boundCapturedValue(value: unknown): any {
    if (value === undefined) return value;
    const serialized = JSON.stringify(value) ?? 'null';
    const byteLength = Buffer.byteLength(serialized, 'utf8');
    if (byteLength <= this.sampleMaxBytes) return value;
    const digest = createHash('sha256').update(serialized).digest('hex');
    const preview = serialized.slice(0, 4096);
    return {
      truncated: true,
      byteLength,
      sha256: digest,
      preview,
    };
  }

  private readPositiveInt(value: string | undefined, fallback: number) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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
