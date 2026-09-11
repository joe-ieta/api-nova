import { createHash } from 'crypto';

export const BUCKET_KEY_SCHEMA_VERSION = 1;
export const MAX_BUCKET_INVALIDATIONS_PER_REVISION = 32;
// These widths are part of the versioned persistent-key contract, not a mutable query policy.
export const PERSISTENT_BUCKET_INTERVALS = { '1m': 60000, '5m': 300000, '1h': 3600000, '1d': 86400000 } as const;
type Interval = keyof typeof PERSISTENT_BUCKET_INTERVALS;
type Scope = 'business' | 'http_ingress' | 'tool' | 'protocol' | 'upstream';
type Origin = 'external' | 'test' | 'probe' | 'internal';
type TimeBasis = 'startedAt' | 'completedAt';

export interface BucketRevision {
  // This is the committed database record version, never the producer's lifecycle version.
  recordVersion: string | number;
  record: {
    invocationId: string;
    runtimeAssetId?: string | null;
    origin: string;
    spanKind: string;
    transport?: string | null;
    startedAt: string;
    completedAt?: string | null;
  };
}

export interface PersistentBucketKey {
  bucketId: string;
  keySchemaVersion: number;
  runtimeAssetId: string | null;
  origin: Origin;
  scope: Scope;
  timeBasis: TimeBasis;
  interval: Interval;
  bucketStart: string;
  bucketEnd: string;
}

export interface BucketInvalidation {
  bucket: PersistentBucketKey;
  membershipChange: 'added' | 'removed' | 'updated';
  action: 'recompute';
}

export interface BucketRevisionPlan {
  status: 'apply' | 'duplicate' | 'stale';
  invocationId: string;
  expectedRecordVersion: string | null;
  incomingRecordVersion: string;
  invalidations: BucketInvalidation[];
}

export class BucketPlanError extends Error {
  constructor(readonly code: 'INVALID_BUCKET_REVISION' | 'BUCKET_INVOCATION_MISMATCH') {
    super(code);
    this.name = 'BucketPlanError';
  }
}

interface NormalizedRevision {
  version: string;
  invocationId: string;
  runtimeAssetId: string | null;
  origin: Origin;
  spanKind: string;
  transport: string | null;
  startedAt: string;
  completedAt: string | null;
}

const ORIGINS = new Set(['external', 'test', 'probe', 'internal']);
const SPANS = new Set(['gateway_request', 'mcp_protocol', 'mcp_tool', 'upstream_api']);
const HTTP_TRANSPORTS = new Set(['http', 'sse', 'streamable', 'streamable-http']);
const MAX_VERSION = 18446744073709551615n;

function invalid(): never { throw new BucketPlanError('INVALID_BUCKET_REVISION'); }

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) invalid();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) invalid();
  return value;
}

function version(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 1) invalid();
    return String(value);
  }
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > MAX_VERSION) invalid();
  return value;
}

function normalize(revision: BucketRevision): NormalizedRevision {
  if (!revision || typeof revision !== 'object' || Array.isArray(revision) ||
    !revision.record || typeof revision.record !== 'object' || Array.isArray(revision.record)) invalid();
  const record = revision.record;
  const origin = record.origin;
  const spanKind = record.spanKind;
  if (!ORIGINS.has(origin) || !SPANS.has(spanKind)) invalid();
  return {
    version: version(revision.recordVersion),
    invocationId: identifier(record.invocationId),
    runtimeAssetId: record.runtimeAssetId == null ? null : identifier(record.runtimeAssetId),
    origin: origin as Origin, spanKind,
    transport: record.transport == null ? null : identifier(record.transport),
    startedAt: timestamp(record.startedAt),
    completedAt: record.completedAt == null ? null : timestamp(record.completedAt),
  };
}

function scopes(record: NormalizedRevision): Scope[] {
  if (record.spanKind === 'gateway_request') return ['business', 'http_ingress'];
  if (record.spanKind === 'mcp_tool') return ['business', 'tool'];
  if (record.spanKind === 'upstream_api') return ['upstream'];
  return record.transport !== null && HTTP_TRANSPORTS.has(record.transport) ? ['protocol', 'http_ingress'] : ['protocol'];
}

function buckets(record: NormalizedRevision): Map<string, PersistentBucketKey> {
  const result = new Map<string, PersistentBucketKey>();
  for (const timeBasis of ['startedAt', 'completedAt'] as const) {
    const at = record[timeBasis];
    if (at === null) continue;
    for (const interval of Object.keys(PERSISTENT_BUCKET_INTERVALS) as Interval[]) {
      const width = PERSISTENT_BUCKET_INTERVALS[interval];
      const start = Math.floor(Date.parse(at) / width) * width;
      const bucketStart = new Date(start).toISOString();
      const bucketEnd = new Date(start + width).toISOString();
      for (const scope of scopes(record)) {
        // A JSON tuple preserves nulls and field boundaries; concatenated strings would not.
        const identity = [BUCKET_KEY_SCHEMA_VERSION, record.runtimeAssetId, record.origin, scope,
          timeBasis, interval, bucketStart];
        const bucketId = 'bkt_' + createHash('sha256').update(JSON.stringify(identity), 'utf8').digest('hex');
        result.set(bucketId, { bucketId, keySchemaVersion: BUCKET_KEY_SCHEMA_VERSION,
          runtimeAssetId: record.runtimeAssetId, origin: record.origin, scope, timeBasis, interval, bucketStart, bucketEnd });
      }
    }
  }
  return result;
}

/**
 * Plan invalidations only. No storage, counter changes, version reservation, clock, or event emission occurs here.
 * A later transaction must compare expectedRecordVersion and commit the contribution plus dirty buckets atomically.
 * Equal versions assume the database's immutable-revision guarantee; this is not an ingestion conflict detector.
 */
export function planBucketRevision(previous: BucketRevision | null, incoming: BucketRevision): BucketRevisionPlan {
  const next = normalize(incoming);
  const before = previous === null ? null : normalize(previous);
  if (before && before.invocationId !== next.invocationId) throw new BucketPlanError('BUCKET_INVOCATION_MISMATCH');
  const common = { invocationId: next.invocationId, expectedRecordVersion: before?.version ?? null,
    incomingRecordVersion: next.version };
  if (before && BigInt(next.version) <= BigInt(before.version)) {
    return { ...common, status: next.version === before.version ? 'duplicate' : 'stale', invalidations: [] };
  }
  const oldBuckets = before ? buckets(before) : new Map<string, PersistentBucketKey>();
  const newBuckets = buckets(next);
  const ids = [...new Set([...oldBuckets.keys(), ...newBuckets.keys()])].sort();
  const invalidations: BucketInvalidation[] = ids.map(bucketId => ({
    bucket: newBuckets.get(bucketId) || oldBuckets.get(bucketId)!,
    membershipChange: oldBuckets.has(bucketId) ? (newBuckets.has(bucketId) ? 'updated' : 'removed') : 'added',
    action: 'recompute',
  }));
  // Recompute every retained membership on a newer revision: bytes, outcomes and distinct sets may have changed.
  return { ...common, status: 'apply', invalidations };
}
