import { GatewayAccessLogService } from './gateway-access-log.service';

describe('GatewayAccessLogService', () => {
  const buildService = () => {
    const create = jest.fn().mockImplementation((input: any) => input);
    const save = jest.fn().mockResolvedValue(undefined);
    const createQueryBuilder = jest.fn();

    const repository = {
      create,
      save,
      createQueryBuilder,
      find: jest.fn().mockResolvedValue([]),
    };

    return {
      service: new GatewayAccessLogService(repository as any),
      repository,
    };
  };

  it('redacts sensitive headers and marks preview captures correctly', async () => {
    const { service, repository } = buildService();

    await service.recordRequest({
      resolvedRoute: {
        runtimeAsset: { id: 'runtime-1' },
        membership: { id: 'membership-1' },
        routeBinding: { id: 'route-1', routePath: '/pets' },
        endpointDefinition: { id: 'endpoint-1' },
      } as any,
      requestId: 'req-1',
      correlationId: 'corr-1',
      req: {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          cookie: 'session=secret',
          'content-type': 'application/json',
        },
        query: { include: 'owner' },
        ip: '127.0.0.1',
        user: { id: 'user-1' },
        gatewayAuth: {
          mode: 'api_key',
          consumerId: 'consumer-1',
          keyId: 'key-live',
        },
      } as any,
      upstreamUrl: 'https://api.example.com/pets',
      proxyResult: {
        statusCode: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'server-secret',
        },
        requestCapture: {
          totalBytes: 20,
          preview: '{"ok":true}',
          hash: 'request-hash',
          truncated: false,
        },
        responseCapture: {
          totalBytes: 40,
          preview: '{"result":true}',
          hash: 'response-hash',
          truncated: false,
        },
      } as any,
      latencyMs: 15,
    });

    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        captureMode: 'body_preview',
        requestHeaders: expect.objectContaining({
          authorization: '[REDACTED]',
          cookie: '[REDACTED]',
        }),
        responseHeaders: expect.objectContaining({
          'set-cookie': '[REDACTED]',
        }),
        actorId: 'user-1',
        authMode: 'api_key',
        consumerId: 'consumer-1',
        credentialKeyId: 'key-live',
        requestBodyPreview: '{"ok":true}',
        responseBodyPreview: '{"result":true}',
      }),
    );
    expect(repository.save).toHaveBeenCalled();
  });

  it('marks failed requests as body_on_error when no preview is available', async () => {
    const { service, repository } = buildService();

    await service.recordRequest({
      resolvedRoute: {
        runtimeAsset: { id: 'runtime-1' },
        membership: { id: 'membership-1' },
        routeBinding: { id: 'route-1', routePath: '/download' },
        endpointDefinition: { id: 'endpoint-1' },
      } as any,
      requestId: 'req-error',
      req: {
        method: 'GET',
        headers: {},
        query: {},
      } as any,
      latencyMs: 50,
      errorMessage: 'Gateway upstream timeout after 20ms',
    });

    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        captureMode: 'body_on_error',
        errorMessage: 'Gateway upstream timeout after 20ms',
      }),
    );
  });

  it('records unmatched gateway requests without runtime asset context', async () => {
    const { service, repository } = buildService();

    await service.recordUnmatchedRequest({
      requestId: 'req-miss',
      correlationId: 'corr-miss',
      req: {
        method: 'GET',
        headers: {
          host: 'gateway.local',
        },
        query: { page: '1' },
        gatewayAuth: {
          mode: 'anonymous',
        },
        ip: '127.0.0.1',
      } as any,
      routePath: '/missing',
      latencyMs: 2,
      statusCode: 404,
      errorMessage: 'No active gateway route for GET /missing',
    });

    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-miss',
        correlationId: 'corr-miss',
        routePath: '/missing',
        statusCode: 404,
        authMode: 'anonymous',
        captureMode: 'meta_only',
        errorMessage: 'No active gateway route for GET /missing',
      }),
    );
  });
});
