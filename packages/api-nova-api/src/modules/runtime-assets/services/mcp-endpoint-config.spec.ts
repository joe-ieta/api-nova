import { validate } from 'class-validator';
import { PATH_METADATA } from '@nestjs/common/constants';
import { DeployRuntimeAssetMcpDto } from '../dto/runtime-assets.dto';
import { RuntimeAssetsController } from '../runtime-assets.controller';
import { RuntimeAssetsService } from './runtime-assets.service';
import { previewMcpEndpoint, resolveMcpEndpoint } from './mcp-endpoint-config';
import { ServerStatus, TransportType } from '../../../database/entities/mcp-server.entity';
import { RuntimeAssetType } from '../../../database/entities/runtime-asset.entity';
const existing = (status = ServerStatus.STOPPED) => ({ id: 'server', name: 'asset', port: 9023,
  transport: TransportType.SSE, status, config: { runtimeAssetId: 'asset', endpoint: '/events/custom' } } as any);
describe('managed MCP endpoint contract', () => {
  it.each([{ transport: 'stdio' }, { transport: null }, { port: 9022.5 }, { port: '9022' }, { port: null },
    { port: 0 }, { endpointPath: null }, ...['/', '/health', '/health/check', '/a/', '/a//b', '/a?x=1',
      '/a#b', '/a%2fb', '/a.b', '/a b', 'http://host/mcp'].map(endpointPath => ({ endpointPath }))])
  ('rejects invalid DTO %j', async input => {
    expect((await validate(Object.assign(new DeployRuntimeAssetMcpDto(), input))).length).toBeGreaterThan(0);
  });
  it('preserves SSE and custom path while automatic port preview stays unknown', async () => {
    expect(await validate(Object.assign(new DeployRuntimeAssetMcpDto(), { port: 9022, endpointPath: '/team/mcp-v2' }))).toHaveLength(0);
    expect(resolveMcpEndpoint({}, existing())).toEqual({ port: 9023, transport: 'sse', endpointPath: '/events/custom' });
    expect(previewMcpEndpoint({})).toMatchObject({ port: null, portMode: 'automatic', consumerUrl: null, endpointPath: '/mcp' });
    expect(previewMcpEndpoint({}, existing())).toMatchObject({ consumerUrl: 'http://127.0.0.1:9023/events/custom',
      messagesUrl: 'http://127.0.0.1:9023/events/custom/messages', availability: 'not_checked' });
  });
  it.each([ServerStatus.RUNNING, ServerStatus.STARTING, ServerStatus.STOPPING])('protects lifecycle state %s', status => {
    expect(() => previewMcpEndpoint({}, existing(status))).not.toThrow();
    for (const change of [{ port: 9024 }, { transport: TransportType.STREAMABLE }, { endpointPath: '/other' }])
      expect(() => previewMcpEndpoint(change, existing(status))).toThrow('MCP_ENDPOINT_CHANGE_REQUIRES_STOP');
  });
  it('rejects malformed stored paths without silently defaulting', () => {
    expect(() => resolveMcpEndpoint({}, { ...existing(), config: { endpoint: '/health' } })).toThrow('INVALID_MCP_ENDPOINT_CONFIG');
  });
  it('preview checks named and explicit ownership without allocating ports', async () => {
    const service: any = Object.create(RuntimeAssetsService.prototype);
    service.requireRuntimeAsset = jest.fn().mockResolvedValue({ id: 'asset', name: 'asset', type: RuntimeAssetType.MCP_SERVER });
    service.mcpServerRepository = { findOne: jest.fn().mockResolvedValue(null) };
    service.findAvailableManagedServerPort = jest.fn();
    expect(await service.previewMcpRuntimeAssetEndpoint('asset', {})).toMatchObject({ port: null, consumerUrl: null });
    expect(service.findAvailableManagedServerPort).not.toHaveBeenCalled();
    service.mcpServerRepository.findOne.mockResolvedValue(existing());
    expect(await service.previewMcpRuntimeAssetEndpoint('asset', {})).toMatchObject({ transport: 'sse' });
    service.mcpServerRepository.findOne.mockResolvedValue({ ...existing(), config: { runtimeAssetId: 'other' } });
    await expect(service.previewMcpRuntimeAssetEndpoint('asset', {})).rejects.toThrow('MCP_SERVER_OWNERSHIP_CONFLICT');
    await expect(service.previewMcpRuntimeAssetEndpoint('asset', { targetServerId: 'server' })).rejects.toThrow('MCP_SERVER_OWNERSHIP_CONFLICT');
  });
  it('controller forwards preview to its separate read service', async () => {
    const service: any = { previewMcpRuntimeAssetEndpoint: jest.fn().mockResolvedValue({ port: null }) };
    const controller = new RuntimeAssetsController(service);
    expect(Reflect.getMetadata(PATH_METADATA, controller.previewMcpEndpoint)).toBe(':id/mcp-endpoint-preview');
    await controller.previewMcpEndpoint('asset', { endpointPath: '/custom' });
    expect(service.previewMcpRuntimeAssetEndpoint).toHaveBeenCalledWith('asset', { endpointPath: '/custom' });
  });
});
