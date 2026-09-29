import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RuntimeSpecAccessGuard } from './runtime-spec-access.guard';
import { RuntimeSpecAccessService } from '../../security/services/runtime-spec-access.service';

const secret = 'runtime-spec-access-guard-fixture-secret-0123456789';
const ownAsset = '00000000-0000-0000-0000-0000000000a1';
const foreignAsset = '00000000-0000-0000-0000-0000000000b2';
const serverId = '00000000-0000-0000-0000-0000000000c3';

function context(headers: Record<string, unknown>, runtimeAssetId = ownAsset): ExecutionContext {
  const request: any = { headers, params: { runtimeAssetId }, socket: { remoteAddress: '127.0.0.1' } };
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}), getNext: () => undefined }),
    getHandler: () => undefined,
    getClass: () => undefined,
    getArgs: () => [],
    getArgByIndex: () => undefined,
    switchToRpc: () => ({}) as any,
    switchToWs: () => ({}) as any,
    getType: () => 'http',
  } as unknown as ExecutionContext;
}

function fixture(options: { now?: () => number; jwtAllowed?: boolean } = {}) {
  const tokenService = new RuntimeSpecAccessService(
    { get: (key: string) => (key === 'JWT_SECRET' ? secret : undefined) } as unknown as ConfigService,
    options.now ? { now: options.now } : {},
  );
  const audit: { log: jest.Mock } = { log: jest.fn(async () => undefined) };
  const jwtAuthGuard = {
    canActivate: options.jwtAllowed === false
      ? jest.fn(async () => { throw new UnauthorizedException('认证失败'); })
      : jest.fn(async () => true),
  };
  const guard = new RuntimeSpecAccessGuard(jwtAuthGuard as any, tokenService, audit as any);
  return { guard, tokenService, audit, jwtAuthGuard };
}

const promiseOf = (value: unknown) => (value instanceof Promise ? value : Promise.resolve(value));

describe('RuntimeSpecAccessGuard', () => {
  it('denies missing credentials without auditing', async () => {
    const { guard, audit } = fixture();
    await expect(promiseOf(guard.canActivate(context({})))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('denies invalid, tampered and expired credentials', async () => {
    const clock = { value: 1_000_000 };
    const { guard, tokenService, audit } = fixture({ now: () => clock.value });
    await expect(promiseOf(guard.canActivate(context({ 'x-api-key': 'bogus' })))).rejects.toBeInstanceOf(UnauthorizedException);
    const token = tokenService.mint({ runtimeAssetId: ownAsset, serverId, ttlSeconds: 1 });
    clock.value = 1_000_002;
    await expect(promiseOf(guard.canActivate(context({ 'x-api-key': token })))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('denies a valid credential minted for another runtime asset', async () => {
    const { guard, tokenService, audit } = fixture();
    const foreign = tokenService.mint({ runtimeAssetId: foreignAsset, serverId });
    await expect(promiseOf(guard.canActivate(context({ 'x-api-key': foreign }, ownAsset)))).rejects.toBeInstanceOf(ForbiddenException);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('allows the owning runtime asset credential and audits sanitized metadata only', async () => {
    const { guard, tokenService, audit } = fixture();
    const token = tokenService.mint({ runtimeAssetId: ownAsset, serverId });
    await expect(promiseOf(guard.canActivate(context({ 'x-api-key': token })))).resolves.toBe(true);
    expect(audit.log).toHaveBeenCalledTimes(1);
    const entry = audit.log.mock.calls[0][0];
    expect(entry).toMatchObject({
      action: 'api_called', level: 'info', status: 'success',
      resource: 'openapi.spec_access', resourceId: ownAsset,
      details: { channel: 'runtime-spec-token', runtimeAssetId: ownAsset, serverId },
    });
    expect(JSON.stringify(entry)).not.toContain(token);
  });

  it('keeps the management JWT path on the original guard and does not consult the runtime credential', async () => {
    const { guard, jwtAuthGuard, tokenService, audit } = fixture();
    const verify = jest.spyOn(tokenService, 'verify');
    await expect(promiseOf(guard.canActivate(context({ authorization: 'Bearer management.token' })))).resolves.toBe(true);
    expect(jwtAuthGuard.canActivate).toHaveBeenCalledTimes(1);
    expect(verify).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('surfaces management JWT rejection instead of accepting a missing runtime credential', async () => {
    const { guard, audit } = fixture({ jwtAllowed: false });
    await expect(promiseOf(guard.canActivate(context({ authorization: 'Bearer expired.management' })))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('fails closed when the credential header is not a string', async () => {
    const { guard } = fixture();
    await expect(promiseOf(guard.canActivate(context({ 'x-api-key': ['a', 'b'] })))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('does not block the request when audit persistence fails', async () => {
    const { guard, tokenService, audit } = fixture();
    audit.log.mockRejectedValue(new Error('fixture audit failure'));
    const token = tokenService.mint({ runtimeAssetId: ownAsset, serverId });
    await expect(promiseOf(guard.canActivate(context({ 'x-api-key': token })))).resolves.toBe(true);
  });
});
