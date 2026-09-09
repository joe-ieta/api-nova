import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'crypto';
import {
  CanonicalInvocation, normalizeRuntimeAuditRecord, redactAuditHeaders, redactAuditUrl,
} from 'api-nova-parser';
import {
  RuntimeIngestCheckpointEntity, RuntimeIngestQuarantineEntity, RuntimeIngestReceiptEntity,
  RuntimeInvocationEntity, RuntimeInvocationRevisionEntity, RuntimePayloadEntity,
  RuntimePipelineStateEntity,
} from '../../database/entities/runtime-call-observability.entity';
import {
  RuntimeObservabilityActorType, RuntimeObservabilityEventEntity,
  RuntimeObservabilityEventFamily, RuntimeObservabilityRetentionClass,
  RuntimeObservabilitySeverity, RuntimeObservabilityStatus,
} from '../../database/entities/runtime-observability-event.entity';
import { CallObservabilityPayloadStore, PreparedPayload } from './call-observability-payload.store';
import {
  canonicalJson, contentHash, expiresAfter, ObservabilityStorageError,
  publicSequence, sequenceKey, SerialStorageLane, ZERO_SEQUENCE,
} from './call-observability-storage';

import { CallObservabilityPayloadCoordinator, PAYLOAD_OWNER_ID } from './call-observability-payload.coordinator';

const COUNTER_ID = 'call-observability:commit-sequence';
const lanes = new WeakMap<DataSource, SerialStorageLane>();

export interface IngestCheckpoint {
  id: string;
  fileName: string;
  fileIdentity: string;
  previousOffset: string;
  byteOffset: string;
  boundaryHash?: string;
}

export interface IngestContext {
  sourceInstanceId?: string;
  checkpoint?: IngestCheckpoint;
  /** Retain history without making initial dataset evidence eligible for delivery. */
  suppressEvent?: boolean;
}

export interface CommittedObservabilityEvent {
  eventId: string;
  sequence: string;
  eventType: string;
}

export interface ObservabilityReadTransaction {
  manager: EntityManager;
  now: string;
  snapshotSeq: string;
}

/** Database-only callback. Never do network I/O or publish before commit. */
export interface ObservabilityWriteTransaction {
  manager: EntityManager;
  now: string;
  nextSequence(): string;
  currentSequence(): string;
  events: CommittedObservabilityEvent[];
}

export type ProjectionHook = (
  transaction: ObservabilityWriteTransaction,
  before: RuntimeInvocationEntity | null,
  after: RuntimeInvocationEntity,
) => Promise<void>;

export interface IngestResult {
  status: 'inserted' | 'updated' | 'duplicate' | 'stale' | 'quarantined';
  invocationId: string | null;
  recordVersion: number | null;
  snapshotSeq: string;
  events: CommittedObservabilityEvent[];
  reason?: string;
}

/**
 * The sole call-projection write path: evidence receipt, current/revision rows,
 * checkpoint and durable event are committed or rolled back together.
 * SQLite requires one management writer; PostgreSQL serializes commit allocation.
 */
@Injectable()
export class CallObservabilityStore {
  private readonly lane: SerialStorageLane;
  private readonly ingestion = new SerialStorageLane(8);
  readonly payloadCoordination: CallObservabilityPayloadCoordinator;
  private payloadStorage?: Promise<string>;

  constructor(
    private readonly dataSource: DataSource,
    private readonly payloadStore: CallObservabilityPayloadStore,
  ) {
    let lane = lanes.get(dataSource);
    if (!lane) {
      lane = new SerialStorageLane();
      lanes.set(dataSource, lane);
    }
    this.lane = lane;
    this.payloadCoordination = new CallObservabilityPayloadCoordinator(operation => this.transaction(operation));
  }

  get pendingWrites(): number { return this.lane.pending + this.ingestion.pending; }

