import { GatewayAccessLogService } from './gateway-access-log.service';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('GatewayAccessLogService', () => {
  it('records denied admissions and cache hits without fabricating upstream calls', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'api-nova-admission-audit-'));
    const previous = process.env.API_NOVA_AUDIT_DIR;
    process.env.API_NOVA_AUDIT_DIR = directory;
    try {
      const { service } = buildService();
      const input = { resolvedRoute: { runtimeAsset: { id: 'runtime-1' }, membership: { id: 'member-1' },
        routeBinding: { id: 'route-1', routePath: '/orders' }, endpointDefinition: { id: 'api-1' } } as any,
        req: { method: 'GET', originalUrl: '/orders?token=secret', headers: { authorization: 'Bearer private-token' } } as any,
        latencyMs: 10 };
      await service.recordRequest({ ...input, requestId: 'denied', statusCode: 401, errorMessage: 'invalid_token' });
      await service.recordRequest({ ...input, requestId: 'cached', upstreamUrl: 'cache://gateway',
        proxyResult: { statusCode: 200, headers: { 'content-type': 'application/json' },
          responseBodyBuffer: Buffer.from(JSON.stringify({ value: 'x'.repeat(9000), password: 'cached-secret' })) } });
      const file = (await readdir(directory)).find(name => /^\d{4}-/.test(name))!;
      const raw = await readFile(join(directory, file), 'utf8');
      expect(raw).not.toMatch(/private-token|cached-secret|token=secret/);
      const [denied, cached] = raw.trim().split('\n').map(line => JSON.parse(line));
      expect(denied).toMatchObject({ kind: 'admission', endpointDefinitionId: 'api-1', outcome: 'error', statusCode: 401,
        request: { state: 'omitted', reason: 'body_not_consumed_at_admission' } });
      expect(denied.response).toBeUndefined();
      expect(cached).toMatchObject({ kind: 'admission', outcome: 'cache_hit', statusCode: 200 });
      expect(JSON.parse(cached.response.data).value).toHaveLength(9000);
    } finally {
      if (previous === undefined) delete process.env.API_NOVA_AUDIT_DIR; else process.env.API_NOVA_AUDIT_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
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
