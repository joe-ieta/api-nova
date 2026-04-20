import * as http from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import { GatewayProxyEngineService } from './gateway-proxy-engine.service';
import { GatewayRequestCaptureService } from './gateway-request-capture.service';

class MockResponse extends Writable {
  public statusCode = 200;
  public headers: Record<string, string | string[]> = {};
  public headersSent = false;
  private readonly chunks: Buffer[] = [];

  _write(
    chunk: any,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.headersSent = true;
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: string | string[]) {
    this.headers[name.toLowerCase()] = value;
  }

  getHeader(name: string) {
    return this.headers[name.toLowerCase()];
  }

  flushHeaders() {
    this.headersSent = true;
  }

  bodyAsText() {
    return Buffer.concat(this.chunks).toString('utf8');
  }

  bodyAsBuffer() {
    return Buffer.concat(this.chunks);
  }
}

const createMockRequest = (input: {
  method: string;
  originalUrl: string;
  headers?: Record<string, string>;
}) => {
  const stream = new PassThrough() as PassThrough & {
    method: string;
    originalUrl: string;
    headers: Record<string, string>;
    protocol: string;
    socket: { remoteAddress: string };
  };
  stream.method = input.method;
  stream.originalUrl = input.originalUrl;
  stream.headers = input.headers || {};
  stream.protocol = 'http';
  stream.socket = { remoteAddress: '127.0.0.1' };
  return stream;
};

describe('GatewayProxyEngine integration', () => {
  let upstreamServer: http.Server;
  let upstreamPort: number;
  let service: GatewayProxyEngineService;

  beforeAll(() => {
    jest.setTimeout(20000);
  });

  beforeEach(async () => {
    service = new GatewayProxyEngineService(new GatewayRequestCaptureService());

    upstreamServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        if (req.url?.startsWith('/slow')) {
          return;
        }
        if (req.url?.startsWith('/sse')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: first\n\n');
          res.write('data: second\n\n');
          res.end();
          return;
        }
        if (req.url?.startsWith('/download')) {
          const payload = Buffer.from('binary-download');
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': String(payload.length),
          });
          res.end(payload);
          return;
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            method: req.method,
            url: req.url,
            contentType: req.headers['content-type'],
            contentLength: req.headers['content-length'],
            bodyText: body.toString('utf8'),
            bodyHex: body.toString('hex'),
            bodyLength: body.length,
          }),
        );
      });
    });

    await new Promise<void>(resolve => upstreamServer.listen(0, '127.0.0.1', () => resolve()));
    upstreamPort = (upstreamServer.address() as any).port;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => upstreamServer.close(() => resolve()));
  });

  const resolvedRouteFor = (path: string, method = 'GET') => ({
    routeBinding: {
      id: 'route-1',
      routePath: path,
      routeMethod: method,
      upstreamPath:
        path === '/events' ? '/sse' : path === '/download' ? '/download' : '/echo',
      upstreamMethod: method,
      timeoutMs: 5000,
    },
    runtimeAsset: { id: 'runtime-1' },
    membership: { id: 'membership-1' },
    publishBinding: { publishedToHttp: true },
    endpointDefinition: { id: 'endpoint-1' },
    sourceServiceAsset: { id: 'source-1' },
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    params: {},
  });

  it('proxies json post requests', async () => {
    const req = createMockRequest({
      method: 'POST',
      originalUrl: '/v1/gateway/json?include=owner',
      headers: {
        'content-type': 'application/json',
        host: 'localhost:9001',
      },
    });
    const res = new MockResponse();

    const forwardPromise = service.forward(resolvedRouteFor('/json', 'POST') as any, req as any, res as any);
    req.end(JSON.stringify({ ok: true }));
    const result = await forwardPromise;

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(res.bodyAsText())).toMatchObject({
      url: '/echo?include=owner',
      contentType: 'application/json',
      bodyText: '{"ok":true}',
    });
    expect(result.requestCapture?.preview).toContain('"ok":true');
  });

  it('proxies multipart uploads', async () => {
    const boundary = '----ApiNovaTestBoundary';
    const payload = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\ndemo\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="demo.txt"\r\nContent-Type: text/plain\r\n\r\nhello-file\r\n--${boundary}--\r\n`,
      'utf8',
    );
    const req = createMockRequest({
      method: 'POST',
      originalUrl: '/v1/gateway/upload',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        host: 'localhost:9001',
      },
    });
    const res = new MockResponse();

    const forwardPromise = service.forward(resolvedRouteFor('/upload', 'POST') as any, req as any, res as any);
    req.end(payload);
    const result = await forwardPromise;
    const body = JSON.parse(res.bodyAsText());

    expect(body.contentType).toContain('multipart/form-data');
    expect(body.bodyText).toContain('hello-file');
    expect(body.bodyText).toContain('demo.txt');
    expect(result.requestCapture?.preview).toBe('[multipart/form-data omitted]');
  });

  it('proxies binary uploads', async () => {
    const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const req = createMockRequest({
      method: 'POST',
      originalUrl: '/v1/gateway/binary',
      headers: {
        'content-type': 'application/octet-stream',
        host: 'localhost:9001',
      },
    });
    const res = new MockResponse();

    const forwardPromise = service.forward(resolvedRouteFor('/binary', 'POST') as any, req as any, res as any);
    req.end(payload);
    const result = await forwardPromise;
    const body = JSON.parse(res.bodyAsText());

    expect(body.bodyHex).toBe(payload.toString('hex'));
    expect(result.requestCapture?.preview).toBeUndefined();
    expect(result.requestCapture?.totalBytes).toBe(payload.length);
  });

  it('proxies binary downloads', async () => {
    const req = createMockRequest({
      method: 'GET',
      originalUrl: '/v1/gateway/download',
      headers: {
        host: 'localhost:9001',
      },
    });
    const res = new MockResponse();

    const forwardPromise = service.forward(resolvedRouteFor('/download', 'GET') as any, req as any, res as any);
    req.end();
    const result = await forwardPromise;

    expect(result.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.bodyAsBuffer().toString('utf8')).toBe('binary-download');
  });

  it('proxies sse responses without rewriting payload', async () => {
    const req = createMockRequest({
      method: 'GET',
      originalUrl: '/v1/gateway/events',
      headers: {
        host: 'localhost:9001',
      },
    });
    const res = new MockResponse();

    const forwardPromise = service.forward(resolvedRouteFor('/events', 'GET') as any, req as any, res as any);
    req.end();
    const result = await forwardPromise;

    expect(result.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.bodyAsText()).toContain('data: first');
    expect(res.bodyAsText()).toContain('data: second');
  });

  it('maps upstream timeouts to gateway timeout errors', async () => {
    const slowRoute = resolvedRouteFor('/slow', 'GET') as any;
    slowRoute.routeBinding.upstreamPath = '/slow';
    slowRoute.routeBinding.timeoutMs = 20;

    const req = createMockRequest({
      method: 'GET',
      originalUrl: '/v1/gateway/slow',
      headers: {
        host: 'localhost:9001',
      },
    });
    const res = new MockResponse();

    const forwardPromise = service.forward(slowRoute, req as any, res as any);
    req.end();

    await expect(forwardPromise).rejects.toThrow('Gateway upstream timeout after 20ms');
  });
});