  async transaction<T>(operation: (tx: ObservabilityWriteTransaction) => Promise<T>): Promise<T> {
    return this.lane.run(() => this.dataSource.transaction(async manager => {
      const now = new Date().toISOString();
      const repository = manager.getRepository(RuntimePipelineStateEntity);
      const initialCounter = repository.create({
        id: COUNTER_ID, value: { sequence: ZERO_SEQUENCE }, updatedAt: now,
      });
      await repository.createQueryBuilder().insert().values(initialCounter).orIgnore().execute();
      const query = repository.createQueryBuilder('counter').where('counter.id = :id', { id: COUNTER_ID });
      if (this.dataSource.options.type === 'postgres') query.setLock('pessimistic_write');
      const counter = await query.getOne();
      if (!counter) throw new ObservabilityStorageError('SEQUENCE_STATE_MISSING');
      let sequence = sequenceKey(counter.value.sequence);
      const tx: ObservabilityWriteTransaction = {
        manager, now, events: [],
        nextSequence: () => { sequence = sequenceKey(BigInt(sequence) + BigInt(1)); return sequence; },
        currentSequence: () => sequence,
      };
      const result = await operation(tx);
      counter.value = { sequence };
      counter.updatedAt = now;
      await repository.save(counter);
      return result;
    }));
  }

  /** Stable read view without allocating a sequence or updating pipeline state. */
  async readSnapshot<T>(operation: (tx: ObservabilityReadTransaction) => Promise<T>): Promise<T> {
    const isolation = this.dataSource.options.type === 'postgres' ? 'REPEATABLE READ' : 'SERIALIZABLE';
    return this.lane.run(() => this.dataSource.transaction(isolation, async manager => {
      const counter = await manager.getRepository(RuntimePipelineStateEntity)
        .findOne({ where: { id: COUNTER_ID } });
      return operation({ manager, now: new Date().toISOString(),
        snapshotSeq: publicSequence(counter?.value?.sequence || ZERO_SEQUENCE) });
    }));
  }

  async watermark(): Promise<string> {
    return this.lane.run(async () => {
      const counter = await this.dataSource.getRepository(RuntimePipelineStateEntity)
        .findOne({ where: { id: COUNTER_ID } });
      return publicSequence(counter?.value?.sequence || ZERO_SEQUENCE);
    });
  }

  async ensurePayloadStorage(): Promise<string> {
    if (!this.payloadStorage) {
      this.payloadStorage = (async () => {
        const owner = await this.transaction(async tx => {
          const repository = tx.manager.getRepository(RuntimePipelineStateEntity);
          const previous = await repository.findOne({ where: { id: PAYLOAD_OWNER_ID } });
          if (previous) return String(previous.value.ownerId);
          const ownerId = randomUUID();
          await repository.save(repository.create({
            id: PAYLOAD_OWNER_ID, value: { ownerId }, updatedAt: tx.now,
          }));
          return ownerId;
        });
        await this.payloadStore.ensureOwner(owner);
        return owner;
      })().catch(error => {
        this.payloadStorage = undefined;
        throw error;
      });
    }
    return this.payloadStorage;
  }

