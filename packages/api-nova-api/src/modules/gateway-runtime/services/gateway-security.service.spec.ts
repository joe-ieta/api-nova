import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { AuditAction } from '../../../database/entities/audit-log.entity';
import { GatewaySecurityService } from './gateway-security.service';

describe('GatewaySecurityService', () => {
  const buildService = () => {
    const jwtService = {
      verify: jest.fn(),
    };
    const userService = {
      findUserById: jest.fn(),
    };
    const auditService = {
      log: jest.fn().mockResolvedValue(undefined),
    };
    const credentialRepository = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation(async value => value),
    };

    return {
      service: new GatewaySecurityService(
        jwtService as unknown as JwtService,
        userService as any,
        auditService as any,
        credentialRepository as any,
      ),
      jwtService,
      userService,
      auditService,
      credentialRepository,
    };
  };

  const resolvedRoute = (mode: 'anonymous' | 'jwt' | 'api_key') =>
    ({
      routeBinding: {
        id: 'route-1',
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

  it('allows anonymous routes without credentials', async () => {
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

  it('validates jwt routes and attaches the authenticated user', async () => {
    const { service, jwtService, userService } = buildService();
    jwtService.verify.mockReturnValue({ sub: 'user-1' });
    userService.findUserById.mockResolvedValue({
      id: 'user-1',
      isActive: true,
    });
    const req = {
      headers: {
        authorization: 'Bearer token-123',
      },
      query: {},
    } as any;

    await expect(service.authorize(resolvedRoute('jwt'), req)).resolves.toEqual({
      mode: 'jwt',
      actorId: 'user-1',
    });
    expect(jwtService.verify).toHaveBeenCalledWith('token-123');
    expect(req.user).toEqual({
      id: 'user-1',
      isActive: true,
    });
  });

  it('rejects jwt routes without a bearer token', async () => {
    const { service } = buildService();

    await expect(
      service.authorize(resolvedRoute('jwt'), { headers: {}, query: {} } as any),
    ).rejects.toThrow(UnauthorizedException);
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
    expect(credentialRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'consumer-1',
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
});
