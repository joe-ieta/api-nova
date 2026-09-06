import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayProxyEngineService } from './gateway-proxy-engine.service';
import { GatewayRequestCaptureService } from './gateway-request-capture.service';
import { auditDigest } from 'api-nova-parser';
import { generateKeyPairSync, sign } from 'node:crypto';
import { GatewaySecurityService } from './gateway-security.service';

describe('Gateway real HTTP audit', () => {
  it('marks a client-cancelled response as incomplete', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'api-nova-gateway-cancel-'));
    const previous = process.env.API_NOVA_AUDIT_DIR;
    process.env.API_NOVA_AUDIT_DIR = directory;
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }); res.write('first chunk');
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const engine = new GatewayProxyEngineService(new GatewayRequestCaptureService());
    const route = { upstreamBaseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      routeBinding: { upstreamPath: '/stream', upstreamMethod: 'GET' }, endpointDefinition: { id: 'stream-api' },
      runtimeAsset: { id: 'runtime' }, sourceServiceInstance: { id: 'instance' }, params: {},
      policies: { auth: {}, traffic: { timeoutMs: 5000 } } } as any;
    let finish!: () => void;
    const completed = new Promise<void>(resolve => { finish = resolve; });
    const gateway = http.createServer(async (req, res) => {
      (req as any).originalUrl = req.url;
      (res as any).status = (code: number) => { res.statusCode = code; return res; };
      try { await engine.forward(route, req as any, res as any); } catch { /* client disconnected */ }
      finally { finish(); }
    });
    gateway.listen(0, '127.0.0.1');
    await once(gateway, 'listening');
    try {
      const controller = new AbortController();
      const result = await fetch(`http://127.0.0.1:${(gateway.address() as AddressInfo).port}/stream`, { signal: controller.signal });
      expect((await result.body!.getReader().read()).value).toBeDefined();
      controller.abort();
      await completed;
      const file = (await readdir(directory)).find(name => /^\d{4}-/.test(name))!;
      const record = JSON.parse((await readFile(join(directory, file), 'utf8')).trim());
      expect(record).toMatchObject({ outcome: 'cancelled', endpointDefinitionId: 'stream-api',
        response: { state: 'incomplete', reason: 'stream_interrupted', totalBytes: 11 } });
      expect(record.response.data).toBeUndefined();
    } finally {
      gateway.closeAllConnections(); upstream.closeAllConnections();
      await Promise.all([new Promise<void>(resolve => gateway.close(() => resolve())),
        new Promise<void>(resolve => upstream.close(() => resolve()))]);
      if (previous === undefined) delete process.env.API_NOVA_AUDIT_DIR; else process.env.API_NOVA_AUDIT_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('persists an upstream timeout without inventing a response body', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'api-nova-gateway-timeout-'));
    const oldDir = process.env.API_NOVA_AUDIT_DIR;
    process.env.API_NOVA_AUDIT_DIR = directory;
    const upstream = http.createServer((_req, _res) => {});
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const engine = new GatewayProxyEngineService(new GatewayRequestCaptureService());
    const route = { upstreamBaseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      routeBinding: { upstreamPath: '/slow', upstreamMethod: 'GET' },
      endpointDefinition: { id: 'slow-api', path: '/slow' }, runtimeAsset: { id: 'runtime' },
      sourceServiceInstance: { id: 'instance' }, params: {}, policies: { auth: {}, traffic: { timeoutMs: 20 } } } as any;
    const gateway = http.createServer(async (req, res) => {
      (req as any).originalUrl = req.url;
      (res as any).status = (code: number) => { res.statusCode = code; return res; };
      try { await engine.forward(route, req as any, res as any); }
      catch (error: any) { res.writeHead(error.getStatus()).end('timeout'); }
    });
    gateway.listen(0, '127.0.0.1');
    await once(gateway, 'listening');
    try {
      const result = await fetch(`http://127.0.0.1:${(gateway.address() as AddressInfo).port}/slow`);
      expect(result.status).toBe(504);
      await result.text();
      const file = (await readdir(directory)).find(file => /^\d{4}-/.test(file))!;
      const record = JSON.parse((await readFile(join(directory, file), 'utf8')).trim());
      expect(record).toMatchObject({ outcome: 'error', statusCode: 504, endpointDefinitionId: 'slow-api' });
      expect(record.response).toBeUndefined();
    } finally {
      gateway.closeAllConnections(); upstream.closeAllConnections();
      await Promise.all([new Promise<void>(resolve => gateway.close(() => resolve())),
        new Promise<void>(resolve => upstream.close(() => resolve()))]);
      if (oldDir === undefined) delete process.env.API_NOVA_AUDIT_DIR; else process.env.API_NOVA_AUDIT_DIR = oldDir;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('captures real request/response bytes, redacts secrets, and correlates upstream identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'api-nova-gateway-audit-'));
    const oldEnv = { ...process.env };
    process.env.API_NOVA_AUDIT_DIR = directory;
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.API_NOVA_RUNTIME_ISSUER = 'https://issuer.example';
    process.env.API_NOVA_GATEWAY_RESOURCE = 'https://runtime.example/gateway';
    process.env.API_NOVA_RUNTIME_REQUIRED_SCOPES = 'api:invoke';
    delete process.env.API_NOVA_RUNTIME_JWKS_URI;
    process.env.API_NOVA_RUNTIME_JWKS_JSON = JSON.stringify({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'gateway-test' }] });
    const unsigned = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'gateway-test' })).toString('base64url') + '.' +
      Buffer.from(JSON.stringify({ iss: process.env.API_NOVA_RUNTIME_ISSUER, sub: 'external-user',
        aud: process.env.API_NOVA_GATEWAY_RESOURCE, scope: 'api:invoke', iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url');
    const token = unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), keys.privateKey).toString('base64url');
    const security = new GatewaySecurityService(null as any, null as any, null as any, null as any);
    let upstreamHeaders: http.IncomingHttpHeaders = {};
    const requestBody = JSON.stringify({ message: 'x'.repeat(9000), password: 'request-secret' });
    const responseBody = JSON.stringify({ result: 'y'.repeat(9000), access_token: 'response-secret' });
    const upstream = http.createServer(async (req, res) => {
      upstreamHeaders = req.headers;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe(requestBody);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(responseBody);
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const route = { upstreamBaseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      routeBinding: { upstreamPath: '/echo', upstreamMethod: 'POST', routePath: '/echo' },
      endpointDefinition: { id: 'api-1', path: '/echo' }, runtimeAsset: { id: 'runtime-1' },
      sourceServiceInstance: { id: 'instance-1' }, params: {}, policies: { auth: { mode: 'oauth' }, traffic: { timeoutMs: 1000 } } } as any;
    const engine = new GatewayProxyEngineService(new GatewayRequestCaptureService());
    let finish!: (value: any) => void;
    const completed = new Promise<any>(resolve => { finish = resolve; });
    const gateway = http.createServer(async (req, res) => {
      (req as any).originalUrl = req.url;
      (res as any).status = (code: number) => { res.statusCode = code; return res; };
      try { await security.authorize(route, req as any); finish(await engine.forward(route, req as any, res as any)); }
      catch (error) { finish(error); res.end(); }
    });
    gateway.listen(0, '127.0.0.1');
    await once(gateway, 'listening');
    try {
      const result = await fetch(`http://127.0.0.1:${(gateway.address() as AddressInfo).port}/echo`, {
        method: 'POST', body: requestBody, headers: { 'content-type': 'application/json',
          authorization: `Bearer ${token}`, 'x-api-key': 'ingress-key' } });
      expect(await result.text()).toBe(responseBody);
      const proxyResult = await completed;
      expect(proxyResult.responseCapture.totalBytes).toBe(Buffer.byteLength(responseBody));
      expect(proxyResult.responseCapture.hash).toBe(auditDigest(responseBody));
      expect(proxyResult.responseCapture.preview).toContain('[truncated]');
      expect(upstreamHeaders.authorization).toBeUndefined();
      expect(upstreamHeaders['x-api-key']).toBeUndefined();
      expect(upstreamHeaders['x-request-id']).toBe(result.headers.get('x-request-id'));
      const logFile = (await readdir(directory)).find(file => /^\d{4}-/.test(file))!;
      const raw = await readFile(join(directory, logFile), 'utf8');
      expect(raw).not.toMatch(/request-secret|response-secret|ingress-secret|ingress-key/);
      expect(raw).not.toContain(token);
      const record = JSON.parse(raw.trim());
      expect(record).toMatchObject({ kind: 'api', endpointDefinitionId: 'api-1', sourceServiceInstanceId: 'instance-1',
        identitySource: 'authenticated', outcome: 'success', statusCode: 200 });
      expect(JSON.parse(record.request.data).message).toHaveLength(9000);
      expect(JSON.parse(record.response.data).result).toHaveLength(9000);
      expect(record.requestId).toBe(upstreamHeaders['x-request-id']);
      expect(record.callerId).toBe(auditDigest('https://issuer.example\0external-user'));
    } finally {
      gateway.closeAllConnections(); upstream.closeAllConnections();
      await Promise.all([new Promise<void>(resolve => gateway.close(() => resolve())),
        new Promise<void>(resolve => upstream.close(() => resolve()))]);
      process.env = oldEnv;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
