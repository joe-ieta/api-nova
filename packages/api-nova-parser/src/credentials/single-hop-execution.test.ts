import axios from 'axios';
import { transformToMCPTools } from '../transformer';
import { validateUpstreamCredentialBindings } from './schema';
import type { UpstreamCredentialRegistrySnapshot } from './registry';
import type { TrustedOperationBinding } from './trusted-operation-bindings';
import { compileSingleHopUpstreamCredentials } from './single-hop-execution';
import { withRuntimeCallContext } from '../audit/runtime-call-audit';
import http = require('node:http');
import { PassThrough, Writable } from 'node:stream';

function snapshot(selection = 'api', revision = 'r1', resolveSecret: (id: string) => Promise<string> = async () => 'synthetic-current-secret'): UpstreamCredentialRegistrySnapshot {
  const candidate = validateUpstreamCredentialBindings({
    apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings',
    metadata: { revision, environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true },
    secretProviders: { env: { type: 'env' } }, credentials: {
      api: { type: 'apiKey', placement: { in: 'header', name: 'X-Private' }, secretRef: 'env:SYNTHETIC_ONLY' },
      other: { type: 'apiKey', placement: { in: 'header', name: 'X-Other-Candidate' }, secretRef: 'env:SYNTHETIC_OTHER' },
    }, sites: [{ id: 'site', sourceServiceAssetId: 'trusted-asset',
      match: { scheme: 'http', host: 'fixture.invalid', port: 80, basePath: '/api' }, allowedHosts: ['fixture.invalid'],
      credential: 'api', endpoints: [{ endpointDefinitionId: 'trusted-endpoint', credential: selection }] }],
  });
  return Object.freeze({ generation: 1, candidate, resolveSecret });
}
function spec(): any {
  return { openapi: '3.0.3', info: { title: 'single-hop fixture', version: '1' }, servers: [{ url: 'http://fixture.invalid' }],
    paths: { '/api/items/{id}': { post: { operationId: 'items', responses: { '200': { description: 'ok' }, '302': { description: 'redirect' } },
      'x-endpoint-definition-id': 'forged-endpoint', 'x-source-service-asset-id': 'forged-asset',
      'x-api-nova-credential-ref': 'invalid-legacy-ref-must-not-evaluate',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ...['Authorization', 'Proxy-Authorization', 'Cookie', 'X-API-Key', 'X-Private', 'X-Other-Candidate', 'X-Business'].map(name => ({ name, in: 'header', schema: { type: 'string' } }))],
      requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
    } } } };
}
const binding: TrustedOperationBinding = { method: 'POST', path: '/api/items/{id}', endpointDefinitionId: 'trusted-endpoint', sourceServiceAssetId: 'trusted-asset' };
const context = { transport: 'mcp' as const, identitySource: 'anonymous' as const, requestId: 'single-hop-fixture' };
const args = { id: '7', Authorization: 'consumer-auth', 'Proxy-Authorization': 'consumer-proxy', Cookie: 'consumer-cookie',
  'X-API-Key': 'consumer-key', 'X-Private': 'consumer-private', 'X-Other-Candidate': 'consumer-other', 'X-Business': 'business-value',
  endpointDefinitionId: 'forged-endpoint', sourceServiceAssetId: 'forged-asset' };
