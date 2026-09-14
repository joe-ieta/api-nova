/** TP12 sender preparation only: no network I/O or persistence. */
export const WEBHOOK_RETRY_DELAYS_MS = Object.freeze([5000, 30000, 120000, 600000, 1800000]);
export const WEBHOOK_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface WebhookRetryInput {
  /** Completed attempts in this replay generation, INCLUDING the initial send. */
  completedAttempts: number;
  now: Date;
  /** Persisted start of this generation. Never reset this on automatic retry. */
  startedAt: Date;
  expiresAt: Date;
  retryAfter?: string;
  /** Internal positive jitter policy: add up to 20%; injectable for deterministic tests. */
  jitterSample?: number;
}

export type WebhookRetryDecision =
  | { status: 'retry_wait'; nextAttemptAt: string }
  | { status: 'dead'; reason: 'retry_limit' | 'delivery_expired' | 'retry_window_exceeded'; nextAttemptAt: null };

/** 3xx are never followed. Successful responses must not enter retry scheduling. */
export function isRetryableWebhookFailure(failure:
  { kind: 'network' } | { kind: 'http'; statusCode: number }): boolean {
  if (failure.kind === 'network') return true;
  const status = failure.statusCode;
  return Number.isInteger(status) && (status === 408 || status === 429 || (status >= 500 && status <= 599));
}

function retryAfterTime(value: string | undefined, now: number): number {
  if (typeof value !== 'string' || value.length > 1024) return now;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return now + Number(trimmed) * 1000;
  // Accept canonical HTTP-date, not Date.parse's permissive local/date-only formats.
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(trimmed)) return now;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) && new Date(parsed).toUTCString() === trimmed ? Math.max(now, parsed) : now;
}

/**
 * Invoke only for a retryable, durably recorded failure under a valid lease.
 * The sender must recheck authorization, pause/revocation and deadlines before sending.
 * A manual replay needs a separately authorized generation; it cannot extend expiresAt.
 */
export function planWebhookRetry(input: WebhookRetryInput): WebhookRetryDecision {
  const now = input.now.getTime(), startedAt = input.startedAt.getTime(), expiresAt = input.expiresAt.getTime();
  const sample = input.jitterSample ?? Math.random();
  if (!Number.isSafeInteger(input.completedAttempts) || input.completedAttempts < 1 ||
      !Number.isFinite(now) || !Number.isFinite(startedAt) || !Number.isFinite(expiresAt) ||
      startedAt > now || !Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new Error('INVALID_WEBHOOK_RETRY_POLICY');
  }
  const deadline = Math.min(expiresAt, startedAt + WEBHOOK_RETRY_WINDOW_MS);
  const expiryReason = expiresAt <= startedAt + WEBHOOK_RETRY_WINDOW_MS
    ? 'delivery_expired' as const : 'retry_window_exceeded' as const;
  if (now >= deadline) return { status: 'dead', reason: expiryReason, nextAttemptAt: null };
  if (input.completedAttempts >= 6) return { status: 'dead', reason: 'retry_limit', nextAttemptAt: null };
  const base = WEBHOOK_RETRY_DELAYS_MS[input.completedAttempts - 1];
  const next = Math.max(now + base + Math.floor(base * 0.2 * sample), retryAfterTime(input.retryAfter, now));
  if (!Number.isSafeInteger(next) || next >= deadline) {
    return { status: 'dead', reason: expiryReason, nextAttemptAt: null };
  }
  return { status: 'retry_wait', nextAttemptAt: new Date(next).toISOString() };
}