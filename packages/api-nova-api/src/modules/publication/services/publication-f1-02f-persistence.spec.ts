import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { UpstreamCredentialRegistry, normalizeUpstreamSecurity } from 'api-nova-parser';
import { UpstreamProductionChallengeEvidenceEntity as Evidence } from '../../../database/entities/upstream-production-challenge-evidence.entity';
import { PublicationProfileEntity as Profile } from '../../../database/entities/publication-profile.entity';
import { EndpointPublishBindingEntity as Binding } from '../../../database/entities/endpoint-publish-binding.entity';
import { GatewayRouteBindingEntity as Route } from '../../../database/entities/gateway-route-binding.entity';
import { RuntimeAssetEndpointBindingEntity as Membership } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import { RuntimeAssetEntity as Runtime, RuntimeAssetType } from '../../../database/entities/runtime-asset.entity';
import { EndpointDefinitionEntity as Endpoint } from '../../../database/entities/endpoint-definition.entity';
import { createUpstreamSecurityContextAuthority } from '../security/upstream-security-context-authority';
import { createUpstreamAuthenticationChallengeTransport } from '../security/upstream-authentication-challenge-transport';
import { createUpstreamAuthenticationChallengeOrchestrator } from '../security/upstream-authentication-challenge-orchestrator';
import { createUpstreamSecurityAuthorizationAdapter } from '../security/upstream-security-authorization-adapter';
import { endpointUpstreamSecurityReadiness } from '../security/endpoint-upstream-security-readiness';
import { createPublicationSecurityPreviewAdapter } from './publication-security-preview-adapter';
import { createPublicationSecurityEvaluation } from './publication-security-evaluation';
import { PublicationMemberTransactionWriter } from './publication-member-transaction-writer';
import { createPublicationBatchCandidateExecutor } from './publication-batch-candidate-executor';

const selection = { runtimeAssetId: 'runtime', runtimeMembershipId: 'membership' };
const entities = [Profile, Binding, Route, Membership, Runtime, Endpoint, Evidence];