  async ingest(input: unknown, context: IngestContext = {}, project?: ProjectionHook): Promise<IngestResult> {
    this.validateCheckpoint(context.checkpoint);
    return this.ingestion.run(async () => {
      // Invalid schema/JSON must be handed to rejectRecord by the collector.
      const source = normalizeRuntimeAuditRecord(input, context);
      if (source.recordVersion > 2147483647) throw new ObservabilityStorageError('INVALID_RECORD_VERSION');
      for (const id of [source.runtimeAssetId, source.runtimeAssetEndpointBindingId,
        source.endpointDefinitionId, source.sourceServiceAssetId]) {
        if (id !== null && id.length > 36) throw new ObservabilityStorageError('INVALID_ASSET_REFERENCE');
      }
      const recordHash = contentHash(canonicalJson(source));
      const record: CanonicalInvocation = {
        ...source,
        requestHeaders: redactAuditHeaders(source.requestHeaders),
        responseHeaders: redactAuditHeaders(source.responseHeaders),
        url: source.url ? redactAuditUrl(source.url) : null,
        path: source.path ? redactAuditUrl(source.path) : null,
      };
      await this.ensurePayloadStorage();
      return this.payloadCoordination.withWriter(async lease => {
        const now = new Date().toISOString();
        const retainFrom = record.completedAt || record.startedAt;
        const bodyExpiresAt = expiresAfter(retainFrom, 7);
        const request = await this.payloadStore.prepare({
          sourceInstanceId: record.sourceInstanceId, invocationId: record.invocationId, side: 'request',
        }, record.request, now, bodyExpiresAt, lease.generation);
        const response = await this.payloadStore.prepare({
          sourceInstanceId: record.sourceInstanceId, invocationId: record.invocationId, side: 'response',
        }, record.response, now, bodyExpiresAt, lease.generation);
        const receiptId = contentHash(canonicalJson([record.sourceInstanceId, record.sourceEventId]));
        return this.transaction(async tx => {
          await this.payloadCoordination.assertWriter(tx, lease);
          const receipts = tx.manager.getRepository(RuntimeIngestReceiptEntity);
          const previousReceipt = await receipts.findOne({ where: { id: receiptId } });
          if (previousReceipt && previousReceipt.recordHash !== recordHash) {
            return this.quarantine(tx, context, recordHash, 'SOURCE_EVENT_CONFLICT', record);
          }
          const repository = tx.manager.getRepository(RuntimeInvocationEntity);
          const previous = await repository.findOne({ where: { invocationId: record.invocationId } });
          if (previousReceipt) {
            await this.checkpoint(tx, context.checkpoint, source.sourceSequence, source.sourceInstanceId);
            return this.result(tx, 'duplicate', previous);
          }
          if (previous && this.identityConflict(previous, record)) {
            return this.quarantine(tx, context, recordHash, 'INVOCATION_IDENTITY_CONFLICT', record);
          }
          if (previous && record.recordVersion === previous.sourceRecordVersion &&
            recordHash !== previous.recordHash) {
            return this.quarantine(tx, context, recordHash, 'SOURCE_VERSION_CONFLICT', record);
          }
          if (previous && record.recordVersion > previous.sourceRecordVersion &&
            previous.phase === 'finished' && previous.record.completionSource === 'observed') {
            return this.quarantine(tx, context, recordHash, 'TERMINAL_RECORD_MUTATION', record);
          }

          await receipts.insert({
            id: receiptId, sourceInstanceId: record.sourceInstanceId, eventId: record.sourceEventId,
            recordHash, invocationId: record.invocationId, createdAt: tx.now, expiresAt: expiresAfter(tx.now, 32),
          });
          if (previous && record.recordVersion <= previous.sourceRecordVersion) {
            await this.checkpoint(tx, context.checkpoint, source.sourceSequence, source.sourceInstanceId);
            return this.result(tx, recordHash === previous.recordHash ? 'duplicate' : 'stale', previous);
          }
          if (Date.parse(expiresAfter(retainFrom, 30)) <= Date.parse(tx.now)) {
            return this.quarantine(tx, context, recordHash, 'OUTSIDE_METADATA_RETENTION', record);
          }
          const revisionSequence = tx.nextSequence();
          const revision = (previous?.recordVersion || 0) + 1;
          if (revision > 2147483647) throw new ObservabilityStorageError('RECORD_VERSION_EXHAUSTED');
          // Recover inferred unknown state only from an observed terminal record.
          if (previous?.record.completionSource === 'reconciled' && record.phase !== 'finished') {
            await this.checkpoint(tx, context.checkpoint, source.sourceSequence, source.sourceInstanceId);
            return this.result(tx, 'stale', previous);
          }
          await this.persistPayload(tx, request);
          await this.persistPayload(tx, response);
          const metadata: CanonicalInvocation = {
            ...record, recordVersion: revision, request: request.body, response: response.body,
          };
          const current = Object.assign(new RuntimeInvocationEntity(), {
            invocationId: record.invocationId, sourceInstanceId: record.sourceInstanceId,
            sourceRecordVersion: source.recordVersion, recordVersion: revision, recordHash,
            createdSequence: previous?.createdSequence || revisionSequence, updatedSequence: revisionSequence,
            traceId: record.traceId, parentInvocationId: record.parentInvocationId,
            runtimeAssetId: record.runtimeAssetId, serverType: record.serverType, spanKind: record.spanKind,
            origin: record.origin, callerId: record.callerId, sourceId: previous?.sourceId || null,
            endpointDefinitionId: record.endpointDefinitionId, sourceServiceInstanceId: record.sourceServiceInstanceId,
            toolName: record.toolName, startedAt: record.startedAt, completedAt: record.completedAt,
            outcome: record.outcome, phase: record.phase, requestPayloadId: request.entity.id,
            responsePayloadId: response.entity.id, record: metadata, expiresAt: expiresAfter(retainFrom, 30),
            ingestedAt: tx.now,
          });
          if (project) await project(tx, previous, current);
          await this.saveProjection(tx, previous, current);
          if (record.phase === 'finished') {
            await this.invocationEvent(tx, current, revisionSequence,
              previous?.record.completionSource === 'reconciled' ? 'invocation.reconciled' : 'invocation.completed',
              context.suppressEvent);
          }
          if (request.storageFailed || response.storageFailed) {
            await this.diagnostic(tx, 'payloadWriteFailures', Number(request.storageFailed) + Number(response.storageFailed));
          }
          await this.checkpoint(tx, context.checkpoint, source.sourceSequence, source.sourceInstanceId);
          return this.result(tx, previous ? 'updated' : 'inserted', current);
        });
      });
    });
  }

