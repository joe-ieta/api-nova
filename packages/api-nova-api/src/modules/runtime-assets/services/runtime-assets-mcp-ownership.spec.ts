import { RuntimeUpstreamBindingsService } from '../../runtime-upstream-bindings/services/runtime-upstream-bindings.service';
import * as reader from './mcp-ownership-reader';
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
  service.runtimeAssetRepository = { manager: {} };
  service.profileRepository = { findOne: jest.fn(async () => null) };
  service.publishBindingRepository = { findOne: jest.fn(async () => ({ publishedToMcp: true })) };
  jest.spyOn(reader, 'readMcpOwnership').mockImplementation(async () => structuredClone({
    asset: await service.requireRuntimeAsset(), rows: rows.data,
  }));
  service.findManagedServerSummary = jest.fn(async () => null);
  service.runtimeUpstreamBindingsService = { resolve: jest.fn(async () => ({ resolved: true, runtimeAssetEndpointBindingId: id(2), sourceServiceAssetId: id(4), instance: { id: id(5), sourceServiceAssetId: id(4) } })), buildBaseUrl: jest.fn(() => 'https://fixture.invalid') };
  return { service, rows };
}
describe('MCP assembly trusted ownership integration', () => {
  afterEach(() => jest.restoreAllMocks());
  it('passes trusted copied identities to the real transform and keeps legacy execution mode', async () => {
    const { service, rows } = fixture();
    const transform = jest.spyOn(server, 'transformOpenApiToMcpTools');
    service.runtimeUpstreamBindingsService.resolve.mockImplementation(async () => {
      rows.data[0].endpointDefinition.id = id(90); rows.data[0].endpointDefinition.path = '/changed';
      return { resolved: true, runtimeAssetEndpointBindingId: id(2), sourceServiceAssetId: id(4), instance: { id: id(5), sourceServiceAssetId: id(4) } };
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
    await expect(service.assembleMcpRuntimeAssetPayload(id(1))).rejects.toThrow(reason === 'offline' || reason.startsWith('missing-') ? 'INVALID_MCP_OPERATION_OWNERSHIP' : reason === 'runtime' ? 'INVALID_MCP_OPERATION_OWNERSHIP' : 'MCP_UPSTREAM_OWNERSHIP_MISMATCH');
    expect(transform).not.toHaveBeenCalled();
  });
  it('excludes disabled memberships using existing selection and emits no tools', async () => {
    const { service, rows } = fixture(); rows.data[0].membership.enabled = false;
    const result = await service.assembleMcpRuntimeAssetPayload(id(1));
    expect(result.tools).toEqual([]); expect(result.includedMembershipCount).toBe(0);
    expect(service.runtimeUpstreamBindingsService.resolve).not.toHaveBeenCalled();
  });
  it.each([
    [{ publishedToMcp: true, publishStatus: 'draft' }, 1],
    [{ publishedToMcp: false, publishStatus: 'active' }, 1],
    [{ publishedToMcp: false, publishStatus: 'draft' }, 0],
    [null, 0],
  ])('uses captured publication eligibility without separate repository reads: %j', async (publication, expected) => {
    const { service, rows } = fixture(); rows.data[0].publishBinding = publication;
    rows.data[0].profile = { intentName: 'captured intent', descriptionForLlm: 'captured description' };
    const result = await service.assembleMcpRuntimeAssetPayload(id(1));
    expect(result.includedMembershipCount).toBe(expected);
    expect(service.profileRepository.findOne).not.toHaveBeenCalled();
    expect(service.publishBindingRepository.findOne).not.toHaveBeenCalled();
    if (expected) {
      expect(result.openApiData.paths['/items'].get.summary).toBe('captured intent');
      expect(result.openApiData.paths['/items'].get.description).toBe('captured description');
    }
  });  it.each(['binding-membership', 'binding-source', 'instance-source', 'missing-binding-membership', 'missing-binding-source', 'missing-instance-source'])('rejects %s before URL construction or transform', async reason => {
    const { service } = fixture();
    const resolution: any = { resolved: true, runtimeAssetEndpointBindingId: id(2), sourceServiceAssetId: id(4), instance: { id: id(5), sourceServiceAssetId: id(4) } };
    if (reason === 'binding-membership') resolution.runtimeAssetEndpointBindingId = id(99);
    if (reason === 'binding-source') resolution.sourceServiceAssetId = id(99);
    if (reason === 'instance-source') resolution.instance.sourceServiceAssetId = id(99);
    if (reason === 'missing-binding-membership') delete resolution.runtimeAssetEndpointBindingId;
    if (reason === 'missing-binding-source') delete resolution.sourceServiceAssetId;
    if (reason === 'missing-instance-source') delete resolution.instance.sourceServiceAssetId;
    service.runtimeUpstreamBindingsService.resolve.mockResolvedValue(resolution);
    const transform = jest.spyOn(server, 'transformOpenApiToMcpTools');
    await expect(service.assembleMcpRuntimeAssetPayload(id(1))).rejects.toThrow('MCP_UPSTREAM_OWNERSHIP_MISMATCH');
    expect(service.runtimeUpstreamBindingsService.buildBaseUrl).not.toHaveBeenCalled();
    expect(transform).not.toHaveBeenCalled();
  });
  it.each([false, true])('uses real resolver output and rejects a later cross-source binding: drift=%s', async drift => {
    const { service } = fixture();
    const upstream: any = Object.create(RuntimeUpstreamBindingsService.prototype);
    const source = drift ? id(99) : id(4);
    upstream.bindingRepository = { findOne: jest.fn(async () => ({ id: id(7), runtimeAssetEndpointBindingId: id(2), sourceServiceAssetId: source,
      environment: 'test', status: 'active', selectionMode: 'fixed_primary', primaryInstanceId: id(5), revision: 2 })) };
    upstream.candidateRepository = { find: jest.fn(async () => [{ id: id(8), sourceServiceInstanceId: id(5), enabled: true }]) };
    upstream.sourceInstanceRepository = { find: jest.fn(async () => [{ id: id(5), sourceServiceAssetId: source, enabled: true, status: 'healthy',
      environment: 'test', scheme: 'https', host: 'fixture.invalid', port: 443, basePath: '/' }]) };
    const url = jest.spyOn(upstream, 'buildBaseUrl');
    service.runtimeUpstreamBindingsService = upstream;
    const transform = jest.spyOn(server, 'transformOpenApiToMcpTools');
    if (drift) {
      await expect(service.assembleMcpRuntimeAssetPayload(id(1))).rejects.toThrow('MCP_UPSTREAM_OWNERSHIP_MISMATCH');
      expect(url).not.toHaveBeenCalled(); expect(transform).not.toHaveBeenCalled();
    } else {
      expect((await service.assembleMcpRuntimeAssetPayload(id(1))).toolsCount).toBe(1);
      expect(url).toHaveBeenCalledTimes(1);
    }
    expect(upstream.bindingRepository.findOne).toHaveBeenCalledWith({ where: { runtimeAssetEndpointBindingId: id(2) } });
  });
});