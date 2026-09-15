import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { readMcpOwnership } from './mcp-ownership-reader';
import { RuntimeAssetEntity } from '../../../database/entities/runtime-asset.entity';
import { RuntimeAssetEndpointBindingEntity } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import { EndpointDefinitionEntity } from '../../../database/entities/endpoint-definition.entity';
import { SourceServiceAssetEntity } from '../../../database/entities/source-service-asset.entity';
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
describe('MCP ownership single SELECT with real SQL.js entities', () => {
  let db: DataSource;
  beforeEach(async () => {
    db = new DataSource({ type: 'sqljs', synchronize: true, entities: [RuntimeAssetEntity, RuntimeAssetEndpointBindingEntity, EndpointDefinitionEntity, SourceServiceAssetEntity] });
    await db.initialize();
    await db.getRepository(RuntimeAssetEntity).save({ id: id(1), name: 'mcp-test', type: 'mcp_server' as any });
    await db.getRepository(SourceServiceAssetEntity).save({ id: id(4), sourceKey: 'source-test' });
    await db.getRepository(EndpointDefinitionEntity).save({ id: id(3), sourceServiceAssetId: id(4), method: 'GET', path: '/items', rawOperation: { operationId: 'fixture' } });
    await db.getRepository(RuntimeAssetEndpointBindingEntity).save({ id: id(2), runtimeAssetId: id(1), endpointDefinitionId: id(3), enabled: true });
  });
  afterEach(async () => { await db.destroy(); });
  it('executes one statement and hydrates boolean/JSON values without secondary ID queries', async () => {
    const query = jest.spyOn(db.driver, 'createQueryRunner');
    const log = jest.spyOn(db.logger, 'logQuery');
    const result = await readMcpOwnership(db.manager, id(1));
    expect(result!.rows).toHaveLength(1);
    expect(result!.rows[0].membership.enabled).toBe(true);
    expect(result!.rows[0].endpointDefinition!.rawOperation).toEqual({ operationId: 'fixture' });
    expect(result!.rows[0].sourceServiceAsset!.id).toBe(id(4));
    expect(log.mock.calls.filter(([sql]) => /^SELECT /i.test(sql))).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it.each(['endpoint', 'source'])('preserves dangling %s rows for fail-closed validation', async removed => {
    await db.getRepository(removed === 'endpoint' ? EndpointDefinitionEntity : SourceServiceAssetEntity).delete(removed === 'endpoint' ? id(3) : id(4));
    const result = await readMcpOwnership(db.manager, id(1));
    expect(result!.rows).toHaveLength(1);
    expect(result!.rows[0].membership.id).toBe(id(2));
    expect(removed === 'endpoint' ? result!.rows[0].endpointDefinition : result!.rows[0].sourceServiceAsset).toBeNull();
  });
  it('distinguishes unknown runtime from an existing empty runtime', async () => {
    expect(await readMcpOwnership(db.manager, id(99))).toBeNull();
    await db.getRepository(RuntimeAssetEndpointBindingEntity).delete(id(2));
    expect((await readMcpOwnership(db.manager, id(1)))!.rows).toEqual([]);
  });
  it('excludes other runtime membership and captures later deletion only on the next read', async () => {
    await db.getRepository(RuntimeAssetEndpointBindingEntity).save({ id: id(6), runtimeAssetId: id(99), endpointDefinitionId: id(3) });
    const first = await readMcpOwnership(db.manager, id(1));
    await db.getRepository(SourceServiceAssetEntity).delete(id(4));
    expect(first!.rows).toHaveLength(1); expect(first!.rows[0].sourceServiceAsset!.id).toBe(id(4));
    expect((await readMcpOwnership(db.manager, id(1)))!.rows[0].sourceServiceAsset).toBeNull();
  });
  it('rejects the overflow sentinel rather than returning a truncated ownership view', async () => {
    const builder: any = {};
    for (const method of ['leftJoinAndMapMany', 'leftJoinAndMapOne', 'where', 'orderBy', 'addOrderBy', 'limit']) builder[method] = jest.fn(() => builder);
    builder.getOne = jest.fn(async () => ({ id: id(1), ownershipMemberships: new Array(10001) }));
    const create = jest.spyOn(db.manager, 'createQueryBuilder').mockReturnValue(builder);
    try {
      await expect(readMcpOwnership(db.manager, id(1))).rejects.toThrow('MCP_OWNERSHIP_READ_TOO_LARGE');
      expect(builder.limit).toHaveBeenCalledWith(10001);
      expect(builder.getOne).toHaveBeenCalledTimes(1);
    } finally { create.mockRestore(); }
  });});