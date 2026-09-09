import { CanonicalInvocation, invocationMatchesScope, ObservabilityOrigin, ObservabilityScope } from 'api-nova-parser';
import { ObservabilityApiError } from './call-observability-api.contract';
import { parseObservabilityQuery } from './call-observability-query';

export const MAX_METRIC_OBSERVATIONS = 5000;
export const METRIC_LATENCY_BOUNDS_MS = Object.freeze([1, 5, 10, 25, 50, 100, 250, 500,
  1000, 2500, 5000, 10000, 30000, 60000]);
const OUTCOMES = ['success', 'error', 'rejected', 'timeout', 'cancelled', 'incomplete', 'unknown'] as const;
const QUERY_KEYS = ['from', 'to', 'scope', 'origin', 'timeBasis'] as const;

export interface MetricObservation {
  /** Database projection revision, not the producer's recordVersion. */
  revision: number;
  invocation: CanonicalInvocation;
  /** From the already-authorized source association, never derived from raw IP here. */
  sourceId?: string | null;
  sourceOverflow?: boolean;
  /** Only the state reader may supply a current, verified live state. Missing means unknown. */
  producerState?: 'live' | 'lost' | 'unknown';
}
export interface MetricByteSide {
  observedBytes: number | string | null;
  measuredRecords: number;
  unmeasuredRecords: number;
  partialRecords: number;
  isLowerBound: boolean;
}
export interface MetricByteGroup {
  spanKind: string;
  byteMeasurement: string;
  measurementStage: string;
  invocationCount: number;
  request: MetricByteSide;
  response: MetricByteSide;
}
function publicBytes(value: bigint): number | string {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}
function measured(row: CanonicalInvocation, side: 'request' | 'response'): boolean {
  return row.byteMeasurement !== 'unavailable' && Number.isSafeInteger(row[side]?.observedBytes) &&
    row[side].observedBytes! >= 0;
}
function partial(row: CanonicalInvocation, side: 'request' | 'response'): boolean {
  return row[side]?.state === 'incomplete' || row[side]?.digestScope === 'partial';
}
function byteSide(rows: CanonicalInvocation[], side: 'request' | 'response'): MetricByteSide {
  let total = 0n, measuredRecords = 0, partialRecords = 0;
  for (const row of rows) {
    if (measured(row, side)) { measuredRecords++; total += BigInt(row[side].observedBytes!); }
    if (partial(row, side)) partialRecords++;
  }
  const unmeasuredRecords = rows.length - measuredRecords;
  return { observedBytes: measuredRecords ? publicBytes(total) : null, measuredRecords,
    unmeasuredRecords, partialRecords, isLowerBound: unmeasuredRecords > 0 || partialRecords > 0 };
}
function byteGroups(rows: CanonicalInvocation[]): MetricByteGroup[] {
  const groups = new Map<string, CanonicalInvocation[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.spanKind, row.byteMeasurement, row.measurementStage]);
    const group = groups.get(key) || [];
    group.push(row); groups.set(key, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, records]) => {
    const [spanKind, byteMeasurement, measurementStage] = JSON.parse(key);
    return { spanKind, byteMeasurement, measurementStage, invocationCount: records.length,
      request: byteSide(records, 'request'), response: byteSide(records, 'response') };
  });
}
function latency(rows: CanonicalInvocation[]) {
  const counts = METRIC_LATENCY_BOUNDS_MS.map(() => 0); counts.push(0);
  let sampleCount = 0, unmeasuredRecords = 0, excludedRecords = 0, sumMs = 0, meanMs = 0;
  let maxMs: number | null = null;
  for (const row of rows) {
    if (row.phase !== 'finished' || row.completionSource !== 'observed' ||
      !row.completedAt || !row.outcome || row.outcome === 'unknown') { excludedRecords++; continue; }
    const value = row.durationMs;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
      value > Number.MAX_SAFE_INTEGER) { unmeasuredRecords++; continue; }
    sampleCount++; sumMs += value; meanMs += (value - meanMs) / sampleCount;
    maxMs = maxMs === null ? value : Math.max(maxMs, value);
    const bucket = METRIC_LATENCY_BOUNDS_MS.findIndex(bound => value <= bound);
    counts[bucket < 0 ? counts.length - 1 : bucket]++;
  }
  const histogram = counts.map((count, index) => ({ lowerBoundMs: index ? METRIC_LATENCY_BOUNDS_MS[index - 1] : 0,
    lowerInclusive: index === 0, upperBoundMs: METRIC_LATENCY_BOUNDS_MS[index] ?? null,
    upperInclusive: index < METRIC_LATENCY_BOUNDS_MS.length, count }));
  const percentile = (fraction: number) => {
    if (!sampleCount) return null;
    const rank = Math.ceil(sampleCount * fraction);
    let seen = 0;
    for (const bucket of histogram) {
      seen += bucket.count;
      if (seen >= rank) return { lowerBoundMs: bucket.lowerBoundMs, lowerInclusive: bucket.lowerInclusive,
        upperBoundMs: bucket.upperBoundMs, upperInclusive: bucket.upperInclusive,
        estimateMs: bucket.upperBoundMs, overflow: bucket.upperBoundMs === null };
    }
    return null;
  };
  const sumOverflow = sumMs > Number.MAX_SAFE_INTEGER;
  return { algorithm: 'fixed_histogram_upper_bound_v1', approximate: true, sampleCount,
    unmeasuredRecords, excludedRecords, sumMs: sampleCount && !sumOverflow ? sumMs : null,
    sumOverflow, meanMs: sampleCount ? meanMs : null, maxMs, histogram,
    p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) };
}

