import { RuntimeAssetType } from '../../../database/entities/runtime-asset.entity';
import { RuntimeAssetsService } from './runtime-assets.service';

describe('RuntimeAssetsService', () => {
  const moduleRef = {
    get: jest.fn(),
  };
  const eventEmitter = {
    emit: jest.fn(),
  };
  const runtimeAssetRepository = {
    findOne: jest.fn(),
    save: jest.fn(),
  };
  const mcpServerRepository = {
    findOne: jest.fn(),
    find: jest.fn(),
  };
  const runtimeBindingRepository = {
    find: jest.fn(),
  };
  const endpointDefinitionRepository = {
    findOne: jest.fn(),
  };
  const sourceServiceRepository = {
    findOne: jest.fn(),
  };
  const profileRepository = {
    findOne: jest.fn(),
  };
  const publishBindingRepository = {
    findOne: jest.fn(),
  };
  const gatewayRouteRepository = {
    findOne: jest.fn(),
  };
  const gatewayRuntimeMetricsService = {
    getRuntimeAssetMetrics: jest.fn().mockReturnValue({
      requestCount: 0,
      successCount: 0,
      errorCount: 0,
      routes: [],
    }),
  };
  const gatewayAccessLogService = {
    listRuntimeAssetLogs: jest.fn(),
  };
  const runtimeObservabilityService = {
    recordRuntimeControlEvent: jest.fn(),
  };

  const service = new RuntimeAssetsService(
    moduleRef as any,
    eventEmitter as any,
    runtimeAssetRepository as any,
    mcpServerRepository as any,
    runtimeBindingRepository as any,
    endpointDefinitionRepository as any,
    sourceServiceRepository as any,
    profileRepository as any,
    publishBindingRepository as any,
    gatewayRouteRepository as any,
    gatewayRuntimeMetricsService as any,
    gatewayAccessLogService as any,
    runtimeObservabilityService as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    runtimeAssetRepository.findOne.mockResolvedValue({
      id: 'runtime-gateway-1',
      type: RuntimeAssetType.GATEWAY_SERVICE,
      status: 'draft',
      name: 'orders-gateway',
      displayName: 'Orders Gateway',
      metadata: {},
    });
    runtimeAssetRepository.save.mockImplementation(async (value: unknown) => value);
    runtimeBindingRepository.find.mockResolvedValue([]);
    mcpServerRepository.find.mockResolvedValue([]);
    runtimeObservabilityService.recordRuntimeControlEvent.mockResolvedValue(undefined);
    eventEmitter.emit.mockReset();
  });

  it('emits gateway snapshot refresh when starting a gateway runtime asset', async () => {
    await service.startRuntimeAsset('runtime-gateway-1');

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'gateway.snapshot.refresh_requested',
      expect.objectContaining({
        reason: 'runtime_assets.gateway_started',
        runtimeAssetId: 'runtime-gateway-1',
      }),
    );
  });

  it('emits gateway snapshot refresh when stopping a gateway runtime asset', async () => {
    runtimeAssetRepository.findOne.mockResolvedValue({
      id: 'runtime-gateway-1',
      type: RuntimeAssetType.GATEWAY_SERVICE,
      status: 'active',
      name: 'orders-gateway',
      displayName: 'Orders Gateway',
      metadata: {},
    });

    await service.stopRuntimeAsset('runtime-gateway-1');

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'gateway.snapshot.refresh_requested',
      expect.objectContaining({
        reason: 'runtime_assets.gateway_stopped',
        runtimeAssetId: 'runtime-gateway-1',
      }),
    );
  });
});
