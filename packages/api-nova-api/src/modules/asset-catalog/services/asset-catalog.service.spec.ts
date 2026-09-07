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

  const service = new AssetCatalogService(
    sourceServiceRepository as any,
    endpointDefinitionRepository as any,
    httpService as any,
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
      'https://api.example.com/v1',
      expect.objectContaining({
        timeout: 8000,
      }),
    );
    expect(result.probe.status).toBe('healthy');
    expect(result.endpoint.status).toBe(EndpointDefinitionStatus.VERIFIED);
    expect(result.endpoint.publishEnabled).toBe(true);
    expect((result.endpoint.metadata || {}).probeScope).toBe('source_service');
  });
});