  /** Only the recovery worker calls this after establishing lost terminal evidence. */
  async reconcile(invocationId: string, expectedVersion: number,
    evidence: { reason: 'process_exit' | 'progress_timeout'; observedBefore: string; suppressEvent?: boolean;
      sourceExitProofId?: string },
    project?: ProjectionHook): Promise<IngestResult> {
    const observedBefore = Date.parse(evidence.observedBefore);
    if (!Number.isFinite(observedBefore) || observedBefore > Date.now()) {
      throw new ObservabilityStorageError('INVALID_RECONCILIATION_EVIDENCE');
    }
    return this.transaction(async tx => {
      const previous = await tx.manager.getRepository(RuntimeInvocationEntity).findOne({ where: { invocationId } });
      if (!previous || previous.recordVersion !== expectedVersion || previous.phase === 'finished' ||
        Date.parse(previous.ingestedAt) > observedBefore) return this.result(tx, 'stale', previous);
      let sourceExitedAt: string | undefined;
      if (evidence.sourceExitProofId) {
        const proof = await tx.manager.getRepository(RuntimePipelineStateEntity)
          .findOneBy({ id: evidence.sourceExitProofId });
        if (evidence.reason !== 'process_exit' ||
          evidence.sourceExitProofId !== 'call-observability:source-exit:' + previous.sourceInstanceId ||
          proof?.value?.state !== 'closed' || proof.value.sourceInstanceId !== previous.sourceInstanceId) {
          throw new ObservabilityStorageError('INVALID_RECONCILIATION_EVIDENCE');
        }
        sourceExitedAt = proof.value.observedAt;
      }
      const revision = previous.recordVersion + 1;
      if (revision > 2147483647) throw new ObservabilityStorageError('RECORD_VERSION_EXHAUSTED');
      const sequence = tx.nextSequence();
      const current = Object.assign(new RuntimeInvocationEntity(), previous, {
        recordVersion: revision, updatedSequence: sequence, completedAt: null,
        phase: 'finished', outcome: 'unknown', ingestedAt: tx.now,
        record: { ...previous.record, recordVersion: revision, phase: 'finished',
          outcome: 'unknown', completionSource: 'reconciled', completedAt: null, durationMs: null,
          reconciledAt: tx.now, reconciliationReason: evidence.reason, sourceExitedAt,
          missingFields: [...new Set([...(previous.record.missingFields || []), 'terminalRecord', 'completedAt'])] },
      });
      if (project) await project(tx, previous, current);
      await this.saveProjection(tx, previous, current);
      await this.invocationEvent(tx, current, sequence, 'invocation.reconciled', evidence.suppressEvent);
      return this.result(tx, 'updated', current);
    });
  }

