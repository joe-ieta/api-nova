import { compileHeaderPolicyV1, normalizeHeaderPolicyV1, assertHeaderPolicyCredentialNames } from './header-policy';
import { UpstreamCredentialRegistry } from '../credentials/registry';

const compile = (policy: unknown) => compileHeaderPolicyV1({ policy, sourceId: 'route:test' });
function config(revision = 'r1'): any {
  return { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision, environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { env: { type: 'env' } }, credentials: { key: { type: 'apiKey', placement: { in: 'header', name: 'x-upstream-auth' }, secretRef: 'env:TOKEN' } }, sites: [{ id: 'site', sourceServiceAssetId: 'asset', match: { scheme: 'https', host: 'example.invalid', port: 443, basePath: '/' }, allowedHosts: ['example.invalid'], credential: 'key', headerPolicy: { version: 1, requestHeaders: ['x-site'], responseHeaders: ['x-response'] }, endpoints: [{ endpointDefinitionId: 'inherited' }, { endpointDefinitionId: 'empty', headerPolicy: { version: 1, requestHeaders: [] } }, { method: 'GET', path: '/replace', headerPolicy: { version: 1, requestHeaders: ['x-endpoint'] } }] }] };
}
const registry = () => new UpstreamCredentialRegistry({ environment: 'test', providerFactory: () => ({ type: 'env', resolve: async () => 'synthetic-token' }) });

describe('Header policy v1 compiler preparation', () => {
  test('canonical names, independent frozen arrays and stable content identity', () => {
    const raw = { version: 1, requestHeaders: ['X-Business', 'x-business', 'X-Tenant'] };
    const first = compile(raw); raw.requestHeaders.push('x-later');
    expect(first.requestExtensions).toEqual(['x-business', 'x-tenant']);
    expect(first.requestHeaders).toContain('accept'); expect(first.responseHeaders).not.toContain('x-business');
    expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(first.requestHeaders)).toBe(true);
    expect(first.identity).toBe(compile({ version: 1, requestHeaders: ['x-tenant', 'x-business'] }).identity);
    expect(first.identity).not.toBe(compile({ version: 1 }).identity);
    expect(first.identity).not.toBe(compileHeaderPolicyV1({ policy: { version: 1, requestHeaders: ['x-tenant', 'x-business'] }, sourceId: 'other' }).identity);
  });
  test.each([null, {}, { version: 2 }, { version: 1, requestHeaders: null }, { version: 1, requestHeaders: 'x-business' }, { version: 1, values: {} }, { version: 1, requestHeaders: ['*'] }, { version: 1, requestHeaders: ['x-*'] }, { version: 1, responseHeaders: ['bad:name'] }, { version: 1, requestHeaders: [' x-test'] }])('rejects malformed configuration %j', value => expect(() => compile(value)).toThrow());
  test.each(['authorization', 'Proxy-Authorization', 'cookie', 'set-cookie', 'x-api-key', 'www-authenticate', 'connection', 'host', 'forwarded', 'x-forwarded-for', 'x-apinova-state', 'content-length', 'expect', 'traceparent', 'baggage', 'server', 'x-powered-by'])('reserved name %s cannot be business extension in either direction', name => {
    for (const direction of ['requestHeaders', 'responseHeaders']) expect(() => compile({ version: 1, [direction]: [name] })).toThrow('HEADER_POLICY_RESERVED_NAME');
  });
  test('limits each raw direction before deduplication', () => {
    expect(compile({ version: 1, requestHeaders: Array(64).fill('x-business'), responseHeaders: Array.from({ length: 64 }, (_, index) => 'x-' + index) }).responseExtensions).toHaveLength(64);
    expect(() => compile({ version: 1, requestHeaders: Array(65).fill('x-business') })).toThrow('HEADER_POLICY_LIMIT');
  });
  test('does not invoke getters or accept non-data arrays', () => {
    const getter = jest.fn();
    expect(() => normalizeHeaderPolicyV1({ version: 1, get requestHeaders() { return getter(); } })).toThrow();
    const headers: string[] = []; Object.defineProperty(headers, '0', { enumerable: true, get: getter });
    expect(() => compile({ version: 1, requestHeaders: headers })).toThrow(); expect(getter).not.toHaveBeenCalled();
    expect(() => compile({ version: 1, requestHeaders: Array(1) })).toThrow();
  });
  test('independent direction inheritance and explicit empty replacement', () => {
    const inheritedPolicy = { version: 1, requestHeaders: ['x-site'], responseHeaders: ['x-response'] };
    const result = compileHeaderPolicyV1({ inheritedPolicy, policy: { version: 1, requestHeaders: [] }, sourceId: 'endpoint' });
    expect(result.requestExtensions).toEqual([]); expect(result.responseExtensions).toEqual(['x-response']);
  });
  test('rejects current, historical and consumer custom auth conflicts', () => {
    for (const property of ['credentialHeaderNames', 'historicalAuthenticationHeaderNames', 'consumerAuthenticationHeaderNames']) expect(() => compileHeaderPolicyV1({ policy: { version: 1, responseHeaders: ['x-secret'] }, sourceId: 'test', [property]: ['X-Secret'] })).toThrow('HEADER_POLICY_CREDENTIAL_CONFLICT');
    const policy = compile({ version: 1 });
    expect(() => assertHeaderPolicyCredentialNames(policy, ['Authorization', 'X-API-Key', 'x-custom-auth'])).not.toThrow();
    for (const name of ['content-type', 'cookie', 'x-forwarded-host', 'x-request-id', 'date']) expect(() => assertHeaderPolicyCredentialNames(policy, [name])).toThrow('HEADER_POLICY_CREDENTIAL_CONFLICT');
  });
});

