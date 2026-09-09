import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { ObservabilityAuthorization } from './call-observability-access';
import { ObservabilityApiError } from './call-observability-api.contract';
import { ObservabilityFilter } from './call-observability-query';
import { canonicalJson, contentHash, publicSequence } from './call-observability-storage';

export interface ObservabilityCursorBinding {
  kind: 'query' | 'event';
  endpoint: string;
  sort: string;
  authorization: ObservabilityAuthorization;
}
export interface ObservabilityCursor {
  version: 1;
  keyId: string;
  kind: 'query' | 'event';
  endpoint: string;
  sort: string;
  scopeHash: string;
  filter: ObservabilityFilter;
  snapshotSeq: string;
  position: Record<string, string | number | null>;
  issuedAt: number;
  expiresAt: number;
}

@Injectable()
export class ObservabilityCursorService {
  constructor(private readonly config: ConfigService) {}

  private signingKey(): { secret: string; keyId: string } {
    const secret = this.config.get<string>('API_NOVA_OBSERVABILITY_CURSOR_SECRET');
    const keyId = this.config.get<string>('API_NOVA_OBSERVABILITY_CURSOR_KEY_ID') || 'v1';
    if (!secret || Buffer.byteLength(secret) < 32 || !/^[A-Za-z0-9_-]{1,32}$/.test(keyId)) {
      throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
    }
    return { secret, keyId };
  }

  issue(
    binding: ObservabilityCursorBinding,
    state: Pick<ObservabilityCursor, 'filter' | 'snapshotSeq' | 'position'>,
    ttlMs = 15 * 60000,
  ): string {
    const maximum = binding.kind === 'event' ? 14 * 86400000 : 3600000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > maximum) throw new ObservabilityApiError('INVALID_QUERY', 'cursor');
    const { secret, keyId } = this.signingKey();
    const issuedAt = Date.now();
    const cursor: ObservabilityCursor = {
      ...state, version: 1, keyId, kind: binding.kind, endpoint: binding.endpoint, sort: binding.sort,
      scopeHash: binding.authorization.fingerprint,
      snapshotSeq: publicSequence(state.snapshotSeq), issuedAt, expiresAt: issuedAt + ttlMs,
    };
    this.validate(cursor);
    const body = Buffer.from(canonicalJson(cursor)).toString('base64url');
    const signature = createHmac('sha256', secret).update('observability.cursor.v1.' + body).digest('base64url');
    const token = body + '.' + signature;
    if (token.length > 8192) throw new ObservabilityApiError('QUERY_TOO_LARGE', 'cursor');
    return token;
  }

  /** Verify signature and current authorization BEFORE using any cursor filters. */
  open(token: string, binding: ObservabilityCursorBinding): ObservabilityCursor {
    if (typeof token !== 'string' || token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new ObservabilityApiError('INVALID_QUERY', 'cursor');
    }
    const { secret, keyId } = this.signingKey();
    const [body, supplied] = token.split('.');
    const expected = createHmac('sha256', secret).update('observability.cursor.v1.' + body).digest();
    const signature = Buffer.from(supplied, 'base64url');
    if (signature.toString('base64url') !== supplied || signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
      throw new ObservabilityApiError('INVALID_QUERY', 'cursor');
    }
    let cursor: ObservabilityCursor;
    try {
      const bytes = Buffer.from(body, 'base64url');
      if (bytes.toString('base64url') !== body) throw new Error('Invalid encoding');
      cursor = JSON.parse(bytes.toString('utf8'));
      this.validate(cursor);
    } catch { throw new ObservabilityApiError('INVALID_QUERY', 'cursor'); }
    if (cursor.keyId !== keyId || cursor.kind !== binding.kind || cursor.endpoint !== binding.endpoint ||
      cursor.sort !== binding.sort || cursor.scopeHash !== binding.authorization.fingerprint) {
      throw new ObservabilityApiError('CURSOR_SCOPE_MISMATCH');
    }
    if (cursor.expiresAt <= Date.now()) {
      throw new ObservabilityApiError(cursor.kind === 'event' ? 'EVENT_CURSOR_EXPIRED' : 'QUERY_CURSOR_EXPIRED');
    }
    return cursor;
  }

  assertFilter(cursor: ObservabilityCursor, filter: ObservabilityFilter): void {
    if (contentHash(canonicalJson(cursor.filter)) !== contentHash(canonicalJson(filter))) {
      throw new ObservabilityApiError('CURSOR_SCOPE_MISMATCH');
    }
  }

  private validate(cursor: ObservabilityCursor): void {
    const scalar = (value: unknown) => (typeof value === 'string' && value.length <= 1000) ||
      (typeof value === 'number' && Number.isSafeInteger(value)) || typeof value === 'boolean';
    if (!cursor || cursor.version !== 1 || !['query','event'].includes(cursor.kind) ||
      typeof cursor.keyId !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(cursor.keyId) ||
      typeof cursor.endpoint !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(cursor.endpoint) ||
      typeof cursor.sort !== 'string' || cursor.sort.length > 256 ||
      typeof cursor.scopeHash !== 'string' || !/^[a-f0-9]{64}$/.test(cursor.scopeHash) ||
      !Number.isSafeInteger(cursor.issuedAt) || !Number.isSafeInteger(cursor.expiresAt) ||
      cursor.issuedAt > Date.now() + 30000 || cursor.expiresAt <= cursor.issuedAt ||
      cursor.expiresAt - cursor.issuedAt > (cursor.kind === 'event' ? 14 * 86400000 : 3600000) ||
      !cursor.filter || typeof cursor.filter !== 'object' || Array.isArray(cursor.filter) ||
      Object.keys(cursor.filter).length > 40 || Object.values(cursor.filter).some(value =>
        !(scalar(value) || (Array.isArray(value) && value.length <= 2 && value.every(scalar)))) ||
      !cursor.position || typeof cursor.position !== 'object' || Array.isArray(cursor.position) ||
      Object.keys(cursor.position).length > 8 || Object.values(cursor.position).some(value =>
        value !== null && !((typeof value === 'string' && value.length <= 500) || (typeof value === 'number' && Number.isSafeInteger(value)))) ||
      typeof cursor.snapshotSeq !== 'string' || publicSequence(cursor.snapshotSeq) !== cursor.snapshotSeq) {
      throw new ObservabilityApiError('INVALID_QUERY', 'cursor');
    }
  }
}
