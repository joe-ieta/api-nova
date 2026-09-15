import { RuntimeAssetsService } from './runtime-assets.service';
import * as server from 'api-nova-server';
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
function fixture() {
  const rows: any = { total: 1, data: [{ membership: { id: id(2), runtimeAssetId: id(1), endpointDefinitionId: id(3), enabled: true, status: 'active' },
    endpointDefinition: { id: id(3), sourceServiceAssetId: id(4), method: 'GET', path: '/items', status: 'published', operationId: 'items', rawOperation: {
      'x-endpoint-definition-id': 'forged', 'x-source-service-asset-id': 'forged', responses: { '200': { description: 'ok' } },
    } }, sourceServiceAsset: { id: id(4) }, publishBinding: { publishedToMcp: true }, profile: null }] };
  const service: any = Object.create(RuntimeAssetsService.prototype);
  service.requireRuntimeAsset = jest.fn(async () => ({ id: id(1), type: 'mcp_server', name: 'fixture' }));
  service.listRuntimeAssetMemberships = jest.fn(async () => rows);
  service.findManagedServerSummary = jest.fn(async () => null);
  service.runtimeUpstreamBindingsService = { resolve: jest.fn(async () => ({ resolved: true, instance: { id: id(5) } })), buildBaseUrl: () => 'https://fixture.invalid' };
  return { service, rows };
}
describe('MCP assembly trusted ownership integration', () => {
  afterEach(() => jest.restoreAllMocks());
  it('passes trusted copied identities to the real transform and keeps legacy execution mode', async () => {
    const { service, rows } = fixture();
    const transform = jest.spyOn(server, 'transformOpenApiToMcpTools');
    service.runtimeUpstreamBindingsService.resolve.mockImplementation(async () => {
      rows.data[0].endpointDefinition.id = id(90); rows.data[0].endpointDefinition.path = '/changed';
      return { resolved: true, instance: { id: id(5) } };
    });
    const result = await service.assembleMcpRuntimeAssetPayload(id(1));
    expect(transform).toHaveBeenCalledTimes(1);
    expect(transform.mock.calls[0][8]).toEqual([{ method: 'GET', path: '/items', endpointDefinitionId: id(3), sourceServiceAssetId: id(4) }]);
    expect(transform.mock.calls[0][9]).toBeUndefined();
    expect(result.tools[0].metadata).toMatchObject({ method: 'GET', path: '/items' });
    expect(result.verificationTools[0].runtimeMembershipId).toBe(id(2));
    expect(result.openApiData.paths['/changed']).toBeUndefined();
  });
  it.each(['source', 'endpoint', 'runtime', 'missing-source', 'missing-endpoint', 'offline'])('rejects %s before transform', async reason => {
    const { service, rows } = fixture(), row = rows.data[0];
    if (reason === 'source') row.sourceServiceAsset.id = id(99);
    if (reason === 'endpoint') row.membership.endpointDefinitionId = id(99);
    if (reason === 'runtime') row.membership.runtimeAssetId = id(99);
    if (reason === 'missing-source') row.sourceServiceAsset = null;
    if (reason === 'missing-endpoint') row.endpointDefinition = null;
    if (reason === 'offline') row.endpointDefinition.status = 'offline';
    const transform = jest.spyOn(server, 'transformOpenApiToMcpTools');
    await expect(service.assembleMcpRuntimeAssetPayload(id(1))).rejects.toThrow('INVALID_MCP_OPERATION_OWNERSHIP');
    expect(transform).not.toHaveBeenCalled();
  });
  it('excludes disabled memberships using existing selection and emits no tools', async () => {
    const { service, rows } = fixture(); rows.data[0].membership.enabled = false;
    const result = await service.assembleMcpRuntimeAssetPayload(id(1));
    expect(result.tools).toEqual([]); expect(result.includedMembershipCount).toBe(0);
    expect(service.runtimeUpstreamBindingsService.resolve).not.toHaveBeenCalled();
  });
});