/**
 * Pure bounded metric kernel, not a public query or authorization boundary.
 * The caller must first enforce current asset permissions, retention and snapshot visibility.
 * No database, source-file, payload, clock, event or policy I/O is performed here.
 */
export function calculateObservabilityMetrics(observations: readonly MetricObservation[], raw: Record<string, unknown>) {
  if (!raw || typeof raw.from !== 'string' || typeof raw.to !== 'string' || typeof raw.scope !== 'string') {
    throw new ObservabilityApiError('INVALID_QUERY', 'window');
  }
  const { filter } = parseObservabilityQuery(raw, QUERY_KEYS);
  if (!Array.isArray(observations) || observations.length > MAX_METRIC_OBSERVATIONS) {
    throw new ObservabilityApiError('QUERY_TOO_LARGE', 'observations');
  }
  const latest = new Map<string, MetricObservation>();
  for (const observation of observations) {
    if (!observation?.invocation || !Number.isSafeInteger(observation.revision) || observation.revision < 1) {
      throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
    }
    const current = latest.get(observation.invocation.invocationId);
    if (!current || observation.revision > current.revision) latest.set(observation.invocation.invocationId, observation);
  }
  const from = Date.parse(String(filter.from)), to = Date.parse(String(filter.to));
  const scope = filter.scope as ObservabilityScope, origin = filter.origin as ObservabilityOrigin;
  const timeBasis = filter.timeBasis as 'startedAt' | 'completedAt';
  // Resolve the latest committed revision before origin/scope/window filtering.
  const selected = [...latest.values()].filter(({ invocation: row }) => {
    const time = row[timeBasis] ? Date.parse(row[timeBasis]!) : NaN;
    return row.origin === origin && invocationMatchesScope(row, scope) && time >= from && time < to;
  });
  const rows = selected.map(item => item.invocation);
  const outcomes = Object.fromEntries(OUTCOMES.map(outcome => [outcome, 0])) as Record<typeof OUTCOMES[number], number>;
  const callers = new Set<string>(), sources = new Set<string>(), retries = new Set<string>();
  let inFlight = 0, unknownInFlight = 0, unidentifiedCallerRecords = 0;
  let anonymousSourceOverflowRecords = 0, unidentifiedSourceRecords = 0, unlinkedRetryRecords = 0;
  for (const item of selected) {
    const row = item.invocation;
    if (row.phase === 'finished') outcomes[OUTCOMES.includes(row.outcome!) ? row.outcome! : 'unknown']++;
    else if (item.producerState === 'live') inFlight++;
    else unknownInFlight++;
    if (row.identitySource === 'authenticated' && row.authState === 'authenticated' && row.callerId) callers.add(row.callerId);
    else unidentifiedCallerRecords++;
    if (row.authState !== 'authenticated') {
      if (item.sourceOverflow) anonymousSourceOverflowRecords++;
      else if (item.sourceId) sources.add(item.sourceId);
      else unidentifiedSourceRecords++;
    }
    if (row.spanKind === 'upstream_api' && row.attemptIndex !== null && row.attemptIndex > 1) {
      if (row.upstreamOperationId) retries.add(JSON.stringify([row.upstreamOperationId, row.attemptIndex]));
      else unlinkedRetryRecords++;
    }
  }
  const knownCompleted = outcomes.success + outcomes.error + outcomes.rejected + outcomes.timeout +
    outcomes.cancelled + outcomes.incomplete;
  const failures = outcomes.error + outcomes.timeout + outcomes.incomplete;
  const groups = byteGroups(rows);
  const measuredRecords = rows.filter(row => measured(row, 'request') && measured(row, 'response')).length;
  return {
    window: { from: String(filter.from), to: String(filter.to), scope, origin, timeBasis },
    metrics: {
      selectedInvocations: rows.length,
      // A completion-window selection cannot establish the number of all starts in that window.
      totalStarted: timeBasis === 'startedAt' ? rows.length : null,
      knownCompleted, successes: outcomes.success, failures, rejections: outcomes.rejected,
      timeouts: outcomes.timeout, cancelled: outcomes.cancelled, incomplete: outcomes.incomplete,
      unknown: outcomes.unknown, outcomes, inFlight, unknownInFlight,
      uniqueCallers: callers.size, unidentifiedCallerRecords, anonymousSources: sources.size,
      anonymousSourceOverflowRecords, unidentifiedSourceRecords,
      anonymousSourceCoveragePartial: anonymousSourceOverflowRecords > 0 || unidentifiedSourceRecords > 0,
      upstreamRequests: rows.filter(row => row.spanKind === 'upstream_api').length,
      retryAttempts: retries.size, unlinkedRetryRecords,
      successRate: knownCompleted ? outcomes.success / knownCompleted : null,
      errorRate: outcomes.success + failures ? failures / (outcomes.success + failures) : null,
      measuredRecords, unmeasuredRecords: rows.length - measuredRecords,
      partialRecords: rows.filter(row => partial(row, 'request') || partial(row, 'response')).length,
      byteGroups: groups,
      requestBytes: groups.length === 1 ? groups[0].request.observedBytes : null,
      responseBytes: groups.length === 1 ? groups[0].response.observedBytes : null,
      latency: latency(rows),
    },
    coverage: { historyCompleteSince: null, isPartial: true, observationHealth: 'unknown' },
  };
}