describe('F1-02F SQL.js reopen, late arrivals and same-revision provider change', () => {
  let db: DataSource, server: http.Server, hits: number, secret: string, row: any, context: any, session: object;
  let authority: ReturnType<typeof createUpstreamSecurityContextAuthority>;
  let orchestrator: ReturnType<typeof createUpstreamAuthenticationChallengeOrchestrator>;
  let authorize: ReturnType<typeof createUpstreamSecurityAuthorizationAdapter>;
  let preview: ReturnType<typeof createPublicationSecurityPreviewAdapter>;
  let evidence: ReturnType<typeof createPublicationSecurityEvaluation>;
  let result: { evidenceId: string; proof: any };
  const snapshot = () => Promise.all(entities.map(entity => db.getRepository(entity as any).find({ order: { id: 'ASC' } })));

  const open = async (database?: Uint8Array) => {
    const dataSource = new DataSource({ type: 'sqljs', ...(database ? { database } : {}), entities, synchronize: !database });
    await dataSource.initialize();
    return dataSource;
  };

  // Process-local capabilities (authority/proofs) are deliberately rebuilt against the
  // reopened connection: a proof capability must never be rehydrated from disk.
  const wire = () => {
    const transport = createUpstreamAuthenticationChallengeTransport(authority);
    orchestrator = createUpstreamAuthenticationChallengeOrchestrator({ authority, transport, repository: db.getRepository(Evidence),
      intents: { resolve: async token => {
        if (!token || typeof token !== 'object') throw Error();
        return { sourceServiceAssetId: 'asset', endpointDefinitionId: 'endpoint', actorId: 'actor', intentId: randomUUID() };
      } } });
    authorize = createUpstreamSecurityAuthorizationAdapter(orchestrator, { read: async (input, selected) => {
      if (input !== session) return undefined;
      const member = await db.getRepository(Membership).findOneBy({ id: selected.runtimeMembershipId, runtimeAssetId: selected.runtimeAssetId });
      return member?.endpointDefinitionId === context.endpointDefinitionId ? context : undefined;
    } });
    preview = createPublicationSecurityPreviewAdapter(db, authorize);
    evidence = createPublicationSecurityEvaluation({ database: db, authorization: authorize, readiness: preview,
      fresh: async (_session, selected) => {
        if (selected.runtimeMembershipId !== selection.runtimeMembershipId || selected.runtimeAssetId !== selection.runtimeAssetId) throw Error('publication_member_rejected');
        return { proof: result.proof, evidenceId: result.evidenceId, contextVersion: `context:${result.evidenceId}` };
      } });
  };

  const reopen = async () => {
    const image = (db.driver as any).export();
    await db.destroy();
    db = await open(image);
    wire();
    return image;
  };

  const executeChallenge = async () => {
    const challenged = await orchestrator.execute(Object.freeze({}));
    result = challenged;
    return challenged;
  };

  beforeEach(async () => {
    db = await open();
    hits = 0; secret = 'synthetic-only'; session = Object.freeze({});
    await db.getRepository(Runtime).save({ id: 'runtime', name: 'fixture', type: RuntimeAssetType.GATEWAY_SERVICE });
    await db.getRepository(Membership).save({ id: 'membership', runtimeAssetId: 'runtime', endpointDefinitionId: 'endpoint' });
    await db.getRepository(Endpoint).save({ id: 'endpoint', sourceServiceAssetId: 'asset', method: 'GET', path: '/target',
      rawOperation: { security: [{ Key: [] }], components: { securitySchemes: { Key: { type: 'apiKey', in: 'header', name: 'X-Key' } } } } });
    server = http.createServer((req, res) => { hits++; res.statusCode = req.headers['x-key'] === secret ? 200 : 401; res.end('{}'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    row = { sourceServiceAssetId: 'asset', endpointDefinitionId: 'endpoint', bindingId: 'binding', bindingRevision: 'r1', method: 'GET',
      target: `http://127.0.0.1:${port}/target`, declaration: normalizeUpstreamSecurity({ security: [{ Key: [] }],
        components: { securitySchemes: { Key: { type: 'apiKey', in: 'header', name: 'X-Key' } } } }, {}) };
    const registry = new UpstreamCredentialRegistry({ environment: 'test', providerFactory: description => ({ type: description.type, resolve: async () => secret }) });
    await registry.reload({ apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'r1', environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { env: { type: 'env' } },
      credentials: { key: { type: 'apiKey', placement: { in: 'header', name: 'X-Key' }, secretRef: 'env:TOKEN' } },
      sites: [{ id: 'site', sourceServiceAssetId: 'asset', match: { scheme: 'http', host: '127.0.0.1', port, basePath: '/' }, allowedHosts: ['127.0.0.1'], credential: 'key', endpoints: [{ endpointDefinitionId: 'endpoint' }] }] });
    authority = createUpstreamSecurityContextAuthority({ read: async () => row }, () => registry.captureSnapshot());
    const { credentialType: ignored, ...captured } = authority.inspect(await authority.issue({ sourceServiceAssetId: 'asset', endpointDefinitionId: 'endpoint' }));
    context = { ...captured, actorId: 'actor' };
    wire();
    await executeChallenge();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (db?.isInitialized) await db.destroy();
  });

  const stagePublishable = async () => {
    await db.getRepository(Route).save({ id: 'route', endpointDefinitionId: 'endpoint', runtimeAssetEndpointBindingId: 'membership', routePath: '/items', routeMethod: 'GET', upstreamPath: '/target', upstreamMethod: 'GET' });
  };
  const publish = async (evaluation: any) => {
    const writer = new PublicationMemberTransactionWriter(db, evidence.toValidator(evaluation));
    const ticket = await writer.prepare({ membershipId: 'membership', evidenceId: evaluation.evidenceId });
    return writer.commit(ticket);
  };

  test('activation, guard evidence and membership state survive SQL.js reopen with zero drift and late arrivals stay rejected', async () => {
    await stagePublishable();
    const evaluation = await evidence.evaluate(session, selection);
    expect(evaluation.preview).toMatchObject({ canPublish: false, proofCurrent: true });
    expect(await publish(evaluation)).toMatchObject({ publicationRevision: 1 });
    expect(hits).toBe(4);
    const persisted = await snapshot();

    await reopen();
    expect((await db.driver.createSchemaBuilder().log()).upQueries).toEqual([]);
    expect(await snapshot()).toEqual(persisted);
    const membership = await db.getRepository(Membership).findOneByOrFail({ id: 'membership' });
    expect(membership).toMatchObject({ publicationRevision: 1, status: 'active' });
    const binding = await db.getRepository(Binding).findOneByOrFail({ runtimeAssetEndpointBindingId: 'membership' });
    expect(binding).toMatchObject({ publicationRevision: 1, publishStatus: 'active', publishedToHttp: true, publishedToMcp: false });
    expect((await db.getRepository(Profile).findOneByOrFail({ runtimeAssetEndpointBindingId: 'membership' })).status).toBe('published');
    const storedEvidence = await db.getRepository(Evidence).findOneByOrFail({ id: evaluation.evidenceId });
    expect(storedEvidence).toMatchObject({ result: 'passed', evidenceKind: 'production_challenge_v1', bindingRevision: 'r1', providerEpoch: context.providerEpoch });
    expect(storedEvidence.revokedAt).toBeNull();
    // The declaration gate that produced the activation decision is persisted, not re-derived from a caller.
    expect(endpointUpstreamSecurityReadiness(await db.getRepository(Endpoint).findOneByOrFail({ id: 'endpoint' }))).toMatchObject({ canPublish: false });

    // A late activation pinned to the pre-reopen membership revision is rejected fail-closed with zero writes.
    const frozenAfterPublish = await snapshot();
    await expect(evidence.assertTransactionCurrent(db.manager, evaluation)).rejects.toThrow('publication_transaction_context_changed');
    let lateActivated = 0;
    const lateExecutor = createPublicationBatchCandidateExecutor({ database: db,
      fresh: async () => ({ proof: result.proof, evidenceId: result.evidenceId, contextVersion: `context:${result.evidenceId}` }),
      authorization: authorize, readiness: { readiness: async () => ({ canPublish: true, proofCurrent: true }) } });
    // Process-local proof capabilities are never rehydrated: the stale capability is rejected before the recheck runs.
    await expect(lateExecutor.activateCandidate(session, selection, { expectedEpoch: 'epoch-live', currentEpoch: () => 'epoch-live',
      activate: () => { lateActivated += 1; return undefined; }, recheck: () => evidence.assertTransactionCurrent(db.manager, evaluation) }))
      .rejects.toThrow('publication_member_rejected');
    expect(lateActivated).toBe(0);
    expect(await snapshot()).toEqual(frozenAfterPublish);

    // Revocation of a live chain-2 evidence and of the chain-1 evidence both persist across another reopen.
    const second = await executeChallenge();
    await db.getRepository(Evidence).update({ id: evaluation.evidenceId }, { revokedAt: new Date() });
    await orchestrator.revoke(second);
    hits = 0;
    const revoked = await snapshot();
    await reopen();
    expect((await db.getRepository(Evidence).findOneByOrFail({ id: evaluation.evidenceId })).revokedAt).toBeTruthy();
    expect((await db.getRepository(Evidence).findOneByOrFail({ id: second.evidenceId })).revokedAt).toBeTruthy();
    expect(await snapshot()).toEqual(revoked);
    expect((await db.driver.createSchemaBuilder().log()).upQueries).toEqual([]);

    // Late proof/evaluation/publish arrivals after revocation are rejected with zero writes and zero network.
    const frozen = await snapshot();
    await expect(evidence.evaluate(session, selection)).rejects.toThrow('publication_evaluation_rejected');
    await expect(evidence.assertTransactionCurrent(db.manager, evaluation)).rejects.toThrow('publication_transaction_context_changed');
    const afterRevokeWriter = new PublicationMemberTransactionWriter(db, evidence.toValidator(evaluation));
    await expect(afterRevokeWriter.prepare({ membershipId: 'membership', evidenceId: evaluation.evidenceId })).rejects.toThrow('publication_transaction_validation_failed');
    expect(await snapshot()).toEqual(frozen);
    expect(hits).toBe(0);
    expect(endpointUpstreamSecurityReadiness(await db.getRepository(Endpoint).findOneByOrFail({ id: 'endpoint' }))).toMatchObject({ canPublish: false });
  });

  test('duplicate and interleaved publishes on the same revision have exactly one winner on SQL.js', async () => {
    await stagePublishable();
    const first = await evidence.evaluate(session, selection);
    await executeChallenge();
    const second = await evidence.evaluate(session, selection);
    const firstWriter = new PublicationMemberTransactionWriter(db, evidence.toValidator(first));
    const secondWriter = new PublicationMemberTransactionWriter(db, evidence.toValidator(second));
    const firstTicket = await firstWriter.prepare({ membershipId: 'membership', evidenceId: first.evidenceId });
    const secondTicket = await secondWriter.prepare({ membershipId: 'membership', evidenceId: second.evidenceId });

    // Both tickets were prepared against revision 0; only the first commit may win the revision claim.
    expect(await firstWriter.commit(firstTicket)).toMatchObject({ publicationRevision: 1, membershipId: 'membership' });
    await expect(secondWriter.commit(secondTicket)).rejects.toThrow('publication_transaction_context_changed');
    await expect(firstWriter.commit(firstTicket)).rejects.toThrow('publication_transaction_ticket_invalid');
    expect(await db.getRepository(Membership).findOneByOrFail({ id: 'membership' })).toMatchObject({ publicationRevision: 1 });
    expect(await db.getRepository(Binding).count()).toBe(1);
    expect(await db.getRepository(Profile).count()).toBe(1);
    expect(await db.getRepository(Route).findOneByOrFail({ id: 'route' })).toMatchObject({ status: 'active' });

    // Late epoch/generation arrivals cannot reactivate after the revision moved.
    let activated = 0, epoch = 'epoch-live';
    const executor = createPublicationBatchCandidateExecutor({ database: db,
      fresh: async (_session, selected) => {
        if (selected.runtimeMembershipId !== selection.runtimeMembershipId) throw Error('publication_member_rejected');
        return { proof: result.proof, evidenceId: result.evidenceId, contextVersion: `context:${result.evidenceId}` };
      },
      authorization: authorize, readiness: { readiness: async () => ({ canPublish: true, proofCurrent: true }) } });
    const candidate = () => ({ expectedEpoch: epoch, currentEpoch: () => epoch, activate: () => { activated += 1; return undefined; },
      recheck: () => evidence.assertTransactionCurrent(db.manager, first) });
    await expect(executor.activateCandidate(session, selection, candidate())).rejects.toThrow('publication_transaction_context_changed');
    expect(activated).toBe(0);
    epoch = 'epoch-next';
    await expect(executor.activateCandidate(session, selection, { expectedEpoch: 'epoch-live', currentEpoch: () => epoch,
      activate: () => { activated += 1; return undefined; } })).rejects.toThrow('publication_candidate_rejected');
    expect(activated).toBe(0);
  });

  test('a same-revision Provider secret change invalidates the evaluation and refuses re-publish before any upstream work', async () => {
    await stagePublishable();
    const evaluation = await evidence.evaluate(session, selection);
    const writer = new PublicationMemberTransactionWriter(db, evidence.toValidator(evaluation));
    const ticket = await writer.prepare({ membershipId: 'membership', evidenceId: evaluation.evidenceId });

    hits = 0;
    secret = 'rotated-synthetic';
    const frozen = await snapshot();
    expect(await orchestrator.isCurrent(result)).toBe(false);
    await expect(evidence.evaluate(session, selection)).rejects.toThrow('publication_evaluation_rejected');
    await expect(writer.commit(ticket)).rejects.toThrow('publication_evaluation_context_changed');
    const executor = createPublicationBatchCandidateExecutor({ database: db,
      fresh: async () => ({ proof: result.proof, evidenceId: result.evidenceId, contextVersion: `context:${result.evidenceId}` }),
      authorization: authorize, readiness: preview });
    const batch = await executor.executeBatch(session, [selection]);
    expect(batch.items[0]).toMatchObject({ status: 'failed', committed: false, code: 'MEMBER_REJECTED' });
    let activated = 0;
    await expect(executor.activateCandidate(session, selection, { expectedEpoch: 'epoch', currentEpoch: () => 'epoch',
      activate: () => { activated += 1; return undefined; } })).rejects.toThrow('publication_member_rejected');
    expect(activated).toBe(0);
    expect(await snapshot()).toEqual(frozen);
    expect(hits).toBe(0);
    expect(evaluation.preview.canPublish).toBe(false);
  });
});
