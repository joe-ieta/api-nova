import { RuntimeMetricBucketEntity, RuntimeMetricContributionEntity } from '../../database/entities/runtime-call-observability.entity';
import { planBucketRevision } from './call-observability-bucket-plan';
import { BucketProjectionError, BucketRecomputeClaim, CallObservabilityBucketRecomputeQueue } from './call-observability-bucket-recompute.queue';
import type { PersistentMetricContribution } from './call-observability-buckets.projector';
import { calculateObservabilityMetrics, MAX_METRIC_OBSERVATIONS, MetricObservation } from './call-observability-metrics';
import type { CallObservabilityStore } from './call-observability.store';

type Store = Pick<CallObservabilityStore, 'transaction' | 'readSnapshot'>;
export interface BucketRecomputeOptions {
  maxContributions?: number;
  batchSize?: number;
  leaseMs?: number;
  retryMs?: number;
}

/** Evidence about this computation's selected rows, never a historical coverage guarantee. */
export interface BucketContributionCoverageEvidence {
  schemaVersion: 1;
  basis: 'matching_persisted_contributions';
  readSnapshotSeq: string;
  selectionWindow: { from: string; to: string; toExclusive: true; timeBasis: 'startedAt' | 'completedAt' };
  selectedRecords: number;
  selectionLimit: number;
  // Overflow aborts publication. This says nothing about upstream loss or prior retention.
  selectionTruncated: false;
  // Inclusive extrema of selected evidence; the interval between them is not proven covered.
  earliestSelectedAt: string | null;
  latestSelectedAt: string | null;
}

export interface CompletedBucketSnapshot {
  schemaVersion: 1;
  computedAt: string;
  computationComplete: true;
  contributionCount: number;
  metrics: ReturnType<typeof calculateObservabilityMetrics>['metrics'];
  coverage: { historyCompleteSince: null; isPartial: true; observationHealth: 'unknown';
    basis: 'persisted_contributions'; livenessEvaluated: false;
    // Optional only for existing schemaVersion=1 snapshots; reads normalize missing evidence to null.
    historyTruncated?: null;
    retentionComplete?: null;
    backfillComplete?: null;
    coveredRanges?: null;
    contributionEvidence?: BucketContributionCoverageEvidence | null;
  };
}

/** Internal, asset-authorized callers only. Does not change the HTTP query backend. */
export class CallObservabilityBucketRecomputeService {
  private readonly options: Required<BucketRecomputeOptions>;
  constructor(private readonly store: Store, private readonly queue = new CallObservabilityBucketRecomputeQueue(),
    options: BucketRecomputeOptions = {}) {
    this.options = { maxContributions: options.maxContributions ?? MAX_METRIC_OBSERVATIONS,
      batchSize: options.batchSize ?? 8, leaseMs: options.leaseMs ?? 30000, retryMs: options.retryMs ?? 30000 };
    const o = this.options;
    if (!Number.isInteger(o.maxContributions) || o.maxContributions < 1 || o.maxContributions > MAX_METRIC_OBSERVATIONS ||
      !Number.isInteger(o.batchSize) || o.batchSize < 1 || o.batchSize > 64 ||
      !Number.isInteger(o.leaseMs) || o.leaseMs < 1 || o.leaseMs > 3600000 ||
      !Number.isInteger(o.retryMs) || o.retryMs < 1 || o.retryMs > 3600000) {
      throw new BucketProjectionError('INVALID_BUCKET_RECOMPUTE_OPTIONS');
    }
  }

  /** Bounded explicit tick; persisted leases/backoff make another process or restart safe. */
  async runOnce() {
    const claims = await this.store.transaction(tx => this.queue.claim(tx, this.options.batchSize, this.options.leaseMs));
    const report = { claimed: claims.length, completed: 0, superseded: 0, failed: 0,
      failures: [] as Array<{ bucketId: string; code: string }> };
    for (const claim of claims) {
      try {
        const snapshot = await this.compute(claim);
        const committed = await this.store.transaction(tx => this.queue.complete(tx, claim, snapshot as unknown as Record<string, unknown>));
        if (committed) report.completed++; else report.superseded++;
      } catch (error) {
        // Let release failures surface. The committed lease still makes the work recoverable.
        const released = await this.store.transaction(tx => this.queue.fail(tx, claim, this.options.retryMs));
        if (!released) { report.superseded++; continue; }
        report.failed++;
        const code = error instanceof BucketProjectionError ? error.code : 'BUCKET_RECOMPUTE_FAILED';
        report.failures.push({ bucketId: claim.bucket.id, code });
      }
    }
    return report;
  }