  /** Malformed lines are quarantined by hash, never copied into queryable payloads. */
  async rejectRecord(context: IngestContext, recordHash: string, reason: string): Promise<IngestResult> {
    this.validateCheckpoint(context.checkpoint);
    if (!/^[a-f0-9]{64}$/.test(recordHash) || !/^[A-Z][A-Z0-9_]{0,79}$/.test(reason)) {
      throw new ObservabilityStorageError('INVALID_QUARANTINE_REFERENCE');
    }
    return this.transaction(tx => this.quarantine(tx, context, recordHash, reason));
  }

  private identityConflict(previous: RuntimeInvocationEntity, record: CanonicalInvocation): boolean {
    if (previous.sourceInstanceId !== record.sourceInstanceId || previous.spanKind !== record.spanKind ||
      previous.serverType !== record.serverType || previous.startedAt !== record.startedAt) return true;
    return ['runtimeAssetId', 'traceId', 'rootInvocationId', 'parentInvocationId', 'callerId']
      .some(key => previous.record[key] != null &&
        previous.record[key] !== (record as any)[key]);
  }

  private async persistPayload(tx: ObservabilityWriteTransaction, payload: PreparedPayload): Promise<void> {
    await tx.manager.getRepository(RuntimePayloadEntity).createQueryBuilder()
      .insert().values(payload.entity).orIgnore().execute();
  }

  private async saveProjection(tx: ObservabilityWriteTransaction,
    previous: RuntimeInvocationEntity | null, current: RuntimeInvocationEntity): Promise<void> {
    if (previous) {
      await tx.manager.getRepository(RuntimeInvocationRevisionEntity).update({
        invocationId: previous.invocationId, recordVersion: previous.recordVersion,
      }, { validUntilSequence: current.updatedSequence });
    }
    await tx.manager.getRepository(RuntimeInvocationEntity).save(current);
    await tx.manager.getRepository(RuntimeInvocationRevisionEntity).insert(Object.assign(
      new RuntimeInvocationRevisionEntity(), current, {
        id: contentHash(canonicalJson([current.invocationId, current.recordVersion])),
        validFromSequence: current.updatedSequence, validUntilSequence: null,
      },
    ));
  }

