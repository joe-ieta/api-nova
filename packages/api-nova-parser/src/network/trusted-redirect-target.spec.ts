import { UpstreamCredentialRegistry } from '../credentials/registry';
import { createNetworkPolicyCompiler } from './network-policy';
import { createTrustedRedirectTargetSelector, type TrustedRedirectTargetRegistration } from './trusted-redirect-target';

describe('trusted exact redirect target selection (no transport or follow loop)', () => {
  let registry: UpstreamCredentialRegistry, compiler: ReturnType<typeof createNetworkPolicyCompiler>, candidate: any;
  let read: jest.Mock, targets: TrustedRedirectTargetRegistration[];
  const start = 'https://a.test/start';
  beforeEach(async () => {
    read = jest.fn(async () => 'synthetic-secret');
    registry = new UpstreamCredentialRegistry({ environment: 'test', providerFactory: () => ({ type: 'env', resolve: read }) });
    candidate = { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'r1', environment: 'test' },
      reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { env: { type: 'env' } },
      credentials: { bearer: { type: 'bearer', secretRef: 'env:BEARER' }, key: { type: 'apiKey', placement: { in: 'header', name: 'X-New' }, secretRef: 'env:KEY' }, old: { type: 'apiKey', placement: { in: 'header', name: 'X-Old' }, secretRef: 'env:OLD' } },
      sites: [
        { id: 'root', sourceServiceAssetId: 'asset', match: { scheme: 'https', host: 'a.test', port: 443, basePath: '/' }, allowedHosts: ['a.test'], credential: 'bearer', endpoints: [{ endpointDefinitionId: 'root-endpoint' }, { endpointDefinitionId: 'public', credential: 'none' }] },
        { id: 'deep', sourceServiceAssetId: 'asset', match: { scheme: 'https', host: 'a.test', port: 443, basePath: '/deep' }, allowedHosts: ['a.test'], credential: 'key', endpoints: [{ endpointDefinitionId: 'deep-endpoint' }] },
        { id: 'other', sourceServiceAssetId: 'asset', match: { scheme: 'https', host: 'b.test', port: 443, basePath: '/' }, allowedHosts: ['b.test'], credential: 'key', endpoints: [{ endpointDefinitionId: 'other-endpoint' }] },
        { id: 'foreign', sourceServiceAssetId: 'foreign-asset', match: { scheme: 'https', host: 'foreign.test', port: 443, basePath: '/' }, allowedHosts: ['foreign.test'], credential: 'key', endpoints: [{ endpointDefinitionId: 'foreign-endpoint' }] },
      ] };
    await registry.reload(candidate);
    delete candidate.credentials.old; candidate.metadata = { revision: 'r2', environment: 'test' }; await registry.reload(candidate);
    compiler = createNetworkPolicyCompiler({ deniedDestinations: [], loopback: 'deny' });
    const policy = (siteId: string, origin: string) => compiler.compile({ version: 1, id: 'p-' + siteId, revision: '1', sourceServiceAssetId: 'asset', siteId, origin, mode: 'public', connection: 'direct' });
    const root = policy('root', 'https://a.test'), deep = policy('deep', 'https://a.test'), other = policy('other', 'https://b.test');
    targets = [
      { siteId: 'root', method: 'GET', path: '/next', endpointDefinitionId: 'root-endpoint', policy: root },
      { siteId: 'root', method: 'HEAD', path: '/next', endpointDefinitionId: 'root-endpoint', policy: root },
      { siteId: 'root', method: 'GET', path: '/public', endpointDefinitionId: 'public', policy: root },
      { siteId: 'deep', method: 'GET', path: '/deep/item', endpointDefinitionId: 'deep-endpoint', policy: deep },
      { siteId: 'other', method: 'GET', path: '/next', endpointDefinitionId: 'other-endpoint', policy: other },
    ]; read.mockClear();
  });
  const selector = () => createTrustedRedirectTargetSelector({ snapshot: registry.captureSnapshot(), sourceServiceAssetId: 'asset', compiler, targets });
  it('resolves relative Location by real method/path and reselects the more specific Site', async () => {
    const selected = await selector().select(start, '/deep/item?q=1', 'GET');
    expect(selected.binding).toEqual({ sourceServiceAssetId: 'asset', endpointDefinitionId: 'deep-endpoint', method: 'GET', path: '/deep/item' });
    expect(selected.credentials.siteId).toBe('deep'); expect(selected.url).toBe('https://a.test:443/deep/item?q=1');
    expect(selected.credentials.headers).toEqual({ 'x-new': 'synthetic-secret' }); expect(Object.isFrozen(selected)).toBe(true);
  });
  it('allows explicitly registered cross-origin within one asset and rebuilds authentication', async () => {
    const directory = selector(), selected = await directory.select(start, 'https://b.test/next', 'GET');
    const headers = directory.rebuildHeaders(selected, { Authorization: 'old', Cookie: 'old', 'Proxy-Authorization': 'old', 'X-Old': 'old', 'x-new': 'consumer', 'X-Safe': 'business', Host: 'a.test', 'Content-Length': '0' });
    expect(headers).toEqual({ 'x-new': 'synthetic-secret', 'x-safe': 'business', 'accept-encoding': 'identity' });
    expect(Object.isFrozen(headers)).toBe(true);
  });
  it('None suppresses prior Endpoint credentials including durable historical names', async () => {
    const directory = selector(), selected = await directory.select(start, '/public', 'GET');
    expect(selected.credentials.headers).toEqual({}); expect(read).not.toHaveBeenCalled();
    expect(directory.rebuildHeaders(selected, { Authorization: 'old', 'X-New': 'old', 'X-Old': 'old', Cookie: 'old' })).toEqual({ 'accept-encoding': 'identity' });
  });
  it.each(['POST', 'PUT', 'DELETE', 'get'])('refuses method %s without resolving a secret', async method => {
    await expect(selector().select(start, '/next', method as any)).rejects.toMatchObject({ code: 'upstream_network_policy_denied' }); expect(read).not.toHaveBeenCalled();
  });
  it.each(['/missing', '/deep/missing', 'https://foreign.test/next', 'http://a.test/next', 'https://a.test:444/next', 'https://user:secret@b.test/next', '/next#fragment', '/%2e%2e/next', '/next\\tail', ' /next', ''])('rejects unsafe or unknown target %s before secret reads', async location => {
    await expect(selector().select(start, location, 'GET')).rejects.toMatchObject({ code: 'upstream_network_policy_denied' }); expect(read).not.toHaveBeenCalled();
  });
  it('distinguishes HEAD and GET and never guesses a missing method entry', async () => {
    expect((await selector().select(start, '/next', 'HEAD')).binding.method).toBe('HEAD'); read.mockClear();
    await expect(selector().select(start, '/public', 'HEAD')).rejects.toThrow(); expect(read).not.toHaveBeenCalled();
  });
  it('retains its original snapshot after Registry rotation without taking a new revision', async () => {
    const directory = selector(); candidate.metadata = { revision: 'r3', environment: 'test' }; await registry.reload(candidate); read.mockClear();
    expect((await directory.select(start, '/next', 'GET')).credentials.revision).toBe('r2');
    expect(registry.captureSnapshot().candidate.metadata.revision).toBe('r3');
  });
  it.each(['duplicate', 'unknown-endpoint', 'template', 'wrong-site', 'policy-clone', 'root-shadow'])('rejects invalid host directory %s', mode => {
    if (mode === 'duplicate') targets.push({ ...targets[0] });
    if (mode === 'unknown-endpoint') targets[0] = { ...targets[0], endpointDefinitionId: 'missing' };
    if (mode === 'template') targets[0] = { ...targets[0], path: '/items/{id}' };
    if (mode === 'wrong-site') targets[0] = { ...targets[0], siteId: 'foreign' };
    if (mode === 'policy-clone') targets[0] = { ...targets[0], policy: { ...targets[0].policy } };
    if (mode === 'root-shadow') targets[0] = { ...targets[0], path: '/deep/item' };
    expect(selector).toThrow(); expect(read).not.toHaveBeenCalled();
  });
  it('rejects cloned target capabilities, headers with getters and case-duplicate business names', async () => {
    const directory = selector(), selected = await directory.select(start, '/next', 'GET');
    expect(() => directory.rebuildHeaders({ ...selected }, {})).toThrow();
    const getter = jest.fn(() => 'secret');
    expect(() => directory.rebuildHeaders(selected, Object.defineProperty({}, 'x-safe', { get: getter }))).toThrow(); expect(getter).not.toHaveBeenCalled();
    expect(() => directory.rebuildHeaders(selected, { 'X-Safe': 'one', 'x-safe': 'two' })).toThrow();
  });
  it('rechecks policy expiry after asynchronous credential resolution', async () => {
    const expires = Date.now() + 10000;
    targets[0] = { ...targets[0], policy: compiler.compile({ version: 1, id: 'limited', revision: '1', sourceServiceAssetId: 'asset', siteId: 'root', origin: 'https://a.test', mode: 'private-exception', connection: 'direct',
      privateException: { id: 'exception', revision: '1', sourceServiceAssetId: 'asset', siteId: 'root', origin: 'https://a.test', addresses: ['10.0.0.1'], purpose: 'test', owner: 'test', approvalRef: 'test', issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(expires).toISOString() } }) };
    const directory = selector(); let clock: jest.SpyInstance | undefined;
    read.mockImplementationOnce(async () => { clock = jest.spyOn(Date, 'now').mockReturnValue(expires + 1); return 'synthetic-secret'; });
    try { await expect(directory.select(start, '/next', 'GET')).rejects.toMatchObject({ code: 'upstream_network_policy_denied' }); }
    finally { clock?.mockRestore(); }
  });
  it('sanitizes credential failure and never returns the source secret error', async () => {
    const directory = selector(); read.mockRejectedValueOnce(new Error('secret-provider-error'));
    await expect(directory.select(start, '/next', 'GET')).rejects.toMatchObject({ message: 'upstream_network_policy_denied' });
  });
  it('does not invoke directory or header getters and rejects hostile header input', async () => {
    const directory = selector(), selected = await directory.select(start, '/next', 'GET');
    const getter = jest.fn(() => targets[0]);
    Object.defineProperty(targets, '0', { get: getter }); expect(selector).toThrow(); expect(getter).not.toHaveBeenCalled();
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const value of [null, revoked.proxy, Object.create({ secret: 'hidden' }), { 'x-safe': 'bad\r\nvalue' }, { 'x-safe': 'x'.repeat(8193) }]) {
      expect(() => directory.rebuildHeaders(selected, value as any)).toThrow('upstream_network_policy_denied');
    }
  });});