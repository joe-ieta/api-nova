import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { UnauthorizedException } from '@nestjs/common';
import { flushRuntimeAudit, getRuntimeAuditHealth, normalizeRuntimeAuditRecord } from 'api-nova-parser';
import { beginGatewayRequestAudit } from './gateway-request-audit';
import { ensureGatewayRequestId } from './gateway-audit-context';
import { GatewayAccessLogService } from './gateway-access-log.service';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('GatewayAccessLogService', () => {
  it('records denied admissions and cache hits without fabricating upstream calls', async () => {
    await flushRuntimeAudit();
    const directory = await mkdtemp(join(tmpdir(), 'api-nova-admission-audit-'));
    const previous = process.env.API_NOVA_AUDIT_DIR;
    const health = getRuntimeAuditHealth();
    process.env.API_NOVA_AUDIT_DIR = directory;
    const { service, repository } = buildService();
    const route = { runtimeAsset: { id: 'runtime-1' }, membership: { id: 'member-1' },
      routeBinding: { id: 'route-1', routePath: '/orders' }, endpointDefinition: { id: 'api-1' },
      policies: { auth: { mode: 'anonymous' } } } as any;
    const body = JSON.stringify({ value: 'x'.repeat(9000), password: 'cached-secret' });
    const gateway = http.createServer(async (req, res) => {
      (req as any).originalUrl = req.url;
      const requestId = ensureGatewayRequestId(req as any, res as any);
      const audit = beginGatewayRequestAudit(req as any, res as any, requestId, route);
      await audit.run(async () => {
        if (req.url!.startsWith('/denied')) {
          audit.failed(new UnauthorizedException('invalid_token'));
          await service.recordRequest({ resolvedRoute: route, req: req as any, requestId,
            statusCode: 401, latencyMs: 10, errorMessage: 'invalid_token' });
          res.writeHead(401).end();
        } else {
          audit.cacheHit();
          await service.recordRequest({ resolvedRoute: route, req: req as any, requestId,
            upstreamUrl: 'cache://gateway', latencyMs: 10,
            proxyResult: { statusCode: 200, headers: { 'content-type': 'application/json' },
              responseBodyBuffer: Buffer.from(body) } });
          res.writeHead(200, { 'content-type': 'application/json' }).end(body);
        }
      });
    });
    gateway.listen(0, '127.0.0.1');
    await once(gateway, 'listening');
    try {
      const base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
      const deniedResponse = await fetch(base + '/denied?token=secret', { headers: { authorization: 'Bearer private-token' } });
      expect(deniedResponse.status).toBe(401);
      await deniedResponse.text();
      const cachedResponse = await fetch(base + '/cached');
      expect(cachedResponse.status).toBe(200);
      expect(await cachedResponse.text()).toBe(body);
      const { raw, records } = await readCanonicalAudit(directory);
      expect(raw).not.toMatch(/private-token|cached-secret|token=secret/);
      expect(records).toHaveLength(2);
      expect(records.every(row => row.spanKind === 'gateway_request' && row.parentInvocationId === null)).toBe(true);
      const denied = records.find(row => row.requestId === deniedResponse.headers.get('x-request-id'))!;
      const cached = records.find(row => row.requestId === cachedResponse.headers.get('x-request-id'))!;
      expect(denied).toMatchObject({ endpointDefinitionId: 'api-1', outcome: 'rejected', httpStatus: 401,
        request: { state: 'unavailable', observedBytes: null }, response: { observedBytes: 0 } });
      expect(denied.request.data).toBeUndefined();
      expect(cached).toMatchObject({ spanKind: 'gateway_request', outcome: 'success', cacheHit: true, httpStatus: 200,
        response: { observedBytes: Buffer.byteLength(body) } });
      expect(JSON.parse(cached.response.data!).value).toHaveLength(9000);
      expect(repository.save).toHaveBeenCalledTimes(2);
    } finally {
      gateway.closeAllConnections();
      await new Promise<void>(resolve => gateway.close(() => resolve()));
      await flushRuntimeAudit();
      if (previous === undefined) delete process.env.API_NOVA_AUDIT_DIR; else process.env.API_NOVA_AUDIT_DIR = previous;
      await rm(directory, { recursive: true, force: true });
      expectHealthyAudit(health);
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

// Producer phases are complete snapshots, not patches. Project each row through
// the shared contract, then choose the terminal version per invocation only.
async function readCanonicalAudit(directory: string) {
  await flushRuntimeAudit();
  const files = (await readdir(directory)).filter(name => /^calls-v2-.*\.jsonl$/.test(name));
  expect(files.length).toBeGreaterThan(0);
  const raw = (await Promise.all(files.map(name => readFile(join(directory, name), 'utf8')))).join('\n');
  const groups = new Map<string, ReturnType<typeof normalizeRuntimeAuditRecord>[]>();
  for (const line of raw.split('\n').filter(line => line.trim())) {
    const row = normalizeRuntimeAuditRecord(JSON.parse(line));
    const group = groups.get(row.invocationId) || [];
    group.push(row);
    groups.set(row.invocationId, group);
  }
  const records = [...groups.values()].map(group => {
    group.sort((a, b) => a.recordVersion - b.recordVersion);
    expect(group[0]).toMatchObject({ phase: 'started', recordVersion: 1 });
    expect(new Set(group.map(row => row.recordVersion)).size).toBe(group.length);
    expect(group.filter(row => row.phase === 'finished')).toHaveLength(1);
    for (const row of group) {
      expect(row).toMatchObject({ sourceInstanceId: group[0].sourceInstanceId,
        requestId: group[0].requestId, spanKind: group[0].spanKind,
        parentInvocationId: group[0].parentInvocationId, traceId: group[0].traceId });
    }
    const terminal = group[group.length - 1];
    expect(terminal.phase).toBe('finished');
    return terminal;
  });
  return { raw, records };
}

function expectHealthyAudit(before: ReturnType<typeof getRuntimeAuditHealth>) {
  const after = getRuntimeAuditHealth();
  expect(after.writeFailures).toBe(before.writeFailures);
  expect(after.sourceManifestFailures).toBe(before.sourceManifestFailures);
  expect(after.droppedRecords).toBe(before.droppedRecords);
  expect(after.pendingWrites).toBe(0);
}