  private async invocationEvent(tx: ObservabilityWriteTransaction, current: RuntimeInvocationEntity,
    sequence: string, eventType: 'invocation.completed' | 'invocation.reconciled',
    suppressEvent = false): Promise<void> {
    const row = current.record as CanonicalInvocation;
    const failed = ['error', 'timeout', 'incomplete', 'rejected'].includes(row.outcome || '');
    const event = Object.assign(new RuntimeObservabilityEventEntity(), {
      id: randomUUID(), sequence, schemaVersion: '1.0', eventName: eventType,
      subjectId: current.invocationId, subjectVersion: current.recordVersion,
      runtimeAssetId: row.runtimeAssetId || undefined,
      runtimeAssetEndpointBindingId: row.runtimeAssetEndpointBindingId || undefined,
      endpointDefinitionId: row.endpointDefinitionId || undefined,
      sourceServiceAssetId: row.sourceServiceAssetId || undefined,
      eventFamily: failed ? RuntimeObservabilityEventFamily.RUNTIME_ERROR : RuntimeObservabilityEventFamily.RUNTIME_REQUEST,
      severity: failed ? RuntimeObservabilitySeverity.WARNING : RuntimeObservabilitySeverity.INFO,
      status: failed ? RuntimeObservabilityStatus.FAILED : row.outcome === 'success' ?
        RuntimeObservabilityStatus.SUCCESS : RuntimeObservabilityStatus.PARTIAL,
      occurredAt: new Date(row.completedAt || tx.now), createdAt: new Date(tx.now),
      correlationId: row.traceId && row.traceId.length <= 120 ? row.traceId : undefined,
      actorType: RuntimeObservabilityActorType.RUNTIME,
      retentionClass: RuntimeObservabilityRetentionClass.STANDARD,
      dispatchState: suppressEvent ? 'suppressed' : 'pending', expiresAt: new Date(expiresAfter(tx.now, 14)),
      dimensions: { runtimeAssetId: row.runtimeAssetId, serverType: row.serverType, origin: row.origin,
        spanKind: row.spanKind, callerId: row.callerId, endpointDefinitionId: row.endpointDefinitionId,
        sourceServiceInstanceId: row.sourceServiceInstanceId },
      // Push is metadata-only. Raw bodies, headers, source IPs and paths are excluded.
      details: { invocationId: row.invocationId, recordVersion: current.recordVersion,
        traceId: row.traceId, spanKind: row.spanKind, serverType: row.serverType, origin: row.origin,
        callerId: row.callerId, runtimeAssetId: row.runtimeAssetId, outcome: row.outcome,
        httpStatus: row.httpStatus, toolIsError: row.toolIsError, errorCategory: row.errorCategory,
        durationMs: row.durationMs, completionSource: row.completionSource,
        byteMeasurement: row.byteMeasurement, measurementStage: row.measurementStage,
        request: { state: row.request.state, observedBytes: row.request.observedBytes },
        response: { state: row.response.state, observedBytes: row.response.observedBytes } },
    });
    await tx.manager.getRepository(RuntimeObservabilityEventEntity).insert(event);
    if (!suppressEvent) tx.events.push({ eventId: event.id, sequence: publicSequence(sequence), eventType });
  }

  private async checkpoint(tx: ObservabilityWriteTransaction,
    checkpoint: IngestCheckpoint | undefined, sourceSequence: number | null, sourceInstanceId?: string): Promise<void> {
    if (!checkpoint) return;
    const repository = tx.manager.getRepository(RuntimeIngestCheckpointEntity);
    const previous = await repository.findOne({ where: { id: checkpoint.id } });
    const offset = sequenceKey(checkpoint.byteOffset);
    if (previous?.fileIdentity && previous.fileIdentity !== checkpoint.fileIdentity) {
      throw new ObservabilityStorageError('CHECKPOINT_FILE_CHANGED');
    }
    if (previous && sequenceKey(previous.byteOffset) >= offset) return;
    if (sequenceKey(previous?.byteOffset || '0') !== sequenceKey(checkpoint.previousOffset)) {
      throw new ObservabilityStorageError('CHECKPOINT_CONFLICT');
    }
    if (previous?.lastSequence && sourceSequence !== null &&
      BigInt(sourceSequence) > BigInt(previous.lastSequence) + BigInt(1)) {
      await this.diagnostic(tx, 'sourceSequenceGaps',
        Number(BigInt(sourceSequence) - BigInt(previous.lastSequence) - BigInt(1)));
    }
    if (checkpoint.boundaryHash) {
      const boundaries = tx.manager.getRepository(RuntimePipelineStateEntity);
      const id = 'call-observability:boundary:' + checkpoint.id;
      const boundary = await boundaries.findOneBy({ id });
      const boundSource = boundary?.value?.sourceInstanceId;
      const mixedSources = boundary?.value?.mixedSources === true ||
        !!(boundSource && sourceInstanceId && boundSource !== sourceInstanceId);
      await boundaries.save(boundaries.create({ id,
        value: { hash: checkpoint.boundaryHash, mixedSources,
          sourceInstanceId: mixedSources ? null : sourceInstanceId || boundSource || null }, updatedAt: tx.now,
      }));
    }
    await repository.save(Object.assign(new RuntimeIngestCheckpointEntity(), {
      id: checkpoint.id, fileName: checkpoint.fileName, fileIdentity: checkpoint.fileIdentity,
      byteOffset: offset, lastSequence: sourceSequence === null ? previous?.lastSequence || null :
        sequenceKey(BigInt(sourceSequence) > BigInt(previous?.lastSequence || '0')
          ? String(sourceSequence) : previous!.lastSequence!), updatedAt: tx.now, status: 'active', error: null,
    }));
  }

