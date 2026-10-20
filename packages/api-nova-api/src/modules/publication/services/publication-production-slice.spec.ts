import { DataSource } from 'typeorm';
import { PublicationService } from './publication.service';
import { PublicationMemberTransactionWriter } from './publication-member-transaction-writer';
import { PublicationController } from '../publication.controller';
import { normalizeUpstreamSecurity } from '../security/upstream-security-reconciliation';
import { PublicationProfileEntity as Profile, PublicationProfileStatus } from '../../../database/entities/publication-profile.entity';
import { PublicationProfileHistoryEntity as History } from '../../../database/entities/publication-profile-history.entity';
import { PublicationBatchRunEntity as Batch } from '../../../database/entities/publication-batch-run.entity';
import { PublicationAuditEventEntity as Audit } from '../../../database/entities/publication-audit-event.entity';
import { EndpointPublishBindingEntity as Binding, PublicationBindingStatus } from '../../../database/entities/endpoint-publish-binding.entity';
import { GatewayRouteBindingEntity as Route } from '../../../database/entities/gateway-route-binding.entity';
import { RuntimeAssetEndpointBindingEntity as Membership, RuntimeAssetEndpointBindingStatus } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import { RuntimeAssetEntity as Runtime, RuntimeAssetStatus, RuntimeAssetType } from '../../../database/entities/runtime-asset.entity';
import { EndpointDefinitionEntity as Endpoint, EndpointDefinitionStatus } from '../../../database/entities/endpoint-definition.entity';
import { SourceServiceAssetEntity as Source } from '../../../database/entities/source-service-asset.entity';
import { UpstreamProductionChallengeEvidenceEntity as Evidence } from '../../../database/entities/upstream-production-challenge-evidence.entity';

const business = [Profile, Binding, Route, Membership, Runtime, Endpoint, Evidence];
const entities = [...business, Source, History, Batch, Audit];
const protectedDeclaration = normalizeUpstreamSecurity({
  security: [{ Key: [] }], components: { securitySchemes: { Key: { type: 'apiKey', in: 'header', name: 'X-Key' } } },
}, {});

