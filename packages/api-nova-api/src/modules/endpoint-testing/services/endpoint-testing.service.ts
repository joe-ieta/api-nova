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
import { In, LessThan, Repository } from 'typeorm';
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
  private readonly objectDeleteGraceMs = 5 * 60 * 1000;
  private readonly objectCleanupBudgetMs = 2 * 1000;
  private pendingObjectCleanup?: Promise<{
    scannedCount: number; deletedCount: number; failedCount: number;
    deferredCount: number; batchLimit: number; timeBudgetExceeded: boolean;
    orphanDeletedCount: number;
  }>;
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
      if (this.isSampleDeletionPending(sample)) throw revoked();
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
      if (currentSample && this.isSampleDeletionPending(currentSample)) throw revoked();
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
    return this.testSampleRepository.manager.transaction(async manager => {
      const samples = manager.getRepository(EndpointTestSampleEntity);
      const objects = manager.getRepository(EndpointTestSampleObjectEntity);
      const sample = await samples.findOne({ where: { id: sampleId } });
      if (!sample) throw new NotFoundException('Test sample not found');
      if (this.isSampleDeletionPending(sample) || await objects.findOne({
        where: { sampleId, side: 'response', state: 'delete_pending' },
      })) throw new GoneException('Test sample deletion pending');

      // Update only approved fields: a stale PATCH must not overwrite the
      // server-owned responsePayload deletion marker.
      const patch: Partial<EndpointTestSampleEntity> = {};
      if (dto.title !== undefined) patch.title = dto.title;
      if (dto.note !== undefined) patch.note = dto.note;
      if (dto.enabled !== undefined) patch.enabled = dto.enabled;
      if (dto.status !== undefined) patch.status = dto.status;
      if (dto.tags !== undefined) patch.tags = dto.tags;
      if (dto.metadata !== undefined) patch.metadata = this.sanitizeRecord(dto.metadata);
      if (dto.status === EndpointTestSampleStatus.ARCHIVED) {
        patch.archivedAt = new Date();
        patch.enabled = false;
      } else if (dto.status === EndpointTestSampleStatus.ACTIVE) {
        patch.archivedAt = null as unknown as Date;
      }
      if (Object.keys(patch).length) await samples.update({ id: sampleId }, patch);
      const current = await samples.findOne({ where: { id: sampleId } });
      if (!current || this.isSampleDeletionPending(current) || await objects.findOne({
        where: { sampleId, side: 'response', state: 'delete_pending' },
      })) throw new GoneException('Test sample deletion pending');
      return current;
    });
  }

  async archiveTestSample(sampleId: string) {
    return this.updateTestSample(sampleId, {
      status: EndpointTestSampleStatus.ARCHIVED,
      enabled: false,
    });
  }

  async deleteTestSample(sampleId: string) {
    const result = await this.revokeOrDeleteSample(sampleId);
    return result === 'pending'
      ? { sampleId, deleted: false, pending: true }
      : { sampleId, deleted: true, pending: false };
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
    let pendingObjectCount = 0;
    for (const sample of expired) {
      const result = await this.revokeOrDeleteSample(sample.id, cutoff);
      if (result === 'pending') pendingObjectCount++;
      else if (result === 'deleted') deletedCount++;
    }
    return { deletedCount, pendingObjectCount, skippedObjectCount: 0, retentionDays: days, cutoff };
  }


  /** Explicit, bounded cleanup of revoked and abandoned staged binary objects. */
  async cleanupPendingBinaryObjects() {
    if (this.pendingObjectCleanup) return this.pendingObjectCleanup;
    const run = this.runPendingObjectCleanup();
    this.pendingObjectCleanup = run;
    try { return await run; }
    finally { if (this.pendingObjectCleanup === run) this.pendingObjectCleanup = undefined; }
  }

  private async runPendingObjectCleanup() {
    const batchLimit = 100;
    const deadline = Date.now() + this.objectCleanupBudgetMs;
    const candidates = await this.sampleObjectRepository.find({
      where: { state: In(['staged', 'delete_pending']), side: 'response' },
      // Failed candidates are moved to the back by a persisted updatedAt write.
      order: { updatedAt: 'ASC', id: 'ASC' },
      take: batchLimit,
    });
    const result = {
      scannedCount: 0, deletedCount: 0, failedCount: 0, deferredCount: 0,
      batchLimit, timeBudgetExceeded: false, orphanDeletedCount: 0,
    };
    for (const object of candidates) {
      if (Date.now() >= deadline) { result.timeBudgetExceeded = true; break; }
      result.scannedCount++;

      try {
        // Candidate selection is only a hint. The object, sample and grace time
        // are re-read while holding the same fence as the publisher and revoker.
        const outcome = await this.sampleObjectService.withSampleFence(
          object.sampleId, () => this.cleanupPendingObjectLocked(object),
        );
        if (outcome === 'deleted') result.deletedCount++;
        else if (outcome === 'orphan_deleted') {
          result.deletedCount++;
          result.orphanDeletedCount++;
        }
        else if (outcome === 'deferred') result.deferredCount++;
      } catch (error) {
        const code = error instanceof SampleObjectError ? error.code : 'OBJECT_STORAGE_FAILED';
        await this.recordObjectCleanupFailure(object, code);
        result.failedCount++;
      }
    }
    return result;
  }

  private async cleanupPendingObjectLocked(
    object: EndpointTestSampleObjectEntity,
  ): Promise<'deleted' | 'orphan_deleted' | 'deferred' | 'skipped'> {
    const currentObject = await this.sampleObjectRepository.findOneBy({
      id: object.id, sampleId: object.sampleId, side: 'response',
    });
    // A publisher may finish while this candidate waits for the fence.
    if (currentObject?.state === 'ready' || currentObject?.state === 'deleted') return 'skipped';
    if (currentObject?.state === 'staged' && currentObject.objectKey === object.objectKey) {
      return this.cleanupStagedOrphanLocked(currentObject);
    }
    if (currentObject?.state === 'delete_pending' &&
      currentObject.failureCode?.startsWith('ORPHAN_') &&
      currentObject.objectKey === object.objectKey) {
      return this.cleanupClaimedOrphanLocked(currentObject);
    }
    if (currentObject?.state !== 'delete_pending' || currentObject.objectKey !== object.objectKey) {
      throw new SampleObjectError('OBJECT_UNAVAILABLE');
    }
    const sample = await this.testSampleRepository.findOneBy({ id: object.sampleId });
    const descriptor = sample?.responsePayload as Record<string, unknown> | undefined;
    const requestedAt = descriptor?.deletionRequestedAt;
    if (!sample || !this.isSampleDeletionPending(sample) ||
      descriptor?.opaqueObjectId !== undefined || sample.enabled ||
      sample.status !== EndpointTestSampleStatus.ARCHIVED ||
      typeof requestedAt !== 'string' || !Number.isFinite(Date.parse(requestedAt))) {
      throw new SampleObjectError('SAMPLE_NOT_REVOKED');
    }
    if (Date.parse(requestedAt) > Date.now() - this.objectDeleteGraceMs) return 'deferred';
    await this.sampleObjectService.unlinkPending(currentObject);
    await this.sampleObjectService.assertSampleFence(object.sampleId);
    try {
      const finalized = await this.testSampleRepository.manager.transaction(async manager => {
        const objects = manager.getRepository(EndpointTestSampleObjectEntity);
        const samples = manager.getRepository(EndpointTestSampleEntity);
        const row = await objects.findOneBy({ id: object.id, sampleId: object.sampleId, side: 'response' });
        if (row?.state === 'deleted') return false;
        if (row?.state !== 'delete_pending' || row.objectKey !== object.objectKey) {
          throw new ConflictException('Binary object changed; retry cleanup');
        }
        const owner = await samples.findOneBy({ id: object.sampleId });
        const ownerDescriptor = owner?.responsePayload as Record<string, unknown> | undefined;
        if (!owner || !this.isSampleDeletionPending(owner) ||
          ownerDescriptor?.opaqueObjectId !== undefined ||
          ownerDescriptor.deletionRequestedAt !== requestedAt ||
          owner.enabled || owner.status !== EndpointTestSampleStatus.ARCHIVED ||
          Date.parse(requestedAt) > Date.now() - this.objectDeleteGraceMs) {
          throw new ConflictException('Binary sample changed; retry cleanup');
        }
        const changed = await objects.update(
          { id: object.id, sampleId: object.sampleId, side: 'response', state: 'delete_pending' },
          { state: 'deleted', failureCode: null as unknown as string,
            deleteAttempts: Math.min(row.deleteAttempts + 1, 2147483647) },
        );
        if (changed.affected !== 1) throw new ConflictException('Binary object changed; retry cleanup');
        const removed = await samples.delete({ id: object.sampleId });
        if (removed.affected !== 1) throw new ConflictException('Binary sample changed; retry cleanup');
        return true;
      });
      return finalized ? 'deleted' : 'skipped';
    } catch {
      // The transaction rolled back; ENOENT on the next pass is idempotent.
      throw new SampleObjectError('FINALIZE_FAILED');
    }
  }

  private isUnreferencedOrphanSample(
    sample: EndpointTestSampleEntity | null,
    allowPending: boolean,
  ): boolean {
    if (!sample) return true;
    const descriptor = sample.responsePayload;
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) return false;
    const binary = descriptor as Record<string, unknown>;
    // Any opaque ID, including a different object's ID, is an uncertain association.
    if (binary.kind !== 'binary' || binary.schemaVersion !== 1 ||
      binary.opaqueObjectId !== undefined) return false;
    if (binary.captureState === 'storage_failed' &&
      binary.deletionState === undefined &&
      !this.isSampleDeletionPending(sample)) return true;
    return allowPending && binary.captureState === 'unavailable' &&
      this.isSampleDeletionPending(sample) && !sample.enabled &&
      sample.status === EndpointTestSampleStatus.ARCHIVED;
  }

  private orphanGraceElapsed(object: EndpointTestSampleObjectEntity): boolean {
    const created = new Date(object.createdAt).getTime();
    return Number.isFinite(created) && created <= Date.now() - this.objectDeleteGraceMs;
  }

  /** Fence first, recheck ownership, then persist a staged -> pending CAS. */
  private async cleanupStagedOrphanLocked(
    object: EndpointTestSampleObjectEntity,
  ): Promise<'orphan_deleted' | 'deferred' | 'skipped'> {
    if (!this.orphanGraceElapsed(object)) return 'deferred';
    const sample = await this.testSampleRepository.findOneBy({ id: object.sampleId });
    if (!this.isUnreferencedOrphanSample(sample, false)) {
      throw new SampleObjectError('SAMPLE_REFERENCE_PRESENT');
    }
    await this.sampleObjectService.assertSampleFence(object.sampleId);
    const claim = await this.sampleObjectRepository.update(
      { id: object.id, sampleId: object.sampleId, side: 'response',
        objectKey: object.objectKey, state: 'staged' },
      { state: 'delete_pending', failureCode: 'ORPHAN_CLAIMED' },
    );
    if (claim.affected !== 1) throw new SampleObjectError('OBJECT_UNAVAILABLE');
    const claimed = await this.sampleObjectRepository.findOneBy({
      id: object.id, sampleId: object.sampleId, side: 'response',
    });
    if (claimed?.state !== 'delete_pending' ||
      claimed.failureCode !== 'ORPHAN_CLAIMED' ||
      claimed.objectKey !== object.objectKey) throw new SampleObjectError('OBJECT_UNAVAILABLE');
    return this.cleanupClaimedOrphanLocked(claimed);
  }

  /** A persisted claim survives unlink, process failure and finalization failure. */
  private async cleanupClaimedOrphanLocked(
    object: EndpointTestSampleObjectEntity,
  ): Promise<'orphan_deleted' | 'deferred' | 'skipped'> {
    const current = await this.sampleObjectRepository.findOneBy({
      id: object.id, sampleId: object.sampleId, side: 'response',
    });
    if (current?.state === 'deleted') return 'skipped';
    if (current?.state !== 'delete_pending' ||
      !current.failureCode?.startsWith('ORPHAN_') ||
      current.objectKey !== object.objectKey) throw new SampleObjectError('OBJECT_UNAVAILABLE');
    if (!this.orphanGraceElapsed(current)) return 'deferred';
    const sample = await this.testSampleRepository.findOneBy({ id: object.sampleId });
    if (!this.isUnreferencedOrphanSample(sample, true)) {
      throw new SampleObjectError('SAMPLE_REFERENCE_PRESENT');
    }
    await this.sampleObjectService.unlinkPending(current);
    await this.sampleObjectService.assertSampleFence(object.sampleId);
    try {
      const finalized = await this.testSampleRepository.manager.transaction(async manager => {
        const objects = manager.getRepository(EndpointTestSampleObjectEntity);
        const samples = manager.getRepository(EndpointTestSampleEntity);
        const row = await objects.findOneBy({
          id: object.id, sampleId: object.sampleId, side: 'response',
        });
        if (row?.state === 'deleted') return false;
        if (row?.state !== 'delete_pending' ||
          !row.failureCode?.startsWith('ORPHAN_') ||
          row.objectKey !== object.objectKey || !this.orphanGraceElapsed(row)) {
          throw new ConflictException('Binary object changed; retry cleanup');
        }
        const owner = await samples.findOneBy({ id: object.sampleId });
        if (!this.isUnreferencedOrphanSample(owner, true)) {
          throw new ConflictException('Binary sample changed; retry cleanup');
        }
        const changed = await objects.update(
          { id: object.id, sampleId: object.sampleId, side: 'response',
            objectKey: object.objectKey, state: 'delete_pending' },
          { state: 'deleted', failureCode: null as unknown as string,
            deleteAttempts: Math.min(row.deleteAttempts + 1, 2147483647) },
        );
        if (changed.affected !== 1) throw new ConflictException('Binary object changed; retry cleanup');
        // A failed capture is retained as evidence. An explicitly revoked
        // sample can be finalized together with its object tombstone.
        if (owner && this.isSampleDeletionPending(owner)) {
          const removed = await samples.delete({ id: object.sampleId });
          if (removed.affected !== 1) throw new ConflictException('Binary sample changed; retry cleanup');
        }
        return true;
      });
      return finalized ? 'orphan_deleted' : 'skipped';
    } catch {
      // The pending marker remains authoritative even if the file is now absent.
      throw new SampleObjectError('FINALIZE_FAILED');
    }
  }

  private async recordObjectCleanupFailure(
    object: EndpointTestSampleObjectEntity, code: string,
  ): Promise<void> {
    // Error categories are fixed and never contain object keys, paths or OS messages.
    const allowed = new Set([
      'SAMPLE_NOT_REVOKED', 'OBJECT_UNAVAILABLE', 'OBJECT_ROOT_INVALID',
      'OBJECT_ROOT_CHANGED', 'OBJECT_INTEGRITY_FAILED', 'OBJECT_UNLINK_FAILED',
      'OBJECT_STORAGE_FAILED', 'OBJECT_BUSY', 'FINALIZE_FAILED',
      'OBJECT_FENCE_UNAVAILABLE', 'OBJECT_FENCE_LOST',
    ]);
    const orphanCodes: Record<string, string> = {
      SAMPLE_REFERENCE_PRESENT: 'ORPHAN_REFERENCED',
      OBJECT_UNAVAILABLE: 'ORPHAN_UNAVAILABLE',
      OBJECT_ROOT_INVALID: 'ORPHAN_ROOT_INVALID',
      OBJECT_ROOT_CHANGED: 'ORPHAN_ROOT_CHANGED',
      OBJECT_INTEGRITY_FAILED: 'ORPHAN_INTEGRITY_FAILED',
      OBJECT_UNLINK_FAILED: 'ORPHAN_UNLINK_FAILED',
      OBJECT_BUSY: 'ORPHAN_BUSY',
      FINALIZE_FAILED: 'ORPHAN_FINALIZE_FAILED',
      OBJECT_FENCE_UNAVAILABLE: 'ORPHAN_FENCE_UNAVAILABLE',
      OBJECT_FENCE_LOST: 'ORPHAN_FENCE_LOST',
    };
    try {
      const current = await this.sampleObjectRepository.findOneBy({
        id: object.id, sampleId: object.sampleId,
      });
      if (!current || !['staged', 'delete_pending'].includes(current.state)) return;
      const orphan = current.state === 'staged' ||
        current.failureCode?.startsWith('ORPHAN_');
      const previous = new Date(current.updatedAt).getTime();
      const retryOrder = new Date(Math.max(
        Date.now() + 1000, Number.isFinite(previous) ? previous + 1000 : 0,
      ));
      await this.sampleObjectRepository.update(
        { id: object.id, sampleId: object.sampleId, state: current.state },
        { failureCode: orphan
            ? orphanCodes[code] ?? 'ORPHAN_STORAGE_FAILED'
            : allowed.has(code) ? code : 'OBJECT_UNLINK_FAILED',
          deleteAttempts: Math.min(current.deleteAttempts + 1, 2147483647),
          updatedAt: retryOrder },
      );
    } catch {
      // A failed diagnostic write must never clear the pending tombstone.
    }
  }

  async recordSuccessfulRun(input: RecordEndpointTestSuccessInput) {
    await this.validateRunReferences(input.endpointDefinitionId, input.testCaseId);
    const executedAt = input.executedAt ?? new Date();
    const evidence = this.sanitizeEvidence(input);
    const sampleId = randomUUID();
    const work = async () => {
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
        if (binary?.objectId) await this.sampleObjectService.assertSampleFence(sampleId);
        const saved = await persist(
          binary?.runPayload ?? evidence.responsePayload,
          binary?.samplePayload ?? evidence.responsePayload,
          binary?.objectId,
        );
        if (binary?.objectId) await this.sampleObjectService.assertSampleFence(sampleId);
        return saved;
      } catch (error) {
        if (!(error instanceof BinaryObjectPromotionError) || !binary?.objectId) throw error;
        // The failed transaction rolled back run/sample and the object promotion.
        // The published file remains staged, so retry only the metadata-only result.
        const payload: BinaryResponseDescriptor = {
          ...binary.runPayload, captureState: 'storage_failed',
        };
        return persist(payload, payload);
      }
    };
    const capture = input.trustedBinaryCapture;
    if (binaryCaptureEnabled() && isTrustedBinaryCapture(capture) &&
      capture.descriptor === input.responsePayload) {
      return this.sampleObjectService.withSampleFence(sampleId, work);
    }
    return work();
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

  private isSampleDeletionPending(sample: EndpointTestSampleEntity): boolean {
    const payload = sample.responsePayload;
    return !!payload && typeof payload === 'object' && !Array.isArray(payload) &&
      (payload as Record<string, unknown>).deletionState === 'pending';
  }

  /** Revoke the sample reference and persist an object tombstone; physical GC is separate. */
  private async revokeOrDeleteSample(
    sampleId: string,
    cutoff?: Date,
  ): Promise<'deleted' | 'pending' | 'skipped'> {
    if (!/^[a-zA-Z0-9-]{1,36}$/.test(sampleId)) {
      if (cutoff) return 'skipped';
      throw new NotFoundException('Test sample not found');
    }
    const work = () => this.testSampleRepository.manager.transaction(async manager => {
        const samples = manager.getRepository(EndpointTestSampleEntity);
        const objects = manager.getRepository(EndpointTestSampleObjectEntity);
        const sample = await samples.findOne({ where: { id: sampleId } });
        if (!sample) {
          if (cutoff) return 'skipped';
          throw new NotFoundException('Test sample not found');
        }
        if (cutoff && (sample.status !== EndpointTestSampleStatus.ARCHIVED ||
          new Date(sample.capturedAt).getTime() >= cutoff.getTime())) return 'skipped';

        const object = await objects.findOne({ where: { sampleId, side: 'response' } });
        if (!object) {
          if (this.isSampleDeletionPending(sample)) {
            throw new ConflictException('Pending binary sample has no object tombstone');
          }
          const removed = await samples.delete(cutoff
            ? { id: sampleId, status: EndpointTestSampleStatus.ARCHIVED, capturedAt: LessThan(cutoff) }
            : { id: sampleId });
          if (removed.affected !== 1) throw new ConflictException('Test sample changed; retry deletion');
          return 'deleted';
        }
        if (object.state === 'deleted') {
          const descriptor = sample.responsePayload as Record<string, unknown> | undefined;
          if (descriptor?.opaqueObjectId !== undefined) {
            throw new ConflictException('Deleted binary object is still referenced');
          }
          const removed = await samples.delete(cutoff
            ? { id: sampleId, status: EndpointTestSampleStatus.ARCHIVED, capturedAt: LessThan(cutoff) }
            : { id: sampleId });
          if (removed.affected !== 1) throw new ConflictException('Test sample changed; retry deletion');
          return 'deleted';
        }
        if (!['ready', 'staged', 'delete_pending'].includes(object.state)) {
          throw new ConflictException('Binary object state cannot be revoked');
        }
        if (object.state !== 'delete_pending') {
          const changed = await objects.update(
            { id: object.id, sampleId, side: 'response', state: object.state },
            { state: 'delete_pending', failureCode: null as unknown as string },
          );
          if (changed.affected !== 1) throw new ConflictException('Binary object changed; retry deletion');
        } else if (object.failureCode?.startsWith('ORPHAN_')) {
          // An explicit revocation has its own first-request grace. Discard
          // the orphan marker so cleanup uses deletionRequestedAt instead.
          const changed = await objects.update(
            { id: object.id, sampleId, side: 'response', state: 'delete_pending' },
            { failureCode: null as unknown as string },
          );
          if (changed.affected !== 1) throw new ConflictException('Binary object changed; retry deletion');
        }

        const source = sample.responsePayload && typeof sample.responsePayload === 'object' &&
          !Array.isArray(sample.responsePayload)
          ? sample.responsePayload as Record<string, unknown>
          : {};
        const rest = { ...source };
        delete rest.opaqueObjectId;
        const deletionRequestedAt = this.isSampleDeletionPending(sample) &&
          typeof rest.deletionRequestedAt === 'string' &&
          Number.isFinite(Date.parse(rest.deletionRequestedAt))
          ? rest.deletionRequestedAt : new Date().toISOString();
        const pendingPayload = {
          ...rest, captureState: 'unavailable', deletionState: 'pending', deletionRequestedAt,
        };
        if (!this.isSampleDeletionPending(sample) || 'opaqueObjectId' in source ||
          source.deletionRequestedAt !== deletionRequestedAt ||
          sample.enabled || sample.status !== EndpointTestSampleStatus.ARCHIVED) {
          const changed = await samples.update({ id: sampleId }, {
            responsePayload: pendingPayload,
            enabled: false,
            status: EndpointTestSampleStatus.ARCHIVED,
            archivedAt: sample.archivedAt ?? new Date(),
          });
          if (changed.affected !== 1) throw new ConflictException('Test sample changed; retry deletion');
        }
        const current = await samples.findOne({ where: { id: sampleId } });
        const tombstone = await objects.findOne({ where: { id: object.id, sampleId, side: 'response' } });
        if (!current || !this.isSampleDeletionPending(current) ||
          (current.responsePayload as Record<string, unknown>).opaqueObjectId !== undefined ||
          tombstone?.state !== 'delete_pending') {
          throw new ConflictException('Binary sample revocation is incomplete');
        }
        return 'pending';
    });
    // A normal sample has no object file to fence. Binary rows are persisted
    // before their file is written, so an in-flight publisher is discoverable.
    const owned = await this.sampleObjectRepository.findOne({
      where: { sampleId, side: 'response' }, select: { id: true },
    });
    return owned ? this.sampleObjectService.withSampleFence(sampleId, work) : work();
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
