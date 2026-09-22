import { UpstreamCredentialRegistry } from './registry';
import { resolveUpstreamCredential } from './resolver';
import { validateUpstreamCredentialBindings } from './schema';
import { parseUpstreamCredentialBindings } from './loader';
import { upstreamCredentialHeaderName } from './types';

const raw = (credential: Record<string, unknown>, revision = 'r1'): any => ({
  apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision, environment: 'test' },
  reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { env: { type: 'env' } },
  credentials: { chosen: credential }, sites: [{ id: 'site', sourceServiceAssetId: 'asset',
    match: { scheme: 'https', host: 'api.example', port: 443, basePath: '/' }, allowedHosts: ['api.example'], credential: 'chosen', endpoints: [] }],
});
const bearer = { type: 'bearer', secretRef: 'env:TOKEN' };
const basic = { type: 'basic', usernameRef: 'env:USER', passwordRef: 'env:PASS' };
const custom = { type: 'customHeader', name: 'X-Service-Key', secretRef: 'env:TOKEN' };
const input = { sourceServiceAssetId: 'asset', endpointDefinitionId: 'endpoint', requestMethod: 'GET', url: 'https://api.example/items' };
function registry(values: Record<string, string> = { TOKEN: 'synthetic-token', USER: '用户', PASS: 'password:with:colons' }) {
  const read = jest.fn(async (key: string) => { if (!(key in values)) throw new Error('PRIVATE_PROVIDER_ERROR'); return values[key]; });
  const store = new UpstreamCredentialRegistry({ environment: 'test', providerFactory: () => ({ type: 'env', resolve: read }) });
  return { store, read, values };
}

