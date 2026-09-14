import { RuntimeInvocationEntity, RuntimeMetricContributionEntity, RuntimePipelineStateEntity } from '../../database/entities/runtime-call-observability.entity';
import { BucketRevision, planBucketRevision } from './call-observability-bucket-plan';
import { BucketProjectionError, CallObservabilityBucketRecomputeQueue, requireBucketTransaction } from './call-observability-bucket-recompute.queue';
import type { ObservabilityWriteTransaction, ProjectionHook } from './call-observability.store';

const BACKFILL_ID = 'call-observability:bucket-backfill:v1';
export interface PersistentMetricContribution {
  schemaVersion: 1;
  revision: BucketRevision;
  bucketIds: string[];
  observation: { revision: number; invocation: Record<string, any>; sourceId: string | null; sourceOverflow: boolean };
}
function contributionFor(after: RuntimeInvocationEntity, revision: BucketRevision, bucketIds: string[]): PersistentMetricContribution {
  const row = after.record;
  const invocation: Record<string, any> = { ...revision.record };
  for (const field of ['serverType', 'phase', 'outcome', 'completionSource', 'durationMs',
    'identitySource', 'authState', 'callerId', 'upstreamOperationId', 'attemptIndex',
    'byteMeasurement', 'measurementStage', 'cacheHit', 'missingFields', 'endpointDefinitionId', 'sourceServiceInstanceId']) {
    if (row[field] !== undefined) invocation[field] = row[field];
  }
  for (const side of ['request', 'response']) {
    invocation[side] = { state: row[side]?.state ?? 'unavailable',
      observedBytes: row[side]?.observedBytes ?? null, digestScope: row[side]?.digestScope ?? null };
  }
  return { schemaVersion: 1, revision, bucketIds,
    observation: { revision: after.recordVersion, invocation,
      sourceId: after.sourceId ?? row.sourceId ?? null, sourceOverflow: row.sourceOverflow === true } };
}
/** Wire after the caller/source projector in BOTH ingest and reconcile hooks. */
export class CallObservabilityBucketsProjector {
  constructor(private readonly queue = new CallObservabilityBucketRecomputeQueue(),
    private readonly retentionDays = 90) {
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 36500) {
      throw new BucketProjectionError('INVALID_BUCKET_RETENTION');
    }
  }
  readonly project: ProjectionHook = async (tx, _before, after) => { await this.apply(tx, after); };

  /** Input must already be accepted by the store; not an alternate identity-validation API. */
  async apply(tx: ObservabilityWriteTransaction, after: RuntimeInvocationEntity): Promise<'apply' | 'duplicate' | 'stale'> {
    requireBucketTransaction(tx);
    if (!Number.isInteger(after.recordVersion) || after.recordVersion < 1 || after.recordVersion > 2147483647) {
      throw new BucketProjectionError('INVALID_BUCKET_DATABASE_VERSION');
    }
    const incoming: BucketRevision = { recordVersion: after.recordVersion, record: {
      invocationId: after.invocationId, runtimeAssetId: after.runtimeAssetId,
      origin: after.origin, spanKind: after.spanKind, transport: after.record.transport,
      startedAt: after.startedAt, completedAt: after.completedAt,
    } };
    planBucketRevision(null, incoming);
    const repository = tx.manager.getRepository(RuntimeMetricContributionEntity);
    // Concurrent initial insertions arbitrate on the primary key before reading the CAS version.
    await repository.createQueryBuilder().insert().values({
      invocationId: after.invocationId, recordVersion: 0, contribution: {}, updatedAt: tx.now,
    }).orIgnore().execute();
    const current = await repository.findOneByOrFail({ invocationId: after.invocationId });
    if (current.recordVersion > 0 && (current.contribution?.schemaVersion !== 1 ||
      String(current.contribution?.revision?.recordVersion) !== String(current.recordVersion))) {
      throw new BucketProjectionError('BUCKET_CONTRIBUTION_FORMAT_UNSUPPORTED');
    }
    const plan = planBucketRevision(current.recordVersion ? current.contribution.revision : null, incoming);
    if (plan.status !== 'apply') return plan.status;
    const bucketIds = plan.invalidations.filter(item => item.membershipChange !== 'removed').map(item => item.bucket.bucketId);
    const contribution = contributionFor(after, incoming, bucketIds);
    const result = await repository.update({ invocationId: after.invocationId, recordVersion: current.recordVersion }, {
      recordVersion: after.recordVersion, contribution: contribution as any, updatedAt: tx.now,
    });
    if (result.affected !== 1) throw new BucketProjectionError('BUCKET_PROJECTION_CONFLICT');
    for (const item of plan.invalidations) {
      const expiresAt = new Date(Math.max(Date.parse(tx.now), Date.parse(item.bucket.bucketEnd)) +
        this.retentionDays * 86400000).toISOString();
      await this.queue.invalidate(tx, item.bucket, after.updatedSequence, expiresAt);
    }
    return 'apply';
  }

  /** Resume a bounded retained-detail scan. Install the live hook before starting this scan. */
  async backfill(tx: ObservabilityWriteTransaction, limit = 100): Promise<{ processed: number; cursor: string | null; complete: boolean }> {
    requireBucketTransaction(tx);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new BucketProjectionError('INVALID_BUCKET_BACKFILL_LIMIT');
    const states = tx.manager.getRepository(RuntimePipelineStateEntity);
    const state = await states.findOneBy({ id: BACKFILL_ID });
    const cursor = state?.value?.cursor || null;
    if (state?.value?.complete) return { processed: 0, cursor, complete: true };
    const query = tx.manager.getRepository(RuntimeInvocationEntity).createQueryBuilder('invocation')
      .where('invocation.expiresAt > :now', { now: tx.now }).orderBy('invocation.invocationId', 'ASC').take(limit);
    if (cursor) query.andWhere('invocation.invocationId > :cursor', { cursor });
    const rows = await query.getMany();
    for (const row of rows) await this.apply(tx, row);
    const next = rows.length ? rows[rows.length - 1].invocationId : cursor;
    const complete = rows.length < limit;
    await states.save(states.create({ id: BACKFILL_ID, updatedAt: tx.now,
      value: { cursor: next, complete, retainedDetailOnly: true } }));
    return { processed: rows.length, cursor: next, complete };
  }

  /** Explicit rescan after offline import; CAS keeps already projected revisions idempotent. */
  async restartBackfill(tx: ObservabilityWriteTransaction): Promise<void> {
    requireBucketTransaction(tx);
    await tx.manager.getRepository(RuntimePipelineStateEntity).delete({ id: BACKFILL_ID });
  }
}
