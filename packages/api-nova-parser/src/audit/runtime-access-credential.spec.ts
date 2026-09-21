import { createHash } from 'node:crypto';
import { authenticateRuntimeRequest } from './runtime-auth';
import { parseRuntimeAccessCredentialEnvelope, RuntimeAccessCredential, verifyRuntimeAccessCredential } from './runtime-access-credential';
const secret = 'fixture-secret';
const record = (overrides: Partial<RuntimeAccessCredential> = {}): RuntimeAccessCredential => ({
  version: 1, id: 'credential-1', keyId: 'key_1', secretHash: createHash('sha256').update(secret).digest('hex'), status: 'active',
  subject: 'worker', protocols: ['gateway', 'mcp'], runtimeAssetId: 'runtime-1', toolScopes: ['read'], scopes: ['invoke'],
  expiresAt: 2000000000, actorId: 'operator-1', ...overrides,
});
const context = { protocol: 'gateway' as const, runtimeAssetId: 'runtime-1', now: 1900000000 };
describe('shared runtime access credential', () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => { saved = { ...process.env }; delete process.env.API_NOVA_RUNTIME_REQUIRED_SCOPES; });
  afterEach(() => { process.env = saved; });
  it('produces identical stable identities for both protocols and preserves independent key identity', () => {
    const gateway = verifyRuntimeAccessCredential('key_1.' + secret, record(), context);
    const mcp = verifyRuntimeAccessCredential('key_1.' + secret, record(), { ...context, protocol: 'mcp' });
    expect(mcp).toEqual(gateway);
    expect(mcp.toolScopes).toEqual(['read']);
    const next = verifyRuntimeAccessCredential('key_2.' + secret, record({ keyId: 'key_2', id: 'credential-2' }), context);
    expect(next.callerId).toBe(gateway.callerId);
    expect(next.credentialId).not.toBe(gateway.credentialId);
  });
  it.each(['key_1.wrong', 'wrong.fixture-secret', 'key_1.', 'key_1', ' key_1.fixture-secret'])('rejects bad presentation %s', presented => {
    expect(() => verifyRuntimeAccessCredential(presented, record(), context)).toThrow('invalid_api_key');
  });
  it.each([{ status: 'revoked' }, { status: 'inactive' }, { expiresAt: 1900000000 }])('rejects inactive and expired %j', overrides => {
    expect(() => verifyRuntimeAccessCredential('key_1.' + secret, record(overrides as Partial<RuntimeAccessCredential>), context)).toThrow('invalid_api_key');
  });
  it.each([{ protocols: ['mcp'] }, { runtimeAssetId: 'other' }, { routeBindingId: 'route' }])('enforces independent protocol/runtime/route boundary %j', overrides => {
    expect(() => verifyRuntimeAccessCredential('key_1.' + secret, record(overrides as Partial<RuntimeAccessCredential>), context)).toThrow('credential_scope_forbidden');
  });
  it('accepts only matching route and treats empty tool scope distinctly from explicit wildcard', () => {
    expect(verifyRuntimeAccessCredential('key_1.' + secret, record({ routeBindingId: 'route', toolScopes: [] }), { ...context, routeBindingId: 'route' }).toolScopes).toEqual([]);
    expect(verifyRuntimeAccessCredential('key_1.' + secret, record({ toolScopes: ['*'] }), context).toolScopes).toEqual(['*']);
  });
  it.each([{ version: 2 }, { toolScopes: null }, { protocols: [] }, { scopes: ['x', 'x'] }, { expiresAt: NaN }, { subject: '' }, { secretHash: 'plaintext' }])('fails closed for malformed stored data %j', overrides => {
    expect(() => verifyRuntimeAccessCredential('key_1.' + secret, record(overrides as any), context)).toThrow('runtime_auth_not_configured');
  });
  it('rejects ambiguous or cross-runtime envelopes', () => {
    for (const credentials of [[record(), record()], [record({ runtimeAssetId: 'other' })]])
      expect(() => parseRuntimeAccessCredentialEnvelope(JSON.stringify({ version: 1, runtimeAssetId: 'runtime-1', credentials }))).toThrow('runtime_auth_not_configured');
  });
  it('authenticates explicit new envelope without a resource URL and never falls back to legacy keys', async () => {
    process.env.API_NOVA_RUNTIME_ACCESS_CREDENTIALS = JSON.stringify({ version: 1, runtimeAssetId: 'runtime-1', credentials: [record()] });
    process.env.API_NOVA_RUNTIME_API_KEYS = JSON.stringify([{ id: 'legacy', subject: 'legacy', secretHash: createHash('sha256').update('legacy-secret').digest('hex'), expiresAt: 2000000000, resources: ['https://fixture.invalid'], scopes: [] }]);
    delete process.env.API_NOVA_RUNTIME_RESOURCE;
    delete process.env.API_NOVA_MCP_RESOURCE;
    const result = await authenticateRuntimeRequest({ 'x-api-key': 'key_1.' + secret }, 'mcp', 'api_key');
    expect(result.credentialId).toBe('credential-1');
    await expect(authenticateRuntimeRequest({ 'x-api-key': 'legacy-secret' }, 'mcp', 'api_key')).rejects.toMatchObject({ status: 401 });
    process.env.API_NOVA_RUNTIME_ACCESS_CREDENTIALS = '';
    await expect(authenticateRuntimeRequest({ 'x-api-key': 'legacy-secret' }, 'mcp', 'api_key')).rejects.toMatchObject({ status: 503 });
  });
  it('still intersects the host required scopes', async () => {
    process.env.API_NOVA_RUNTIME_ACCESS_CREDENTIALS = JSON.stringify({ version: 1, runtimeAssetId: 'runtime-1', credentials: [record()] });
    process.env.API_NOVA_RUNTIME_REQUIRED_SCOPES = 'admin';
    await expect(authenticateRuntimeRequest({ 'x-api-key': 'key_1.' + secret }, 'mcp', 'api_key')).rejects.toMatchObject({ status: 403 });
  });
});
