import * as http from 'node:http';
import axios from 'axios';
import { createRuntimeHttpAuditAgents } from './runtime-http-agent';
import { gzipSync } from 'node:zlib';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { transformToMCPTools } from '../transformer';
import { beginRuntimeCall, flushRuntimeAudit, getRuntimeAuditHealth, withRuntimeCallContext } from './runtime-call-audit';

describe('transformer physical HTTP attempt observation', () => {
  let root: string, environment: NodeJS.ProcessEnv, server: http.Server, origin: string;
  let received: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: Buffer }>;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void;
  beforeEach(async () => {
    environment = { ...process.env };
    root = await mkdtemp(join(tmpdir(), 'api-nova-agent-audit-'));
    process.env.API_NOVA_AUDIT_DIR = root;
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
      'API_NOVA_AUDIT_MAX_BODY_BYTES', 'API_NOVA_AUDIT_CAPTURE_BODY', 'API_NOVA_AUDIT_MEMORY_BUDGET_BYTES']) delete process.env[key];
    process.env.NO_PROXY = '127.0.0.1,localhost';
    received = [];
    handler = (_req, res, body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ bytes: body.length, token: 'response-secret' }));
    };
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        received.push({ method: req.method, url: req.url, headers: req.headers, body });
        handler(req, res, body);
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = 'http://127.0.0.1:' + (server.address() as import('node:net').AddressInfo).port;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await flushRuntimeAudit();
    process.env = environment;
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
    expect(basename(root).startsWith('api-nova-agent-audit-')).toBe(true);
    await rm(root, { recursive: true, force: true });
  });
  function tool(method = 'get', options: any = {}) {
    return transformToMCPTools({ openapi: '3.0.3', info: { title: 'fixture', version: '1' },
      servers: [{ url: origin }], paths: { '/start': { [method]: {
        operationId: 'invoke', 'x-runtime-asset-id': 'runtime-a', 'x-endpoint-definition-id': 'endpoint-a',
        'x-source-service-instance-id': 'instance-a', 'x-source-service-asset-id': 'source-a',
        ...(method === 'post' ? { requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } } : {}),
        responses: { '200': { description: 'OK' } },
      } } },
    } as any, { includeFieldAnnotations: false, requestTimeout: 1000, ...options })[0];
  }
  async function invoke(selected: ReturnType<typeof tool>, args: unknown = {}) {
    const parent = beginRuntimeCall({ transport: 'mcp', requestId: 'tool-request',
      identitySource: 'authenticated', callerId: 'caller-a', toolName: selected.name }, 'tool');
    const result = await withRuntimeCallContext({
      transport: 'mcp', requestId: parent.record.requestId, identitySource: 'authenticated', callerId: 'caller-a',
      parentInvocationId: parent.record.invocationId, rootInvocationId: parent.record.rootInvocationId,
      traceId: parent.record.traceId,
    }, () => selected.handler(args));
    await parent.finish({ outcome: result.isError ? 'error' : 'success' });
    return { parent: parent.record, result };
  }
  async function records() {
    await flushRuntimeAudit();
    const files = (await readdir(root)).filter(name => name.startsWith('calls-v2-'));
    return (await Promise.all(files.map(name => readFile(join(root, name), 'utf8'))))
      .flatMap(text => text.split('\n').filter(Boolean).map(line => JSON.parse(line)))
      .filter(row => row.phase === 'finished' && row.spanKind === 'upstream_api');
  }
  it('captures actual serialized request and response bytes while retaining JSON tool output', async () => {
    const input = { value: 'hello', token: 'request-secret' };
    const { parent, result } = await invoke(tool('post'), input);
    expect(result.isError).toBe(false);
    expect(received).toHaveLength(1);
    const rows = await records(); expect(rows).toHaveLength(1);
    const call = rows[0];
    expect(call.parentInvocationId).toBe(parent.invocationId);
    expect(call.traceId).toBe(parent.traceId);
    expect(call.rootInvocationId).toBe(parent.rootInvocationId);
    expect(call.request.totalBytes).toBe(received[0].body.length);
    expect(call.response.totalBytes).toBe(Buffer.byteLength(JSON.stringify({ bytes: received[0].body.length, token: 'response-secret' })));
    expect(call.measurementStage).toBe('upstream_http');
    expect(call.byteMeasurement).toBe('observed_body');
    expect(call.operationId).toBe('invoke'); expect(call.sourceServiceAssetId).toBe('source-a');
    expect(call.attemptIndex).toBe(1); expect(call.redirectHopIndex).toBe(0);
    expect(call.outcome).toBe('success');
    expect(JSON.stringify(rows)).not.toContain('request-secret');
    expect(JSON.stringify(rows)).not.toContain('response-secret');
    expect((result.structuredContent as any).data.bytes).toBe(received[0].body.length);
  });
  it('observes empty GET requests and empty 204 responses without synthesizing payloads', async () => {
    handler = (_req, res) => { res.writeHead(204); res.end(); };
    await invoke(tool());
    const [call] = await records();
    expect(call.request.state).toBe('empty'); expect(call.response.state).toBe('empty');
    expect(call.request.totalBytes).toBe(0); expect(call.response.totalBytes).toBe(0);
  });
  it('records each redirect hop as a sibling without implementing a second redirect loop', async () => {
    handler = (req, res) => {
      if (req.url === '/start') { res.writeHead(302, { location: '/final' }); res.end('discarded'); }
      else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }
    };
    const { parent, result } = await invoke(tool());
    expect(result.isError).toBe(false); expect(received).toHaveLength(2);
    const rows = (await records()).sort((a,b) => a.redirectHopIndex - b.redirectHopIndex);
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.redirectHopIndex)).toEqual([0,1]);
    expect(new Set(rows.map(row => row.upstreamOperationId)).size).toBe(1);
    for (const row of rows) { expect(row.attemptIndex).toBe(1); expect(row.parentInvocationId).toBe(parent.invocationId); }
    expect(rows[0].statusCode).toBe(302); expect(rows[0].outcome).toBe('incomplete');
    expect(rows[0].response.state).toBe('incomplete'); expect(rows[0].response.data).toBeUndefined();
    expect(rows[1].outcome).toBe('success');
  });
  it('preserves Axios 307 request-body replay with one observation per physical request', async () => {
    handler = (req, res) => {
      if (req.url === '/start') { res.writeHead(307, { location: '/final' }); res.end(); }
      else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }
    };
    const { result } = await invoke(tool('post'), { message: 'replayed-by-existing-client' });
    expect(result.isError).toBe(false); expect(received).toHaveLength(2);
    expect(received[0].method).toBe('POST'); expect(received[1].method).toBe('POST');
    expect(received[1].body).toEqual(received[0].body);
    const rows = await records(); expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.request.totalBytes).toBe(received[0].body.length);
  });
  it('retains the existing maximum redirect limit without phantom attempts', async () => {
    handler = (_req, res) => { res.writeHead(302, { location: '/again' }); res.end(); };
    const { result } = await invoke(tool());
    expect(result.isError).toBe(true); expect(received).toHaveLength(6);
    expect(await records()).toHaveLength(6);
  });
  it('HTTP error status remains a tool failure and a physical error record', async () => {
    handler = (_req, res) => { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"unavailable"}'); };
    const { result } = await invoke(tool());
    expect(result.isError).toBe(true);
    const [call] = await records(); expect(call.statusCode).toBe(503); expect(call.outcome).toBe('error');
  });
  it('compressed responses count encoded bytes and omit raw content while Axios still decodes', async () => {
    const encoded = gzipSync(Buffer.from('{"value":"decoded","token":"compressed-secret"}'));
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }); res.end(encoded); };
    const { result } = await invoke(tool());
    expect(result.isError).toBe(false); expect((result.structuredContent as any).data.value).toBe('decoded');
    const [call] = await records();
    expect(call.response.totalBytes).toBe(encoded.length);
    expect(call.response.state).toBe('omitted'); expect(call.response.reason).toBe('encoded_body');
    expect(call.responseHeaders['content-encoding']).toBe('gzip');
    expect(call.response.data).toBeUndefined();
  });
  it('interrupted response streams keep incomplete body evidence without partial secrets', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"token":"incomplete-secret');
      setTimeout(() => res.destroy(), 10);
    };
    const { result } = await invoke(tool());
    expect(result.isError).toBe(true);
    const [call] = await records(); expect(call.outcome).toBe('error');
    expect(call.response.state).toBe('incomplete'); expect(call.response.data).toBeUndefined();
  });
  it('timeouts terminate one observed attempt without introducing business retries', async () => {
    handler = () => undefined;
    const { result } = await invoke(tool('get', { requestTimeout: 25 }));
    expect(result.isError).toBe(true); expect(received).toHaveLength(1);
    const rows = await records(); expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('timeout'); expect(rows[0].response).toBeUndefined();
  });

  it.each([false, true])('keeps the business timeout error with clarifyTimeoutError=%s', async clarifyTimeoutError => {
    handler = () => undefined;
    const agents = createRuntimeHttpAuditAgents({ transport: 'mcp', requestId: 'timeout-cause', identitySource: 'anonymous' });
    let originalError: unknown;
    try {
      await axios.get(origin + '/start', { httpAgent: agents.httpAgent, httpsAgent: agents.httpsAgent,
        timeout: 25, transitional: { clarifyTimeoutError } });
    } catch (value) { originalError = value; }
    finally { agents.destroy(); }
    expect(axios.isAxiosError(originalError)).toBe(true);
    expect((originalError as { code: string }).code).toBe(clarifyTimeoutError ? 'ETIMEDOUT' : 'ECONNABORTED');
    expect(received).toHaveLength(1);
    const rows = await records(); expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('timeout'); expect(rows[0].errorCode).toBe('UPSTREAM_TIMEOUT');
  });

  it('does not relabel an explicit Axios cancellation as a timeout', async () => {
    const controller = new AbortController();
    handler = () => controller.abort();
    const agents = createRuntimeHttpAuditAgents({ transport: 'mcp', requestId: 'cancel-cause', identitySource: 'anonymous' });
    try {
      await expect(axios.get(origin + '/start', { httpAgent: agents.httpAgent, httpsAgent: agents.httpsAgent,
        timeout: 1000, signal: controller.signal })).rejects.toMatchObject({ code: 'ERR_CANCELED' });
    } finally { agents.destroy(); }
    const rows = await records(); expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('cancelled'); expect(rows[0].errorCode).toBe('UPSTREAM_CANCELLED');
  });

  it('does not guess a timeout for a native ECONNABORTED error', async () => {
    const agents = createRuntimeHttpAuditAgents({ transport: 'mcp', requestId: 'native-abort', identitySource: 'anonymous' });
    const originalError = Object.assign(new Error('Native request aborted'), { code: 'ECONNABORTED' });
    let request: http.ClientRequest;
    handler = () => request.destroy(originalError);
    try {
      await expect(new Promise<void>((resolve, reject) => {
        request = http.get(origin + '/start', { agent: agents.httpAgent }, response => {
          response.resume(); response.on('end', resolve);
        });
        request.once('error', reject);
      })).rejects.toBe(originalError);
    } finally { agents.destroy(); }
    const rows = await records(); expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('cancelled'); expect(rows[0].errorCode).toBe('UPSTREAM_CANCELLED');
  });

  it('marks only the pending redirect hop as timed out', async () => {
    handler = (req, res) => {
      if (req.url === '/start') { res.writeHead(302, { location: '/final' }); res.end('discarded'); }
    };
    const { result } = await invoke(tool('get', { requestTimeout: 50 }));
    expect(result.isError).toBe(true); expect(received).toHaveLength(2);
    const rows = (await records()).sort((a,b) => a.redirectHopIndex - b.redirectHopIndex);
    expect(rows).toHaveLength(2);
    expect(rows[0].outcome).toBe('incomplete'); expect(rows[1].outcome).toBe('timeout');
    expect(new Set(rows.map(row => row.upstreamOperationId)).size).toBe(1);
  });

  it('concurrent tool calls do not share operation ids or parent links', async () => {
    const selected = tool('post');
    const results = await Promise.all(Array.from({ length: 6 }, (_, value) => invoke(selected, { value })));
    const rows = await records(); expect(rows).toHaveLength(6);
    expect(new Set(rows.map(row => row.upstreamOperationId)).size).toBe(6);
    for (const { parent } of results) expect(rows.filter(row => row.parentInvocationId === parent.invocationId)).toHaveLength(1);
  });
  it('a custom handler does not create a fictitious HTTP attempt', async () => {
    await invoke(tool('get', { customHandlers: { invoke: async () => ({ content: [], isError: false }) } }));
    expect(received).toHaveLength(0); expect(await records()).toHaveLength(0);
  });
  it('filesystem audit failure does not replace a successful tool result', async () => {
    const blocker = join(root, 'blocked'); await writeFile(blocker, 'fixture');
    process.env.API_NOVA_AUDIT_DIR = blocker;
    const before = getRuntimeAuditHealth().writeFailures;
    const { result } = await invoke(tool());
    await flushRuntimeAudit();
    expect(result.isError).toBe(false); expect(received).toHaveLength(1);
    expect(getRuntimeAuditHealth().writeFailures).toBeGreaterThan(before);
    expect(getRuntimeAuditHealth().activeCalls).toBe(0);
  });
});
