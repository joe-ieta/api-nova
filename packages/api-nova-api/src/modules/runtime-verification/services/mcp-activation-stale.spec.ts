import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { RuntimeVerificationService } from './runtime-verification.service';
import { RuntimeAssetEntity } from '../../../database/entities/runtime-asset.entity';
import { RuntimeVerificationRunEntity } from '../../../database/entities/runtime-verification-run.entity';
import { RuntimeUpstreamBindingEntity } from '../../../database/entities/runtime-upstream-binding.entity';
import { MCPServerEntity } from '../../../database/entities/mcp-server.entity';
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
describe('MCP stale activation guard with SQL.js transaction rollback', () => {
  let db: DataSource, service: RuntimeVerificationService;
  beforeEach(async () => {
    db = new DataSource({ type: 'sqljs', synchronize: true, entities: [RuntimeAssetEntity, RuntimeVerificationRunEntity, RuntimeUpstreamBindingEntity, MCPServerEntity] });
    await db.initialize();
    await db.getRepository(RuntimeAssetEntity).save({ id: id(1), name: 'fixture', type: 'mcp_server' as any, metadata: { activeRevision: 'prior' } });
    await db.getRepository(MCPServerEntity).save({ id: id(2), name: 'server', openApiData: { original: true } });
    await db.getRepository(RuntimeUpstreamBindingEntity).save({ id: id(3), runtimeAssetEndpointBindingId: id(4), sourceServiceAssetId: id(5), environment: 'test', selectionMode: 'fixed_primary' as any, status: 'active' as any, revision: 1 });
    await db.getRepository(RuntimeVerificationRunEntity).save({ id: id(6), runtimeAssetId: id(1), candidateRevision: 'candidate', previousActiveRevision: 'prior', status: 'passed' as any, trigger: 'deploy' as any,
      upstreamBindingRevisions: [{ bindingId: id(3), runtimeMembershipId: id(4), revision: 1 }], createdAt: new Date('2026-09-15T00:00:00Z') });
    service = Object.create(RuntimeVerificationService.prototype);
    (service as any).runRepository = db.getRepository(RuntimeVerificationRunEntity);
    (service as any).runtimeAssetRepository = db.getRepository(RuntimeAssetEntity);
  });
  afterEach(async () => { await db.destroy(); });
  it.each(['revision', 'missing', 'membership', 'inactive', 'active-changed', 'invalidated', 'missing-invalidation-time', 'duplicate', 'invalid-revision', 'missing-list'])('rejects %s and rolls back preceding server writes', async reason => {
    if (reason === 'revision') await db.getRepository(RuntimeUpstreamBindingEntity).update(id(3), { revision: 2 });
    if (reason === 'missing') await db.getRepository(RuntimeUpstreamBindingEntity).delete(id(3));
    if (reason === 'membership') await db.getRepository(RuntimeUpstreamBindingEntity).update(id(3), { runtimeAssetEndpointBindingId: id(99) });
    if (reason === 'inactive') await db.getRepository(RuntimeUpstreamBindingEntity).update(id(3), { status: 'blocked' as any });
    if (reason === 'active-changed') await db.getRepository(RuntimeAssetEntity).update(id(1), { metadata: { activeRevision: 'newer' } });
    if (reason === 'invalidated') await db.getRepository(RuntimeAssetEntity).update(id(1), { metadata: { activeRevision: 'prior', verificationRequired: true, verificationRequiredAt: '2026-09-15T00:00:01Z' } });
    if (reason === 'missing-invalidation-time') await db.getRepository(RuntimeAssetEntity).update(id(1), { metadata: { activeRevision: 'prior', verificationRequired: true } });
    if (['duplicate', 'invalid-revision', 'missing-list'].includes(reason)) {
      const revisions: any = reason === 'missing-list' ? null : [{ bindingId: id(3), runtimeMembershipId: id(4), revision: reason === 'invalid-revision' ? 0 : 1 }];
      if (reason === 'duplicate') revisions.push({ ...revisions[0] });
      await db.getRepository(RuntimeVerificationRunEntity).update(id(6), { upstreamBindingRevisions: revisions });
    }
    const before = await db.getRepository(RuntimeAssetEntity).findOneByOrFail({ id: id(1) });
    await expect(db.transaction(async manager => {
      await manager.getRepository(MCPServerEntity).update(id(2), { openApiData: { candidate: true } as any });
      await service.activateMcpCandidate(id(1), id(6), manager);
    })).rejects.toThrow('MCP_CANDIDATE_STALE');
    expect((await db.getRepository(MCPServerEntity).findOneByOrFail({ id: id(2) })).openApiData).toEqual({ original: true });
    expect((await db.getRepository(RuntimeAssetEntity).findOneByOrFail({ id: id(1) })).metadata).toEqual(before.metadata);
    expect((await db.getRepository(RuntimeVerificationRunEntity).findOneByOrFail({ id: id(6) })).activationStatus).toBe('not_attempted');
  });
  it('applies the same guard without a caller manager', async () => {
    await db.getRepository(RuntimeUpstreamBindingEntity).update(id(3), { revision: 2 });
    await expect(service.activateMcpCandidate(id(1), id(6))).rejects.toThrow('MCP_CANDIDATE_STALE');
  });
  it('activates an unchanged candidate and preserves unrelated current metadata', async () => {
    await db.getRepository(RuntimeAssetEntity).update(id(1), { metadata: { activeRevision: 'prior', managedServerId: id(2), operatorNote: 'current' } });
    await db.transaction(manager => service.activateMcpCandidate(id(1), id(6), manager));
    const asset = await db.getRepository(RuntimeAssetEntity).findOneByOrFail({ id: id(1) });
    expect(asset.metadata).toMatchObject({ activeRevision: 'candidate', managedServerId: id(2), operatorNote: 'current' });
  });
});