  private async compute(claim: BucketRecomputeClaim): Promise<CompletedBucketSnapshot> {
    return this.store.readSnapshot(async tx => {
      const key = claim.bucket.dimensions;
      if (!/^bkt_[a-f0-9]{64}$/.test(claim.bucket.id) || key?.bucketId !== claim.bucket.id) {
        throw new BucketProjectionError('INVALID_BUCKET_DIMENSIONS');
      }
      if (claim.bucket.expiresAt <= tx.now) throw new BucketProjectionError('BUCKET_EXPIRED');
      // Existing JSON contribution model, with an exact quoted hash membership predicate.
      // Portable to simple-json/SQLite and jsonb/PostgreSQL. Rows are bounded; this is not an indexed lookup.
      const rows = await tx.manager.getRepository(RuntimeMetricContributionEntity).createQueryBuilder('contribution')
        .where('CAST(contribution.contribution AS TEXT) LIKE :membership', { membership: '%"' + claim.bucket.id + '"%' })
        .orderBy('contribution.invocationId', 'ASC').take(this.options.maxContributions + 1).getMany();
      if (rows.length > this.options.maxContributions) throw new BucketProjectionError('BUCKET_CONTRIBUTION_LIMIT_EXCEEDED');
      const observations: MetricObservation[] = [];
      let earliestSelectedAt: string | null = null;
      let latestSelectedAt: string | null = null;
      for (const row of rows) {
        const value: PersistentMetricContribution = row.contribution;
        if (value?.schemaVersion !== 1 || !Array.isArray(value.bucketIds) || !value.bucketIds.includes(claim.bucket.id) ||
          value.revision?.record?.invocationId !== row.invocationId || Number(value.revision.recordVersion) !== row.recordVersion ||
          value.observation?.revision !== row.recordVersion || value.observation?.invocation?.invocationId !== row.invocationId) {
          throw new BucketProjectionError('INVALID_BUCKET_CONTRIBUTION');
        }
        const membership = planBucketRevision(null, value.revision).invalidations.find(i => i.bucket.bucketId === claim.bucket.id);
        if (!membership || Object.keys(membership.bucket).some(field => membership.bucket[field] !== key[field])) {
          throw new BucketProjectionError('INVALID_BUCKET_MEMBERSHIP');
        }
        // Membership planning validated this timestamp. Extrema describe evidence, not gap-free coverage.
        const selectedAt = value.revision.record[membership.bucket.timeBasis];
        if (typeof selectedAt !== 'string') throw new BucketProjectionError('INVALID_BUCKET_MEMBERSHIP');
        earliestSelectedAt = earliestSelectedAt === null || selectedAt < earliestSelectedAt ? selectedAt : earliestSelectedAt;
        latestSelectedAt = latestSelectedAt === null || selectedAt > latestSelectedAt ? selectedAt : latestSelectedAt;
        // The persisted evidence has no authoritative current producer-liveness proof.
        observations.push({ ...value.observation, invocation: value.observation.invocation as MetricObservation['invocation'],
          producerState: 'unknown' });
      }
      const result = calculateObservabilityMetrics(observations, { from: key.bucketStart, to: key.bucketEnd,
        scope: key.scope, origin: key.origin, timeBasis: key.timeBasis });
      if (result.metrics.selectedInvocations !== rows.length) throw new BucketProjectionError('INVALID_BUCKET_METRIC_MEMBERSHIP');
      return { schemaVersion: 1, computedAt: tx.now, computationComplete: true, contributionCount: rows.length,
        metrics: result.metrics, coverage: {
          historyCompleteSince: null, isPartial: true, observationHealth: 'unknown',
          basis: 'persisted_contributions', livenessEvaluated: false,
          historyTruncated: null, retentionComplete: null, backfillComplete: null, coveredRanges: null,
          contributionEvidence: {
            schemaVersion: 1, basis: 'matching_persisted_contributions', readSnapshotSeq: tx.snapshotSeq,
            selectionWindow: { from: key.bucketStart, to: key.bucketEnd, toExclusive: true, timeBasis: key.timeBasis },
            selectedRecords: rows.length, selectionLimit: this.options.maxContributions, selectionTruncated: false,
            earliestSelectedAt, latestSelectedAt,
          },
        } };
    });
  }

  /** Return only an atomically completed version, even when a newer generation is pending. */
  async readCompleted(bucketId: string) {
    if (!/^bkt_[a-f0-9]{64}$/.test(bucketId)) throw new BucketProjectionError('INVALID_BUCKET_ID');
    return this.store.readSnapshot(async tx => {
      const bucket = await tx.manager.getRepository(RuntimeMetricBucketEntity).findOneBy({ id: bucketId });
      if (!bucket) return { state: 'missing' as const, bucketId, snapshot: null };
      if (bucket.expiresAt <= tx.now) return { state: 'expired' as const, bucketId, snapshot: null, expiresAt: bucket.expiresAt };
      if (!bucket.version) return { state: 'pending' as const, bucketId, snapshot: null, dirtyVersion: bucket.dirtyVersion };
      const snapshot = bucket.metrics as CompletedBucketSnapshot;
      if (snapshot?.schemaVersion !== 1 || snapshot.computationComplete !== true || !snapshot.metrics ||
        !Number.isInteger(snapshot.contributionCount) || snapshot.contributionCount < 0) {
        throw new BucketProjectionError('INVALID_COMPLETED_BUCKET');
      }
      // Never infer historical completeness from a completed computation, expiry or an empty result.
      // Older snapshots carry no selection evidence; do not reconstruct it using today's settings/state.
      const readableSnapshot: CompletedBucketSnapshot = { ...snapshot, coverage: {
        historyCompleteSince: null, isPartial: true, observationHealth: 'unknown',
        basis: 'persisted_contributions', livenessEvaluated: false,
        historyTruncated: null, retentionComplete: null, backfillComplete: null, coveredRanges: null,
        contributionEvidence: snapshot.coverage?.contributionEvidence ?? null,
      } };
      return { state: 'available' as const, bucketId, bucketVersion: bucket.version,
        dirtyVersion: bucket.dirtyVersion, stale: bucket.version !== bucket.dirtyVersion,
        dataWatermark: bucket.dataWatermark, expiresAt: bucket.expiresAt, dimensions: bucket.dimensions, snapshot: readableSnapshot };
    });
  }
}
