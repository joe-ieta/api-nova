import { createHash } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { AuditAction } from '../../../database/entities/audit-log.entity';
import { GatewaySecurityService } from './gateway-security.service';

describe('GatewaySecurityService', () => {
  const buildService = () => {
    const auditService = {
      log: jest.fn().mockResolvedValue(undefined),
    };
    const credentialRepository = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation(async value => value),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    return {
      service: new GatewaySecurityService(
        auditService as any,
        credentialRepository as any,
      ),
      auditService,
      credentialRepository,
    };
  };

  const resolvedRoute = (mode: 'anonymous' | 'jwt' | 'api_key') =>
    ({
      routeBinding: {
        id: 'route-1',
        // Anonymous access is only allowed on explicitly external routes;
        // internal (default) routes are forced to require a JWT.
        routeVisibility: mode === 'anonymous' ? 'external' : 'internal',
      },
      runtimeAsset: {
        id: 'runtime-1',
      },
      policies: {
        auth: {
          mode,
        },
      },
    } as any);

  it('allows anonymous routes without credentials when visibility is external', async () => {
    const { service } = buildService();
    const req = {
      headers: {},
      query: {},
    } as any;

    await expect(service.authorize(resolvedRoute('anonymous'), req)).resolves.toEqual({
      mode: 'anonymous',
    });
    expect(req.gatewayAuth).toEqual({ mode: 'anonymous' });
  });

  it('validates jwt routes with the shared runtime validator', async () => {
    const { service } = buildService();
    const principal = { callerId: 'caller-1', issuer: 'https://issuer.example',
      subject: 'user-1', identitySource: 'authenticated' as const, scopes: ['api:invoke'] };
    const authenticate = jest.fn().mockResolvedValue(principal);
    (service as any).authenticateJwt = authenticate;
    const req = {
      headers: {
        authorization: 'Bearer token-123',
      },
      query: {},
    } as any;

    await expect(service.authorize(resolvedRoute('jwt'), req)).resolves.toEqual({
      mode: 'jwt',
      principal,
    });
    expect(authenticate).toHaveBeenCalledWith(req.headers);
  });

  it('rejects jwt routes without a bearer token', async () => {
    const { service } = buildService();
    await expect(
      service.authorize(resolvedRoute('jwt'), { headers: {}, query: {} } as any),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('validates active api keys scoped to the runtime asset', async () => {
    const { service, credentialRepository, auditService } = buildService();
    credentialRepository.findOne.mockResolvedValue({
      id: 'consumer-1',
      keyId: 'key-live',
      secretHash: createHash('sha256').update('secret-live').digest('hex'),
      status: 'active',
      runtimeAssetId: 'runtime-1',
    });
    const req = {
      headers: {
        'x-api-key': 'key-live.secret-live',
      },
      query: {},
    } as any;

    await expect(service.authorize(resolvedRoute('api_key'), req)).resolves.toEqual({
      mode: 'api_key',
      consumerId: 'consumer-1',
      keyId: 'key-live',
    });
    expect(credentialRepository.update).toHaveBeenCalledWith(
      'consumer-1', expect.objectContaining({
        lastUsedAt: expect.any(Date),
      }),
    );
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.API_KEY_USED,
        resource: 'gateway_consumer_credential',
        resourceId: 'consumer-1',
      }),
    );
  });

  it('supports explicit api key query parameter extraction', async () => {
    const { service, credentialRepository } = buildService();
    credentialRepository.findOne.mockResolvedValue({
      id: 'consumer-2',
      keyId: 'key-query',
      secretHash: createHash('sha256').update('secret-query').digest('hex'),
      status: 'active',
    });
    const req = {
      headers: {},
      query: {
        api_key: 'key-query.secret-query',
      },
    } as any;
    const route = resolvedRoute('api_key');
    route.policies.auth.apiKeyQueryParamName = 'api_key';

    await expect(service.authorize(route, req)).resolves.toEqual({
      mode: 'api_key',
      consumerId: 'consumer-2',
      keyId: 'key-query',
    });
  });

  it('rejects invalid api keys', async () => {
    const { service, credentialRepository } = buildService();
    credentialRepository.findOne.mockResolvedValue({
      id: 'consumer-1',
      keyId: 'key-live',
      secretHash: createHash('sha256').update('different-secret').digest('hex'),
      status: 'active',
    });

    await expect(
      service.authorize(
        resolvedRoute('api_key'),
        {
          headers: {
            'x-api-key': 'key-live.secret-live',
          },
          query: {},
        } as any,
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it.each(['internal', undefined, 'INTERNAL', 'unknown'])(
    'requires shared runtime authentication for anonymous policy with visibility %s', async visibility => {
      const { service } = buildService();
      const route = resolvedRoute('anonymous');
      route.routeBinding.routeVisibility = visibility;
      await expect(service.authorize(route, { headers: {}, query: {} } as any))
        .rejects.toMatchObject({ status: 401 });
    },
  );

  it('authenticates internal anonymous-policy routes with the shared runtime principal', async () => {
    const { service } = buildService();
    const principal = { callerId: 'caller-1', scopes: ['api:invoke'] };
    const authenticate = jest.fn().mockResolvedValue(principal);
    (service as any).authenticateJwt = authenticate;
    const route = resolvedRoute('anonymous');
    route.routeBinding.routeVisibility = 'internal';
    await expect(service.authorize(route, { headers: { authorization: 'Bearer token' } } as any))
      .resolves.toEqual({ mode: 'jwt', principal });
  });


  describe.each([false, true])('invalid policy with existing identity=%s', existingIdentity => {
    const invalidPolicies: Array<[string, any]> = [
      ['missing policies', undefined],
      ['missing auth', {}],
      ['null auth', { auth: null }],
      ...[undefined, null, '', 'unknown', 'oauth', 'runtime-api-key', 'JWT', 'API_KEY', 'Anonymous', ' jwt ']
        .map(mode => [`mode ${String(mode)}`, { auth: { mode } }] as [string, any]),
    ];
    it.each(invalidPolicies)('rejects %s before authentication or identity mutation', async (_label, policies) => {
      const { service, credentialRepository, auditService } = buildService();
      credentialRepository.findOne.mockResolvedValue({
        id: 'consumer-1', keyId: 'key-live', status: 'active', runtimeAssetId: 'runtime-1',
        secretHash: createHash('sha256').update('secret-live').digest('hex'),
      });
      const authenticate = jest.fn().mockResolvedValue({ callerId: 'new-identity' });
      (service as any).authenticateJwt = authenticate;
      const identity = Object.freeze({ mode: 'jwt', principal: Object.freeze({ callerId: 'existing-caller' }) });
      const req: any = { headers: { 'x-api-key': 'key-live.secret-live', authorization: 'Bearer valid-token' }, query: {} };
      if (existingIdentity) Object.defineProperty(req, 'gatewayAuth', {
        value: identity, enumerable: true, writable: false, configurable: false,
      });
      const route = resolvedRoute('api_key');
      route.policies = policies;
      await expect(service.authorize(route, req)).rejects.toMatchObject({
        status: 503, response: 'gateway_auth_policy_invalid',
      });
      expect(credentialRepository.findOne).not.toHaveBeenCalled();
      expect(credentialRepository.save).not.toHaveBeenCalled();
      expect(authenticate).not.toHaveBeenCalled();
      expect(auditService.log).not.toHaveBeenCalled();
      expect(Object.prototype.hasOwnProperty.call(req, 'gatewayAuth')).toBe(existingIdentity);
      expect(req.gatewayAuth).toBe(existingIdentity ? identity : undefined);
    });
  });
});