describe('NP-30 bounded production wiring: actual PublicationService and SQL.js', () => {
  let db: DataSource, service: PublicationService, queries: string[];
  let effects: { startRuntimeAsset: jest.Mock; deployMcpRuntimeAsset: jest.Mock }, events: { emit: jest.Mock };
  const snapshot = () => Promise.all(business.map(entity => db.getRepository(entity as any).find({ order: { id: 'ASC' } })));
  async function member(id: string, protectedEndpoint = false) {
    await db.getRepository(Endpoint).save({ id, sourceServiceAssetId: 'source', method: 'GET', path: '/' + id,
      status: EndpointDefinitionStatus.VERIFIED, publishEnabled: true, rawOperation: {},
      metadata: { testStatus: 'passed', lastProbeStatus: 'healthy', source: 'manual-registration',
        ...(protectedEndpoint ? { upstreamSecurityDeclaration: protectedDeclaration } : {}) } });
    await db.getRepository(Membership).save({ id, runtimeAssetId: 'runtime', endpointDefinitionId: id });
    await db.getRepository(Profile).save({ id: 'profile-' + id, endpointDefinitionId: id, runtimeAssetEndpointBindingId: id,
      intentName: id, descriptionForLlm: id, status: PublicationProfileStatus.REVIEWED });
  }
  async function previous(id: string) {
    await db.getRepository(Membership).update(id, { publicationRevision: 4, status: RuntimeAssetEndpointBindingStatus.ACTIVE });
    await db.getRepository(Profile).update('profile-' + id, { status: PublicationProfileStatus.PUBLISHED });
    await db.getRepository(Binding).save({ id: 'binding-' + id, endpointDefinitionId: id, runtimeAssetEndpointBindingId: id,
      publicationProfileId: 'profile-' + id, publicationRevision: 4, publishStatus: PublicationBindingStatus.ACTIVE,
      publishedToMcp: true });
    await db.getRepository(Runtime).update('runtime', { status: RuntimeAssetStatus.ACTIVE });
  }
  beforeEach(async () => {
    queries = [];
    db = await new DataSource({ type: 'sqljs', entities, synchronize: true, logging: ['query'],
      logger: { logQuery: query => { queries.push(query); }, logQueryError() {}, logQuerySlow() {}, logSchemaBuild() {}, logMigration() {}, log() {} },
    }).initialize();
    await db.getRepository(Source).save({ id: 'source', sourceKey: 'http://synthetic.invalid' });
    await db.getRepository(Runtime).save({ id: 'runtime', name: 'isolated-mcp', type: RuntimeAssetType.MCP_SERVER });
    effects = { startRuntimeAsset: jest.fn(async () => ({ managedServer: { id: 'test-effect' } })),
      deployMcpRuntimeAsset: jest.fn(async () => ({ managedServer: { id: 'test-effect' } })) };
    events = { emit: jest.fn() };
    service = new PublicationService(db.getRepository(Endpoint), db.getRepository(Runtime), db.getRepository(Membership),
      db.getRepository(Source), db.getRepository(Profile), db.getRepository(History), db.getRepository(Batch),
      db.getRepository(Audit), db.getRepository(Binding), db.getRepository(Route), effects as any, events as any, {} as any);
  });
  afterEach(async () => { jest.restoreAllMocks(); await db.destroy(); });

  it('exposes a read-only preview that cannot create missing drafts or claim deployment', async () => {
    await member('one');
    await db.getRepository(Profile).delete('profile-one');
    const before = await snapshot();
    queries = [];
    const result = await new PublicationController(service).previewRuntimeMembership('one');
    expect(result).toMatchObject({ phase: 'preview_only', canPublish: false,
      deployment: { status: 'not_attempted', attempted: false, autoTriggered: false } });
    expect(queries.every(query => /^SELECT\b/i.test(query.trim()))).toBe(true);
    expect(await snapshot()).toEqual(before);
    expect(await db.getRepository(History).count()).toBe(0);
    expect(await db.getRepository(Audit).count()).toBe(0);
    expect(effects.startRuntimeAsset).not.toHaveBeenCalled();
    expect(effects.deployMcpRuntimeAsset).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('uses the same Unsecured MCP decision for preview and transactional publication before any deployment effect', async () => {
    await member('one');
    expect(await service.previewRuntimeMembership('one')).toMatchObject({ canPublish: true, phase: 'preview_only', publicationRevision: 0 });
    effects.startRuntimeAsset.mockImplementationOnce(async () => {
      expect(db.createQueryRunner().isTransactionActive).toBe(false);
      expect((await db.getRepository(Membership).findOneByOrFail({ id: 'one' })).publicationRevision).toBe(1);
      expect((await db.getRepository(Binding).findOneByOrFail({ runtimeAssetEndpointBindingId: 'one' })).publishedToMcp).toBe(true);
      return { managedServer: { id: 'test-effect' } };
    });
    const result = await service.publishRuntimeMembership('one', {}, 'actor');
    expect(result.membership.publicationRevision).toBe(1);
    expect(effects.startRuntimeAsset).toHaveBeenCalledTimes(1);
    expect(await service.previewRuntimeMembership('one')).toMatchObject({ canPublish: true, phase: 'preview_only', publicationRevision: 1 });
  });

  it.each(['protected', 'disabled', 'profile', 'ownership', 'revision'])('preview/single/batch all reject %s without altering the prior publication', async kind => {
    await member('one', kind === 'protected');
    await previous('one');
    if (kind === 'protected') {
      const endpoint = await db.getRepository(Endpoint).findOneByOrFail({ id: 'one' });
      await db.getRepository(Endpoint).update('one', { metadata: { ...endpoint.metadata, upstreamSecurityState: 'Verified',
        evidence: { result: 'passed', canPublish: true } } });
    }
    if (kind === 'disabled') await db.getRepository(Membership).update('one', { enabled: false });
    if (kind === 'profile') await db.getRepository(Profile).update('profile-one', { status: PublicationProfileStatus.DRAFT });
    if (kind === 'ownership') await db.getRepository(Profile).update('profile-one', { endpointDefinitionId: 'other' });
    if (kind === 'revision') await db.getRepository(Binding).update('binding-one', { publicationRevision: 3 });
    const before = await snapshot(), preview = await service.previewRuntimeMembership('one');
    expect(preview.canPublish).toBe(false);
    await expect(service.publishRuntimeMembership('one', {})).rejects.toMatchObject({ status: 400 });
    const batch = await service.batchPublishRuntimeMemberships({ membershipIds: ['one'] });
    expect(batch.items[0]).toMatchObject({ status: 'failed', committed: false });
    expect(preview.readiness.reasons.some(reason => batch.items[0].message.includes(reason))).toBe(true);
    expect(batch.deployment).toMatchObject({ status: 'blocked', attempted: false, code: 'BATCH_PUBLICATION_INCOMPLETE' });
    expect(await snapshot()).toEqual(before);
    expect(effects.startRuntimeAsset).not.toHaveBeenCalled();
    expect(effects.deployMcpRuntimeAsset).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it.each([true, false])('partial publication preserves the rejected old member and does not deploy (autoStart=%s)', async autoStart => {
    await member('one'); await member('two', true); await member('three');
    await previous('two');
    const oldBinding = await db.getRepository(Binding).findOneByOrFail({ id: 'binding-two' });
    const oldProfile = await db.getRepository(Profile).findOneByOrFail({ id: 'profile-two' });
    const oldMember = await db.getRepository(Membership).findOneByOrFail({ id: 'two' });
    const batch = await service.batchPublishRuntimeMemberships({ membershipIds: ['one', 'two', 'three'], autoStart }, 'actor');
    expect(batch.items.map(item => item.status)).toEqual(['success', 'failed', 'success']);
    expect(batch.batchRun).toMatchObject({ status: 'partial', successCount: 2, failedCount: 1 });
    expect(batch.deployment).toMatchObject({ status: 'blocked', attempted: false });
    expect(await db.getRepository(Binding).findOneByOrFail({ id: 'binding-two' })).toEqual(oldBinding);
    expect(await db.getRepository(Profile).findOneByOrFail({ id: 'profile-two' })).toEqual(oldProfile);
    expect(await db.getRepository(Membership).findOneByOrFail({ id: 'two' })).toEqual(oldMember);
    expect(effects.startRuntimeAsset).not.toHaveBeenCalled();
    expect(effects.deployMcpRuntimeAsset).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('deploys once only after all members have committed successfully', async () => {
    await member('one'); await member('two');
    const result = await service.batchPublishRuntimeMemberships({ membershipIds: ['one', 'two'], autoStart: false }, 'actor');
    expect(result.items.every(item => item.status === 'success')).toBe(true);
    expect(effects.deployMcpRuntimeAsset).toHaveBeenCalledTimes(1);
    expect(effects.deployMcpRuntimeAsset).toHaveBeenCalledWith('runtime', {}, { actorId: 'actor' });
    expect(effects.startRuntimeAsset).not.toHaveBeenCalled();
  });

  it('rolls back a mid-write database failure and keeps all old business rows intact', async () => {
    await member('one'); await previous('one');
    const before = await snapshot();
    await db.query("CREATE TRIGGER reject_np30 BEFORE UPDATE ON endpoint_publish_bindings BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
    await expect(service.publishRuntimeMembership('one', {})).rejects.toThrow('synthetic failure');
    expect(await snapshot()).toEqual(before);
    expect(effects.startRuntimeAsset).not.toHaveBeenCalled();
    expect(await db.getRepository(History).count()).toBe(0);
  });

  it.each([
    "UPDATE endpoint_definitions SET path='/changed' WHERE id='one'",
    "UPDATE publication_profiles SET descriptionForLlm='changed' WHERE id='profile-one'",
    "UPDATE runtime_assets SET name='changed' WHERE id='runtime'",
    "UPDATE runtime_asset_endpoint_bindings SET enabled=0 WHERE id='one'",
    "UPDATE endpoint_publish_bindings SET publishedToMcp=0 WHERE id='binding-one'",
  ])('rejects in-transaction context drift from a database hook: %s', async mutation => {
    await member('one'); await previous('one');
    const before = await snapshot();
    await db.query(`CREATE TRIGGER change_np30 AFTER UPDATE ON endpoint_publish_bindings BEGIN ${mutation}; END`);
    await expect(service.publishRuntimeMembership('one', {})).rejects.toThrow('publication_transaction_context_changed');
    expect(await snapshot()).toEqual(before);
    expect(effects.startRuntimeAsset).not.toHaveBeenCalled();
  });

  it('rejects a protected declaration introduced after preview and before the write transaction', async () => {
    await member('one'); await previous('one');
    expect((await service.previewRuntimeMembership('one')).canPublish).toBe(true);
    const endpoint = await db.getRepository(Endpoint).findOneByOrFail({ id: 'one' });
    await db.getRepository(Endpoint).update('one', { metadata: { ...endpoint.metadata, upstreamSecurityDeclaration: protectedDeclaration } });
    const before = await snapshot();
    const writer = new PublicationMemberTransactionWriter(db, async () => { throw Error('proof_path_disabled'); });
    await expect(writer.commitUnsecuredMcp('one', 'runtime', 'one')).rejects.toThrow('upstream_security:BindingMissing');
    expect(await snapshot()).toEqual(before);
  });

  it('rejects preview drift between snapshots without writing records or granting a reusable permit', async () => {
    await member('one');
    const repository = db.getRepository(Endpoint), original = repository.findOne.bind(repository);
    let reads = 0;
    jest.spyOn(repository, 'findOne').mockImplementation(async options => {
      // The first snapshot already read membership; change it before the second
      // snapshot reads membership. Preview is not a permit for later writes.
      if (++reads === 1) await db.getRepository(Membership).update('one', { publicationRevision: 1 });
      return original(options);
    });
    const preview = await service.previewRuntimeMembership('one');
    expect(preview).toMatchObject({ phase: 'preview_only', canPublish: false });
    expect(preview.readiness.reasons).toContain('PREVIEW_CONTEXT_CHANGED');
    expect(await db.getRepository(Binding).count()).toBe(0);
    expect(effects.startRuntimeAsset).not.toHaveBeenCalled();
  });

  it('keeps Gateway preview and publication closed without the production Header authority', async () => {
    await member('one');
    await db.getRepository(Runtime).update('runtime', { type: RuntimeAssetType.GATEWAY_SERVICE });
    await db.getRepository(Route).save({ id: 'route', endpointDefinitionId: 'one', runtimeAssetEndpointBindingId: 'one',
      routePath: '/one', routeMethod: 'GET', upstreamPath: '/one', upstreamMethod: 'GET' });
    const before = await snapshot();
    const preview = await service.previewRuntimeMembership('one');
    expect(preview.canPublish).toBe(false);
    expect(preview.readiness.reasons).toContain('GATEWAY_HEADER_POLICY_NOT_READY');
    await expect(service.publishRuntimeMembership('one', {})).rejects.toMatchObject({ response: { code: 'GATEWAY_HEADER_POLICY_NOT_READY' } });
    expect(await snapshot()).toEqual(before);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('reports a committed history failure separately and never deploys that batch', async () => {
    await member('one'); await member('two');
    await db.query("CREATE TRIGGER fail_history BEFORE INSERT ON publication_profile_history WHEN NEW.endpointDefinitionId='one' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END");
    const result = await service.batchPublishRuntimeMemberships({ membershipIds: ['one', 'two'] });
    expect(result.items[0]).toMatchObject({ status: 'committed_side_effect_failed', committed: true, publicationRevision: 1 });
    expect(result.items[1].status).toBe('success');
    expect((await db.getRepository(Membership).findOneByOrFail({ id: 'one' })).publicationRevision).toBe(1);
    expect(result.deployment).toMatchObject({ status: 'blocked', attempted: false });
    expect(effects.startRuntimeAsset).not.toHaveBeenCalled();
  });

  it('does not refresh or deploy a no-op batch', async () => {
    await member('one');
    const result = await service.batchPublishRuntimeMemberships({ membershipIds: ['one'], publishToMcp: false });
    expect(result.deployment.attempted).toBe(false);
    expect(effects.startRuntimeAsset).not.toHaveBeenCalled();
    expect(effects.deployMcpRuntimeAsset).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    expect((await db.getRepository(Membership).findOneByOrFail({ id: 'one' })).publicationRevision).toBe(0);
  });
});
