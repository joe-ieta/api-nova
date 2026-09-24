import { createNetworkOperationAuthority } from './network-operation-authority';
import { createNetworkPolicyCompiler } from './network-policy';
import { UpstreamCredentialRegistry } from '../credentials/registry';
import { resolveUpstreamCredential } from '../credentials/resolver';

describe('host-owned logical network operation authority (no production wiring)', () => {
  let epoch: string, registry: UpstreamCredentialRegistry, config: any, context: any, captured: jest.Mock, read: jest.Mock;
  let compiler: ReturnType<typeof createNetworkPolicyCompiler>;
  const request = () => ({ sourceServiceAssetId: 'asset', operationKey: 'endpoint', deadline: Date.now() + 10000 });
  beforeEach(async () => {
    epoch = 'security-1';
    config = { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'r1', environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { memory: { type: 'env' } }, credentials: { api: { type: 'apiKey', placement: { in: 'header', name: 'X-Private' }, secretRef: 'memory:KEY' } },
      sites: [{ id: 'site', sourceServiceAssetId: 'asset', match: { scheme: 'https', host: 'fixture.test', port: 443, basePath: '/' }, allowedHosts: ['fixture.test'], credential: 'api', endpoints: [{ endpointDefinitionId: 'endpoint' }] }] };
    registry = new UpstreamCredentialRegistry({ environment: 'test', providerFactory: description => ({ type: description.type, resolve: async () => 'synthetic-secret' }) });
    await registry.reload(config); compiler = createNetworkPolicyCompiler({ deniedDestinations: [], loopback: 'deny' });
    const snapshot = registry.captureSnapshot(), resolution = await resolveUpstreamCredential(snapshot, { sourceServiceAssetId: 'asset', endpointDefinitionId: 'endpoint', url: 'https://fixture.test/path', requestMethod: 'GET' });
    context = { snapshot, policy: compiler.compile({ version: 1, id: 'policy', revision: '1', sourceServiceAssetId: 'asset', siteId: 'site', origin: 'https://fixture.test', mode: 'public', connection: 'direct' }), sourceServiceAssetId: 'asset', siteId: 'site', endpointDefinitionId: 'endpoint', targetUrl: 'https://fixture.test/path', method: 'GET', providerEpoch: 'opaque-observed-material-1', credentialHeaders: { ...resolution.headers } };
    captured = jest.fn(async () => context); read = jest.fn(() => epoch);
  });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });
  const authority = (options = {}) => createNetworkOperationAuthority({ compiler, readSecurityEpoch: read, captureAuthorizedContext: captured, ...options });
  it('generates IDs and exposes no Snapshot/policy/credentials in handles or JSON', async () => {
    const host = authority(), one = await host.begin(request()), two = await host.begin(request());
    expect(one.operationId).not.toBe(two.operationId); expect(Object.keys(one)).toEqual(['operationId', 'deadline', 'signal']);
    const wire = JSON.stringify(one); for (const text of ['synthetic-secret', 'fixture.test', 'snapshot', 'providerEpoch', 'credentialHeaders']) expect(wire).not.toContain(text);
    expect(host.assertCurrent(one).snapshot).toBe(context.snapshot); expect(host.assertCurrent(one).credentialHeaders['x-private']).toBe('synthetic-secret'); host.close(one); host.close(two);
  });
  it('copies authorization material before later mutation', async () => {
    const host = authority(), handle = await host.begin(request()); context.credentialHeaders['x-private'] = 'changed'; context.targetUrl = 'https://other.test/';
    expect(host.assertCurrent(handle).credentialHeaders['x-private']).toBe('synthetic-secret'); expect(host.assertCurrent(handle).targetUrl).toBe('https://fixture.test:443/path'); expect(Object.isFrozen(host.assertCurrent(handle).credentialHeaders)).toBe(true); host.close(handle);
  });
  it('ordinary reload leaves active Snapshot fixed and new operations capture new Snapshot', async () => {
    const host = authority(), one = await host.begin(request()), old = context.snapshot;
    await registry.reload({ ...config, metadata: { revision: 'r2', environment: 'test' } }); context = { ...context, snapshot: registry.captureSnapshot() };
    const two = await host.begin(request()); expect(host.assertCurrent(one).snapshot).toBe(old); expect(host.assertCurrent(two).snapshot).toBe(context.snapshot); host.close(one); host.close(two);
  });
  it('revoke advances state before synchronous listeners and requires a new host epoch', async () => {
    const host = authority(), one = await host.begin(request()), two = await host.begin(request()); let rejected = false;
    one.signal.addEventListener('abort', () => { try { host.assertCurrent(two); } catch { rejected = true; } });
    host.revoke('asset'); expect(rejected).toBe(true); expect(one.signal.aborted).toBe(true); expect(two.signal.aborted).toBe(true);
    await expect(host.begin(request())).rejects.toMatchObject({ code: 'upstream_network_policy_denied' });
    epoch = 'security-2'; const three = await host.begin(request()); expect(host.assertCurrent(three)).toBeDefined(); expect(() => host.assertCurrent(one)).toThrow(); host.close(three);
  });
  it.each(['revoke', 'epoch', 'abort', 'unavailable'])('late capture after %s cannot issue or revive a handle', async action => {
    let complete!: (value: any) => void; captured.mockImplementation(() => new Promise(resolve => complete = resolve)); const host = authority(), controller = new AbortController();
    const pending = host.begin({ ...request(), signal: controller.signal }); await Promise.resolve(); await Promise.resolve();
    if (action === 'revoke') host.revoke('asset'); if (action === 'epoch') epoch = 'security-2'; if (action === 'abort') controller.abort(); if (action === 'unavailable') read.mockImplementation(() => { throw new Error('private host detail'); });
    complete(context); await expect(pending).rejects.toMatchObject({ code: action === 'abort' ? 'ABORT_ERR' : action === 'unavailable' ? 'upstream_network_policy_unavailable' : 'upstream_network_policy_denied' });
  });
  it('deadline includes pending capture and a late result cannot reclaim capacity', async () => {
    jest.useFakeTimers(); let complete!: (value: any) => void; captured.mockImplementationOnce(() => new Promise(resolve => complete = resolve)); const host = authority({ maxOperations: 1 });
    const pending = host.begin({ ...request(), deadline: Date.now() + 100 }); const expected = expect(pending).rejects.toMatchObject({ code: 'ETIMEDOUT' }); await Promise.resolve(); await jest.advanceTimersByTimeAsync(101); await expected;
    complete(context); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); const next = await host.begin(request()); host.close(next); expect(jest.getTimerCount()).toBe(0);
  });
  it('capacity counts pending captures and close removes timer/cancellation subscriptions', async () => {
    jest.useFakeTimers(); const controller = new AbortController(), remove = jest.spyOn(controller.signal, 'removeEventListener'), host = authority({ maxOperations: 1 });
    const handle = await host.begin({ ...request(), signal: controller.signal }); await expect(host.begin(request())).rejects.toMatchObject({ code: 'upstream_network_policy_unavailable' });
    host.close(handle); host.close(handle); expect(remove).toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0); const next = await host.begin(request()); host.close(next);
  });
  it('state read failure aborts associated operations and never exposes raw error', async () => {
    const host = authority(), one = await host.begin(request()), two = await host.begin(request()); read.mockImplementation(() => { throw new Error('private secret diagnostic'); });
    expect(() => host.assertCurrent(one)).toThrow('upstream_network_policy_unavailable'); expect(one.signal.aborted).toBe(true); expect(two.signal.aborted).toBe(true); expect(String(one.signal.reason)).not.toContain('private');
  });
  it('rejects JSON, foreign authority and caller-provided IDs', async () => {
    const host = authority(), other = authority(), one = await host.begin(request());
    expect(() => host.assertCurrent(JSON.parse(JSON.stringify(one)))).toThrow(); expect(() => other.assertCurrent(one)).toThrow();
    await expect(host.begin({ ...request(), operationId: 'chosen' } as any)).rejects.toThrow(); host.close(one);
  });
  it.each(['snapshot', 'policy', 'source', 'headers', 'throw'])('rejects malicious capture %s safely', async change => {
    if (change === 'snapshot') context.snapshot = { ...context.snapshot }; if (change === 'policy') context.policy = JSON.parse(JSON.stringify(context.policy)); if (change === 'source') context.sourceServiceAssetId = 'other';
    const hook = jest.fn(() => 'secret'); if (change === 'headers') context.credentialHeaders = Object.defineProperty({}, 'authorization', { get: hook });
    if (change === 'throw') captured.mockRejectedValue(new Error('sensitive provider failure'));
    await expect(authority().begin(request())).rejects.not.toThrow('sensitive'); expect(hook).not.toHaveBeenCalled();
  });
  it('rejects unavailable initial epoch without calling capture', async () => { read.mockReturnValue(''); await expect(authority().begin(request())).rejects.toMatchObject({ code: 'upstream_network_policy_unavailable' }); expect(captured).not.toHaveBeenCalled(); });
  it('pre-aborted/deadline input allocates no timer and never captures', async () => { jest.useFakeTimers(); const controller = new AbortController(); controller.abort(); const host = authority();
    await expect(host.begin({ ...request(), signal: controller.signal })).rejects.toMatchObject({ code: 'ABORT_ERR' }); await expect(host.begin({ ...request(), deadline: Date.now() })).rejects.toMatchObject({ code: 'ETIMEDOUT' }); expect(captured).not.toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0);
  });
  it('revoke before first use blocks its epoch and permits only a new host epoch', async () => {
    const host = authority(); host.revoke('asset'); await expect(host.begin(request())).rejects.toMatchObject({ code: 'upstream_network_policy_denied' }); epoch = 'security-2'; const handle = await host.begin(request()); host.close(handle);
  });
  it('reentrant host callback cannot close and still return an authorized context', async () => {
    const host = authority(), handle = await host.begin(request()); read.mockImplementation(() => { host.close(handle); return epoch; }); expect(() => host.assertCurrent(handle)).toThrow(); expect(handle.signal.aborted).toBe(true);
  });
  it('capacity includes unresolved async work and source tombstones are bounded', async () => {
    let complete!: (value: any) => void; captured.mockImplementationOnce(() => new Promise(resolve => complete = resolve)); const host = authority({ maxOperations: 1, maxSources: 1 });
    const pending = host.begin(request()); await Promise.resolve(); await Promise.resolve(); await expect(host.begin(request())).rejects.toMatchObject({ code: 'upstream_network_policy_unavailable' }); complete(context); const handle = await pending; host.close(handle);
    await expect(host.begin({ ...request(), sourceServiceAssetId: 'other' })).rejects.toMatchObject({ code: 'upstream_network_policy_unavailable' });
  });

  it('cancelled callback that ignores Signal retains its bounded capacity until settled', async () => {
    let complete!: (value: any) => void; captured.mockImplementationOnce(() => new Promise(resolve => complete = resolve)); const host = authority({ maxOperations: 1 }), controller = new AbortController();
    const pending = host.begin({ ...request(), signal: controller.signal }); const rejection = expect(pending).rejects.toMatchObject({ code: 'ABORT_ERR' }); await Promise.resolve(); await Promise.resolve(); controller.abort(); await rejection;
    await expect(host.begin(request())).rejects.toMatchObject({ code: 'upstream_network_policy_unavailable' }); complete(context); await new Promise(resolve => setImmediate(resolve)); const next = await host.begin(request()); host.close(next);
  });

  it('cancellation between queued capture stages prevents callback execution', async () => {
    const host = authority(), controller = new AbortController(); const pending = host.begin({ ...request(), signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'ABORT_ERR' }); await Promise.resolve(); controller.abort(); await rejection; expect(captured).not.toHaveBeenCalled();
  });

});
