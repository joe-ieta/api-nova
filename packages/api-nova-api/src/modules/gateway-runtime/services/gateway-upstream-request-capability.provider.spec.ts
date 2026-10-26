import { createGatewayUpstreamRequestCapability, createGatewayUpstreamRequestCapabilityProvider } from './gateway-upstream-request-capability.provider';
import type { SecurityProof } from '../../publication/security/upstream-security-proof-authority';

const proof = Object.freeze({}) as SecurityProof;
const scope = { runtimeAssetId: 'runtime', runtimeMembershipId: 'membership', endpointDefinitionId: 'endpoint', sourceServiceAssetId: 'asset' };
const context = (overrides: Record<string, unknown> = {}) => ({
  sourceServiceAssetId: 'asset', endpointDefinitionId: 'endpoint', contextDigest: 'a'.repeat(64), providerEpoch: 'epoch-1',
  bindingId: 'binding', bindingRevision: 'r1', registryRevision: 'r1', generation: 1, target: 'https://api.example/target',
  method: 'GET' as 'GET' | 'HEAD', credentialType: 'apiKey', actorId: 'actor', ...overrides,
});

const create = (overrides: Record<string, unknown> = {}) => createGatewayUpstreamRequestCapability({
  proof, session: { actorId: 'actor' }, scope, method: 'GET', requestMethod: 'GET',
  target: 'https://api.example/target', contextDigest: 'a'.repeat(64), providerEpoch: 'epoch-1',
  generation: 1, actorId: 'actor', expiresAt: Date.now() + 60000, ...overrides,
});

