import { PayloadQuotaPrimitives } from './call-observability-payload-quota';
import { PayloadPublicationIntentStore } from './call-observability-payload-publication-intent';
import { payloadPhysicalGuardEnabled } from './call-observability-payload-physical';
import { Injectable } from '@nestjs/common';
import { readEventRetentionPolicy } from './call-observability-policy';
import { DataSource, EntityManager, In } from 'typeorm';
import { randomUUID } from 'crypto';
import {
  CanonicalInvocation, InvalidRuntimeAuditRecord, invocationMatchesScope, normalizeRuntimeAuditRecord, redactAuditHeaders, redactAuditUrl,
} from 'api-nova-parser';
import {
  RuntimeIngestCheckpointEntity, RuntimeIngestQuarantineEntity, RuntimeIngestReceiptEntity,
  RuntimeIngestReceiptTombstoneEntity,
  RuntimeInvocationEntity, RuntimeInvocationRevisionEntity, RuntimeMetricBucketEntity,
  RuntimeMetricContributionEntity, RuntimeAccessSourceEntity, RuntimeCallerBucketEntity, RuntimePayloadEntity,
  RuntimePipelineStateEntity,
} from '../../database/entities/runtime-call-observability.entity';
import {
  BUCKET_KEY_SCHEMA_VERSION, BucketRevisionPlan, PERSISTENT_BUCKET_INTERVALS, planBucketRevision,
} from './call-observability-bucket-plan';
import {
  RuntimeObservabilityActorType, RuntimeObservabilityEventEntity,
  RuntimeObservabilityEventFamily, RuntimeObservabilityRetentionClass,
  RuntimeObservabilitySeverity, RuntimeObservabilityStatus,
} from '../../database/entities/runtime-observability-event.entity';
import { CallObservabilityPayloadStore, PreparedPayload, PayloadPublicationQuota } from './call-observability-payload.store';
import {
  canonicalJson, contentHash, expiresAfter, ObservabilityStorageError,
  publicSequence, sequenceKey, SerialStorageLane, ZERO_SEQUENCE,
} from './call-observability-storage';
import { calculateObservabilityMetrics, MAX_METRIC_OBSERVATIONS } from './call-observability-metrics';
import { ObservabilityApiError } from './call-observability-api.contract';

import { CallObservabilityPayloadCoordinator, PayloadLease, PAYLOAD_OWNER_ID } from './call-observability-payload.coordinator';

const COUNTER_ID = 'call-observability:commit-sequence';
const lanes = new WeakMap<DataSource, SerialStorageLane>();
type ProjectionWriteStatus = 'apply' | 'duplicate' | 'stale';

interface PreparedBatchKeys { invocationId: string; receiptId: string; payloadIds: string[]; }
interface IngestFactBatch {
  receipts: Map<string, RuntimeIngestReceiptEntity>;
  tombstones: Map<string, RuntimeIngestReceiptTombstoneEntity>;
  invocations: Map<string, RuntimeInvocationEntity>;
  payloads: Map<string, RuntimePayloadEntity>;
  checkpoints: Map<string, RuntimeIngestCheckpointEntity>;
  boundaries: Map<string, RuntimePipelineStateEntity>;
  newReceipts: RuntimeIngestReceiptEntity[];
  newPayloads: Map<string, RuntimePayloadEntity>;
  current: Map<string, RuntimeInvocationEntity>;
  revisions: Map<string, RuntimeInvocationRevisionEntity>;
  closeRevisions: Map<string, { invocationId: string; recordVersion: number; sequence: string }>;
  contributions: Map<string, RuntimeMetricContributionEntity>;
  changedCheckpoints: Map<string, RuntimeIngestCheckpointEntity>;
  changedBoundaries: Map<string, RuntimePipelineStateEntity>;
  events: RuntimeObservabilityEventEntity[];
  eventDays: number;
}

interface ProjectionWriteResult {
  status: ProjectionWriteStatus;
  invocation: RuntimeInvocationEntity | null;
}

interface RecomputeRowProjection {
  bucketStart: string;
  bucketEnd: string;
  scope: 'business' | 'http_ingress' | 'tool' | 'protocol' | 'upstream';
  origin: string;
  timeBasis: 'startedAt' | 'completedAt';
  runtimeAssetId: string | null;
}
interface PendingBucketMarker {
  state: 'pending';
  action: 'recompute';
  suppressEvent?: boolean;
}
interface MetricBucketPendingMarker extends PendingBucketMarker {
  invocationId: string;
  membershipChange?: 'added' | 'removed' | 'updated';
  runtimeAssetId?: string | null;
}
interface CallerBucketPendingMarker extends PendingBucketMarker {
  invocationId: string;
  callerId: string;
  bucketScope: string;
  bucketTimeBasis: 'startedAt' | 'completedAt';
  bucketInterval: string;
  runtimeAssetId: string | null;
  origin: string;
}
interface PersistedBucketDimensions {
  keySchemaVersion: number;
  runtimeAssetId: string | null;
  origin: string;
  scope: 'business' | 'http_ingress' | 'tool' | 'protocol' | 'upstream';
  timeBasis: 'startedAt' | 'completedAt';
  interval: string;
  bucketStart: string;
  bucketEnd: string;
}
interface RecomputeBucketSummary {
  recomputed: number;
  failed: number;
}

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
  suppressBucketEvents?: boolean;
}

export interface ProjectionBatch {
  project: ProjectionHook;
  flush(transaction: ObservabilityWriteTransaction): Promise<void>;
  dispose(): void;
}

export type ProjectionHook = ((
  transaction: ObservabilityWriteTransaction,
  before: RuntimeInvocationEntity | null,
  after: RuntimeInvocationEntity,
) => Promise<void>) & {
  /** Internal bounded collector optimization; default calls retain immediate writes. */
  createBatch?: () => ProjectionBatch;
};