describe('Registry Header policy snapshot preparation', () => {
  test('pins per-direction Site/Endpoint policies and retained snapshots across reloads', async () => {
    const store = registry(); const first = await store.reload(config());
    expect(first.getHeaderPolicy!('site', { endpointDefinitionId: 'inherited' })!.requestExtensions).toEqual(['x-site']);
    expect(first.getHeaderPolicy!('site', { endpointDefinitionId: 'empty' })!.requestExtensions).toEqual([]);
    expect(first.getHeaderPolicy!('site', { endpointDefinitionId: 'empty' })!.responseExtensions).toEqual(['x-response']);
    expect(first.getHeaderPolicy!('site', { method: 'get', path: '/replace' })!.requestExtensions).toEqual(['x-endpoint']);
    expect(first.getHeaderPolicy!('site', { endpointDefinitionId: 'other' })).toBe(first.getHeaderPolicy!('site'));
    const next = config('r2'); next.sites[0].headerPolicy.requestHeaders = ['x-next']; await store.reload(next);
    expect(first.getHeaderPolicy!('site')!.requestExtensions).toEqual(['x-site']);
    expect(store.captureSnapshot().getHeaderPolicy!('site')!.requestExtensions).toEqual(['x-next']);
  });
  test.each(['current', 'endpoint', 'unknown-version'])('rejects %s compilation atomically', async failure => {
    const store = registry(); const first = await store.reload(config()); const next = config('r2');
    if (failure === 'current') next.sites[0].headerPolicy.requestHeaders = ['x-upstream-auth'];
    if (failure === 'endpoint') next.sites[0].endpoints[1].headerPolicy.responseHeaders = ['cookie'];
    if (failure === 'unknown-version') next.sites[0].headerPolicy.version = 2;
    await expect(store.reload(next)).rejects.toMatchObject({ code: 'CANDIDATE_REJECTED' });
    expect(store.captureSnapshot()).toBe(first); expect(store.getStatus().generation).toBe(1);
  });
  test('deleted auth names remain forbidden within successful Registry lifetime, failed candidates do not pollute', async () => {
    const store = registry(); await store.reload(config());
    const next = config('r2'); next.credentials = {}; next.sites[0].credential = 'none'; next.sites[0].headerPolicy.requestHeaders = ['x-upstream-auth'];
    await expect(store.reload(next)).rejects.toMatchObject({ code: 'CANDIDATE_REJECTED' });
    const failed = config('r3'); failed.credentials.key.placement.name = 'x-never-activated'; failed.sites[0].headerPolicy.requestHeaders = ['x-never-activated'];
    await expect(store.reload(failed)).rejects.toThrow();
    const valid = config('r4'); valid.sites[0].headerPolicy.requestHeaders = ['x-never-activated'];
    await expect(store.reload(valid)).resolves.toMatchObject({ generation: 2 });
  });
  test.each(['json', 'yaml'] as const)('text loader compiles %s Header policies with inheritance', async format => {
    const store = registry();
    const input = config();
    const text = format === 'json' ? JSON.stringify(input) : require('js-yaml').dump(input);
    const snapshot = await store.reloadText(text, format);
    expect(snapshot.getHeaderPolicy!('site', { endpointDefinitionId: 'empty' })!.requestExtensions).toEqual([]);
    expect(snapshot.getHeaderPolicy!('site', { endpointDefinitionId: 'empty' })!.responseExtensions).toEqual(['x-response']);
  });
  test('first invalid policy leaves Registry empty; absent policy stays explicitly legacy', async () => {
    const store = registry(); const invalid = config(); invalid.sites[0].headerPolicy.requestHeaders = ['x-upstream-auth'];
    await expect(store.reload(invalid)).rejects.toThrow(); expect(store.getStatus().state).toBe('empty');
    const legacy = config(); delete legacy.sites[0].headerPolicy; legacy.sites[0].endpoints = [];
    const snapshot = await store.reload(legacy); expect(snapshot.getHeaderPolicy!('site')).toBeUndefined();
    expect(() => snapshot.getHeaderPolicy!('other')).toThrow();
  });
});