describe('Gateway request-bound proof capability provider', () => {
  it('consumes a bound capability exactly once for the matching request and scope', async () => {
    const provider = createGatewayUpstreamRequestCapabilityProvider();
    const request = { method: 'GET' };
    expect(provider.bind(request, create())).toBe(true);
    expect(provider.has(request)).toBe(true);
    const consumed = await provider.read(request, scope);
    expect(consumed).toEqual({ proof, session: { actorId: 'actor' }, binding: expect.objectContaining({
      runtimeAssetId: 'runtime', runtimeMembershipId: 'membership', endpointDefinitionId: 'endpoint', sourceServiceAssetId: 'asset',
      method: 'GET', requestMethod: 'GET', target: 'https://api.example/target', contextDigest: 'a'.repeat(64),
      providerEpoch: 'epoch-1', generation: 1, actorId: 'actor' }) });
    expect(await provider.read(request, scope)).toBeUndefined();
    expect(await provider.read({ method: 'GET' }, scope)).toBeUndefined();
  });

  it('never serializes proof or session material into the capability', () => {
    const capability = create();
    expect(Object.keys(capability)).toEqual(['kind']);
    expect(JSON.stringify(capability)).toBe('{"kind":"gateway-upstream-request-capability"}');
    expect(JSON.stringify(Object.getOwnPropertyDescriptors(capability))).not.toContain('proof');
  });

  it.each(['runtimeAssetId', 'runtimeMembershipId', 'endpointDefinitionId', 'sourceServiceAssetId'])('rejects a %s scope mismatch before consumption', async field => {
    const provider = createGatewayUpstreamRequestCapabilityProvider();
    const request = { method: 'GET' };
    expect(provider.bind(request, create())).toBe(true);
    expect(await provider.read(request, { ...scope, [field]: 'other' })).toBeUndefined();
    expect(await provider.read(request, scope)).toBeUndefined();
  });

  it.each(['POST', 'HEAD', ''])('rejects a %s request method mismatch', async method => {
    const provider = createGatewayUpstreamRequestCapabilityProvider();
    const request = { method };
    expect(provider.bind(request, create())).toBe(true);
    expect(await provider.read(request, scope)).toBeUndefined();
  });

  it('rejects a replay that binds the same capability to a second request', async () => {
    const provider = createGatewayUpstreamRequestCapabilityProvider();
    const first = { method: 'GET' }, second = { method: 'GET' };
    const capability = create();
    expect(provider.bind(first, capability)).toBe(true);
    expect(await provider.read(first, scope)).toBeDefined();
    expect(provider.bind(second, capability)).toBe(false);
    expect(await provider.read(second, scope)).toBeUndefined();
  });

  it('rejects a second capability on the same request', async () => {
    const provider = createGatewayUpstreamRequestCapabilityProvider();
    const request = { method: 'GET' };
    expect(provider.bind(request, create())).toBe(true);
    expect(provider.bind(request, create())).toBe(false);
    expect(await provider.read(request, scope)).toBeDefined();
  });

  it.each([
    ['target', { target: 'https://other.example/target' }],
    ['contextDigest', { contextDigest: 'b'.repeat(64) }],
    ['providerEpoch', { providerEpoch: 'epoch-2' }],
    ['generation', { generation: 2 }],
    ['method', { method: 'HEAD' }],
    ['actorId', { actorId: 'other' }],
    ['sourceServiceAssetId', { sourceServiceAssetId: 'other' }],
    ['endpointDefinitionId', { endpointDefinitionId: 'other' }],
  ])('rejects a current context %s mismatch at read time', async (_field, change) => {
    const read = jest.fn(async (_session: unknown, _selector: unknown) => context(change));
    const provider = createGatewayUpstreamRequestCapabilityProvider({ contexts: { read } });
    const request = { method: 'GET' };
    expect(provider.bind(request, create())).toBe(true);
    expect(await provider.read(request, scope)).toBeUndefined();
  });

  it('accepts a matching host context and fails closed when the reader is missing or throws', async () => {
    const read = jest.fn(async () => context());
    const provider = createGatewayUpstreamRequestCapabilityProvider({ contexts: { read } });
    const request = { method: 'GET' };
    expect(provider.bind(request, create())).toBe(true);
    expect(await provider.read(request, scope)).toBeDefined();
    expect(await provider.read(request, scope)).toBeUndefined();

    const missing = createGatewayUpstreamRequestCapabilityProvider({ contexts: { read: jest.fn(async () => undefined) } });
    const missingRequest = { method: 'GET' };
    expect(missing.bind(missingRequest, create())).toBe(true);
    expect(await missing.read(missingRequest, scope)).toBeUndefined();

    const failing = createGatewayUpstreamRequestCapabilityProvider({ contexts: { read: jest.fn(async () => { throw Error('secret-private'); }) } });
    const failingRequest = { method: 'GET' };
    expect(failing.bind(failingRequest, create())).toBe(true);
    expect(await failing.read(failingRequest, scope)).toBeUndefined();
  });

  it('expires a capability by TTL and rejects an already expired binding', async () => {
    let clock = 0;
    const provider = createGatewayUpstreamRequestCapabilityProvider({ now: () => clock, ttlMs: 1000 });
    const request = { method: 'GET' };
    const capability = create({ expiresAt: 1000 });
    expect(provider.bind(request, capability)).toBe(true);
    clock = 1000;
    expect(await provider.read(request, scope)).toBeUndefined();
    clock = 0;
    const late = { method: 'GET' };
    expect(provider.bind(late, create({ expiresAt: 0 }))).toBe(false);
  });

  it('revokes a bound capability without returning any material', async () => {
    const provider = createGatewayUpstreamRequestCapabilityProvider();
    const request = { method: 'GET' };
    expect(provider.bind(request, create())).toBe(true);
    provider.revoke(request);
    expect(provider.has(request)).toBe(false);
    expect(await provider.read(request, scope)).toBeUndefined();
  });

  it.each([
    ['scope ids', { scope: { ...scope, runtimeAssetId: '' } }],
    ['scope key set', { scope: { ...scope, extra: 'x' } }],
    ['method', { method: 'POST' }],
    ['requestMethod', { requestMethod: '?' }],
    ['target scheme', { target: 'ftp://api.example/target' }],
    ['target credentials', { target: 'https://user:pass@api.example/target' }],
    ['target hash', { target: 'https://api.example/target#fragment' }],
    ['contextDigest', { contextDigest: '' }],
    ['providerEpoch', { providerEpoch: ' ' }],
    ['generation', { generation: 0 }],
    ['actorId', { actorId: 'actor actor' }],
    ['expiresAt', { expiresAt: NaN }],
  ])('refuses to mint a capability from malformed %s', (_field, change) => {
    expect(() => create(change)).toThrow('GATEWAY_UPSTREAM_REQUEST_CAPABILITY_INVALID');
  });
});
