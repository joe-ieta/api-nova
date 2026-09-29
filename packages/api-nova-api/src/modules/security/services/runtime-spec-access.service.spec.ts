import { ConfigService } from '@nestjs/config';
import {
  RUNTIME_SPEC_ACCESS_TOKEN_PREFIX,
  RuntimeSpecAccessService,
} from './runtime-spec-access.service';

const secret = 'runtime-spec-access-fixture-secret-value-0123456789';
const assetA = '00000000-0000-0000-0000-00000000000a';
const assetB = '00000000-0000-0000-0000-00000000000b';
const serverId = '00000000-0000-0000-0000-00000000000c';

function service(now: () => number = () => 1_000_000, value: string = secret) {
  return new RuntimeSpecAccessService(
    { get: (key: string) => (key === 'JWT_SECRET' ? value : undefined) } as unknown as ConfigService,
    { now },
  );
}

describe('RuntimeSpecAccessService', () => {
  it('mints a prefixed, deterministic, asset-bound grant that verifies', () => {
    const access = service();
    const token = access.mint({ runtimeAssetId: assetA, serverId, ttlSeconds: 300 });
    expect(token.startsWith(RUNTIME_SPEC_ACCESS_TOKEN_PREFIX)).toBe(true);
    expect(token).toHaveLength(RUNTIME_SPEC_ACCESS_TOKEN_PREFIX.length + encodedPayloadLength(token) + 44);
    const grant = access.verify(token);
    expect(grant).toEqual({ runtimeAssetId: assetA, serverId, expiresAt: 1_000_300 });
  });

  it('fails closed on missing configuration or malformed grant inputs', () => {
    expect(() => new RuntimeSpecAccessService({ get: () => undefined } as unknown as ConfigService)).toThrow();
    const access = service();
    expect(() => access.mint(undefined as any)).toThrow('Invalid runtime spec access grant');
    expect(() => access.mint({ runtimeAssetId: '', serverId })).toThrow();
    expect(() => access.mint({ runtimeAssetId: assetA, serverId: 'bad\nvalue' })).toThrow();
    expect(() => access.mint({ runtimeAssetId: assetA, serverId, ttlSeconds: 0 })).toThrow();
    expect(() => access.mint({ runtimeAssetId: assetA, serverId, ttlSeconds: 3601 })).toThrow();
  });

  it('rejects tampered payloads, tampered signatures and foreign secrets', () => {
    const access = service();
    const token = access.mint({ runtimeAssetId: assetA, serverId });
    const [prefix, payload, signature] = token.split('.');
    const flippedPayload = Buffer.from(payload, 'base64url');
    flippedPayload[0] = flippedPayload[0] ^ 0x01;
    const tamperedPayload = `${prefix}.${flippedPayload.toString('base64url')}.${signature}`;
    expect(access.verify(tamperedPayload)).toBeNull();
    const flippedSignature = Buffer.from(signature, 'base64url');
    flippedSignature[0] = flippedSignature[0] ^ 0x01;
    expect(access.verify(`${prefix}.${payload}.${flippedSignature.toString('base64url')}`)).toBeNull();
    const other = service(() => 1_000_000, 'another-runtime-spec-access-fixture-secret-0123456789');
    expect(other.verify(token)).toBeNull();
  });

  it('rejects expired, far-future, oversized and structurally invalid tokens', () => {
    const access = service();
    const token = access.mint({ runtimeAssetId: assetA, serverId, ttlSeconds: 60 });
    expect(access.verify(token, 1_000_059)).not.toBeNull();
    expect(access.verify(token, 1_000_060)).toBeNull();
    expect(access.verify(token, 1_000_061)).toBeNull();
    expect(access.verify('x'.repeat(4097))).toBeNull();
    expect(access.verify('')).toBeNull();
    expect(access.verify(undefined)).toBeNull();
    expect(access.verify(1234)).toBeNull();
    expect(access.verify(`${RUNTIME_SPEC_ACCESS_TOKEN_PREFIX}not-json.signature`)).toBeNull();
    const body = Buffer.from(JSON.stringify({
      v: 1, runtimeAssetId: assetA, serverId, exp: 1_000_060, extra: true,
    }), 'utf8').toString('base64url');
    expect(access.verify(`${RUNTIME_SPEC_ACCESS_TOKEN_PREFIX}${body}.${'a'.repeat(43)}`)).toBeNull();
    const future = Buffer.from(JSON.stringify({
      v: 1, runtimeAssetId: assetA, serverId, exp: 1_000_000 + 3601 + 61,
    }), 'utf8').toString('base64url');
    const signature = (access as any).signature(`${RUNTIME_SPEC_ACCESS_TOKEN_PREFIX}${future}`).toString('base64url');
    expect(access.verify(`${RUNTIME_SPEC_ACCESS_TOKEN_PREFIX}${future}.${signature}`)).toBeNull();
  });
});

function encodedPayloadLength(token: string): number {
  const body = token.slice(RUNTIME_SPEC_ACCESS_TOKEN_PREFIX.length);
  return body.slice(0, body.indexOf('.')).length;
}