export interface IngestBatchEntry {
  input?: unknown;
  sourceHash?: string;
  context: IngestContext;
  rejection?: { hash: string; reason: string };
}

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
  // Scheduling hints only: pending markers remain the authoritative durable work.
  private bucketRecomputeCursor = { metric: '', caller: '', preferCaller: false };
  private readonly bucketRecomputeBackoff = new Map<string, number>();
  readonly payloadCoordination: CallObservabilityPayloadCoordinator;
  private payloadStorage?: Promise<string>;
  private readonly factBatches = new WeakMap<ObservabilityWriteTransaction, IngestFactBatch>();
  private readonly batchBuckets = new WeakMap<ObservabilityWriteTransaction, {
    metrics: Map<string, RuntimeMetricBucketEntity>; callers: Map<string, RuntimeCallerBucketEntity>;
  }>();

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
    return (await this.ingestBatch([{ input, context }], project))[0];
  }

  /** Bounded atomic source batch. Files are prepared outside the database transaction;
   * all receipts, facts, projections, events and checkpoints commit together. */
  async ingestBatch(entries: IngestBatchEntry[], project?: ProjectionHook,
    options: { coalesceBuckets?: boolean;
      /** Internal collector opt-in: hook uses before/after and only caller/source tables.
       * Core facts become queryable after the batch flush, in this same transaction. */
      batchFacts?: boolean } = {}): Promise<IngestResult[]> {
    if (entries.length < 1 || entries.length > 16) throw new ObservabilityStorageError('INVALID_INGEST_BATCH');
    for (const entry of entries) {
      this.validateCheckpoint(entry.context.checkpoint);
      if (entry.rejection && (!/^[a-f0-9]{64}$/.test(entry.rejection.hash) ||
        !/^[A-Z][A-Z0-9_]{0,79}$/.test(entry.rejection.reason))) {
        throw new ObservabilityStorageError('INVALID_QUARANTINE_REFERENCE');
      }
    }
    return this.ingestion.run(async () => {
      await this.ensurePayloadStorage();
      return this.payloadCoordination.withPreparedWriter(async tx => {
          // Acquire the writer lease and its bounded retention view under one
          // commit-counter lock. Body I/O starts only after this transaction ends.
          const policy = await readEventRetentionPolicy(tx.manager);
          const ids = entries.map(entry => (entry.input as any)?.invocationId)
            .filter((id): id is string => typeof id === 'string' && id.length <= 240);
          const previous = ids.length ? await tx.manager.getRepository(RuntimeInvocationEntity)
            .findBy({ invocationId: In(ids) }) : [];
          const payloadIds = previous.flatMap(row => [row.requestPayloadId, row.responsePayloadId]).filter(Boolean) as string[];
          const payloads = payloadIds.length ? await tx.manager.getRepository(RuntimePayloadEntity)
            .findBy({ id: In(payloadIds) }) : [];
          const expiry = new Map(payloads.map(row => [row.id, row.expiresAt]));
          return { days: policy.payloadDays, previous: new Map(previous.map(row => [row.invocationId, {
            request: row.requestPayloadId ? expiry.get(row.requestPayloadId) : undefined,
            response: row.responsePayloadId ? expiry.get(row.responsePayloadId) : undefined,
          }])) };
        }, async session => {
        const { lease, prepared: retention } = session;
        const projectionBatch = options.batchFacts ? project?.createBatch?.() : undefined;
        const activeProject = projectionBatch?.project || project;
        try {
          const preparedKeys: PreparedBatchKeys[] = [];
          const operations: Array<(tx: ObservabilityWriteTransaction) => Promise<IngestResult>> = [];
          for (const entry of entries) {
            if (entry.rejection) {
              const rejected = entry.rejection;
              operations.push(tx => this.quarantine(tx, entry.context, rejected.hash, rejected.reason));
            } else {
              try { operations.push(await this.prepareIngest(entry.input, entry.context, lease, retention, activeProject, preparedKeys)); }
              catch (error) {
                const invalid = error instanceof InvalidRuntimeAuditRecord ||
                  error instanceof ObservabilityStorageError && [
                    'INVALID_RECORD_VERSION', 'INVALID_ASSET_REFERENCE',
                    'INVALID_RECORD_DEPTH', 'INVALID_RECORD_VALUE',
                  ].includes(error.code);
                if (!invalid || !entry.sourceHash || !/^[a-f0-9]{64}$/.test(entry.sourceHash)) throw error;
                operations.push(tx => this.quarantine(tx, entry.context, entry.sourceHash!, 'INVALID_SOURCE_SCHEMA'));
              }
            }
          }
          return await session.commit(async tx => {
            await this.payloadCoordination.assertWriter(tx, lease);
            const facts = options.batchFacts ? await this.prepareFactBatch(tx, preparedKeys, entries) : undefined;
            if (facts) this.factBatches.set(tx, facts);
            // Collector hooks do not read pending bucket markers. Other callers retain
            // immediate read-your-writes unless they explicitly opt in to coalescing.
            const buckets = options.coalesceBuckets ? {
              metrics: new Map<string, RuntimeMetricBucketEntity>(), callers: new Map<string, RuntimeCallerBucketEntity>(),
            } : undefined;
            if (buckets) this.batchBuckets.set(tx, buckets);
            const results: IngestResult[] = [];
            for (const operation of operations) {
              const eventOffset = tx.events.length;
              const result = await operation(tx);
              results.push({ ...result, events: tx.events.slice(eventOffset) });
            }
            if (projectionBatch) await projectionBatch.flush(tx);
            if (facts) await this.flushFactBatch(tx, facts);
            if (buckets) {
              if (facts) {
                await this.upsertFactRows(tx, RuntimeMetricBucketEntity, [...buckets.metrics.values()], 'id');
                await this.upsertFactRows(tx, RuntimeCallerBucketEntity, [...buckets.callers.values()], 'id');
              } else {
                if (buckets.metrics.size) await tx.manager.getRepository(RuntimeMetricBucketEntity).save([...buckets.metrics.values()]);
                if (buckets.callers.size) await tx.manager.getRepository(RuntimeCallerBucketEntity).save([...buckets.callers.values()]);
              }
              this.batchBuckets.delete(tx);
            }
            this.factBatches.delete(tx);
            return results;
          });
        } finally { projectionBatch?.dispose(); }
      });
    });
  }

  private async prepareFactBatch(tx: ObservabilityWriteTransaction, keys: PreparedBatchKeys[],
    entries: IngestBatchEntry[]): Promise<IngestFactBatch> {
    const receiptIds = [...new Set(keys.map(key => key.receiptId))];
    const invocationIds = [...new Set(keys.map(key => key.invocationId))];
    const checkpointIds = [...new Set(entries.flatMap(entry => entry.context.checkpoint ? [entry.context.checkpoint.id] : []))];
    const receipts = receiptIds.length ? await tx.manager.getRepository(RuntimeIngestReceiptEntity).findBy({ id: In(receiptIds) }) : [];
    const tombstones = receiptIds.length ? await tx.manager.getRepository(RuntimeIngestReceiptTombstoneEntity).findBy({ id: In(receiptIds) }) : [];
    const query = tx.manager.getRepository(RuntimeInvocationEntity).createQueryBuilder('invocation')
      .where('invocation.invocationId IN (:...ids)', { ids: invocationIds });
    if (this.dataSource.options.type === 'postgres') query.setLock('pessimistic_write');
    const invocations = invocationIds.length ? await query.getMany() : [];
    const payloadIds = [...new Set([...invocations.flatMap(row => [row.requestPayloadId, row.responsePayloadId]),
      ...keys.flatMap(key => key.payloadIds)].filter(Boolean))] as string[];
    const payloads = payloadIds.length ? await tx.manager.getRepository(RuntimePayloadEntity).findBy({ id: In(payloadIds) }) : [];
    const checkpoints = checkpointIds.length ? await tx.manager.getRepository(RuntimeIngestCheckpointEntity).findBy({ id: In(checkpointIds) }) : [];
    const boundaries = checkpointIds.length ? await tx.manager.getRepository(RuntimePipelineStateEntity)
      .findBy({ id: In(checkpointIds.map(id => 'call-observability:boundary:' + id)) }) : [];
    return {
      receipts: new Map(receipts.map(row => [row.id, row])), tombstones: new Map(tombstones.map(row => [row.id, row])),
      invocations: new Map(invocations.map(row => [row.invocationId, row])), payloads: new Map(payloads.map(row => [row.id, row])),
      checkpoints: new Map(checkpoints.map(row => [row.id, row])), boundaries: new Map(boundaries.map(row => [row.id, row])),
      newReceipts: [], newPayloads: new Map(), current: new Map(), revisions: new Map(), closeRevisions: new Map(),
      contributions: new Map(), changedCheckpoints: new Map(), changedBoundaries: new Map(), events: [],
      eventDays: (await readEventRetentionPolicy(tx.manager)).eventDays,
    };
  }

  private async upsertFactRows(tx: ObservabilityWriteTransaction, entity: any, rows: any[], key: string): Promise<void> {
    for (let offset = 0; offset < rows.length; offset += 16) {
      await tx.manager.getRepository(entity).upsert(rows.slice(offset, offset + 16), [key]);
    }
  }

  private async flushFactBatch(tx: ObservabilityWriteTransaction, batch: IngestFactBatch): Promise<void> {
    // At most 16 source records, 32 payloads and 32 events. Flush SQL in chunks of 16
    // to stay below SQLite parameter limits even for wide invocation revisions.
    const insert = async (entity: any, rows: any[], ignore = false) => {
      for (let offset = 0; offset < rows.length; offset += 16) {
        const query = tx.manager.getRepository(entity).createQueryBuilder().insert().values(rows.slice(offset, offset + 16));
        if (ignore) query.orIgnore();
        await query.execute();
      }
    };
    const upsert = (entity: any, rows: any[], key: string) => this.upsertFactRows(tx, entity, rows, key);
    await insert(RuntimeIngestReceiptEntity, batch.newReceipts);
    await insert(RuntimePayloadEntity, [...batch.newPayloads.values()], true);
    // Only the pre-batch revision needs a database update; intermediate versions are
    // retained individually with their exact closing sequence in the pending map.
    for (const previous of batch.closeRevisions.values()) {
      await tx.manager.getRepository(RuntimeInvocationRevisionEntity).update({
        invocationId: previous.invocationId, recordVersion: previous.recordVersion,
      }, { validUntilSequence: previous.sequence });
    }
    await upsert(RuntimeInvocationEntity, [...batch.current.values()], 'invocationId');
    await insert(RuntimeInvocationRevisionEntity, [...batch.revisions.values()]);
    await upsert(RuntimeMetricContributionEntity, [...batch.contributions.values()], 'invocationId');
    await insert(RuntimeObservabilityEventEntity, batch.events);
    await upsert(RuntimePipelineStateEntity, [...batch.changedBoundaries.values()], 'id');
    // Checkpoints are the final fact writes; every preceding write and the counter
    // remain inside the original transaction, including failures in bucket flush.
    await upsert(RuntimeIngestCheckpointEntity, [...batch.changedCheckpoints.values()], 'id');
  }

  private async prepareIngest(input: unknown, context: IngestContext, lease: PayloadLease,
    retention: { days: number; previous: Map<string, { request?: string; response?: string }> },
    project?: ProjectionHook, preparedKeys?: PreparedBatchKeys[]): Promise<(tx: ObservabilityWriteTransaction) => Promise<IngestResult>> {
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
        const now = new Date().toISOString();
        const retainFrom = record.completedAt || record.startedAt;
        // Snapshot the active policy before filesystem I/O. Existing invocation sides keep
        // their original deadline, including expired tombstones, across source revisions.
        const previousExpiry = retention.previous.get(record.invocationId);
        const defaultExpiry = expiresAfter(retainFrom, retention.days);
        const bodyExpiry = { request: previousExpiry?.request ?? defaultExpiry,
          response: previousExpiry?.response ?? defaultExpiry };
        const enabled = process.env.API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_ENABLED;
        const quota: PayloadPublicationQuota | undefined = enabled === undefined || enabled === 'false' ? undefined : {
          reserve: async (payloadId, fileKey, digest, storedBytes) => {
            if (enabled !== 'true') throw new ObservabilityStorageError('QUOTA_UNAVAILABLE');
            const primitives = new PayloadQuotaPrimitives();
            const intent = new PayloadPublicationIntentStore();
            const physical = payloadPhysicalGuardEnabled()
              ? { observation: await this.payloadStore.measureFreeSpace() } : null;
            const reservation = await this.transaction(async tx => {
              await this.payloadCoordination.assertWriter(tx, lease);
              const status = await primitives.status({ manager: tx.manager, now: tx.now, snapshotSeq: publicSequence(tx.currentSequence()) });
              if (!status || !status.configuration.enabled) throw new ObservabilityStorageError('QUOTA_NOT_READY');
              if (storedBytes * 2 > status.configuration.maxBodyBytes * 2) throw new ObservabilityStorageError('QUOTA_BODY_LIMIT');
              let result: Awaited<ReturnType<PayloadPublicationIntentStore['reserve']>>;
              try {
                result = await intent.reserve(tx, status.epoch, {
                  sourceInstanceId: record.sourceInstanceId, sourceEventId: record.sourceEventId,
                  payloadId, generation: lease.generation, fileKey, digest, storedBytes,
                }, physical);
              } catch (error) {
                if (status.state === 'limited' && error instanceof ObservabilityStorageError && error.code === 'QUOTA_NOT_READY') {
                  throw new ObservabilityStorageError('QUOTA_EXHAUSTED');
                }
                throw error;
              }
              if (result.replayed && result.reservationState === 'uncertain') {
                throw new ObservabilityStorageError('QUOTA_PUBLICATION_PENDING');
              }
              return { epoch: status.epoch, operationId: result.operationId,
                temporaryKey: result.temporaryKey, replayed: result.replayed,
                mode: result.reservationState === 'settled' ? 'verify_existing' as const : 'publish' as const };
            });
            return { mode: reservation.mode, temporaryKey: reservation.temporaryKey,
              replayed: reservation.replayed, settle: async outcome => {
                await this.transaction(async tx => {
                  await this.payloadCoordination.assertWriter(tx, lease);
                  await primitives.settle(tx, reservation.epoch, reservation.operationId, outcome);
                });
              } };
          },
        };
        const request = await this.payloadStore.prepare({
          sourceInstanceId: record.sourceInstanceId, invocationId: record.invocationId, side: 'request',
        }, record.request, now, bodyExpiry.request, lease.generation, quota);
        const response = await this.payloadStore.prepare({
          sourceInstanceId: record.sourceInstanceId, invocationId: record.invocationId, side: 'response',
        }, record.response, now, bodyExpiry.response, lease.generation, quota);
        const receiptId = contentHash(canonicalJson([record.sourceInstanceId, record.sourceEventId]));
        preparedKeys?.push({ invocationId: record.invocationId, receiptId, payloadIds: [request.entity.id, response.entity.id] });
        return async tx => {
          const batch = this.factBatches.get(tx);
          await this.payloadCoordination.assertWriter(tx, lease);
          const receipts = tx.manager.getRepository(RuntimeIngestReceiptEntity);
          const previousReceipt = batch ? batch.receipts.get(receiptId) : await receipts.findOne({ where: { id: receiptId } });
          if (previousReceipt && previousReceipt.recordHash !== recordHash) {
            return this.quarantine(tx, context, recordHash, 'SOURCE_EVENT_CONFLICT', record);
          }
          const repository = tx.manager.getRepository(RuntimeInvocationEntity);
          const previous = batch ? batch.invocations.get(record.invocationId) || null :
            await repository.findOne({ where: { invocationId: record.invocationId } });
          if (previousReceipt) {
            await this.checkpoint(tx, context.checkpoint, source.sourceSequence, source.sourceInstanceId);
            return this.result(tx, 'duplicate', previous);
          }
          // The receipt remains authoritative while present; the tombstone only gates
          // replay after the physical receipt is removed. Matching identity + hash is a
          // duplicate with no sequence, event or invocation mutation; a different hash
          // keeps the original conflict isolation.
          const previousTombstone = batch ? batch.tombstones.get(receiptId) : await tx.manager
            .getRepository(RuntimeIngestReceiptTombstoneEntity).findOne({ where: { id: receiptId } });
          if (previousTombstone) {
            if (previousTombstone.recordHash !== recordHash) {
              return this.quarantine(tx, context, recordHash, 'SOURCE_EVENT_CONFLICT', record);
            }
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

          const receipt = receipts.create({
            id: receiptId, sourceInstanceId: record.sourceInstanceId, eventId: record.sourceEventId,
            recordHash, invocationId: record.invocationId, createdAt: tx.now, expiresAt: expiresAfter(tx.now, 32),
          });
          if (batch) { batch.receipts.set(receiptId, receipt); batch.newReceipts.push(receipt); }
          else await receipts.insert(receipt);
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
          // Another process may have committed a source revision after the pre-I/O
          // snapshot. Recheck the current references under the write transaction.
          if (previous) {
            const payloads = tx.manager.getRepository(RuntimePayloadEntity);
            for (const [prepared, payloadId] of [[request, previous.requestPayloadId], [response, previous.responsePayloadId]] as const) {
              if (!payloadId) continue;
              const existing = batch ? batch.payloads.get(payloadId) : await payloads.findOneBy({ id: payloadId });
              if (existing) prepared.entity.expiresAt = existing.expiresAt;
            }
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
          tx.suppressBucketEvents = context.suppressEvent === true;
          const projection = await this.saveProjection(tx, previous, current);
          if (projection.status !== 'apply') {
            await this.checkpoint(tx, context.checkpoint, source.sourceSequence, source.sourceInstanceId);
            return this.result(tx, projection.status === 'duplicate' ? 'duplicate' : 'stale',
              projection.invocation || previous);
          }
          await this.inFlightMembershipEvent(tx, previous, current, context.suppressEvent);
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

        };
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
      tx.suppressBucketEvents = evidence.suppressEvent === true;
      const projection = await this.saveProjection(tx, previous, current);
      if (projection.status !== 'apply') return this.result(tx, 'stale', projection.invocation || previous);
      await this.inFlightMembershipEvent(tx, previous, current, evidence.suppressEvent);
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
    const batch = this.factBatches.get(tx);
    if (batch) {
      if (!batch.payloads.has(payload.entity.id)) {
        batch.payloads.set(payload.entity.id, payload.entity);
        batch.newPayloads.set(payload.entity.id, payload.entity);
      }
      return;
    }
    await tx.manager.getRepository(RuntimePayloadEntity).createQueryBuilder()
      .insert().values(payload.entity).orIgnore().execute();
  }

  private async saveProjection(tx: ObservabilityWriteTransaction,
    previous: RuntimeInvocationEntity | null, current: RuntimeInvocationEntity): Promise<ProjectionWriteResult> {
    const invocations = tx.manager.getRepository(RuntimeInvocationEntity);
    const revisions = tx.manager.getRepository(RuntimeInvocationRevisionEntity);
    const selector = invocations.createQueryBuilder('invocation')
      .where('invocation.invocationId = :invocationId', { invocationId: current.invocationId });
    if (this.dataSource.options.type === 'postgres') selector.setLock('pessimistic_write');
    const batch = this.factBatches.get(tx);
    const latest = batch ? batch.invocations.get(current.invocationId) || null : await selector.getOne();
    if (latest && latest.invocationId !== current.invocationId) return { status: 'stale', invocation: null };
    if (!latest) {
      if (previous) return { status: 'stale', invocation: null };
    } else if (previous) {
      if (latest.recordVersion !== previous.recordVersion) {
        return {
          status: latest.recordHash === current.recordHash && latest.recordVersion === current.recordVersion ? 'duplicate' : 'stale',
          invocation: latest,
        };
      }
      if (current.recordVersion !== latest.recordVersion + 1) {
        return {
          status: current.recordVersion === latest.recordVersion && current.recordHash === latest.recordHash ? 'duplicate' : 'stale',
          invocation: latest,
        };
      }
    } else if (current.recordVersion === latest.recordVersion) {
      return { status: current.recordHash === latest.recordHash ? 'duplicate' : 'stale', invocation: latest };
    } else if (current.recordVersion !== latest.recordVersion + 1) {
      return { status: 'stale', invocation: latest };
    }
    const plan = planBucketRevision(
      latest ? this.toBucketRevision(latest) : null,
      this.toBucketRevision(current),
    );
    if (plan.status !== 'apply') return { status: plan.status === 'duplicate' ? 'duplicate' : 'stale', invocation: latest };
    const revision = Object.assign(new RuntimeInvocationRevisionEntity(), current, {
      id: contentHash(canonicalJson([current.invocationId, current.recordVersion])),
      validFromSequence: current.updatedSequence, validUntilSequence: null,
    });
    if (batch) {
      if (latest) {
        const id = contentHash(canonicalJson([latest.invocationId, latest.recordVersion]));
        const pending = batch.revisions.get(id);
        if (pending) pending.validUntilSequence = current.updatedSequence;
        else batch.closeRevisions.set(id, { invocationId: latest.invocationId,
          recordVersion: latest.recordVersion, sequence: current.updatedSequence });
      }
      batch.invocations.set(current.invocationId, current);
      batch.current.set(current.invocationId, current);
      batch.revisions.set(revision.id, revision);
    } else {
      if (latest) await revisions.update({ invocationId: latest.invocationId, recordVersion: latest.recordVersion }, {
        validUntilSequence: current.updatedSequence,
      });
      await invocations.save(current);
      await revisions.insert(revision);
    }
    await this.persistProjectionContribution(tx, current, plan);
    await this.markBucketsForRecompute(tx, current, plan);
    return { status: 'apply', invocation: current };
  }

  private toBucketRevision(invocation: RuntimeInvocationEntity): {
    recordVersion: number;
    record: {
      invocationId: string;
      runtimeAssetId: string | null;
      origin: string;
      spanKind: string;
      transport: string | null;
      startedAt: string;
      completedAt: string | null;
    };
  } {
    const record = invocation.record as CanonicalInvocation;
    return {
      recordVersion: invocation.recordVersion,
      record: {
        invocationId: invocation.invocationId, runtimeAssetId: record.runtimeAssetId || null,
        origin: record.origin, spanKind: record.spanKind, transport: record.transport || null,
        startedAt: record.startedAt, completedAt: record.completedAt || null,
      },
    };
  }

  private async persistProjectionContribution(tx: ObservabilityWriteTransaction,
    current: RuntimeInvocationEntity, plan: BucketRevisionPlan): Promise<void> {
    const repository = tx.manager.getRepository(RuntimeMetricContributionEntity);
    const contribution = Object.assign(new RuntimeMetricContributionEntity(), {
      invocationId: current.invocationId,
      recordVersion: current.recordVersion,
      contribution: plan,
      updatedAt: tx.now,
    });
    const batch = this.factBatches.get(tx);
    if (batch) batch.contributions.set(current.invocationId, contribution);
    else await repository.save(contribution);
  }

  private async markBucketsForRecompute(tx: ObservabilityWriteTransaction,
    current: RuntimeInvocationEntity, plan: BucketRevisionPlan): Promise<void> {
    const marker = current.record as CanonicalInvocation;
    const expiresAt = current.expiresAt;
    const metricBuckets = tx.manager.getRepository(RuntimeMetricBucketEntity);
    const batch = this.batchBuckets.get(tx);
    const metricIds = plan.invalidations.map(({ bucket }) => bucket.bucketId).filter(id => !batch?.metrics.has(id));
    const previousMetrics = new Map([
      ...(metricIds.length ? await metricBuckets.findBy({ id: In(metricIds) }) : []).map(row => [row.id, row] as const),
      ...(batch?.metrics.entries() || []),
    ]);
    const metricRows = plan.invalidations.map(({ bucket, membershipChange, action }) => metricBuckets.create({
      id: bucket.bucketId, scope: bucket.scope, bucketStart: bucket.bucketStart, bucketEnd: bucket.bucketEnd,
      dimensions: {
        keySchemaVersion: bucket.keySchemaVersion, runtimeAssetId: bucket.runtimeAssetId,
        origin: bucket.origin, scope: bucket.scope, timeBasis: bucket.timeBasis, interval: bucket.interval,
      },
      metrics: {
        recompute: {
          state: 'pending', action, membershipChange, incomingRecordVersion: plan.incomingRecordVersion,
          suppressEvent: tx.suppressBucketEvents === true &&
            (previousMetrics.get(bucket.bucketId)?.metrics?.recompute?.suppressEvent ?? true),
          expectedRecordVersion: plan.expectedRecordVersion, queuedAt: tx.now, invocationId: current.invocationId,
          callerId: marker.callerId || null, runtimeAssetId: marker.runtimeAssetId || null,
        },
      },
      version: previousMetrics.get(bucket.bucketId)?.version ?? 0,
      dataWatermark: current.updatedSequence,
      expiresAt,
    }));
    if (batch) for (const row of metricRows) batch.metrics.set(row.id, row);
    else if (metricRows.length) await metricBuckets.save(metricRows);
    if (!current.record?.callerId) return;
    const callerBuckets = tx.manager.getRepository(RuntimeCallerBucketEntity);
    const callerKey = (bucket: BucketRevisionPlan['invalidations'][number]['bucket']) =>
      contentHash(canonicalJson([current.record.callerId, bucket.bucketId, bucket.scope, bucket.timeBasis, bucket.interval]));
    const callerIds = plan.invalidations.map(({ bucket }) => callerKey(bucket)).filter(id => !batch?.callers.has(id));
    const previousCallers = new Map([
      ...(callerIds.length ? await callerBuckets.findBy({ id: In(callerIds) }) : []).map(row => [row.id, row] as const),
      ...(batch?.callers.entries() || []),
    ]);
    const callerRows = plan.invalidations.map(({ bucket, membershipChange, action }) => callerBuckets.create({
      id: contentHash(canonicalJson([
        current.record.callerId, bucket.bucketId, bucket.scope, bucket.timeBasis, bucket.interval,
      ])),
      callerId: current.record.callerId, runtimeAssetId: marker.runtimeAssetId || null, bucketStart: bucket.bucketStart,
      metrics: {
        recompute: {
          state: 'pending', action, membershipChange, incomingRecordVersion: plan.incomingRecordVersion,
          expectedRecordVersion: plan.expectedRecordVersion, queuedAt: tx.now, invocationId: current.invocationId,
          suppressEvent: tx.suppressBucketEvents === true &&
            (previousCallers.get(callerKey(bucket))?.metrics?.recompute?.suppressEvent ?? true),
          bucketScope: bucket.scope, bucketInterval: bucket.interval, bucketTimeBasis: bucket.timeBasis,
          runtimeAssetId: marker.runtimeAssetId || null, origin: current.record.origin,
        },
      },
      version: previousCallers.get(callerKey(bucket))?.version ?? 0,
      expiresAt,
    }));
    if (batch) for (const row of callerRows) batch.callers.set(row.id, row);
    else if (callerRows.length) await callerBuckets.save(callerRows);
  }

  /** Repair committed pending markers; production passes an explicit fair budget. */
  async recomputePendingBuckets(limit?: number): Promise<RecomputeBucketSummary> {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 128)) {
      throw new ObservabilityStorageError('INVALID_RECOMPUTE_LIMIT');
    }
    return this.transaction(async tx => this.recomputePendingBucketsInTransaction(tx, limit));
  }

  private async recomputePendingBucketsInTransaction(tx: ObservabilityWriteTransaction,
    limit?: number): Promise<RecomputeBucketSummary> {
    const metricBuckets = tx.manager.getRepository(RuntimeMetricBucketEntity);
    const callerBuckets = tx.manager.getRepository(RuntimeCallerBucketEntity);
    const snapshot = tx.currentSequence();
    const now = Date.now();
    for (const [key, until] of this.bucketRecomputeBackoff) if (until <= now) this.bucketRecomputeBackoff.delete(key);
    const select = async <T extends { id: string }>(repository: any, kind: 'metric' | 'caller'): Promise<T[]> => {
      const query = () => repository.createQueryBuilder('bucket').where(
        this.jsonText(tx.manager, 'bucket', 'metrics', 'recompute.state') + ' = :state', { state: 'pending' });
      if (limit === undefined) return query().getMany();
      const deferred = [...this.bucketRecomputeBackoff.keys()].filter(key => key.startsWith(kind + ':'))
        .map(key => key.slice(kind.length + 1));
      const bounded = () => {
        const result = query().orderBy('bucket.id', 'ASC');
        if (deferred.length) result.andWhere('bucket.id NOT IN (:...deferred)', { deferred });
        return result;
      };
      const cursor = this.bucketRecomputeCursor[kind];
      const first: T[] = await bounded().andWhere('bucket.id > :cursor', { cursor }).take(limit).getMany();
      if (cursor && first.length < limit) {
        first.push(...await bounded().andWhere('bucket.id <= :cursor', { cursor }).take(limit - first.length).getMany());
      }
      return first;
    };
    let pendingMetric = await select<RuntimeMetricBucketEntity>(metricBuckets, 'metric');
    let pendingCaller = await select<RuntimeCallerBucketEntity>(callerBuckets, 'caller');
    if (limit !== undefined) {
      // Fetch at most twice the work budget, then share it fairly between tables.
      // Odd slots alternate; unused slots transfer to the other table.
      const metricShare = this.bucketRecomputeCursor.preferCaller ? Math.floor(limit / 2) : Math.ceil(limit / 2);
      const callerCount = Math.min(pendingCaller.length, limit - Math.min(pendingMetric.length, metricShare));
      const metricCount = Math.min(pendingMetric.length, limit - callerCount);
      pendingMetric = pendingMetric.slice(0, metricCount);
      pendingCaller = pendingCaller.slice(0, callerCount);
      if (pendingMetric.length) this.bucketRecomputeCursor.metric = pendingMetric[pendingMetric.length - 1].id;
      if (pendingCaller.length) this.bucketRecomputeCursor.caller = pendingCaller[pendingCaller.length - 1].id;
      this.bucketRecomputeCursor.preferCaller = !this.bucketRecomputeCursor.preferCaller;
    }
    const deferFailure = (kind: string, id: string) => {
      if (limit === undefined) return;
      const key = kind + ':' + id;
      if (!this.bucketRecomputeBackoff.has(key) && this.bucketRecomputeBackoff.size >= 128) {
        this.bucketRecomputeBackoff.delete(this.bucketRecomputeBackoff.keys().next().value!);
      }
      this.bucketRecomputeBackoff.set(key, Date.now() + 1000);
    };
    const summary: RecomputeBucketSummary = { recomputed: 0, failed: 0 };
    let watermark: string | null = null;
    const ensureWatermark = () => {
      if (watermark === null) watermark = tx.nextSequence();
      return watermark;
    };
    for (const row of pendingMetric) {
      const suppressEvent = row.metrics?.recompute?.suppressEvent === true;
      try {
        const projection = this.parseMetricBucketRecompute(row);
        if (!projection) throw new Error('INVALID_BUCKET_PROJECTION');
        const rows = await this.loadBucketInvocations(tx, projection, tx.now, snapshot);
        const sourceRows = await this.loadSources(tx, rows);
        const observations = rows.map(revision => {
          const source = revision.sourceId ? sourceRows.get(revision.sourceId) : undefined;
          return { revision: revision.recordVersion, invocation: revision.record as CanonicalInvocation,
            sourceId: revision.sourceId || null, sourceOverflow: source?.ipSource === 'overflow' };
        });
        const result = calculateObservabilityMetrics(observations, {
          from: projection.bucketStart, to: projection.bucketEnd,
          scope: projection.scope, origin: projection.origin, timeBasis: projection.timeBasis,
        });
        row.metrics = { metrics: result.metrics, coverage: result.coverage };
        row.version = this.nextSubjectVersion(row.version);
        row.dataWatermark = ensureWatermark();
      } catch {
        summary.failed += 1;
        deferFailure('metric', row.id);
        await this.diagnostic(tx, 'recomputeBucketFailures', 1);
        continue;
      }
      await metricBuckets.save(row);
      await this.projectionEvent(tx, 'metrics.bucket_updated', row.id, row.version,
        { bucketKind: 'metric', bucketId: row.id, bucketVersion: row.version,
          bucketStart: row.bucketStart, bucketEnd: row.bucketEnd,
          dataWatermark: publicSequence(row.dataWatermark), ...row.metrics }, row.dimensions, suppressEvent);
      summary.recomputed += 1;
    }
    for (const row of pendingCaller) {
      const marker = row.metrics?.recompute;
      const suppressEvent = marker?.suppressEvent === true;
      try {
        const projection = this.parseCallerBucketRecompute(row);
        if (!projection) throw new Error('INVALID_BUCKET_PROJECTION');
        const rows = await this.loadBucketInvocations(tx, projection, tx.now, snapshot, row.callerId);
        const sourceRows = await this.loadSources(tx, rows);
        const observations = rows.map(revision => {
          const source = revision.sourceId ? sourceRows.get(revision.sourceId) : undefined;
          return { revision: revision.recordVersion, invocation: revision.record as CanonicalInvocation,
            sourceId: revision.sourceId || null, sourceOverflow: source?.ipSource === 'overflow' };
        });
        const result = calculateObservabilityMetrics(observations, {
          from: projection.bucketStart, to: projection.bucketEnd,
          scope: projection.scope, origin: projection.origin, timeBasis: projection.timeBasis,
        });
        row.metrics = { metrics: result.metrics, coverage: result.coverage };
        row.version = this.nextSubjectVersion(row.version);
      } catch {
        summary.failed += 1;
        deferFailure('caller', row.id);
        await this.diagnostic(tx, 'recomputeBucketFailures', 1);
        continue;
      }
      await callerBuckets.save(row);
      await this.projectionEvent(tx, 'metrics.bucket_updated', row.id, row.version,
        { bucketKind: 'caller', bucketId: row.id, bucketVersion: row.version,
          bucketStart: row.bucketStart, dataWatermark: publicSequence(ensureWatermark()), ...row.metrics },
        { runtimeAssetId: row.runtimeAssetId, callerId: row.callerId, origin: marker.origin,
          scope: marker.bucketScope, timeBasis: marker.bucketTimeBasis, interval: marker.bucketInterval }, suppressEvent);
      summary.recomputed += 1;
    }
    return summary;
  }

  private async loadBucketInvocations(tx: ObservabilityWriteTransaction, projection: RecomputeRowProjection,
    now: string, snapshot: string, callerId?: string): Promise<RuntimeInvocationRevisionEntity[]> {
    const bucketRows = tx.manager.getRepository(RuntimeInvocationRevisionEntity);
    const basis = projection.timeBasis === 'completedAt' ? 'completedAt' : 'startedAt';
    const query = bucketRows.createQueryBuilder('revision')
      .where('revision.validFromSequence <= :snapshot', { snapshot })
      .andWhere('(revision.validUntilSequence IS NULL OR revision.validUntilSequence > :snapshot)', { snapshot })
      .andWhere('revision.expiresAt > :now', { now })
      .andWhere('revision.origin = :origin', { origin: projection.origin })
      .andWhere('revision.' + basis + ' >= :from AND revision.' + basis + ' < :to',
        { from: projection.bucketStart, to: projection.bucketEnd });
    if (projection.scope === 'business') {
      query.andWhere('revision.spanKind IN (:...scopes)', { scopes: ['gateway_request', 'mcp_tool'] });
    } else if (projection.scope === 'http_ingress') {
      query.andWhere('(revision.spanKind = :gateway OR (revision.spanKind = :protocol AND ' +
        this.jsonText(tx.manager, 'revision', 'record', 'transport') + ' IN (:...httpTransports)))',
        { gateway: 'gateway_request', protocol: 'mcp_protocol',
          httpTransports: ['http', 'sse', 'streamable', 'streamable-http'] });
    } else if (projection.scope === 'tool') {
      query.andWhere('revision.spanKind = :scope', { scope: 'mcp_tool' });
    } else if (projection.scope === 'protocol') {
      query.andWhere('revision.spanKind = :scope', { scope: 'mcp_protocol' });
    } else if (projection.scope === 'upstream') {
      query.andWhere('revision.spanKind = :scope', { scope: 'upstream_api' });
    } else {
      throw new Error('INVALID_BUCKET_SCOPE');
    }
    if (projection.runtimeAssetId === null) query.andWhere('revision.runtimeAssetId IS NULL');
    else query.andWhere('revision.runtimeAssetId = :runtimeAssetId', { runtimeAssetId: projection.runtimeAssetId });
    if (callerId) query.andWhere('revision.callerId = :callerId', { callerId });
    // Fetch one sentinel beyond the kernel limit, never the entire busy bucket.
    // Reject before source expansion and leave the pending marker to the caller's
    // existing failure/backoff path; a truncated sample must not become a metric.
    const rows = await query.take(MAX_METRIC_OBSERVATIONS + 1).getMany();
    if (rows.length > MAX_METRIC_OBSERVATIONS) {
      throw new ObservabilityApiError('QUERY_TOO_LARGE', 'observations');
    }
    return rows;
  }

  private async loadSources(tx: ObservabilityWriteTransaction, rows: RuntimeInvocationRevisionEntity[])
    : Promise<Map<string, RuntimeAccessSourceEntity>> {
    const sourceIds = [...new Set(rows.map(row => row.sourceId).filter((value): value is string => !!value))];
    const sourceRows = new Map<string, RuntimeAccessSourceEntity>();
    if (!sourceIds.length) return sourceRows;
    const sources = await tx.manager.getRepository(RuntimeAccessSourceEntity).findBy({ sourceId: In(sourceIds) });
    for (const source of sources) sourceRows.set(source.sourceId, source);
    return sourceRows;
  }

  private parseCallerBucketRecompute(row: RuntimeCallerBucketEntity): RecomputeRowProjection | null {
    if (!row.callerId) return null;
    const raw = row.metrics?.recompute as CallerBucketPendingMarker | undefined;
    const runtimeAssetId = raw?.runtimeAssetId === undefined ? null : raw.runtimeAssetId;
    if (!raw || raw.state !== 'pending' || raw.action !== 'recompute' || typeof raw.bucketScope !== 'string' ||
      typeof raw.bucketTimeBasis !== 'string' || !this.validateTimeBasis(raw.bucketTimeBasis) ||
      typeof raw.bucketInterval !== 'string' || !this.validateScope(raw.bucketScope) || typeof raw.origin !== 'string' ||
      typeof raw.invocationId !== 'string' || !this.validateOrigin(raw.origin) || !this.validateRuntimeAsset(runtimeAssetId)) return null;
    const bucketStart = row.bucketStart;
    if (!this.validateIsoDate(bucketStart)) return null;
    const width = PERSISTENT_BUCKET_INTERVALS[raw.bucketInterval as keyof typeof PERSISTENT_BUCKET_INTERVALS];
    if (!width) return null;
    return {
      bucketStart,
      bucketEnd: new Date(Date.parse(bucketStart) + width).toISOString(),
      scope: raw.bucketScope, origin: raw.origin, timeBasis: raw.bucketTimeBasis,
      runtimeAssetId,
    };
  }

  private parseMetricBucketRecompute(row: RuntimeMetricBucketEntity): RecomputeRowProjection | null {
    const raw = row.metrics?.recompute as MetricBucketPendingMarker | undefined;
    if (!raw || raw.state !== 'pending' || raw.action !== 'recompute' || !this.validateRuntimeAsset(raw.runtimeAssetId || null)) {
      return null;
    }
    const dimensions = this.parseMetricBucketDimensions(row);
    if (!dimensions) return null;
    return { ...dimensions, runtimeAssetId: raw.runtimeAssetId || dimensions.runtimeAssetId };
  }

  private parseMetricBucketDimensions(row: RuntimeMetricBucketEntity): PersistedBucketDimensions | null {
    const raw = row.dimensions;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const dimensions = {
      keySchemaVersion: raw.keySchemaVersion,
      runtimeAssetId: raw.runtimeAssetId === null ? null : (typeof raw.runtimeAssetId === 'string' ? raw.runtimeAssetId : null),
      origin: raw.origin, scope: raw.scope, timeBasis: raw.timeBasis, interval: raw.interval,
      bucketStart: row.bucketStart, bucketEnd: row.bucketEnd,
    };
    if (!this.validateIsoDate(dimensions.bucketStart) || !this.validateIsoDate(dimensions.bucketEnd)) return null;
    if (Number(dimensions.keySchemaVersion) !== BUCKET_KEY_SCHEMA_VERSION) return null;
    if (!this.validateScope(dimensions.scope) || !this.validateTimeBasis(dimensions.timeBasis) || !this.validateOrigin(dimensions.origin) ||
      typeof dimensions.interval !== 'string') return null;
    if (!PERSISTENT_BUCKET_INTERVALS[dimensions.interval as keyof typeof PERSISTENT_BUCKET_INTERVALS]) return null;
    if (!this.validateRuntimeAsset(dimensions.runtimeAssetId)) return null;
    return dimensions;
  }

  private validateRuntimeAsset(runtimeAssetId: string | null): runtimeAssetId is string | null {
    return runtimeAssetId === null || (typeof runtimeAssetId === 'string' && runtimeAssetId.length <= 36 &&
      !/[\u0000-\u001f\u007f]/.test(runtimeAssetId));
  }

  private validateTimeBasis(value: unknown): value is 'startedAt' | 'completedAt' {
    return value === 'startedAt' || value === 'completedAt';
  }

  private validateScope(value: string): value is RecomputeRowProjection['scope'] {
    return value === 'business' || value === 'http_ingress' || value === 'tool' || value === 'protocol' || value === 'upstream';
  }

  private validateOrigin(value: unknown): value is 'external' | 'test' | 'probe' | 'internal' {
    return value === 'external' || value === 'test' || value === 'probe' || value === 'internal';
  }

  private jsonText(manager: EntityManager, alias: string, key: string, path: string): string {
    const database = manager.connection.options.type;
    const segments = path.split('.');
    if (database === 'postgres') {
      if (segments.length === 1) return `(${alias}.${key} ->> '${segments[0]}')`;
      return `(${alias}.${key} #>> '{${segments.join(',')}}')`;
    }
    if (database === 'sqljs' || database === 'sqlite' || database === 'better-sqlite3') {
      const jsonPath = '$.' + segments.map(part => `"${part.replace(/"/g, '\\"')}"`).join('.');
      return `json_extract(${alias}.${key}, '${jsonPath}')`;
    }
    throw new ObservabilityStorageError('OBSERVABILITY_UNAVAILABLE');
  }

  private validateIsoDate(value: unknown): value is string {
    return typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      Number.isFinite(Date.parse(value));
  }

  private nextSubjectVersion(previous: number): number {
    if (!Number.isInteger(previous) || previous < 0 || previous >= 2147483647) {
      throw new ObservabilityStorageError('SUBJECT_VERSION_EXHAUSTED');
    }
    return previous + 1;
  }

  /** Durable outbox only; callers must not publish until this transaction commits. */
  async projectionEvent(tx: ObservabilityWriteTransaction,
    eventType: 'metrics.bucket_updated' | 'pipeline.state_changed' | 'server.state_changed', subjectId: string,
    subjectVersion: number, details: Record<string, unknown>, dimensions: Record<string, unknown>,
    suppressEvent = false): Promise<void> {
    const sequence = tx.nextSequence();
    const event = Object.assign(new RuntimeObservabilityEventEntity(), {
      id: randomUUID(), sequence, schemaVersion: '1.0', eventName: eventType,
      subjectId, subjectVersion, details, dimensions,
      runtimeAssetId: dimensions.runtimeAssetId || undefined,
      eventFamily: eventType === 'server.state_changed' ? RuntimeObservabilityEventFamily.RUNTIME_LIFECYCLE : RuntimeObservabilityEventFamily.RUNTIME_CONTROL,
      severity: details.state === 'degraded' ? RuntimeObservabilitySeverity.WARNING : RuntimeObservabilitySeverity.INFO,
      status: details.state === 'degraded' ? RuntimeObservabilityStatus.DEGRADED : RuntimeObservabilityStatus.SUCCESS,
      actorType: RuntimeObservabilityActorType.SYSTEM,
      occurredAt: new Date(tx.now), createdAt: new Date(tx.now),
      retentionClass: RuntimeObservabilityRetentionClass.STANDARD,
      dispatchState: suppressEvent ? 'suppressed' : 'pending', expiresAt: new Date(expiresAfter(tx.now, (this.factBatches.get(tx)?.eventDays ?? (await readEventRetentionPolicy(tx.manager)).eventDays))),
    });
    const batch = this.factBatches.get(tx);
    if (batch) batch.events.push(event);
    else await tx.manager.getRepository(RuntimeObservabilityEventEntity).insert(event);
    if (!suppressEvent) tx.events.push({ eventId: event.id, sequence: publicSequence(sequence), eventType });
  }

  /** Retained member transition evidence, never a claim of live producer activity or complete coverage. */
  private async inFlightMembershipEvent(tx: ObservabilityWriteTransaction,
    previous: RuntimeInvocationEntity | null, current: RuntimeInvocationEntity, suppressEvent = false): Promise<void> {
    if (!current.runtimeAssetId || !['gateway_request', 'mcp_tool'].includes(current.spanKind)) return;
    const delta = !previous && current.phase === 'started' ? 1 :
      previous?.phase === 'started' && previous.runtimeAssetId === current.runtimeAssetId && current.phase === 'finished' ? -1 : 0;
    if (!delta) return;
    await this.projectionEvent(tx, 'server.state_changed', current.invocationId, current.recordVersion, {
      evidenceScope: 'retained_business_in_flight', delta, invocationId: current.invocationId,
      revisionSequence: publicSequence(current.updatedSequence),
    }, { runtimeAssetId: current.runtimeAssetId, serverType: current.serverType, origin: current.origin }, suppressEvent);
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
      dispatchState: suppressEvent ? 'suppressed' : 'pending', expiresAt: new Date(expiresAfter(tx.now, (this.factBatches.get(tx)?.eventDays ?? (await readEventRetentionPolicy(tx.manager)).eventDays))),
      dimensions: { runtimeAssetId: row.runtimeAssetId, serverType: row.serverType, origin: row.origin,
        spanKind: row.spanKind, callerId: row.callerId, endpointDefinitionId: row.endpointDefinitionId,
        sourceServiceInstanceId: row.sourceServiceInstanceId },
      // Push is metadata-only. Raw bodies, headers, source IPs and paths are excluded.
      details: { invocationId: row.invocationId, recordVersion: current.recordVersion,
        traceId: row.traceId, spanKind: row.spanKind, serverType: row.serverType, origin: row.origin, toolName: row.toolName,
        callerId: row.callerId, runtimeAssetId: row.runtimeAssetId, outcome: row.outcome,
        httpStatus: row.httpStatus, toolIsError: row.toolIsError, errorCategory: row.errorCategory,
        durationMs: row.durationMs, completionSource: row.completionSource,
        byteMeasurement: row.byteMeasurement, measurementStage: row.measurementStage,
        request: { state: row.request.state, observedBytes: row.request.observedBytes },
        response: { state: row.response.state, observedBytes: row.response.observedBytes } },
    });
    const batch = this.factBatches.get(tx);
    if (batch) batch.events.push(event);
    else await tx.manager.getRepository(RuntimeObservabilityEventEntity).insert(event);
    if (!suppressEvent) tx.events.push({ eventId: event.id, sequence: publicSequence(sequence), eventType });
  }

  private async checkpoint(tx: ObservabilityWriteTransaction,
    checkpoint: IngestCheckpoint | undefined, sourceSequence: number | null, sourceInstanceId?: string): Promise<void> {
    if (!checkpoint) return;
    const repository = tx.manager.getRepository(RuntimeIngestCheckpointEntity);
    const batch = this.factBatches.get(tx);
    const previous = batch ? batch.checkpoints.get(checkpoint.id) : await repository.findOne({ where: { id: checkpoint.id } });
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
      const boundary = batch ? batch.boundaries.get(id) : await boundaries.findOneBy({ id });
      const boundSource = boundary?.value?.sourceInstanceId;
      const mixedSources = boundary?.value?.mixedSources === true ||
        !!(boundSource && sourceInstanceId && boundSource !== sourceInstanceId);
      const nextBoundary = boundaries.create({ id,
        value: { hash: checkpoint.boundaryHash, mixedSources,
          sourceInstanceId: mixedSources ? null : sourceInstanceId || boundSource || null }, updatedAt: tx.now,
      });
      if (batch) { batch.boundaries.set(id, nextBoundary); batch.changedBoundaries.set(id, nextBoundary); }
      else await boundaries.save(nextBoundary);
    }
    const nextCheckpoint = Object.assign(new RuntimeIngestCheckpointEntity(), {
      id: checkpoint.id, fileName: checkpoint.fileName, fileIdentity: checkpoint.fileIdentity,
      byteOffset: offset, lastSequence: sourceSequence === null ? previous?.lastSequence || null :
        sequenceKey(BigInt(sourceSequence) > BigInt(previous?.lastSequence || '0')
          ? String(sourceSequence) : previous!.lastSequence!), updatedAt: tx.now, status: 'active', error: null,
    });
    if (batch) { batch.checkpoints.set(checkpoint.id, nextCheckpoint); batch.changedCheckpoints.set(checkpoint.id, nextCheckpoint); }
    else await repository.save(nextCheckpoint);
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
