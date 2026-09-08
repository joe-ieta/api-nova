import { createHash } from 'crypto';

export const ZERO_SEQUENCE = '00000000000000000000';
export const MAX_SEQUENCE = BigInt('18446744073709551615');
export const DAY_MS = 24 * 60 * 60 * 1000;

export class ObservabilityStorageError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'ObservabilityStorageError';
  }
}

export function sequenceKey(value: string | bigint): string {
  const text = String(value);
  if (!/^[0-9]{1,20}$/.test(text)) throw new ObservabilityStorageError('INVALID_SEQUENCE');
  const number = BigInt(text);
  if (number > MAX_SEQUENCE) throw new ObservabilityStorageError('SEQUENCE_EXHAUSTED');
  return number.toString().padStart(20, '0');
}

export function publicSequence(value: string): string {
  return BigInt(sequenceKey(value)).toString();
}

export function contentHash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Deterministic JSON for receipt identity, never a diagnostic log of the input. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 64) throw new ObservabilityStorageError('INVALID_RECORD_DEPTH');
    if (item === null || item === undefined) return null;
    if (typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || ancestors.has(item)) {
      throw new ObservabilityStorageError('INVALID_RECORD_VALUE');
    }
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return item.map(entry => visit(entry, depth + 1));
      return Object.fromEntries(Object.keys(item).sort()
        .filter(key => (item as Record<string, unknown>)[key] !== undefined)
        .map(key => [key, visit((item as Record<string, unknown>)[key], depth + 1)]));
    } finally {
      ancestors.delete(item);
    }
  };
  return JSON.stringify(visit(value, 0));
}

export function expiresAfter(isoTime: string, days: number): string {
  const milliseconds = Date.parse(isoTime);
  if (!Number.isFinite(milliseconds) || !Number.isFinite(days) || days < 0) {
    throw new ObservabilityStorageError('INVALID_RETENTION');
  }
  return new Date(milliseconds + days * DAY_MS).toISOString();
}

/** A bounded local lane; PostgreSQL also uses a database row lock across processes. */
export class SerialStorageLane {
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;

  constructor(private readonly capacity = 32) {}

  get pending(): number { return this.queued; }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.queued >= this.capacity) throw new ObservabilityStorageError('STORAGE_BUSY');
    this.queued++;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    try {
      await previous;
      return await operation();
    } finally {
      this.queued--;
      release();
    }
  }
}
