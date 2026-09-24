import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { DataSource } from 'typeorm';
import { UpstreamCredentialRegistry, normalizeUpstreamSecurity } from 'api-nova-parser';
import { UpstreamProductionChallengeEvidenceEntity as Evidence } from '../../../database/entities/upstream-production-challenge-evidence.entity';
import { createUpstreamSecurityContextAuthority } from './upstream-security-context-authority';
import { createUpstreamAuthenticationChallengeTransport } from './upstream-authentication-challenge-transport';
import { createUpstreamAuthenticationChallengeOrchestrator } from './upstream-authentication-challenge-orchestrator';
import { createUpstreamSecurityAuthorizationAdapter } from './upstream-security-authorization-adapter';
const ids = { sourceServiceAssetId: 'asset', endpointDefinitionId: 'endpoint' };
const selection = { runtimeAssetId: 'runtime', runtimeMembershipId: 'membership' };
describe('host-only proof consumption with real challenge and epoch revalidation', () => {
  let db: DataSource, server: http.Server, hits: number, providerReads: number, secret: string, row: any, candidate: any;
  let registry: UpstreamCredentialRegistry, context: any, result: any, service: ReturnType<typeof createUpstreamAuthenticationChallengeOrchestrator>;
  let authority: ReturnType<typeof createUpstreamSecurityContextAuthority>, transport: ReturnType<typeof createUpstreamAuthenticationChallengeTransport>;
  let session: object, reader: jest.Mock, adapter: ReturnType<typeof createUpstreamSecurityAuthorizationAdapter>;
  beforeEach(async () => {
    hits = providerReads = 0; secret = 'synthetic-only'; session = Object.freeze({});
    db = await new DataSource({ type: 'sqljs', entities: [Evidence], synchronize: true }).initialize();
    server = http.createServer((req, res) => { hits++; res.statusCode = req.headers['x-key'] === secret ? 200 : 401; res.end('{}'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const port = (server.address() as AddressInfo).port;
    row = { ...ids, bindingId: 'binding-a', bindingRevision: 'r1', method: 'GET', target: `http://127.0.0.1:${port}/target`, declaration: normalizeUpstreamSecurity({ security: [{ Key: [] }], components: { securitySchemes: { Key: { type: 'apiKey', in: 'header', name: 'X-Key' } } } }, {}) };
    candidate = { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'r1', environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { env: { type: 'env' } }, credentials: { key: { type: 'apiKey', placement: { in: 'header', name: 'X-Key' }, secretRef: 'env:TOKEN' } }, sites: [{ id: 'site', sourceServiceAssetId: 'asset', match: { scheme: 'http', host: '127.0.0.1', port, basePath: '/' }, allowedHosts: ['127.0.0.1'], credential: 'key', endpoints: [{ endpointDefinitionId: 'endpoint', credential: 'key' }] }] };
    registry = new UpstreamCredentialRegistry({ environment: 'test', providerFactory: d => ({ type: d.type, resolve: async () => { providerReads++; return secret; } }) }); await registry.reload(candidate);
    authority = createUpstreamSecurityContextAuthority({ read: async () => row }, () => registry.captureSnapshot());
    transport = createUpstreamAuthenticationChallengeTransport(authority);
    const intent = Object.freeze({});
    service = createUpstreamAuthenticationChallengeOrchestrator({ authority, transport, repository: db.getRepository(Evidence), intents: { resolve: async token => { if (token !== intent) throw Error(); return { ...ids, actorId: 'actor', intentId: 'intent' }; } } });
    result = await service.execute(intent);
    const { credentialType: _ignored, ...captured } = authority.inspect(await authority.issue(ids)); context = { ...captured, actorId: 'actor' };
    reader = jest.fn(async (input, selected) => input === session && selected.runtimeAssetId === 'runtime' && selected.runtimeMembershipId === 'membership' ? context : undefined);
    adapter = createUpstreamSecurityAuthorizationAdapter(service, { read: reader });
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await db.destroy(); jest.restoreAllMocks(); });
  it('accepts only the exact current actor/Binding/target context and rechecks each consumption', async () => {
    const initial = providerReads; expect(await adapter.authorize(result.proof, session, selection)).toBe(true); expect(providerReads).toBeGreaterThan(initial); expect(reader).toHaveBeenCalledTimes(2); expect(hits).toBe(4);
    secret = 'rotated'; expect(await adapter.authorize(result.proof, session, selection)).toBe(false); expect(hits).toBe(4);
  });
  it.each(['object', 'json', 'row', 'other-authority'])('rejects %s without context/Provider calls', async kind => {
    let capability: any = {};
    if (kind === 'json') capability = JSON.parse(JSON.stringify(result.proof));
    if (kind === 'row') capability = await db.getRepository(Evidence).findOneByOrFail({ id: result.evidenceId });
    if (kind === 'other-authority') {
      const another = createUpstreamAuthenticationChallengeOrchestrator({ authority, transport, repository: db.getRepository(Evidence), intents: { resolve: async () => ({ ...ids, actorId: 'actor', intentId: 'different' }) } }); capability = (await another.execute({})).proof;
    }
    const reads = providerReads, requests = hits;
    expect(await adapter.authorize(capability, session, selection)).toBe(false); expect(reader).not.toHaveBeenCalled(); expect(providerReads).toBe(reads); expect(hits).toBe(requests);
  });
  it.each(['actorId', 'sourceServiceAssetId', 'endpointDefinitionId', 'target', 'method', 'bindingId', 'bindingRevision', 'registryRevision', 'generation', 'providerEpoch', 'contextDigest'])('rejects mismatched %s before Provider calls', async field => {
    context = { ...context, [field]: field === 'generation' ? 99 : 'different' }; const reads = providerReads;
    expect(await adapter.authorize(result.proof, session, selection)).toBe(false); expect(providerReads).toBe(reads); expect(hits).toBe(4);
  });
  it.each(['bindingId', 'bindingRevision', 'generation', 'providerEpoch', 'actorId'])('rejects missing %s', async field => {
    delete context[field]; const reads = providerReads; expect(await adapter.authorize(result.proof, session, selection)).toBe(false); expect(providerReads).toBe(reads); expect(hits).toBe(4);
  });
  it('never equates different Binding entities with the same revision', async () => {
    row.bindingId = 'binding-b'; expect(row.bindingRevision).toBe(context.bindingRevision);
    expect(await adapter.authorize(result.proof, session, selection)).toBe(false); expect(hits).toBe(4);
  });
  it('rejects missing Binding identity from the authoritative repository', async () => {
    delete row.bindingId; await expect(authority.issue(ids)).rejects.toThrow('CHALLENGE_CONTEXT_UNAVAILABLE'); expect(hits).toBe(4);
  });
  it.each(['revoke', 'db-revoke', 'expiry', 'reload'])('rejects %s without business HTTP', async change => {
    if (change === 'revoke') await service.revoke(result);
    if (change === 'db-revoke') await db.getRepository(Evidence).update(result.evidenceId, { revokedAt: new Date() });
    if (change === 'expiry') jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 120000);
    if (change === 'reload') { candidate.metadata.revision = 'r2'; await registry.reload(candidate); }
    expect(await adapter.authorize(result.proof, session, selection)).toBe(false); expect(hits).toBe(4);
  });
  it('rejects untrusted session, membership mismatch and request URL/Verified extensions', async () => {
    const reads = providerReads; expect(await adapter.authorize(result.proof, {}, selection)).toBe(false);
    expect(await adapter.authorize(result.proof, session, { ...selection, runtimeMembershipId: 'other' })).toBe(false);
    expect(await adapter.authorize(result.proof, session, { ...selection, target: row.target, state: 'Verified' } as any)).toBe(false); expect(providerReads).toBe(reads); expect(hits).toBe(4);
  });
  it('rechecks credentials after the second asynchronous ownership read', async () => {
    reader.mockImplementation(async () => { if (reader.mock.calls.length === 2) secret = 'rotated-during-read'; return context; });
    expect(await adapter.authorize(result.proof, session, selection)).toBe(false); expect(hits).toBe(4);
  });
  it('rejects ownership/context drift between reads', async () => {
    reader.mockImplementation(async () => reader.mock.calls.length === 1 ? context : { ...context, actorId: 'another-user' });
    expect(await adapter.authorize(result.proof, session, selection)).toBe(false); expect(hits).toBe(4);
  });
});