  private validateCheckpoint(checkpoint?: IngestCheckpoint): void {
    if (!checkpoint) return;
    if (!/^[a-f0-9]{64}$/.test(checkpoint.id) || !checkpoint.fileIdentity ||
      checkpoint.fileIdentity.length > 500 ||
      !/^calls-v2-[a-zA-Z0-9-]+\.jsonl$/.test(checkpoint.fileName) ||
      checkpoint.fileName.length > 240 ||
      checkpoint.boundaryHash !== undefined && !/^[a-f0-9]{64}$/.test(checkpoint.boundaryHash) ||
      sequenceKey(checkpoint.byteOffset) <= sequenceKey(checkpoint.previousOffset)) {
      throw new ObservabilityStorageError('INVALID_CHECKPOINT');
    }
  }

  private async quarantine(tx: ObservabilityWriteTransaction, context: IngestContext,
    recordHash: string, reason: string, record?: CanonicalInvocation): Promise<IngestResult> {
    const id = contentHash(canonicalJson([context.checkpoint?.id, context.checkpoint?.byteOffset, recordHash, reason]));
    await tx.manager.getRepository(RuntimeIngestQuarantineEntity).createQueryBuilder().insert().values({
      id, sourceInstanceId: record?.sourceInstanceId || context.sourceInstanceId || null,
      eventId: record?.sourceEventId || null, invocationId: record?.invocationId || null,
      fileName: context.checkpoint?.fileName || null,
      byteOffset: context.checkpoint ? sequenceKey(context.checkpoint.byteOffset) : null,
      recordHash, reason, createdAt: tx.now, expiresAt: expiresAfter(tx.now, 30),
    }).orIgnore().execute();
    await this.diagnostic(tx, 'quarantinedRecords', 1);
    if (reason === 'SOURCE_CLOSED_PARTIAL_LINE' && context.checkpoint) {
      await this.diagnostic(tx, 'closedSourcePartialRecords', 1);
      await this.diagnostic(tx, 'closedSourcePartialBytes',
        Number(BigInt(context.checkpoint.byteOffset) - BigInt(context.checkpoint.previousOffset)));
    }
    await this.checkpoint(tx, context.checkpoint, record?.sourceSequence || null,
      record?.sourceInstanceId || context.sourceInstanceId);
    return { ...this.result(tx, 'quarantined', null), invocationId: record?.invocationId || null, reason };
  }

  private async diagnostic(tx: ObservabilityWriteTransaction, field: string, increment: number): Promise<void> {
    const repository = tx.manager.getRepository(RuntimePipelineStateEntity);
    const id = 'call-observability:storage-diagnostics';
    const previous = await repository.findOne({ where: { id } });
    const value = { ...(previous?.value || {}) };
    value[field] = Math.min(Number.MAX_SAFE_INTEGER, (Number(value[field]) || 0) + increment);
    await repository.save(Object.assign(new RuntimePipelineStateEntity(), { id, value, updatedAt: tx.now }));
  }

  private result(tx: ObservabilityWriteTransaction, status: IngestResult['status'],
    invocation: RuntimeInvocationEntity | null): IngestResult {
    return { status, invocationId: invocation?.invocationId || null,
      recordVersion: invocation?.recordVersion || null,
      snapshotSeq: publicSequence(tx.currentSequence()), events: tx.events };
  }
}
