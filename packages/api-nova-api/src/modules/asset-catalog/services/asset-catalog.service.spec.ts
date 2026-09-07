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

  const runtimeBindingRepository = { find: jest.fn(), delete: jest.fn() };
  const publishBindingRepository = { find: jest.fn(), delete: jest.fn() };
  const routeBindingRepository = { find: jest.fn(), save: jest.fn(), delete: jest.fn() };
  const profileRepository = { delete: jest.fn() };
  const profileHistoryRepository = { delete: jest.fn() };
  const publicationAuditRepository = { delete: jest.fn() };
  const upstreamRepository = { find: jest.fn(), delete: jest.fn() };
  const runtimeRepository = { find: jest.fn(), save: jest.fn() };
  const repositories: Record<string, any> = {
    EndpointDefinitionEntity: endpointDefinitionRepository,
    RuntimeAssetEndpointBindingEntity: runtimeBindingRepository,
    EndpointPublishBindingEntity: publishBindingRepository,
    GatewayRouteBindingEntity: routeBindingRepository,
    PublicationProfileEntity: profileRepository,
    PublicationProfileHistoryEntity: profileHistoryRepository,
    PublicationAuditEventEntity: publicationAuditRepository,
    RuntimeUpstreamBindingEntity: upstreamRepository,
    RuntimeAssetEntity: runtimeRepository,
  };
  const manager = { getRepository: (entity: any) => repositories[entity.name] };
  (endpointDefinitionRepository as any).delete = jest.fn();
  (endpointDefinitionRepository as any).manager = {
    ...manager,
    transaction: jest.fn(async callback => callback(manager)),
  };

  const service = new AssetCatalogService(
    sourceServiceRepository as any,
    endpointDefinitionRepository as any,
    runtimeBindingRepository as any,
    publishBindingRepository as any,
    routeBindingRepository as any,
    profileRepository as any,
    profileHistoryRepository as any,
    publicationAuditRepository as any,
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
    runtimeBindingRepository.find.mockResolvedValue([]);
    publishBindingRepository.find.mockResolvedValue([]);
    routeBindingRepository.find.mockResolvedValue([]);
    routeBindingRepository.save.mockImplementation(async value => value);
    runtimeRepository.find.mockResolvedValue([]);
    upstreamRepository.find.mockResolvedValue([]);
    endpointDefinitionRepository.count.mockResolvedValue(0);
    sourceServiceRepository.save.mockImplementation(async value => value);
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

  it('uses explicit path values and separates query, header and body inputs', async () => {
    endpointDefinitionRepository.findOne.mockResolvedValue({
      ...endpointDefinition, method: 'POST', path: '/orders/{id}',
      rawOperation: {
        parameters: [
          { name: 'id', in: 'path', schema: { type: 'string', example: 'wrong' } },
          { name: 'expand', in: 'query' }, { name: 'x-tenant', in: 'header' },
        ],
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
      },
    });
    httpService.request.mockReturnValue(of({ status: 200, data: {}, headers: {} }));
    await service.executeEndpointDefinitionTest('endpoint-1', {
      sourceServiceInstanceId: 'instance-1',
      parameters: { id: 'one/two', expand: false, 'x-tenant': 'tenant-1', body: { value: 42 } },
    });
    expect(httpService.request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://runtime.example.com/api/orders/one%2Ftwo',
      method: 'POST', params: { expand: false }, headers: { 'x-tenant': 'tenant-1' },
      data: { value: 42 },
    }));
    expect(endpointTestingService.recordSuccessfulRun).toHaveBeenCalledWith(
      expect.objectContaining({ sourceServiceInstanceId: 'instance-1' }),
    );
  });

  it('requires a real path sample instead of guessing a resource identifier', async () => {
    endpointDefinitionRepository.findOne.mockResolvedValue({
      ...endpointDefinition, path: '/orders/{id}', rawOperation: {},
    });
    await expect(service.executeEndpointDefinitionTest('endpoint-1'))
      .rejects.toThrow("Path parameter 'id' requires");
    expect(httpService.request).not.toHaveBeenCalled();
  });

  it('uses zero examples and substitutes legitimate parameters named path', async () => {
    endpointDefinitionRepository.findOne.mockResolvedValue({
      ...endpointDefinition, path: '/items/{path}',
      metadata: { source: 'manual-registration' },
      rawOperation: { parameters: [{ name: 'path', in: 'path', schema: { example: 0 } }] },
    });
    httpService.head.mockReturnValue(of({ status: 200 }));
    const result = await service.probeEndpointDefinition('endpoint-1');
    expect(httpService.head).toHaveBeenCalledWith(
      'https://runtime.example.com/api/items/0', expect.any(Object),
    );
    expect(result.endpoint.metadata.probeUrl).toBe('https://runtime.example.com/api/items/{path}');
  });

  it('requires path inputs in the persisted manual schema and rejects duplicate names', () => {
    const template = (service as any).buildManualOperationTemplate([
      { name: ' id ', in: 'path', required: false, schema: { type: 'integer', minimum: 1 } },
    ]);
    expect(template.parameters[0]).toMatchObject({
      name: 'id', required: true, schema: { type: 'integer', minimum: 1 },
    });
    expect(() => (service as any).buildManualOperationTemplate([
      { name: 'id', in: 'path' }, { name: 'id', in: 'query' },
    ])).toThrow('unique names');
  });

  it('preserves omitted templates and resets readiness on manual edits', async () => {
    const rawOperation = { parameters: [{ name: 'q', in: 'query' }],
      requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } };
    endpointDefinitionRepository.findOne.mockResolvedValue({
      ...endpointDefinition, rawOperation, metadata: {
        source: 'manual-registration', lastProbeStatus: 'healthy', testStatus: 'passed',
      },
    });
    await service.updateManualEndpointAssetRecord('endpoint-1', {
      name: 'Renamed', baseUrl: 'https://runtime.example.com/api', method: 'GET', path: '/orders',
    });
    expect(endpointDefinitionRepository.save).toHaveBeenCalledWith(expect.objectContaining({
      rawOperation, status: 'draft', publishEnabled: false,
      metadata: expect.objectContaining({ testStatus: 'untested', lastProbeStatus: undefined }),
    }));
  });

  it('persists explicit removal of a manual request template', async () => {
    endpointDefinitionRepository.findOne.mockResolvedValue({
      ...endpointDefinition, rawOperation: { parameters: [{ name: 'q', in: 'query' }], requestBody: {} },
      metadata: { source: 'manual-registration' },
    });
    await service.updateManualEndpointAssetRecord('endpoint-1', {
      name: 'Orders', baseUrl: 'https://runtime.example.com/api', method: 'GET', path: '/orders',
      parameters: [], requestBody: null,
    });
    expect(endpointDefinitionRepository.save).toHaveBeenCalledWith(expect.objectContaining({
      rawOperation: { parameters: [] },
    }));
  });

  it.each(['publication', 'route', 'membership'])('blocks deletion with an active %s', async kind => {
    endpointDefinitionRepository.findOne.mockResolvedValue({
      ...endpointDefinition, metadata: { source: 'manual-registration' },
    });
    ({ publication: publishBindingRepository, route: routeBindingRepository,
      membership: runtimeBindingRepository })[kind].find.mockResolvedValue([{ id: 'active-1' }]);
    await expect(service.deleteManualEndpointAssetRecord('endpoint-1')).rejects.toThrow('offline');
    expect((endpointDefinitionRepository as any).delete).not.toHaveBeenCalled();
  });

  it('deletes live associations transactionally while retaining publication evidence', async () => {
    endpointDefinitionRepository.findOne.mockResolvedValue({
      ...endpointDefinition, metadata: { source: 'manual-registration' },
    });
    runtimeBindingRepository.find.mockImplementation(async ({ where }) => where.status ? [] : [
      { id: 'membership-1', runtimeAssetId: 'runtime-1', endpointDefinitionId: 'endpoint-1' },
    ]);
    runtimeRepository.find.mockResolvedValue([{ id: 'runtime-1', metadata: {} }]);
    await service.deleteManualEndpointAssetRecord('endpoint-1');
    expect(upstreamRepository.delete).toHaveBeenCalledTimes(1);
    expect(runtimeBindingRepository.delete).toHaveBeenCalledWith({ endpointDefinitionId: 'endpoint-1' });
    expect(runtimeRepository.save).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ verificationRequired: true }),
    }));
    expect(profileHistoryRepository.delete).not.toHaveBeenCalled();
    expect(publicationAuditRepository.delete).not.toHaveBeenCalled();
    expect(sourceServiceRepository.delete).not.toHaveBeenCalled();
  });

  it('does not overwrite custom route paths when an endpoint path changes', async () => {
    const route = { id: 'route-1', routePath: '/public/orders', upstreamPath: '/orders',
      routeMethod: 'GET', upstreamMethod: 'GET', pathMatchMode: 'exact' };
    routeBindingRepository.find.mockImplementation(async ({ where }) => where.routePath ? [] : [route]);
    await (service as any).syncEndpointRouteBindings(
      { ...endpointDefinition, path: '/orders/{id}' }, endpointDefinition, manager,
    );
    expect(routeBindingRepository.save).toHaveBeenCalledWith(expect.objectContaining({
      routePath: '/public/orders', upstreamPath: '/orders/{id}', pathMatchMode: 'exact',
    }));
  });


  it('blocks mutation while an offlined membership still has a live verified gateway snapshot', async () => {
    endpointDefinitionRepository.findOne.mockResolvedValue({
      ...endpointDefinition, metadata: { source: 'manual-registration' },
    });
    runtimeBindingRepository.find.mockImplementation(async ({ where }) => where.status ? [] : [
      { id: 'membership-1', runtimeAssetId: 'runtime-1' },
    ]);
    runtimeRepository.find.mockResolvedValue([{
      id: 'runtime-1', type: 'gateway_service', status: 'active', metadata: { activeRevision: 'live' },
    }]);
    await expect(service.deleteManualEndpointAssetRecord('endpoint-1'))
      .rejects.toThrow('stop deployed runtimes');
  });
});
