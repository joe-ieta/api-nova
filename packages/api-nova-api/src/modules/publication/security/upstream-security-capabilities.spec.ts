import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { UpstreamCredentialRegistry, normalizeUpstreamSecurity } from 'api-nova-parser';
import { createUpstreamSecurityContextAuthority } from './upstream-security-context-authority';
import { createUpstreamAuthenticationChallengeTransport } from './upstream-authentication-challenge-transport';
import { createUpstreamSecurityProofAuthority } from './upstream-security-proof-authority';
const ids = { sourceServiceAssetId: 'asset', endpointDefinitionId: 'endpoint' };
describe('isolated C3 authority, real challenge transport and proof capability', () => {
  let server: http.Server, hits: number, seen: http.IncomingHttpHeaders[], behavior: string;
  let registry: UpstreamCredentialRegistry, candidate: any, row: any, secret: string;
  let providerFailure: boolean, providerPending: boolean, repoFailure: boolean;
  let authority: ReturnType<typeof createUpstreamSecurityContextAuthority>;
  beforeEach(async () => {
    hits = 0; seen = []; behavior = 'normal'; secret = 'synthetic-private'; providerFailure = false; providerPending = false; repoFailure = false;
    server = http.createServer((req, res) => {
      hits++; seen.push(req.headers);
      if (behavior === 'timeout') return;
      if (behavior === 'redirect') { res.statusCode = 302; res.setHeader('location', '/redirect-target'); res.end(); return; }
      if (behavior === 'error') { req.socket.destroy(); return; }
      const type = candidate.credentials.key.type;
      const expected = type === 'bearer' ? 'Bearer ' + secret : type === 'basic' ? 'Basic ' + Buffer.from(secret + ':' + secret).toString('base64') : secret;
      const field = type === 'bearer' || type === 'basic' ? 'authorization' : 'x-key';
      res.statusCode = behavior === 'always-success' || behavior === 'wrong-success' && hits === 2 || behavior === 'after-success' && hits === 4 || req.headers[field] === expected ? 200 : 401;
      if (behavior === 'valid-fails' && hits === 3) res.statusCode = 401;
      res.end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const port = (server.address() as AddressInfo).port;
    row = { ...ids, bindingId: 'binding-id', bindingRevision: 'binding-1', method: 'GET', target: `http://127.0.0.1:${port}/target`, declaration: normalizeUpstreamSecurity({ security: [{ Key: [] }], components: { securitySchemes: { Key: { type: 'apiKey', in: 'header', name: 'X-Key' } } } }, {}) };
    candidate = { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'r1', environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { env: { type: 'env' } }, credentials: { key: { type: 'apiKey', placement: { in: 'header', name: 'X-Key' }, secretRef: 'env:TOKEN' } }, sites: [{ id: 'site', sourceServiceAssetId: 'asset', match: { scheme: 'http', host: '127.0.0.1', port, basePath: '/' }, allowedHosts: ['127.0.0.1'], credential: 'key', endpoints: [{ endpointDefinitionId: 'endpoint', credential: 'key' }] }] };
    registry = new UpstreamCredentialRegistry({ environment: 'test', providerFactory: d => ({ type: d.type, resolve: async () => { if (providerFailure) throw Error('private-provider-path'); if (providerPending) return new Promise<string>(() => undefined); return secret; } }) }); await registry.reload(candidate);
    authority = createUpstreamSecurityContextAuthority({ read: async () => { if (repoFailure) throw Error('private-repository-path'); return row; } }, () => registry.captureSnapshot());
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  it('accepts only IDs and creates nonserializable target capabilities without HTTP', async () => {
    await expect(authority.issue({ ...ids, target: row.target } as any)).rejects.toThrow('CHALLENGE_CONTEXT_UNAVAILABLE');
    const token = await authority.issue(ids); expect(JSON.stringify(token)).toBe('{}'); expect(authority.inspect(token).providerEpoch).toBeTruthy();
    expect(() => authority.inspect(JSON.parse(JSON.stringify(token)))).toThrow(); expect(() => authority.inspect({} as any)).toThrow(); expect(hits).toBe(0);
    expect(JSON.stringify(authority.inspect(token))).not.toMatch(/synthetic|TOKEN|secretRef/);
  });
  it.each(['binding', 'target', 'declaration', 'secret', 'registry', 'repository', 'provider'])('invalidates %s changes and never resurrects a failed token', async change => {
    const token = await authority.issue(ids);
    if (change === 'binding') row.bindingRevision = 'binding-2';
    if (change === 'target') row.target += '/different';
    if (change === 'declaration') row.declaration = normalizeUpstreamSecurity({}, {});
    if (change === 'secret') secret = 'rotated';
    if (change === 'registry') { candidate.metadata.revision = 'r2'; await registry.reload(candidate); }
    if (change === 'repository') repoFailure = true;
    if (change === 'provider') providerFailure = true;
    await expect(authority.resolveCurrent(token)).rejects.toThrow('CHALLENGE_CONTEXT_UNAVAILABLE');
    repoFailure = providerFailure = false; await expect(authority.resolveCurrent(token)).rejects.toThrow(); expect(hits).toBe(0);
  });
  it('executes strict anonymous/wrong/valid/anonymous challenge without consumer headers', async () => {
    const token = await authority.issue(ids), transport = createUpstreamAuthenticationChallengeTransport(authority);
    const receipt = await transport.challenge(token); expect(JSON.stringify(receipt)).toBe('{}'); expect(transport.inspect(receipt).target).toBe(token); expect(transport.inspect(receipt).statuses).toEqual([401, 401, 200, 401]); expect(Object.isFrozen(transport.inspect(receipt).statuses)).toBe(true); expect(() => transport.inspect(JSON.parse(JSON.stringify(receipt)))).toThrow(); expect(hits).toBe(4);
    expect(seen.map(headers => headers['x-key'])).toEqual([undefined, expect.any(String), secret, undefined]); expect(seen[1]['x-key']).not.toBe(secret);
    for (const headers of seen) { expect(headers.cookie).toBeUndefined(); expect(headers.authorization).toBeUndefined(); }
  });
  it.each(['redirect', 'timeout', 'error', 'always-success'])('fails %s without continuing stages', async mode => {
    behavior = mode; const token = await authority.issue(ids); const transport = createUpstreamAuthenticationChallengeTransport(authority, 40);
    await expect(transport.challenge(token)).rejects.toThrow('AUTHENTICATION_CHALLENGE_FAILED'); expect(hits).toBe(1);
  });
  it('rejects forged tokens and pre-aborted requests without network', async () => {
    const token = await authority.issue(ids), transport = createUpstreamAuthenticationChallengeTransport(authority);
    await expect(transport.challenge({} as any)).rejects.toThrow(); const controller = new AbortController(); controller.abort();
    await expect(transport.challenge(token, controller.signal)).rejects.toThrow(); expect(hits).toBe(0);
  });
  it('bounds pending Provider reads before any request', async () => {
    const token = await authority.issue(ids); providerPending = true;
    await expect(createUpstreamAuthenticationChallengeTransport(authority, 20).challenge(token)).rejects.toThrow('AUTHENTICATION_CHALLENGE_FAILED'); expect(hits).toBe(0);
  });
  it.each(['bearer', 'basic', 'customHeader'])('runs real %s positive and negative challenge headers', async type => {
    candidate.metadata.revision = 'r2'; candidate.credentials.key = type === 'basic' ? { type, usernameRef: 'env:USER', passwordRef: 'env:PASS' } : type === 'customHeader' ? { type, name: 'X-Key', secretRef: 'env:TOKEN' } : { type, secretRef: 'env:TOKEN' };
    if (type !== 'customHeader') row.declaration = normalizeUpstreamSecurity({ security: [{ Key: [] }], components: { securitySchemes: { Key: { type: 'http', scheme: type } } } }, {});
    await registry.reload(candidate); const token = await authority.issue(ids);
    await createUpstreamAuthenticationChallengeTransport(authority).challenge(token); expect(hits).toBe(4);
    const field = type === 'customHeader' ? 'x-key' : 'authorization'; expect(seen[1][field]).not.toBe(seen[2][field]);
  });
  it.each([['wrong-success', 2], ['valid-fails', 3], ['after-success', 4]])('requires every strict stage (%s)', async (mode, count) => {
    behavior = String(mode); const token = await authority.issue(ids);
    await expect(createUpstreamAuthenticationChallengeTransport(authority).challenge(token)).rejects.toThrow(); expect(hits).toBe(count); expect(() => authority.inspect(token)).toThrow();
  });
  it('aborts an active request and revokes its capability', async () => {
    behavior = 'timeout'; const token = await authority.issue(ids), controller = new AbortController();
    server.once('request', () => controller.abort());
    await expect(createUpstreamAuthenticationChallengeTransport(authority).challenge(token, controller.signal)).rejects.toThrow(); expect(hits).toBe(1); expect(() => authority.inspect(token)).toThrow();
  });
  it('rejects a Registry reload during the final repository reread', async () => {
    let reads = 0;
    const local = createUpstreamSecurityContextAuthority({ read: async () => { if (++reads === 2) { candidate.metadata.revision = 'r2'; await registry.reload(candidate); } return row; } }, () => registry.captureSnapshot());
    await expect(local.issue(ids)).rejects.toThrow('CHALLENGE_CONTEXT_UNAVAILABLE'); expect(hits).toBe(0);
  });
  it('cannot return credentials from a revoked token after a late repository read', async () => {
    let paused = false, release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const local = createUpstreamSecurityContextAuthority({ read: async () => { if (paused) await wait; return row; } }, () => registry.captureSnapshot());
    const token = await local.issue(ids); paused = true; const pending = local.resolveCurrent(token); local.revoke(token); paused = false; release();
    await expect(pending).rejects.toThrow('CHALLENGE_CONTEXT_UNAVAILABLE'); expect(hits).toBe(0);
  });
  it('proof requires genuine fresh receipt, is bound to exact target and cannot survive serialization/restart', async () => {
    const token = await authority.issue(ids), transport = createUpstreamAuthenticationChallengeTransport(authority), proofAuthority = createUpstreamSecurityProofAuthority(authority, transport);
    await expect(proofAuthority.issue({ result: 'passed' } as any)).rejects.toThrow();
    const receipt = await transport.challenge(token), proof = await proofAuthority.issue(receipt);
    expect(await proofAuthority.isCurrent(proof, token)).toBe(true); expect(await proofAuthority.isCurrent(JSON.parse(JSON.stringify(proof)), token)).toBe(false);
    expect(await createUpstreamSecurityProofAuthority(authority, transport).isCurrent(proof, token)).toBe(false);
    await expect(proofAuthority.issue(receipt)).rejects.toThrow();
    const other = await authority.issue(ids); expect(await proofAuthority.isCurrent(proof, other)).toBe(false);
  });
  it.each(['expiry', 'revoke', 'rotation'])('invalidates proof after %s', async change => {
    const token = await authority.issue(ids), transport = createUpstreamAuthenticationChallengeTransport(authority);
    let now = Date.now(); const proofAuthority = createUpstreamSecurityProofAuthority(authority, transport, 1000, () => now = Math.max(now, Date.now()));
    const proof = await proofAuthority.issue(await transport.challenge(token));
    if (change === 'expiry') now += 2000;
    if (change === 'revoke') proofAuthority.revoke(proof);
    if (change === 'rotation') secret = 'changed';
    expect(await proofAuthority.isCurrent(proof, token)).toBe(false);
  });
});
