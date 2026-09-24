import { PublicationMemberTransactionWriter } from './publication-member-transaction-writer';
import { DataSource } from 'typeorm';
import { createPublicationBatchCandidateExecutor, type PublicationBatchDependencies } from './publication-batch-candidate-executor';
import { createPublicationSecurityPreviewAdapter } from './publication-security-preview-adapter';
import { PublicationProfileEntity as Profile } from '../../../database/entities/publication-profile.entity';
import { EndpointPublishBindingEntity as Binding } from '../../../database/entities/endpoint-publish-binding.entity';
import { GatewayRouteBindingEntity as Route } from '../../../database/entities/gateway-route-binding.entity';
import { RuntimeAssetEndpointBindingEntity as Membership } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import { RuntimeAssetEntity as Runtime, RuntimeAssetType } from '../../../database/entities/runtime-asset.entity';
import { EndpointDefinitionEntity as Endpoint } from '../../../database/entities/endpoint-definition.entity';
import { UpstreamProductionChallengeEvidenceEntity as Evidence } from '../../../database/entities/upstream-production-challenge-evidence.entity';
const entities = [Profile, Binding, Route, Membership, Runtime, Endpoint, Evidence];
const select = (id: string) => ({ runtimeAssetId: 'runtime', runtimeMembershipId: id });
describe('bounded batch executor semantics with injected future readiness and real G3 SQL.js transactions', () => {
  let db: DataSource, dependencies: PublicationBatchDependencies, evidence: Map<string, string>, proofs: Map<string, any>;
  beforeEach(async () => {
    db = await new DataSource({ type: 'sqljs', entities, synchronize: true }).initialize(); evidence = new Map(); proofs = new Map();
    await db.query('CREATE TABLE batch_fixture_audit (member varchar, outcome varchar)');
    await db.getRepository(Runtime).save({ id: 'runtime', name: 'fixture', type: RuntimeAssetType.GATEWAY_SERVICE });
    for (const id of ['one', 'two', 'three']) {
      await db.getRepository(Endpoint).save({ id, sourceServiceAssetId: 'source', method: 'GET', path: '/' + id });
      await db.getRepository(Membership).save({ id, runtimeAssetId: 'runtime', endpointDefinitionId: id });
      await db.getRepository(Route).save({ id, endpointDefinitionId: id, runtimeAssetEndpointBindingId: id, routePath: '/' + id, routeMethod: 'GET', upstreamPath: '/' + id, upstreamMethod: 'GET' });
      const row = await db.getRepository(Evidence).save({ sourceServiceAssetId: 'source', endpointDefinitionId: id, contextDigest: 'a'.repeat(64), providerEpoch: 'epoch', runNonce: id, bindingRevision: 'r1', bindingGeneration: 1, actorId: 'actor', result: 'passed', completedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 60000), anonymousBeforeStatus: 401, wrongCredentialStatus: 401, validCredentialStatus: 200, anonymousAfterStatus: 401 });
      evidence.set(id, row.id); proofs.set(id, Object.freeze({}));
    }
    dependencies = {
      database: db,
      fresh: jest.fn(async (_session, selector) => ({ proof: proofs.get(selector.runtimeMembershipId), evidenceId: evidence.get(selector.runtimeMembershipId), contextVersion: 'fixture-current' })),
      authorization: { authorize: jest.fn(async (proof, _session, selector) => proofs.get(selector.runtimeMembershipId) === proof) },
      // Explicit fixture capability, NOT the production G2 decision (which is always false).
      readiness: { readiness: jest.fn(async () => ({ canPublish: true, proofCurrent: true })) },
      afterCommit: jest.fn(async () => {}),
      audit: jest.fn(async item => { await db.query('INSERT INTO batch_fixture_audit VALUES (?,?)', [item.membershipId, item.status]); }),
    };
  });
  afterEach(async () => { jest.restoreAllMocks(); await db.destroy(); });
  const rowsFor = async (id: string) => Promise.all([db.getRepository(Profile).findBy({ runtimeAssetEndpointBindingId: id }), db.getRepository(Binding).findBy({ runtimeAssetEndpointBindingId: id }), db.getRepository(Route).findBy({ id }), db.getRepository(Membership).findBy({ id })]);
  it('rolls back only the second member when proof becomes invalid after writes; preserves first and continues third', async () => {
    const secondBefore = await rowsFor('two');
    dependencies.authorization.authorize = jest.fn(async (proof, _session, selector) => {
      if (selector.runtimeMembershipId === 'two' && await db.getRepository(Profile).countBy({ runtimeAssetEndpointBindingId: 'two' })) return false;
      return proof === proofs.get(selector.runtimeMembershipId);
    });
    const report = await createPublicationBatchCandidateExecutor(dependencies).executeBatch({}, ['one', 'two', 'three'].map(select));
    expect(report.atomic).toBe(false); expect(report.items.map(item => [item.membershipId, item.status, item.committed])).toEqual([['one', 'success', true], ['two', 'failed', false], ['three', 'success', true]]);
    expect(await rowsFor('two')).toEqual(secondBefore);
    for (const id of ['one', 'three']) expect((await db.getRepository(Membership).findOneByOrFail({ id })).publicationRevision).toBe(1);
    expect((dependencies.fresh as jest.Mock).mock.calls.map(call => call[1].runtimeMembershipId)).toEqual(['one', 'two', 'three']);
    expect(dependencies.afterCommit).toHaveBeenCalledTimes(2); expect(await db.query('SELECT * FROM batch_fixture_audit')).toHaveLength(3);
  });
  it('obeys actual G2 canPublish:false without creating business records; audit records are allowed', async () => {
    dependencies.readiness = createPublicationSecurityPreviewAdapter(db, dependencies.authorization);
    const prepare = jest.spyOn(PublicationMemberTransactionWriter.prototype, 'prepare');
    const commit = jest.spyOn(PublicationMemberTransactionWriter.prototype, 'commit');
    const before = await Promise.all(['one', 'two'].map(rowsFor));
    const report = await createPublicationBatchCandidateExecutor(dependencies).executeBatch({}, ['one', 'two'].map(select));
    expect(report.items.every(item => !item.committed && item.status === 'failed')).toBe(true);
    expect(await Promise.all(['one', 'two'].map(rowsFor))).toEqual(before); expect(dependencies.afterCommit).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
    expect(await db.query('SELECT * FROM batch_fixture_audit')).toHaveLength(2);
  });
  it('reports a committed after-effect failure accurately and continues without undoing prior publication', async () => {
    dependencies.afterCommit = jest.fn(async result => { if (result.membershipId === 'one') throw Error('private deployment details'); });
    const report = await createPublicationBatchCandidateExecutor(dependencies).executeBatch({}, ['one', 'two'].map(select));
    expect(report.items[0]).toMatchObject({ committed: true, status: 'committed_side_effect_failed', code: 'AFTER_COMMIT_FAILED' }); expect(report.items[1].status).toBe('success');
    expect((await db.getRepository(Membership).findOneByOrFail({ id: 'one' })).publicationRevision).toBe(1); expect(JSON.stringify(report)).not.toContain('private');
  });
  it('isolates audit failure from durable member result and does not stop following members', async () => {
    dependencies.audit = jest.fn(async () => { throw Error('audit unavailable'); });
    const report = await createPublicationBatchCandidateExecutor(dependencies).executeBatch({}, ['one', 'two'].map(select));
    expect(report.items.every(item => item.committed && item.auditFailed && item.status === 'success')).toBe(true);
  });
  it('rejects mixed-runtime/duplicate batches before acquiring capabilities', async () => {
    const executor = createPublicationBatchCandidateExecutor(dependencies);
    await expect(executor.executeBatch({}, [select('one'), select('one')])).rejects.toThrow();
    await expect(executor.executeBatch({}, [select('one'), { ...select('two'), runtimeAssetId: 'other' }])).rejects.toThrow();
    expect(dependencies.fresh).not.toHaveBeenCalled();
  });
  it('candidate synchronous swap requires fresh proof and exact epoch at the final call boundary', async () => {
    let epoch = 'epoch-1'; const activate = jest.fn();
    const executor = createPublicationBatchCandidateExecutor(dependencies);
    await executor.activateCandidate({}, select('one'), { expectedEpoch: epoch, currentEpoch: () => epoch, activate }); expect(activate).toHaveBeenCalledTimes(1);
    dependencies.authorization.authorize = jest.fn(async () => { epoch = 'epoch-2'; return true; });
    await expect(executor.activateCandidate({}, select('one'), { expectedEpoch: 'epoch-1', currentEpoch: () => epoch, activate })).rejects.toThrow('publication_candidate_rejected');
    dependencies.authorization.authorize = jest.fn(async () => false);
    await expect(executor.activateCandidate({}, select('one'), { expectedEpoch: epoch, currentEpoch: () => epoch, activate })).rejects.toThrow(); expect(activate).toHaveBeenCalledTimes(1);
    expect(dependencies.fresh).toHaveBeenCalledTimes(3);
  });
  it('candidate remains blocked with actual G2 readiness', async () => {
    dependencies.readiness = createPublicationSecurityPreviewAdapter(db, dependencies.authorization); const activate = jest.fn();
    await expect(createPublicationBatchCandidateExecutor(dependencies).activateCandidate({}, select('one'), { expectedEpoch: 'epoch', currentEpoch: () => 'epoch', activate })).rejects.toThrow(); expect(activate).not.toHaveBeenCalled();
  });
});
