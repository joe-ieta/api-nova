import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { requireManagementJwtSecret } from '../utils/management-jwt-secret';

export const RUNTIME_SPEC_ACCESS_TOKEN_PREFIX = 'apinova-spec-v1.';
export const RUNTIME_SPEC_ACCESS_HEADER = 'x-api-key';
export const RUNTIME_SPEC_ACCESS_DENIED = 'runtime_spec_access_denied';

const KEY_DOMAIN = 'api-nova:runtime-spec-access:v1';
const DEFAULT_TTL_SECONDS = 900;
const MAX_TTL_SECONDS = 3600;
const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_LENGTH = 4096;
const MAX_IDENTIFIER_LENGTH = 200;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BODY_PATTERN = /^[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{43}$/;
const PAYLOAD_KEYS = ['v', 'runtimeAssetId', 'serverId', 'exp'];

export interface RuntimeSpecAccessGrantInput {
  runtimeAssetId: string;
  serverId: string;
  ttlSeconds?: number;
}

export interface RuntimeSpecAccessGrant {
  runtimeAssetId: string;
  serverId: string;
  expiresAt: number;
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

@Injectable()
export class RuntimeSpecAccessService {
  private readonly key: Buffer;
  private readonly now: () => number;

  constructor(config: ConfigService, @Optional() options: { now?: () => number } = {}) {
    this.key = createHmac('sha256', requireManagementJwtSecret(config.get<string>('JWT_SECRET')))
      .update(KEY_DOMAIN)
      .digest();
    this.now = options.now ?? (() => Date.now() / 1000);
  }

  private signature(text: string): Buffer {
    return createHmac('sha256', this.key).update(text).digest();
  }

  mint(input: RuntimeSpecAccessGrantInput): string {
    if (!input || !identifier(input.runtimeAssetId) || !identifier(input.serverId)) {
      throw new Error('Invalid runtime spec access grant');
    }
    const ttl = input.ttlSeconds === undefined ? DEFAULT_TTL_SECONDS : input.ttlSeconds;
    if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > MAX_TTL_SECONDS) {
      throw new Error('Invalid runtime spec access grant');
    }
    const body = Buffer.from(JSON.stringify({
      v: 1,
      runtimeAssetId: input.runtimeAssetId,
      serverId: input.serverId,
      exp: Math.floor(this.now()) + ttl,
    }), 'utf8').toString('base64url');
    const signed = `${RUNTIME_SPEC_ACCESS_TOKEN_PREFIX}${body}`;
    return `${signed}.${this.signature(signed).toString('base64url')}`;
  }

  verify(token: unknown, nowSeconds?: number): RuntimeSpecAccessGrant | null {
    try {
      if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH ||
        !token.startsWith(RUNTIME_SPEC_ACCESS_TOKEN_PREFIX)) return null;
      const body = token.slice(RUNTIME_SPEC_ACCESS_TOKEN_PREFIX.length);
      if (!BODY_PATTERN.test(body)) return null;
      const separator = body.indexOf('.');
      const encodedPayload = body.slice(0, separator);
      const encodedSignature = body.slice(separator + 1);
      if (!SIGNATURE_PATTERN.test(encodedSignature)) return null;
      const expected = this.signature(`${RUNTIME_SPEC_ACCESS_TOKEN_PREFIX}${encodedPayload}`);
      const provided = Buffer.from(encodedSignature, 'base64url');
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
      const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        Object.keys(payload).sort().join('|') !== PAYLOAD_KEYS.slice().sort().join('|')) return null;
      if (payload.v !== 1 || !identifier(payload.runtimeAssetId) || !identifier(payload.serverId) ||
        !Number.isSafeInteger(payload.exp)) return null;
      const now = nowSeconds === undefined ? this.now() : nowSeconds;
      if (!Number.isFinite(now) || payload.exp <= now || payload.exp > now + MAX_TTL_SECONDS + CLOCK_SKEW_SECONDS) return null;
      return { runtimeAssetId: payload.runtimeAssetId, serverId: payload.serverId, expiresAt: payload.exp };
    } catch {
      return null;
    }
  }
}
