import { DataSource } from 'typeorm';
import { PublicationMemberTransactionWriter as Writer } from './publication-member-transaction-writer';
import { PublicationProfileEntity as Profile } from '../../../database/entities/publication-profile.entity';
import { EndpointPublishBindingEntity as Binding } from '../../../database/entities/endpoint-publish-binding.entity';
import { GatewayRouteBindingEntity as Route } from '../../../database/entities/gateway-route-binding.entity';
import { RuntimeAssetEndpointBindingEntity as Membership } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import { RuntimeAssetEntity as Runtime, RuntimeAssetType } from '../../../database/entities/runtime-asset.entity';
import { EndpointDefinitionEntity as Endpoint } from '../../../database/entities/endpoint-definition.entity';
import { UpstreamProductionChallengeEvidenceEntity as Evidence } from '../../../database/entities/upstream-production-challenge-evidence.entity';

const business = [Profile, Route, Binding, Membership, Runtime];
describe('independent single-member transaction writer (not production registered)', () => {
  let db: DataSource, ids: { membershipId: string; evidenceId: string }, validate: jest.Mock, writer: Writer;
  const now = new Date('2026-09-24T00:00:00Z');
  const snapshot = async () => Promise.all(business.map(entity => db.getRepository(entity as any).find({ order: { id: 'ASC' } })));
  beforeEach(async () => {
    db = await new DataSource({ type: 'sqljs', entities: [...business, Endpoint, Evidence], synchronize: true }).initialize();
    await db.getRepository(Endpoint).save({ id: 'endpoint', sourceServiceAssetId: 'source', method: 'GET', path: '/items' });
    await db.getRepository(Runtime).save({ id: 'runtime', name: 'fixture', type: RuntimeAssetType.GATEWAY_SERVICE });
    await db.getRepository(Membership).save({ id: 'member', runtimeAssetId: 'runtime', endpointDefinitionId: 'endpoint' });
    await db.getRepository(Route).save({ id: 'route', endpointDefinitionId: 'endpoint', runtimeAssetEndpointBindingId: 'member', routePath: '/items', routeMethod: 'GET', upstreamPath: '/items', upstreamMethod: 'GET' });
    const evidence = await db.getRepository(Evidence).save({ sourceServiceAssetId: 'source', endpointDefinitionId: 'endpoint', contextDigest: 'a'.repeat(64), providerEpoch: 'epoch', runNonce: 'nonce', bindingRevision: 'r1', bindingGeneration: 1, actorId: 'actor', result: 'passed', completedAt: new Date('2026-09-23T23:59:00Z'), expiresAt: new Date('2026-09-25T00:00:00Z'), anonymousBeforeStatus: 401, wrongCredentialStatus: 403, validCredentialStatus: 200, anonymousAfterStatus: 401 });
    ids = { membershipId: 'member', evidenceId: evidence.id }; validate = jest.fn(async () => 'trusted-context-version'); writer = new Writer(db, validate, () => now);
  });
  afterEach(async () => { await db.destroy(); });
  it('validation failure before prepare or commit changes zero business records and runs no hook', async () => {
    const before = await snapshot(), hook = jest.fn(); validate.mockRejectedValueOnce(new Error('validation rejected'));
    await expect(writer.prepare(ids)).rejects.toThrow(); expect(await snapshot()).toEqual(before);
    const ticket = await writer.prepare(ids); validate.mockRejectedValueOnce(new Error('validation rejected'));
    await expect(writer.commit(ticket, hook)).rejects.toThrow(); expect(await snapshot()).toEqual(before); expect(hook).not.toHaveBeenCalled();
  });
  it.each(['endpoint', 'evidence', 'revision'])('rejects optimistic %s change between prepare and commit without business writes', async changed => {
    const ticket = await writer.prepare(ids);
    if (changed === 'endpoint') await db.getRepository(Endpoint).update('endpoint', { path: '/changed' });
    if (changed === 'evidence') await db.getRepository(Evidence).update(ids.evidenceId, { revokedAt: now });
    if (changed === 'revision') await db.getRepository(Membership).update('member', { publicationRevision: 1 });
    const before = await snapshot(); await expect(writer.commit(ticket)).rejects.toThrow(); expect(await snapshot()).toEqual(before);
  });
  it('rolls back all five business writes when final context changes', async () => {
    const before = await snapshot(), hook = jest.fn(), ticket = await writer.prepare(ids);
    validate.mockResolvedValueOnce('trusted-context-version').mockImplementationOnce(async () => {
      expect((await db.getRepository(Profile).findOneByOrFail({ runtimeAssetEndpointBindingId: 'member' })).status).toBe('published');
      expect((await db.getRepository(Route).findOneByOrFail({ id: 'route' })).status).toBe('active');
      return 'changed-context';
    });
    await expect(writer.commit(ticket, hook)).rejects.toThrow('publication_transaction_context_changed');
    expect(await snapshot()).toEqual(before); expect(hook).not.toHaveBeenCalled();
  });
  it('re-reads evidence after the final asynchronous validation and rolls back mutations', async () => {
    const before = await snapshot(), ticket = await writer.prepare(ids);
    validate.mockResolvedValueOnce('trusted-context-version').mockImplementationOnce(async () => {
      await db.getRepository(Evidence).update(ids.evidenceId, { revokedAt: now }); return 'trusted-context-version';
    });
    await expect(writer.commit(ticket)).rejects.toThrow('publication_transaction_validation_failed');
    expect(await snapshot()).toEqual(before);
    expect((await db.getRepository(Evidence).findOneByOrFail({ id: ids.evidenceId })).revokedAt).toBeNull();
  });
  it('rolls back a mid-write database failure including the membership revision claim', async () => {
    const ticket = await writer.prepare(ids), before = await snapshot(), hook = jest.fn();
    await db.query(`CREATE TRIGGER reject_publish BEFORE INSERT ON endpoint_publish_bindings BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
    await expect(writer.commit(ticket, hook)).rejects.toThrow('fixture failure'); expect(await snapshot()).toEqual(before); expect(hook).not.toHaveBeenCalled();
  });
  it('commits all five business rows before executing the hook, without claiming batch audit atomicity', async () => {
    const ticket = await writer.prepare(ids); const hook = jest.fn(async result => {
      expect(db.createQueryRunner().isTransactionActive).toBe(false);
      expect((await db.getRepository(Profile).findOneByOrFail({ id: result.profileId })).status).toBe('published');
      expect((await db.getRepository(Binding).findOneByOrFail({ id: result.bindingId })).publicationRevision).toBe(1);
      expect((await db.getRepository(Route).findOneByOrFail({ id: 'route' })).status).toBe('active');
      expect((await db.getRepository(Membership).findOneByOrFail({ id: 'member' })).publicationRevision).toBe(1);
      expect((await db.getRepository(Runtime).findOneByOrFail({ id: 'runtime' })).status).toBe('active');
    });
    expect(await writer.commit(ticket, hook)).toMatchObject({ publicationRevision: 1, routeId: 'route' }); expect(hook).toHaveBeenCalledTimes(1);
    await expect(writer.commit(ticket, hook)).rejects.toThrow('publication_transaction_ticket_invalid'); expect(hook).toHaveBeenCalledTimes(1);
  });
  it('keeps committed state after hook failure and never replays the consumed ticket', async () => {
    const ticket = await writer.prepare(ids), hook = jest.fn(async () => { throw new Error('deployment failed'); });
    await expect(writer.commit(ticket, hook)).rejects.toMatchObject({ message: 'publication_after_commit_failed', committed: true, result: { publicationRevision: 1 } });
    expect((await db.getRepository(Membership).findOneByOrFail({ id: 'member' })).publicationRevision).toBe(1);
    await expect(writer.commit(ticket, hook)).rejects.toThrow('publication_transaction_ticket_invalid'); expect(hook).toHaveBeenCalledTimes(1);
  });
  it('preserves the default new-route Header policy gate with no partial draft writes', async () => {
    await db.getRepository(Route).delete('route'); const before = await snapshot();
    const ticket = await writer.prepare(ids, { routePath: '/new', routeMethod: 'GET', upstreamPath: '/items', upstreamMethod: 'GET' });
    await expect(writer.commit(ticket)).rejects.toThrow('GATEWAY_HEADER_POLICY_NOT_READY'); expect(await snapshot()).toEqual(before);
  });
});
