import * as http from 'node:http';
import { DataSource } from 'typeorm';
import { UpstreamCredentialRegistry, normalizeUpstreamSecurity } from 'api-nova-parser';
import { UpstreamProductionChallengeEvidenceEntity as Evidence } from '../../../database/entities/upstream-production-challenge-evidence.entity';
import { EndpointDefinitionEntity as Endpoint } from '../../../database/entities/endpoint-definition.entity';
import { RuntimeAssetEndpointBindingEntity as Membership } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import { createUpstreamSecurityContextAuthority } from '../../publication/security/upstream-security-context-authority';
import { createUpstreamAuthenticationChallengeTransport } from '../../publication/security/upstream-authentication-challenge-transport';
import { createTrustedChallengeIntentAuthority } from '../../publication/security/trusted-challenge-intent-authority';
import { createGatewayUpstreamProofAuthorityLifecycle } from './gateway-upstream-proof-authority.lifecycle';
import { createGatewayUpstreamRequestCapabilityProvider } from './gateway-upstream-request-capability.provider';
const listen = (server: http.Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port)));
const close = (server: http.Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });

describe('Gateway same-process host proof authority lifecycle', () => {
  let db: DataSource, upstream: http.Server, hits: number, context: any, session: object, secret: string, clock: number;
  let registry: UpstreamCredentialRegistry, candidate: any, audits: any[], lifecycle: ReturnType<typeof createGatewayUpstreamProofAuthorityLifecycle>;
  let grantIds: { sourceServiceAssetId: string; endpointDefinitionId: string }, selector: { runtimeAssetId: string; runtimeMembershipId: string };
  beforeEach(async () => {
    hits = 0; clock = 0; secret = 'synthetic-only'; audits = [];
    db = await new DataSource({ type: 'sqljs', entities: [Endpoint, Membership, Evidence], synchronize: true }).initialize();
    upstream = http.createServer((req, res) => { hits++; res.statusCode = req.headers['x-key'] === secret ? 200 : 401; res.setHeader('content-type', 'text/plain'); res.end('ok'); });
    const upstreamPort = await listen(upstream);
    await db.getRepository(Endpoint).save({ id: 'endpoint', sourceServiceAssetId: 'asset', method: 'GET', path: '/target', rawOperation: { security: [{ Key: [] }] } });
    await db.getRepository(Membership).save({ id: 'membership', runtimeAssetId: 'runtime', endpointDefinitionId: 'endpoint' });
    const row = { sourceServiceAssetId: 'asset', endpointDefinitionId: 'endpoint', bindingId: 'binding', bindingRevision: 'r1', method: 'GET' as 'GET' | 'HEAD', target: `http://127.0.0.1:${upstreamPort}/target`, declaration: normalizeUpstreamSecurity({ security: [{ Key: [] }], components: { securitySchemes: { Key: { type: 'apiKey', in: 'header', name: 'X-Key' } } } }, {}) };
    registry = new UpstreamCredentialRegistry({ environment: 'test', providerFactory: description => ({ type: description.type, resolve: async () => secret }) });
    candidate = { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'r1', environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { env: { type: 'env' } }, credentials: { key: { type: 'apiKey', placement: { in: 'header', name: 'X-Key' }, secretRef: 'env:TOKEN' } }, sites: [{ id: 'site', sourceServiceAssetId: 'asset', match: { scheme: 'http', host: '127.0.0.1', port: upstreamPort, basePath: '/' }, allowedHosts: ['127.0.0.1'], credential: 'key', endpoints: [{ endpointDefinitionId: 'endpoint' }] }] };
    await registry.reload(candidate);
    const authority = createUpstreamSecurityContextAuthority({ read: async () => row }, () => registry.captureSnapshot());
    const transport = createUpstreamAuthenticationChallengeTransport(authority);
    const intentAuthority = createTrustedChallengeIntentAuthority({
      sessions: { resolve: async value => value === session ? { actorId: 'actor', authenticationEpoch: 'e1' } : undefined },
      users: { findUserById: async (id: string) => id === 'actor' ? { id: 'actor', isActive: true, isLocked: false,
        roles: [{ id: 'role', enabled: true, updatedAt: new Date(0), permissions: [{ id: 'permission', name: 'upstream:challenge', enabled: true, conditions: null, updatedAt: new Date(0) }] }] } as any : undefined },
      ownership: { resolve: async () => ({ revision: 'ownership-r1' }) },
      audit: { record: async event => { audits.push(event); } },
    });
    session = Object.freeze({});
    grantIds = { sourceServiceAssetId: 'asset', endpointDefinitionId: 'endpoint' };
    selector = { runtimeAssetId: 'runtime', runtimeMembershipId: 'membership' };
    const captured = authority.inspect(await authority.issue(grantIds));
    context = { ...captured, actorId: 'actor' };
    const contexts = { read: async (value: unknown, selected: { runtimeAssetId: string; runtimeMembershipId: string }) => {
      if (value !== session) return undefined;
      const member = await db.getRepository(Membership).findOneBy({ id: selected.runtimeMembershipId, runtimeAssetId: selected.runtimeAssetId });
      return member?.endpointDefinitionId === context.endpointDefinitionId ? { ...context } : undefined;
    } };
    lifecycle = createGatewayUpstreamProofAuthorityLifecycle({ authority, transport, intents: intentAuthority, repository: db.getRepository(Evidence), contexts, ttlMs: 60000, now: () => clock });
  });
  afterEach(async () => { await lifecycle.close(); await close(upstream); await db.destroy(); });
  const passives = [{ method: 'GET' }, { method: 'GET' }];

  it('issues an opaque host grant, consumes it once, and never exposes proof material', async () => {
    const grant = await lifecycle.issue(session, grantIds);
    expect(lifecycle.active()).toBe(1);
    expect(hits).toBe(4);
    expect(JSON.stringify(grant)).toBe('{}');
    expect(Object.getOwnPropertyNames(grant)).toEqual([]);
    expect(audits.map(event => event.event)).toEqual(['issued', 'consumed', 'passed']);
    const capabilities = createGatewayUpstreamRequestCapabilityProvider({ contexts: lifecycleContexts(), now: () => clock });
    expect(await lifecycle.isCurrent(grant)).toBe(true);
    expect(await lifecycle.bind(passives[0], grant, selector, capabilities, 'GET')).toBe(true);
    expect(lifecycle.active()).toBe(0);
    expect(await lifecycle.bind(passives[1], grant, selector, capabilities, 'GET')).toBe(false);
    const consumed = await capabilities.read(passives[0], { ...selector, endpointDefinitionId: 'endpoint', sourceServiceAssetId: 'asset' });
    expect(consumed?.proof).toBeDefined();
    expect(await capabilities.read(passives[0], { ...selector, endpointDefinitionId: 'endpoint', sourceServiceAssetId: 'asset' })).toBeUndefined();
  });

  it('denies unknown sessions, foreign selectors and replayed grants without writing evidence', async () => {
    await expect(lifecycle.issue(Object.freeze({ other: true }), grantIds)).rejects.toThrow('GATEWAY_UPSTREAM_PROOF_AUTHORITY_UNAVAILABLE');
    expect(await db.getRepository(Evidence).count()).toBe(0);
    const grant = await lifecycle.issue(session, grantIds);
    const capabilities = createGatewayUpstreamRequestCapabilityProvider({ contexts: lifecycleContexts(), now: () => clock });
    expect(await lifecycle.bind(passives[0], grant, { runtimeAssetId: 'runtime', runtimeMembershipId: 'other' }, capabilities, 'GET')).toBe(false);
    expect(await lifecycle.bind(passives[0], grant, selector, capabilities, 'POST')).toBe(false);
    expect(await lifecycle.bind(passives[0], grant, selector, capabilities, 'GET')).toBe(true);
    const evidence = await db.getRepository(Evidence).find();
    expect(evidence).toHaveLength(1);
    expect(evidence[0].result).toBe('passed');
  });

  it('expires grants on TTL, revokes accepted grants and revokes evidence on close', async () => {
    const first = await lifecycle.issue(session, grantIds);
    clock = 60001;
    expect(await lifecycle.isCurrent(first)).toBe(false);
    const capabilities = createGatewayUpstreamRequestCapabilityProvider({ contexts: lifecycleContexts(), now: () => clock });
    expect(await lifecycle.bind(passives[0], first, selector, capabilities, 'GET')).toBe(false);

    const second = await lifecycle.issue(session, grantIds);
    await lifecycle.revoke(second);
    expect(await lifecycle.isCurrent(second)).toBe(false);
    expect((await db.getRepository(Evidence).find()).filter(row => row.revokedAt)).toHaveLength(1);

    const third = await lifecycle.issue(session, grantIds);
    expect(lifecycle.active()).toBe(2);
    await lifecycle.close();
    expect(lifecycle.active()).toBe(0);
    expect(await lifecycle.isCurrent(third)).toBe(false);
    const rows = await db.getRepository(Evidence).find();
    expect(rows.every(row => row.revokedAt)).toBe(true);
  });

  it('rejects grants after a provider epoch change and after membership ownership changes', async () => {
    const grant = await lifecycle.issue(session, grantIds);
    secret = 'rotated-synthetic';
    candidate.metadata.revision = 'r2';
    await registry.reload(candidate);
    expect(await lifecycle.isCurrent(grant)).toBe(false);
    const capabilities = createGatewayUpstreamRequestCapabilityProvider({ contexts: lifecycleContexts(), now: () => clock });
    expect(await lifecycle.bind(passives[0], grant, selector, capabilities, 'GET')).toBe(false);

    const replacement = await lifecycle.issue(session, grantIds);
    await db.getRepository(Membership).update('membership', { endpointDefinitionId: 'other-endpoint' });
    expect(await lifecycle.bind(passives[1], replacement, selector, capabilities, 'GET')).toBe(false);
  });

  it('reauthorizes proof/session/scope and does not leak secrets in denial paths', async () => {
    const grant = await lifecycle.issue(session, grantIds);
    const capabilityProvider = createGatewayUpstreamRequestCapabilityProvider({ contexts: lifecycleContexts(), now: () => clock });
    const request = { method: 'GET' };
    expect(await lifecycle.bind(request, grant, selector, capabilityProvider, 'GET')).toBe(true);
    const consumed = await capabilityProvider.read(request, { ...selector, endpointDefinitionId: 'endpoint', sourceServiceAssetId: 'asset' });
    expect(await lifecycle.authorize(Object.freeze({}) as never, session, selector)).toBe(false);
    expect(await lifecycle.authorize(consumed!.proof, { other: true }, selector)).toBe(false);
    const failure = await lifecycle.issue(Object.freeze({ nope: true }), grantIds).then(() => undefined, error => error);
    expect(String(failure?.message)).not.toContain(secret);
  });

  function lifecycleContexts() {
    return { read: async (value: unknown, selected: { runtimeAssetId: string; runtimeMembershipId: string }) => {
      if (value !== session) return undefined;
      const member = await db.getRepository(Membership).findOneBy({ id: selected.runtimeMembershipId, runtimeAssetId: selected.runtimeAssetId });
      return member?.endpointDefinitionId === context.endpointDefinitionId ? { ...context } : undefined;
    } };
  }
});