function tool(captureSnapshot: () => UpstreamCredentialRegistrySnapshot, options: any = {}) {
  return transformToMCPTools(spec(), { includeFieldAnnotations: false, trustedOperationBindings: [binding],
    upstreamCredentialPolicy: { mode: 'single-hop', captureSnapshot }, ...options })[0];
}
describe('single-hop shared Resolver standard HTTP execution', () => {
  let oldAdapter: typeof axios.defaults.adapter, oldAuth: typeof axios.defaults.auth, oldHeaders: typeof axios.defaults.headers;
  let oldProxy: typeof axios.defaults.proxy, oldParams: typeof axios.defaults.params;
  let sent: any[], responseStatus: number;
  beforeEach(() => {
    oldAdapter = axios.defaults.adapter; oldAuth = axios.defaults.auth; oldHeaders = axios.defaults.headers;
    oldProxy = axios.defaults.proxy; oldParams = axios.defaults.params;
    sent = []; responseStatus = 200;
    axios.defaults.adapter = async config => {
      sent.push(config); return { config, data: { ok: true }, status: responseStatus, statusText: 'fixture', headers: { location: 'http://elsewhere.invalid/steal' } };
    };
  });
  afterEach(() => {
    axios.defaults.adapter = oldAdapter; axios.defaults.auth = oldAuth; axios.defaults.headers = oldHeaders;
    axios.defaults.proxy = oldProxy; axios.defaults.params = oldParams; jest.restoreAllMocks();
  });

  test.each([false, true])('uses trusted IDs and one snapshot, strips every candidate credential with context=%s', async useContext => {
    const capture = jest.fn(() => snapshot());
    const selected = tool(capture, { defaultHeaders: { AUTHORIZATION: 'default-auth', 'X-Other-Candidate': 'default-other' },
      customHeaders: { static: { 'x-private': 'custom-private', 'x-other-candidate': 'custom-other', 'x-business': 'custom-business' } },
      authConfig: { type: 'bearer', token: 'legacy-auth-must-not-win' } });
    const run = () => selected.handler(args);
    const result = await (useContext ? withRuntimeCallContext(context, run) : run());
    expect(result.isError).toBe(false); expect(capture).toHaveBeenCalledTimes(1); expect(sent).toHaveLength(1);
    const headers = sent[0].headers.toJSON();
    expect(headers['x-private']).toBe('synthetic-current-secret'); expect(headers['x-business']).toBe('custom-business');
    const output = JSON.stringify(headers); expect(output).not.toContain('consumer-'); expect(output).not.toContain('default-');
    expect(output).not.toContain('custom-private'); expect(output).not.toContain('legacy-auth');
    for (const key of ['authorization', 'proxy-authorization', 'x-api-key', 'cookie', 'x-other-candidate']) {
      expect(Object.keys(headers).map(key => key.toLowerCase())).not.toContain(key);
    }
    expect(sent[0].maxRedirects).toBe(0); expect(JSON.stringify(sent[0].data)).not.toContain('consumer-');
  });

  test('None cannot recover credentials from global Axios defaults, global interceptors, custom headers or legacy ref', async () => {
    axios.defaults.headers = { common: { Authorization: 'ambient-auth', 'X-Private': 'ambient-private', 'Proxy-Authorization': 'ambient-proxy' } } as any;
    axios.defaults.auth = { username: 'ambient-user', password: 'ambient-password' };
    axios.defaults.proxy = { host: 'ambient-proxy.invalid', port: 80, auth: { username: 'proxy-user', password: 'proxy-password' } };
    axios.defaults.params = { token: 'ambient-query-token' };
    const interceptor = axios.interceptors.request.use(config => { config.headers.set('Authorization', 'interceptor-secret'); return config; });
    try {
      const result = await tool(() => snapshot('none'), { defaultHeaders: { Cookie: 'default-cookie' }, customHeaders: { static: { 'X-Private': 'custom-key' } } }).handler(args);
      expect(result.isError).toBe(false); expect(sent).toHaveLength(1);
      expect(sent[0].auth).toBeUndefined(); expect(sent[0].proxy).toBeUndefined();
      expect(JSON.stringify(sent[0].headers)).not.toMatch(/ambient-|consumer-|custom-key|interceptor-secret|default-cookie/);
      expect(JSON.stringify(sent[0].params)).not.toContain('ambient-query-token');
      expect(sent[0].maxRedirects).toBe(0); expect(JSON.stringify(sent[0].data)).not.toContain('consumer-');
    } finally { axios.interceptors.request.eject(interceptor); }
  });

  test('callback and binding cannot be replaced after transform; in-flight resolution holds its captured revision', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let current = snapshot('api', 'r1', async () => { await gate; return 'first-revision-secret'; });
    const capture = jest.fn(() => current), policy = { mode: 'single-hop' as const, captureSnapshot: capture };
    const selected = tool(capture, { upstreamCredentialPolicy: policy });
    const first = selected.handler(args);
    (policy as any).captureSnapshot = () => { throw new Error('mutated-callback'); };
    current = snapshot('api', 'r2', async () => 'second-revision-secret');
    release(); await first; await selected.handler(args);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(sent.map(config => config.headers.get('x-private'))).toEqual(['first-revision-secret', 'second-revision-secret']);
  });

  test.each(['snapshot', 'site', 'secret'])('fails closed before custom headers/transport with sanitized %s failure', async reason => {
    const failure = jest.spyOn(console, 'error').mockImplementation(() => {});
    const capture = reason === 'snapshot' ? () => { throw new Error('private-provider-path-secret'); } :
      () => snapshot('api', 'r1', async () => { if (reason === 'secret') throw new Error('secret-provider-failure'); return 'fixture'; });
    const selected = tool(capture, reason === 'site' ? { baseUrl: 'http://wrong.invalid' } : {});
    const result = await selected.handler(args);
    expect(result.isError).toBe(true); expect(sent).toHaveLength(0);
    expect(result.content[0]).toMatchObject({ text: 'UPSTREAM_CREDENTIAL_UNAVAILABLE' });
    expect(JSON.stringify(result)).not.toMatch(/private-provider|secret-provider|stack|wrong.invalid/);
    expect(failure).not.toHaveBeenCalled();
  });

  test('custom handler added after construction is rejected before either callback or transport runs', async () => {
    const handlers: Record<string, any> = {};
    const selected = tool(() => snapshot(), { customHandlers: handlers });
    const bypass = jest.fn(async () => ({ content: [] })); handlers.items = bypass;
    const result = await selected.handler(args);
    expect(result.isError).toBe(true); expect(bypass).not.toHaveBeenCalled(); expect(sent).toHaveLength(0);
  });
  test('nonenumerable handler getters are never evaluated, including late injection', async () => {
    const getter = jest.fn(() => undefined), handlers = {};
    const selected = tool(() => snapshot(), { customHandlers: handlers });
    Object.defineProperty(handlers, 'items', { get: getter });
    expect((await selected.handler(args)).isError).toBe(true);
    expect(getter).not.toHaveBeenCalled(); expect(sent).toHaveLength(0);
    expect(() => tool(() => snapshot(), { customHandlers: handlers })).toThrow('INVALID_UPSTREAM_CREDENTIAL_EXECUTION');
    expect(getter).not.toHaveBeenCalled();
  });
  test('None disables arbitrary legacy env headers and ignores later provider mutation', async () => {
    const env = { 'X-Legacy-Token': 'SYNTHETIC_LEGACY_FIXTURE' };
    const customHeaders: any = { env, static: { 'X-Business': 'ordinary' } };
    const selected = tool(() => snapshot('none'), { customHeaders });
    const previous = process.env.SYNTHETIC_LEGACY_FIXTURE;
    process.env.SYNTHETIC_LEGACY_FIXTURE = 'synthetic-old-token';
    try {
      customHeaders.env = { 'X-Late-Token': 'SYNTHETIC_LEGACY_FIXTURE' };
      (env as any)['x-MuTaTeD-token'] = 'SYNTHETIC_LEGACY_FIXTURE';
      expect((await selected.handler(args)).isError).toBe(false);
      expect(JSON.stringify(sent[0].headers)).not.toMatch(/synthetic-old-token|legacy-token|late-token|mutated-token/i);
    } finally { if (previous === undefined) delete process.env.SYNTHETIC_LEGACY_FIXTURE; else process.env.SYNTHETIC_LEGACY_FIXTURE = previous; }
  });
  test('prototype-named operationId still takes the authorized standard HTTP path', async () => {
    const source = spec(); source.paths['/api/items/{id}'].post.operationId = 'toString';
    const selected = transformToMCPTools(source, { trustedOperationBindings: [binding],
      upstreamCredentialPolicy: { mode: 'single-hop', captureSnapshot: () => snapshot() } })[0];
    expect((await selected.handler(args)).isError).toBe(false); expect(sent).toHaveLength(1);
    expect(sent[0].headers.get('x-private')).toBe('synthetic-current-secret');
  });
  test('requires trusted mappings, rejects custom-handler bypass and rejects mutable snapshots', async () => {
    expect(() => transformToMCPTools(spec(), { upstreamCredentialPolicy: { mode: 'single-hop', captureSnapshot: () => snapshot() } })).toThrow('INVALID_UPSTREAM_CREDENTIAL_EXECUTION');
    expect(() => tool(() => snapshot(), { customHandlers: { items: async () => ({ content: [] }) } })).toThrow('INVALID_UPSTREAM_CREDENTIAL_EXECUTION');
    expect(() => tool(() => snapshot(), { trustedOperationBindings: [] })).toThrow('MISSING_TRUSTED_OPERATION_BINDING');
    const result = await tool(() => ({ ...snapshot() })).handler(args);
    expect(result.isError).toBe(true); expect(sent).toHaveLength(0);
    await expect(compileSingleHopUpstreamCredentials({ mode: 'single-hop', captureSnapshot: () => snapshot() }).resolve(undefined, 'http://fixture.invalid/api/items/7')).rejects.toThrow('UPSTREAM_CREDENTIAL_UNAVAILABLE');
  });

  test('returns redirects with no automatic follow and sanitizes transport errors that contain credentials', async () => {
    responseStatus = 302;
    const result = await tool(() => snapshot()).handler(args);
    expect(sent).toHaveLength(1); expect(sent[0].maxRedirects).toBe(0); expect(JSON.stringify(sent[0].data)).not.toContain('consumer-');
    expect(JSON.stringify(result)).toContain('302');
    axios.defaults.adapter = async () => { throw new Error('synthetic-current-secret private transport config'); };
    const failure = await tool(() => snapshot()).handler(args);
    expect(failure.content[0]).toMatchObject({ text: 'UPSTREAM_REQUEST_FAILED' });
    expect(JSON.stringify(failure)).not.toContain('synthetic-current-secret');
  });

  test('native mocked HTTP path writes only one request for 302 and no next-hop secret or body', async () => {
    let nativeError: unknown;
    const httpAdapter = axios.getAdapter('http');
    axios.defaults.adapter = async config => { try { return await httpAdapter(config); } catch (error) { nativeError = error; throw error; } };
    const calls: Array<{ options: any; body: Buffer[] }> = [];
    const native = jest.spyOn(http, 'request').mockImplementation(((options: any, callback: any) => {
      const call = { options, body: [] as Buffer[] }; calls.push(call);
      const request = new Writable({ autoDestroy: false, write(chunk, _encoding, done) { call.body.push(Buffer.from(chunk)); done(); } }) as any;
      request.setTimeout = () => request;
      request.on('finish', () => {
        const response = new PassThrough() as any;
        response.statusCode = 302; response.statusMessage = 'Found'; response.headers = { location: 'http://elsewhere.invalid/steal', 'content-type': 'application/json' };
        response.req = request; callback(response); response.end('{"redirect":true}');
      });
      return request;
    }) as any);
    const result = await tool(() => snapshot()).handler({ ...args, body: { data: 'body-fixture' } });
    expect(native).toHaveBeenCalledTimes(1); expect(nativeError).toBeUndefined(); expect(JSON.stringify(result)).toContain('302');
    expect(calls[0].options.path).toBe('/api/items/7');
    expect(calls[0].options.headers['x-private']).toBe('synthetic-current-secret');
    expect(Buffer.concat(calls[0].body).toString()).toContain('body-fixture');
  });
});
