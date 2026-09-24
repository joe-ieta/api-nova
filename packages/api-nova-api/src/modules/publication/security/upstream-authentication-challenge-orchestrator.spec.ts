import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { DataSource } from 'typeorm';
import { UpstreamCredentialRegistry, normalizeUpstreamSecurity } from 'api-nova-parser';
import { UpstreamProductionChallengeEvidenceEntity as Evidence } from '../../../database/entities/upstream-production-challenge-evidence.entity';
import { createUpstreamSecurityContextAuthority } from './upstream-security-context-authority';
import { createUpstreamAuthenticationChallengeTransport } from './upstream-authentication-challenge-transport';
import { createUpstreamAuthenticationChallengeOrchestrator } from './upstream-authentication-challenge-orchestrator';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
describe('internal challenge orchestration with real loopback and SQL.js persistence', () => {
  let directory: string;
  let db: DataSource, server: http.Server, hits: number, secret: string, row: any, statusMode: string;
  let authority: ReturnType<typeof createUpstreamSecurityContextAuthority>, transport: ReturnType<typeof createUpstreamAuthenticationChallengeTransport>;
  let repository: any, intents: { resolve(intent: unknown): Promise<any> }, claims: WeakMap<object, any>, counter: number;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'apinova-c3-orchestrator-'));
    db = await new DataSource({ type: 'sqljs', location: join(directory, 'evidence.sqlite'), autoSave: true, entities: [Evidence], synchronize: true }).initialize();
    hits = 0; secret = 'synthetic-secret'; statusMode = 'normal'; counter = 0; claims = new WeakMap();
    intents = { resolve: async intent => { const claim = claims.get(intent as object); if (!claim) throw Error('untrusted-intent'); return claim; } };
    server = http.createServer((req, res) => { hits++; res.statusCode = statusMode === 'open' || req.headers['x-key'] === secret ? 200 : 401; res.end('{}'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const port = (server.address() as AddressInfo).port;
    row = { sourceServiceAssetId: 'asset', endpointDefinitionId: 'endpoint', bindingId: 'binding-id', bindingRevision: 'binding-1', method: 'GET', target: `http://127.0.0.1:${port}/target`, declaration: normalizeUpstreamSecurity({ security: [{ Key: [] }], components: { securitySchemes: { Key: { type: 'apiKey', in: 'header', name: 'X-Key' } } } }, {}) };
    const registry = new UpstreamCredentialRegistry({ environment: 'test', providerFactory: d => ({ type: d.type, resolve: async () => secret }) });
    await registry.reload({ apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'r1', environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { env: { type: 'env' } }, credentials: { key: { type: 'apiKey', placement: { in: 'header', name: 'X-Key' }, secretRef: 'env:TOKEN' } }, sites: [{ id: 'site', sourceServiceAssetId: 'asset', match: { scheme: 'http', host: '127.0.0.1', port, basePath: '/' }, allowedHosts: ['127.0.0.1'], credential: 'key', endpoints: [{ endpointDefinitionId: 'endpoint', credential: 'key' }] }] });
    authority = createUpstreamSecurityContextAuthority({ read: async () => row }, () => registry.captureSnapshot());
    transport = createUpstreamAuthenticationChallengeTransport(authority);
    const repo = db.getRepository(Evidence);
    repository = { create: repo.create.bind(repo), save: jest.fn(repo.save.bind(repo)), findOneBy: jest.fn(repo.findOneBy.bind(repo)), update: jest.fn(repo.update.bind(repo)) };
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await db.destroy(); const target = resolve(directory); if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('apinova-c3-orchestrator-')) throw Error('Unsafe fixture cleanup'); rmSync(target, { recursive: true, force: true }); });
  function intent() { const token = Object.freeze({}); claims.set(token, { intentId: 'intent-' + ++counter, sourceServiceAssetId: 'asset', endpointDefinitionId: 'endpoint', actorId: 'actor' }); return token; }
  function service(ttlMs = 60000) { return createUpstreamAuthenticationChallengeOrchestrator({ authority, transport, repository, intents, ttlMs }); }
  it('durably records actual four stages before issuing an opaque current proof', async () => {
    const value = service(), result = await value.execute(intent()); const evidence = await db.getRepository(Evidence).findOneByOrFail({ id: result.evidenceId });
    expect(evidence).toMatchObject({ evidenceKind: 'production_challenge_v1', challengeVersion: 1, result: 'passed', bindingRevision: 'binding-1', bindingGeneration: 1, actorId: 'actor', anonymousBeforeStatus: 401, wrongCredentialStatus: 401, validCredentialStatus: 200, anonymousAfterStatus: 401 });
    expect(evidence.runNonce).toMatch(/^[a-f0-9-]{36}$/); expect(evidence.expiresAt.getTime() - evidence.completedAt.getTime()).toBe(60000);
    expect(hits).toBe(4); expect(await value.isCurrent(result)).toBe(true); expect(JSON.stringify(evidence)).not.toMatch(/synthetic-secret|TOKEN|headers|responseBody/);
    expect(await value.isCurrent(JSON.parse(JSON.stringify(result)))).toBe(false); expect(await service().isCurrent(result)).toBe(false);
    expect(await value.isCurrent(evidence as any)).toBe(false);
  });
  it('reopens durable evidence without reconstructing any proof capability', async () => {
    const result = await service().execute(intent()); await db.destroy();
    db = await new DataSource({ type: 'sqljs', location: join(directory, 'evidence.sqlite'), autoSave: true, entities: [Evidence], synchronize: false }).initialize();
    const stored = await db.getRepository(Evidence).findOneByOrFail({ id: result.evidenceId }); expect(stored.result).toBe('passed');
    const restarted = createUpstreamAuthenticationChallengeOrchestrator({ authority, transport, repository: db.getRepository(Evidence), intents });
    expect(await restarted.isCurrent(result)).toBe(false); expect(await restarted.isCurrent(stored as any)).toBe(false);
  });
  it('rejects caller JSON including URL, declaration or Verified as an intent before any request', async () => {
    await expect(service().execute({ ...row, state: 'Verified' })).rejects.toThrow('CHALLENGE_ORCHESTRATION_UNAVAILABLE'); expect(hits).toBe(0); expect(await db.getRepository(Evidence).count()).toBe(0);
  });
  it('save failure produces no proof', async () => {
    repository.save.mockRejectedValue(Error('sensitive-database-error'));
    await expect(service().execute(intent())).rejects.toThrow('CHALLENGE_ORCHESTRATION_UNAVAILABLE'); expect(hits).toBe(4); expect(await db.getRepository(Evidence).count()).toBe(0);
  });
  it('a save response without a durably readable row produces no proof', async () => {
    repository.save.mockImplementation(async input => ({ ...input, id: 'fake-id' }));
    await expect(service().execute(intent())).rejects.toThrow('CHALLENGE_ORCHESTRATION_UNAVAILABLE'); expect(await db.getRepository(Evidence).count()).toBe(0);
  });
  it.each(['binding', 'secret'])('rejects %s changes during durable save and revokes the stored observation', async changed => {
    const repo = db.getRepository(Evidence); repository.save.mockImplementation(async input => { const stored = await repo.save(input); if (changed === 'binding') row.bindingRevision = 'binding-2'; else secret = 'rotated'; return stored; });
    await expect(service().execute(intent())).rejects.toThrow('CHALLENGE_ORCHESTRATION_UNAVAILABLE');
    expect(await repo.find()).toEqual([expect.objectContaining({ result: 'failed', failureCode: 'CONTEXT_CHANGED', revokedAt: expect.any(Date) })]);
  });
  it('limits same-entity concurrency and cannot issue a late stale result', async () => {
    const entered = deferred(), release = deferred(), repo = db.getRepository(Evidence);
    repository.save.mockImplementation(async input => { const saved = await repo.save(input); entered.resolve(); await release.promise; return saved; });
    const value = service(), first = value.execute(intent()); await entered.promise;
    await expect(value.execute(intent())).rejects.toThrow(); expect(hits).toBe(4); row.bindingRevision = 'changed'; release.resolve(); await expect(first).rejects.toThrow();
  });
  it('consumes intent identities and generates distinct orchestration run nonces', async () => {
    const value = service(), token = intent(); await value.execute(token); await expect(value.execute(token)).rejects.toThrow();
    await value.execute(intent()); expect(new Set((await db.getRepository(Evidence).find()).map(item => item.runNonce)).size).toBe(2); expect(hits).toBe(8);
  });
  it('rejects an existing runNonce before challenge execution', async () => {
    repository.findOneBy.mockResolvedValueOnce({ runNonce: 'existing' }); await expect(service().execute(intent())).rejects.toThrow(); expect(hits).toBe(0);
  });
  it('records failed challenges without minting a receipt or proof', async () => {
    statusMode = 'open'; await expect(service().execute(intent())).rejects.toThrow(); expect(hits).toBe(1);
    expect(await db.getRepository(Evidence).find()).toEqual([expect.objectContaining({ result: 'failed', failureCode: 'CHALLENGE_TRANSPORT_FAILED', anonymousBeforeStatus: null })]);
  });
  it('revoke invalidates capability and persists revocation', async () => {
    const value = service(), result = await value.execute(intent()); await value.revoke(result); expect(await value.isCurrent(result)).toBe(false);
    expect((await db.getRepository(Evidence).findOneByOrFail({ id: result.evidenceId })).revokedAt).toBeInstanceOf(Date);
  });
  it('persisted expiry and revocation never authorize an otherwise current in-memory proof', async () => {
    const value = service(), result = await value.execute(intent()); const repo = db.getRepository(Evidence);
    await repo.update(result.evidenceId, { completedAt: new Date(Date.now() - 2000), expiresAt: new Date(Date.now() - 1000) });
    expect(await value.isCurrent(result)).toBe(false);
    const result2 = await value.execute(intent()); await repo.update(result2.evidenceId, { revokedAt: new Date() }); expect(await value.isCurrent(result2)).toBe(false);
  });
  it('changed persisted context cannot reuse an issued proof', async () => {
    const value = service(), result = await value.execute(intent()); await db.getRepository(Evidence).update(result.evidenceId, { contextDigest: 'f'.repeat(64) }); expect(await value.isCurrent(result)).toBe(false);
  });
  it('a save that substitutes actor identity cannot issue proof', async () => {
    const repo = db.getRepository(Evidence); repository.save.mockImplementation(async input => repo.save({ ...input, actorId: 'other-actor' }));
    await expect(service().execute(intent())).rejects.toThrow('CHALLENGE_ORCHESTRATION_UNAVAILABLE'); expect((await repo.find())[0].result).toBe('failed');
  });
  it('cancellation during save cannot publish a late proof', async () => {
    const controller = new AbortController(), repo = db.getRepository(Evidence); repository.save.mockImplementation(async input => { const saved = await repo.save(input); controller.abort(); return saved; });
    await expect(service().execute(intent(), controller.signal)).rejects.toThrow(); expect((await repo.find())[0].result).toBe('failed');
  });
});