describe('C1 complete upstream credential types', () => {
  it.each([bearer, basic, custom, { type: 'apiKey', placement: { in: 'header', name: 'X-Service-Key' }, secretRef: 'env:TOKEN' }])('normalizes object/JSON/YAML identically: $type', credential => {
    const data = raw(credential), expected = validateUpstreamCredentialBindings(data);
    expect(parseUpstreamCredentialBindings(JSON.stringify(data), 'json')).toEqual(expected);
    expect(parseUpstreamCredentialBindings(JSON.stringify(data), 'yaml')).toEqual(expected);
    expect(expected.credentials.chosen).toMatchObject({ enabled: true, environment: 'test' });
  });
  it('reads two Basic references and produces one UTF-8 header without single-secret fallback', async () => {
    const { store } = registry(); const snapshot = await store.reload(raw(basic));
    const result = await resolveUpstreamCredential(snapshot, input);
    expect(result.headers.authorization === 'Basic ' + Buffer.from('用户:password:with:colons').toString('base64')).toBe(true);
    await expect(snapshot.resolveSecret('chosen')).rejects.toMatchObject({ code: 'UNKNOWN_CREDENTIAL' });
    expect(JSON.stringify(store.getStatus())).not.toMatch(/用户|password|synthetic-token/);
  });
  it('injects one custom Header and keeps its name after deletion/None', async () => {
    const { store } = registry(); const first = await store.reload(raw(custom));
    expect((await resolveUpstreamCredential(first, input)).headers).toEqual({ 'x-service-key': 'synthetic-token' });
    const data = raw(bearer, 'r2'); data.sites[0].credential = 'none'; const second = await store.reload(data);
    expect(second.historicalAuthenticationHeaderNames).toContain('x-service-key');
    expect((await resolveUpstreamCredential(second, input)).headers).toEqual({});
  });
  it.each(['query', 'cookie', 'oauth2', 'openIdConnect', 'digest', 'mutualTLS', 'unknown'])('rejects unsupported %s', type => {
    expect(() => validateUpstreamCredentialBindings(raw({ type, secretRef: 'env:TOKEN' }))).toThrow('UNSUPPORTED_CREDENTIAL_TYPE');
  });
  it.each(['authorization', 'cookie', 'proxy-authorization', 'content-length', 'x-forwarded-for', 'x-apinova-key', 'traceparent'])('rejects reserved custom name %s', name => {
    expect(() => validateUpstreamCredentialBindings(raw({ ...custom, name }))).toThrow('INVALID_HEADER');
  });
  it.each([
    { enabled: null }, { enabled: 'false' }, { methods: [] }, { methods: ['GET', 'get'] }, { methods: ['BOGUS'] },
    { endpointDefinitionIds: [] }, { allowedHosts: [] }, { allowedHosts: ['*.example'] }, { environment: 'production' },
    { notBefore: '2026-02-30T00:00:00Z' }, { expiresAt: '2026-01-01' }, { expiresAt: null },
    { notBefore: '2026-01-01T00:00:00Z', expiresAt: '2026-01-01T00:00:00Z' },
  ])('rejects malformed constraint %j', constraints => {
    expect(() => validateUpstreamCredentialBindings(raw({ ...bearer, ...constraints }))).toThrow();
  });
  it.each([
    [{ enabled: false }, 'CREDENTIAL_INACTIVE'],
    [{ notBefore: '2999-01-01T00:00:00Z' }, 'CREDENTIAL_INACTIVE'],
    [{ expiresAt: '2000-01-01T00:00:00Z' }, 'CREDENTIAL_INACTIVE'],
    [{ methods: ['POST'] }, 'SCOPE_MISMATCH'],
    [{ endpointDefinitionIds: ['other'] }, 'SCOPE_MISMATCH'],
    [{ allowedHosts: ['other.example'] }, 'SCOPE_MISMATCH'],
  ])('activates valid constraints but rejects use before reading secret: %j', async (constraints, code) => {
    const { store, read } = registry(); const snapshot = await store.reload(raw({ ...bearer, ...(constraints as object) })); read.mockClear();
    await expect(resolveUpstreamCredential(snapshot, input)).rejects.toMatchObject({ code }); expect(read).not.toHaveBeenCalled();
  });
  it('checks ID and actual method together, rejecting a missing actual method', async () => {
    const { store } = registry(); const snapshot = await store.reload(raw({ ...bearer, methods: ['get'], endpointDefinitionIds: ['endpoint'], allowedHosts: ['API.EXAMPLE.'] }));
    expect((await resolveUpstreamCredential(snapshot, input)).mode).toBe('reference');
    await expect(resolveUpstreamCredential(snapshot, { ...input, requestMethod: undefined })).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' });
  });
  it('activates disabled credentials and preserves the disabled snapshot if another candidate fails', async () => {
    const { store } = registry(); await store.reload(raw(bearer));
    const disabled = await store.reload(raw({ ...bearer, enabled: false }, 'r2'));
    await expect(store.reload(raw({ ...basic, passwordRef: 'env:MISSING' }, 'r3'))).rejects.toMatchObject({ code: 'SECRET_RESOLUTION_FAILED' });
    expect(store.captureSnapshot()).toBe(disabled);
    await expect(resolveUpstreamCredential(store.captureSnapshot(), input)).rejects.toMatchObject({ code: 'CREDENTIAL_INACTIVE' });
  });
  it('rechecks expiry after asynchronous secret reads and accepts the exact notBefore boundary', async () => {
    const { store } = registry(); const at = Date.parse('2030-01-01T00:00:00Z');
    const snapshot = await store.reload(raw({ ...bearer, notBefore: new Date(at).toISOString(), expiresAt: new Date(at + 1000).toISOString() }));
    const now = jest.spyOn(Date, 'now').mockReturnValue(at);
    try {
      expect((await resolveUpstreamCredential(snapshot, input)).mode).toBe('reference');
      const crossing = { ...snapshot, resolveSecret: async () => { now.mockReturnValue(at + 1000); return 'token'; } };
      await expect(resolveUpstreamCredential(crossing, input)).rejects.toMatchObject({ code: 'CREDENTIAL_INACTIVE' });
    } finally { now.mockRestore(); }
  });
  it.each([{ USER: 'bad:name', PASS: 'pass' }, { USER: '', PASS: 'pass' }, { USER: 'name', PASS: '\r\nsecret' }, { USER: 'name', PASS: '\ud800' }, { USER: 'name', PASS: 'x'.repeat(8192) }])('rejects unsafe Basic material without leaking it', async values => {
    const { store } = registry(values);
    await expect(store.reload(raw(basic))).rejects.toMatchObject({ code: 'SECRET_RESOLUTION_FAILED', message: 'Upstream credential registry rejected the request: SECRET_RESOLUTION_FAILED' });
  });
  it('does not return partial Basic material when a provider fails after activation', async () => {
    const { store, values } = registry(); const snapshot = await store.reload(raw(basic)); delete values.PASS;
    await expect(resolveUpstreamCredential(snapshot, input)).rejects.toMatchObject({ code: 'SECRET_RESOLUTION_FAILED' });
  });
  it('reads changed provider contents on each call at the same revision', async () => {
    const { store, values } = registry(); const snapshot = await store.reload(raw(custom));
    const before = await resolveUpstreamCredential(snapshot, input); values.TOKEN = 'next-synthetic-token';
    const after = await resolveUpstreamCredential(snapshot, input); expect(after.headers['x-service-key'] !== before.headers['x-service-key']).toBe(true);
  });
  it('rejects unknown runtime credential objects rather than taking an apiKey default branch', async () => {
    const { store } = registry(); const snapshot = await store.reload(raw(bearer));
    const bad = { ...snapshot, candidate: { ...snapshot.candidate, credentials: { chosen: { type: 'unknown' } } } } as any;
    await expect(resolveUpstreamCredential(bad, input)).rejects.toMatchObject({ code: 'UNSUPPORTED_CREDENTIAL_TYPE' });
    expect(() => upstreamCredentialHeaderName({ type: 'unknown' } as any)).toThrow('UNSUPPORTED_CREDENTIAL_TYPE');
  });
  it.each(['Bearer prefixed', 'token with spaces', 'x'.repeat(8190), '令牌'])('rejects invalid Bearer material before candidate activation (%#)', async token => {
    const { store } = registry({ TOKEN: token });
    await expect(store.reload(raw(bearer))).rejects.toMatchObject({ code: 'SECRET_RESOLUTION_FAILED' });
  });

  it('compares timestamp instants numerically when timezone conversion crosses year 9999', () => {
    const earlier = '9999-12-31T23:59:59Z', later = '9999-12-31T23:59:59-01:00';
    expect(() => validateUpstreamCredentialBindings(raw({ ...bearer, notBefore: later, expiresAt: earlier }))).toThrow('INVALID_VALUE');
    const accepted = validateUpstreamCredentialBindings(raw({ ...bearer, notBefore: earlier, expiresAt: later })).credentials.chosen;
    expect(Date.parse(accepted.expiresAt!) - Date.parse(accepted.notBefore!)).toBe(3600000);
    expect(accepted.expiresAt).toBe('+010000-01-01T00:59:59.000Z');
  });

});
