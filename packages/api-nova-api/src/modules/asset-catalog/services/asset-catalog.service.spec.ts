import { of } from 'rxjs';
import {
  EndpointDefinitionEntity,
  EndpointDefinitionStatus,
} from '../../../database/entities/endpoint-definition.entity';
import { AssetCatalogService } from './asset-catalog.service';

describe('AssetCatalogService', () => {
  const sourceServiceRepository = {
    findOne: jest.fn(),
    find: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
  };
  const endpointDefinitionRepository = {
    findOne: jest.fn(),
    find: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    count: jest.fn(),
    remove: jest.fn(),
  };
  const httpService = {
    head: jest.fn(),
    get: jest.fn(),
    request: jest.fn(),
  };
  const endpointTestingService = {
    recordSuccessfulRun: jest.fn(),
    recordFailedRun: jest.fn(),
  };
  const sourceServiceInstancesService = {
    resolveForExecution: jest.fn(),
    buildBaseUrl: jest.fn(),
    ensureImportedInstance: jest.fn(),
    list: jest.fn(),
  };

  const service = new AssetCatalogService(
    sourceServiceRepository as any,
    endpointDefinitionRepository as any,
    httpService as any,
    endpointTestingService as any,
    sourceServiceInstancesService as any,
  );

  const sourceServiceAsset = {
    id: 'source-1',
    scheme: 'https',
    host: 'api.example.com',
    port: 443,
    normalizedBasePath: '/v1',
  };

  const endpointDefinition: EndpointDefinitionEntity = {
    id: 'endpoint-1',
    sourceServiceAssetId: 'source-1',
    method: 'GET',
    path: '/orders',
    status: EndpointDefinitionStatus.VERIFIED,
    publishEnabled: true,
    metadata: {
      source: 'document-import',
      lastProbeStatus: 'healthy',
      testStatus: 'passed',
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  } as EndpointDefinitionEntity;

  beforeEach(() => {
    jest.clearAllMocks();
    sourceServiceRepository.findOne.mockResolvedValue(sourceServiceAsset);
    endpointDefinitionRepository.findOne.mockResolvedValue({ ...endpointDefinition });
    endpointDefinitionRepository.save.mockImplementation(async (value: unknown) => value);
    sourceServiceInstancesService.resolveForExecution.mockResolvedValue({
      id: 'instance-1',
      sourceServiceAssetId: 'source-1',
    });
    sourceServiceInstancesService.buildBaseUrl.mockReturnValue('https://runtime.example.com/api');
    sourceServiceInstancesService.ensureImportedInstance.mockResolvedValue({ id: 'instance-imported' });
    sourceServiceInstancesService.list.mockResolvedValue({ total: 1, data: [
      { id: 'instance-1', scheme: 'https', host: 'runtime.example.com', port: 443, basePath: '/api' },
    ] });
  });

  it('returns governance readiness using the shared endpoint rules', async () => {
    const result = await service.getEndpointDefinitionReadiness('endpoint-1');

    expect(result).toEqual({
      endpointDefinitionId: 'endpoint-1',
      ready: true,
      reasons: [],
      checks: {
        testingPassed: true,
        lifecycleReady: true,
        probeReady: true,
        publishEnabledReady: true,
      },
    });
  });

  it('normalizes imported source-service probe 404 as healthy and promotes draft endpoint', async () => {
    endpointDefinitionRepository.findOne.mockResolvedValue({
      ...endpointDefinition,
      status: EndpointDefinitionStatus.DRAFT,
      publishEnabled: false,
      metadata: {
        source: 'document-import',
      },
    });
    httpService.head.mockReturnValue(of({ status: 404 }));
    httpService.get.mockReturnValue(of({ status: 404 }));

    const result = await service.probeEndpointDefinition('endpoint-1');

    expect(httpService.head).toHaveBeenCalledWith(
      'https://runtime.example.com/api',
      expect.objectContaining({
        timeout: 8000,
      }),
    );
    expect(sourceServiceInstancesService.resolveForExecution).toHaveBeenCalledWith('source-1');
    expect(result.probe.status).toBe('healthy');
    expect(result.endpoint.status).toBe(EndpointDefinitionStatus.VERIFIED);
    expect(result.endpoint.publishEnabled).toBe(true);
    expect((result.endpoint.metadata || {}).probeScope).toBe('source_service');
  });

  it('automatically records a durable sample for a successful endpoint test', async () => {
    httpService.request.mockReturnValue(
      of({ status: 200, data: { orderId: 'order-1' }, headers: { 'content-type': 'application/json' } }),
    );

    const result = await service.executeEndpointDefinitionTest('endpoint-1', {
      parameters: { customerId: 'customer-1' },
    });

    expect(result.test.passed).toBe(true);
    expect(endpointTestingService.recordSuccessfulRun).toHaveBeenCalledWith(
      expect.objectContaining({
        endpointDefinitionId: 'endpoint-1',
        sourceServiceInstanceId: 'instance-1',
        requestPayload: { customerId: 'customer-1' },
        responseStatusCode: 200,
        responsePayload: { orderId: 'order-1' },
      }),
    );
    expect(endpointTestingService.recordFailedRun).not.toHaveBeenCalled();
  });

  it('creates an imported runtime instance when a usable source URL is registered', async () => {
    sourceServiceRepository.findOne.mockResolvedValue(null);
    sourceServiceRepository.create.mockImplementation((value: Record<string, unknown>) => ({
      id: 'source-created',
      ...value,
    }));
    sourceServiceRepository.save.mockImplementation(async (value: unknown) => value);

    await (service as any).upsertSourceServiceAsset({
      scheme: 'https',
      host: 'orders.example.com',
      port: 443,
      normalizedBasePath: '/api',
      displayName: 'Orders',
      metadata: { source: 'document-import' },
    });

    expect(sourceServiceInstancesService.ensureImportedInstance).toHaveBeenCalledWith(
      'source-created',
      expect.objectContaining({
        scheme: 'https',
        host: 'orders.example.com',
        port: 443,
        basePath: '/api',
      }),
    );
  });
});
