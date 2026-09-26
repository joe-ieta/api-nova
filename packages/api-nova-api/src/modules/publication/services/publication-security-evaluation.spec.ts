import * as http from 'node:http';
import { AddressInfo } from 'node:net';
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
import { createPublicationSecurityPreviewAdapter } from './publication-security-preview-adapter';
import { createPublicationSecurityEvaluation } from './publication-security-evaluation';
import { PublicationMemberTransactionWriter } from './publication-member-transaction-writer';
import { createPublicationBatchCandidateExecutor } from './publication-batch-candidate-executor';

const selection = { runtimeAssetId: 'runtime', runtimeMembershipId: 'membership' };
const entities = [Profile, Binding, Route, Membership, Runtime, Endpoint, Evidence];

describe('F1-02D unified evaluation consumed by preview, publish and activation (SQL.js + real G1/G2)', () => {
  let db: DataSource, server: http.Server, hits: number, row: any, context: any, session: object, result: any;
  let authority: ReturnType<typeof createUpstreamSecurityContextAuthority>;
  let orchestrator: ReturnType<typeof createUpstreamAuthenticationChallengeOrchestrator>;
  let authorize: ReturnType<typeof createUpstreamSecurityAuthorizationAdapter>;
  let preview: ReturnType<typeof createPublicationSecurityPreviewAdapter>;
  let evidence: ReturnType<typeof createPublicationSecurityEvaluation>;
  const snapshot = () => Promise.all(entities.map(entity => db.getRepository(entity as any).find({ order: { id: 'ASC' } })));

  beforeEach(async () => {
    db = await new DataSource({ type: 'sqljs', entities, synchronize: true }).initialize();
    hits = 0; session = Object.freeze({});
    await db.getRepository(Runtime).save({ id: 'runtime', name: 'fixture', type: RuntimeAssetType.GATEWAY_SERVICE });
    await db.getRepository(Membership).save({ id: 'membership', runtimeAssetId: 'runtime', endpointDefinitionId: 'endpoint' });
    await db.getRepository(Endpoint).save({ id: 'endpoint', sourceServiceAssetId: 'asset', method: 'GET', path: '/target' });
    server = http.createServer((req, res) => { hits++; res.statusCode = req.headers['x-key'] === 'synthetic-only' ? 200 : 401; res.end('{}'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    row = { sourceServiceAssetId: 'asset', endpointDefinitionId: 'endpoint', bindingId: 'binding', bindingRevision: 'r1', method: 'GET', target: `http://127.0.0.1:${port}/target`, declaration: normalizeUpstreamSecurity({ security: [{ Key: [] }], components: { securitySchemes: { Key: { type: 'apiKey', in: 'header', name: 'X-Key' } } } }, {}) };
    const registry = new UpstreamCredentialRegistry({ environment: 'test', providerFactory: description => ({ type: description.type, resolve: async () => 'synthetic-only' }) });
    await registry.reload({ apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'r1', environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { env: { type: 'env' } }, credentials: { key: { type: 'apiKey', placement: { in: 'header', name: 'X-Key' }, secretRef: 'env:TOKEN' } }, sites: [{ id: 'site', sourceServiceAssetId: 'asset', match: { scheme: 'http', host: '127.0.0.1', port, basePath: '/' }, allowedHosts: ['127.0.0.1'], credential: 'key', endpoints: [{ endpointDefinitionId: 'endpoint' }] }] });
    authority = createUpstreamSecurityContextAuthority({ read: async () => row }, () => registry.captureSnapshot());
    const transport = createUpstreamAuthenticationChallengeTransport(authority), intent = Object.freeze({});
    orchestrator = createUpstreamAuthenticationChallengeOrchestrator({ authority, transport, repository: db.getRepository(Evidence), intents: { resolve: async token => { if (token !== intent) throw Error(); return { sourceServiceAssetId: 'asset', endpointDefinitionId: 'endpoint', actorId: 'actor', intentId: 'intent' }; } } });
    result = await orchestrator.execute(intent);
    const { credentialType: ignored, ...captured } = authority.inspect(await authority.issue({ sourceServiceAssetId: 'asset', endpointDefinitionId: 'endpoint' })); context = { ...captured, actorId: 'actor' };
    authorize = createUpstreamSecurityAuthorizationAdapter(orchestrator, { read: async (input, selected) => {
      if (input !== session) return undefined;
      const member = await db.getRepository(Membership).findOneBy({ id: selected.runtimeMembershipId, runtimeAssetId: selected.runtimeAssetId });
      return member?.endpointDefinitionId === context.endpointDefinitionId ? context : undefined;
    } });
    preview = createPublicationSecurityPreviewAdapter(db, authorize);
    evidence = createPublicationSecurityEvaluation({ database: db, authorization: authorize, readiness: preview,
      fresh: async (_session, selector) => {
        if (selector.runtimeMembershipId !== selection.runtimeMembershipId || selector.runtimeAssetId !== selection.runtimeAssetId) throw Error('publication_member_rejected');
        return { proof: result.proof, evidenceId: result.evidenceId, contextVersion: `context:${result.evidenceId}` };
      } });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.destroy();
  });

  const stagePublishable = async () => {
    await db.getRepository(Profile).save({ endpointDefinitionId: 'endpoint', runtimeAssetEndpointBindingId: 'membership', status: 'reviewed' as any });
    await db.getRepository(Binding).save({ endpointDefinitionId: 'endpoint', runtimeAssetEndpointBindingId: 'membership' });
    await db.getRepository(Route).save({ endpointDefinitionId: 'endpoint', runtimeAssetEndpointBindingId: 'membership', routePath: '/items', routeMethod: 'GET', upstreamPath: '/target', upstreamMethod: 'GET' });
  };

  test('preview and single-member publish consume one frozen evaluation', async () => {
    await stagePublishable();
    const evaluation = await evidence.evaluate(session, selection);
    expect(evaluation.preview).toMatchObject({ canPublish: false, proofCurrent: true, phase: 'preview_validated' });
    expect(evaluation.preview.reasons).toContain('PUBLICATION_ACTIVATION_NOT_READY');
    expect(evaluation.preview.reasons).not.toContain('MEMBERSHIP_DISABLED');

    const writer = new PublicationMemberTransactionWriter(db, evidence.toValidator(evaluation));
    const ticket = await writer.prepare({ membershipId: 'membership', evidenceId: evaluation.evidenceId });
    const committed = await writer.commit(ticket);

    expect(committed.publicationRevision).toBe(1);
    expect((await db.getRepository(Membership).findOneByOrFail({ id: 'membership' })).publicationRevision).toBe(1);
    expect(await db.getRepository(Binding).count()).toBe(1);
    // The shared preview never becomes an authorization after the write.
    expect(evaluation.preview.canPublish).toBe(false);
  });

  test('revoked evidence after evaluation fails publish and activation rechecks with zero writes', async () => {
    await stagePublishable();
    const evaluation = await evidence.evaluate(session, selection);
    await orchestrator.revoke(result);
    const before = await snapshot();

    const writer = new PublicationMemberTransactionWriter(db, evidence.toValidator(evaluation));
    await expect(writer.prepare({ membershipId: 'membership', evidenceId: evaluation.evidenceId }))
      .rejects.toThrow();
    await expect(evidence.assertTransactionCurrent(db.manager, evaluation))
      .rejects.toThrow('publication_transaction_context_changed');
    expect(await snapshot()).toEqual(before);
  });

  test('membership revision drift fails publish commit and activation rechecks', async () => {
    await stagePublishable();
    const evaluation = await evidence.evaluate(session, selection);

    // Drift between prepare and commit is rejected by G3's digest/contextVersion.
    const writer = new PublicationMemberTransactionWriter(db, evidence.toValidator(evaluation));
    const ticket = await writer.prepare({ membershipId: 'membership', evidenceId: evaluation.evidenceId });
    await db.getRepository(Membership).update({ id: 'membership' }, { publicationRevision: evaluation.membershipRevision + 1 });
    await expect(writer.commit(ticket)).rejects.toThrow('publication_transaction_context_changed');

    // Drift already present before activation is rejected by the evaluation pin.
    await expect(evidence.assertTransactionCurrent(db.manager, evaluation))
      .rejects.toThrow('publication_transaction_context_changed');
  });

  test('batch executor and activation consume the shared evaluation and recheck at the commit boundary', async () => {
    await stagePublishable();
    const evaluation = await evidence.evaluate(session, selection);
    const fresh = async () => ({ proof: evaluation.proof, evidenceId: evaluation.evidenceId, contextVersion: evaluation.contextVersion });
    const executor = createPublicationBatchCandidateExecutor({ database: db, fresh, authorization: authorize,
      readiness: { readiness: async () => ({ canPublish: true, proofCurrent: true }) } });

    const batch = await executor.executeBatch(session, [selection]);
    expect(batch.items[0]).toMatchObject({ status: 'success', committed: true });

    const next = await evidence.evaluate(session, selection);
    let activated = 0;
    const candidate = () => ({
      expectedEpoch: 'e1', currentEpoch: () => 'e1',
      activate: () => { activated += 1; return undefined; },
      recheck: () => evidence.assertTransactionCurrent(db.manager, next),
    });
    await executor.activateCandidate(session, selection, candidate());
    expect(activated).toBe(1);

    await db.getRepository(Membership).update({ id: 'membership' }, { publicationRevision: next.membershipRevision + 1 });
    await expect(executor.activateCandidate(session, selection, candidate()))
      .rejects.toThrow('publication_transaction_context_changed');
    expect(activated).toBe(1);
  });

  test('production G2 canPublish:false is preserved by batch execution', async () => {
    await stagePublishable();
    const evaluation = await evidence.evaluate(session, selection);
    const before = await snapshot();
    const executor = createPublicationBatchCandidateExecutor({ database: db,
      fresh: async () => ({ proof: evaluation.proof, evidenceId: evaluation.evidenceId, contextVersion: evaluation.contextVersion }),
      authorization: authorize, readiness: preview });

    const batch = await executor.executeBatch(session, [selection]);

    expect(batch.items[0]).toMatchObject({ status: 'failed', committed: false });
    expect(await snapshot()).toEqual(before);
  });
});
