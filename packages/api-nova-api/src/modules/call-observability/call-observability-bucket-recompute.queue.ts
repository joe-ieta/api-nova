import { randomUUID } from 'crypto';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { RuntimeMetricBucketEntity } from '../../database/entities/runtime-call-observability.entity';
import type { ObservabilityWriteTransaction } from './call-observability.store';
import type { PersistentBucketKey } from './call-observability-bucket-plan';

export const BUCKET_ZERO_WATERMARK = '00000000000000000000';
const MAX_VERSION = 2147483647;
export class BucketProjectionError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'BucketProjectionError'; }
}
export function requireBucketTransaction(tx: ObservabilityWriteTransaction): void {
  if (!tx.manager.queryRunner?.isTransactionActive) throw new BucketProjectionError('BUCKET_TRANSACTION_REQUIRED');
  if (!Number.isFinite(Date.parse(tx.now)) || new Date(tx.now).toISOString() !== tx.now) {
    throw new BucketProjectionError('INVALID_BUCKET_CLOCK');
  }
}
export interface BucketRecomputeClaim {
  bucket: RuntimeMetricBucketEntity;
  token: string;
  dirtyVersion: number;
}
/** Durable queue in the existing bucket row. Run inside store.transaction and let errors roll back. */
export class CallObservabilityBucketRecomputeQueue {
  async invalidate(tx: ObservabilityWriteTransaction, key: PersistentBucketKey,
    watermark: string, expiresAt: string): Promise<void> {
    requireBucketTransaction(tx);
    if (!/^\d{20}$/.test(watermark) || BigInt(watermark) > 18446744073709551615n ||
      !Number.isFinite(Date.parse(expiresAt))) throw new BucketProjectionError('INVALID_BUCKET_INVALIDATION');
    const repository = tx.manager.getRepository(RuntimeMetricBucketEntity);
    await repository.createQueryBuilder().insert().values({
      id: key.bucketId, scope: key.scope, bucketStart: key.bucketStart, bucketEnd: key.bucketEnd,
      dimensions: key as unknown as QueryDeepPartialEntity<any>, metrics: {}, version: 0, dirtyVersion: 0, recomputeState: 'clean',
      leaseToken: null, leaseUntil: null, retryAt: null, recomputeAttempts: 0,
      pendingWatermark: BUCKET_ZERO_WATERMARK, dataWatermark: BUCKET_ZERO_WATERMARK, expiresAt,
    }).orIgnore().execute();
    const result = await repository.createQueryBuilder().update().set({
      dirtyVersion: () => '"dirtyVersion" + 1', recomputeState: 'pending',
      leaseToken: null, leaseUntil: null, retryAt: null, recomputeAttempts: 0,
      pendingWatermark: () => 'CASE WHEN "pendingWatermark" < :watermark THEN :watermark ELSE "pendingWatermark" END',
      expiresAt: () => 'CASE WHEN "expiresAt" < :expiresAt THEN :expiresAt ELSE "expiresAt" END',
    }).where('id = :id AND "dirtyVersion" < :maximum', { id: key.bucketId, maximum: MAX_VERSION })
      .setParameters({ watermark, expiresAt }).execute();
    if (result.affected !== 1) throw new BucketProjectionError('BUCKET_VERSION_EXHAUSTED');
  }

  async claim(tx: ObservabilityWriteTransaction, limit = 16, leaseMs = 30000): Promise<BucketRecomputeClaim[]> {
    requireBucketTransaction(tx);
    if (!Number.isInteger(limit) || limit < 1 || limit > 256 || !Number.isInteger(leaseMs) ||
      leaseMs < 1 || leaseMs > 3600000) throw new BucketProjectionError('INVALID_BUCKET_LEASE');
    const repository = tx.manager.getRepository(RuntimeMetricBucketEntity);
    const eligible = '("recomputeState" = :pending AND ("retryAt" IS NULL OR "retryAt" <= :now)) OR ' +
      '("recomputeState" = :leased AND "leaseUntil" <= :now)';
    const parameters = { pending: 'pending', leased: 'leased', now: tx.now };
    const candidates = await repository.createQueryBuilder('bucket').where('(' + eligible + ')', parameters)
      .andWhere('bucket.expiresAt > :now', { now: tx.now }).orderBy('bucket.bucketStart', 'ASC').addOrderBy('bucket.id', 'ASC').take(limit).getMany();
    const claims: BucketRecomputeClaim[] = [];
    for (const bucket of candidates) {
      const token = randomUUID();
      const leaseUntil = new Date(Date.parse(tx.now) + leaseMs).toISOString();
      const result = await repository.createQueryBuilder().update().set({
        recomputeState: 'leased', leaseToken: token, leaseUntil, retryAt: null,
        recomputeAttempts: () => 'CASE WHEN "recomputeAttempts" < 2147483647 THEN "recomputeAttempts" + 1 ELSE "recomputeAttempts" END',
      }).where('id = :id AND "dirtyVersion" = :generation AND (' + eligible + ')', {
        ...parameters, id: bucket.id, generation: bucket.dirtyVersion,
      }).execute();
      if (result.affected === 1) claims.push({ token, dirtyVersion: bucket.dirtyVersion,
        bucket: { ...bucket, recomputeState: 'leased', leaseToken: token, leaseUntil,
          retryAt: null, recomputeAttempts: Math.min(MAX_VERSION, bucket.recomputeAttempts + 1) } });
    }
    return claims;
  }

  /** Only publish a complete B03 computation; coverage/retention remain the caller's responsibility. */
  async complete(tx: ObservabilityWriteTransaction, claim: BucketRecomputeClaim,
    metrics: Record<string, unknown>): Promise<boolean> {
    requireBucketTransaction(tx);
    if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) {
      throw new BucketProjectionError('INVALID_BUCKET_METRICS');
    }
    const result = await tx.manager.getRepository(RuntimeMetricBucketEntity).createQueryBuilder().update().set({
      metrics: metrics as any, version: claim.dirtyVersion, dataWatermark: () => '"pendingWatermark"',
      recomputeState: 'clean', leaseToken: null, leaseUntil: null, retryAt: null,
    }).where('id = :id AND "dirtyVersion" = :generation AND "recomputeState" = :state ' +
      'AND "leaseToken" = :token AND "leaseUntil" > :now AND "expiresAt" > :now', {
      id: claim.bucket.id, generation: claim.dirtyVersion, state: 'leased', token: claim.token, now: tx.now,
    }).execute();
    return result.affected === 1;
  }

  /** Retry without storing arbitrary exception text or credentials. */
  async fail(tx: ObservabilityWriteTransaction, claim: BucketRecomputeClaim, delayMs = 1000): Promise<boolean> {
    requireBucketTransaction(tx);
    if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 3600000) {
      throw new BucketProjectionError('INVALID_BUCKET_RETRY');
    }
    const result = await tx.manager.getRepository(RuntimeMetricBucketEntity).createQueryBuilder().update().set({
      recomputeState: 'pending', leaseToken: null, leaseUntil: null,
      retryAt: new Date(Date.parse(tx.now) + delayMs).toISOString(),
    }).where('id = :id AND "dirtyVersion" = :generation AND "recomputeState" = :state ' +
      'AND "leaseToken" = :token AND "leaseUntil" > :now AND "expiresAt" > :now', {
      id: claim.bucket.id, generation: claim.dirtyVersion, state: 'leased', token: claim.token, now: tx.now,
    }).execute();
    return result.affected === 1;
  }
}
