import { from, of } from 'rxjs';
import axios from 'axios';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
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

  describe('binary response capture at the real HTTP test boundary', () => {
    const initialFlag = process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED;
    const initialLimit = process.env.ENDPOINT_TEST_SAMPLE_MAX_BYTES;

    afterEach(() => {
      if (initialFlag === undefined) delete process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED;
      else process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED = initialFlag;
      if (initialLimit === undefined) delete process.env.ENDPOINT_TEST_SAMPLE_MAX_BYTES;
      else process.env.ENDPOINT_TEST_SAMPLE_MAX_BYTES = initialLimit;
    });

    async function serve(body: Buffer, contentType: string, status = 200, extraHeaders = {}) {
      const server = createServer((_req, res) => {
        res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...extraHeaders });
        res.end(body);
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Loopback address unavailable');
      return {
        baseUrl: 'http://127.0.0.1:' + address.port,
        close: () => new Promise<void>(resolve => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
      };
    }

    function declaredBinaryEndpoint() {
      endpointDefinitionRepository.findOne.mockResolvedValue({
        ...endpointDefinition,
        rawOperation: { responses: { '200': { content: { 'image/png': {} } } } },
      });
      httpService.request.mockImplementation(config => from(axios.request(config)));
    }

    it('measures decoded non-UTF-8 bytes without placing them in JSON evidence', async () => {
      process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED = 'true';
      process.env.ENDPOINT_TEST_SAMPLE_MAX_BYTES = '32';
      declaredBinaryEndpoint();
      const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x80]);
      const compressed = gzipSync(original);
      const upstream = await serve(compressed, 'image/png; charset=binary', 200, { 'content-encoding': 'gzip' });
      sourceServiceInstancesService.buildBaseUrl.mockReturnValue(upstream.baseUrl);
      try {
        const result = await service.executeEndpointDefinitionTest('endpoint-1');
        expect(result.test.passed).toBe(true);
        expect(httpService.request.mock.calls[0][0].responseType).toBe('stream');
        expect(endpointTestingService.recordSuccessfulRun).toHaveBeenCalledWith(expect.objectContaining({
          responsePayload: {
            kind: 'binary', schemaVersion: 1, mediaType: 'image/png',
            measurement: 'decoded_response_body', observedBytes: original.length,
            isComplete: true, sha256: createHash('sha256').update(original).digest('hex'),
            captureState: 'metadata_only', declaredBytes: compressed.length,
          },
        }));
        const payload = endpointTestingService.recordSuccessfulRun.mock.calls[0][0].responsePayload;
        expect(JSON.stringify(payload)).not.toContain(original.toString('base64'));
      } finally { await upstream.close(); }
    });

    it('stops a binary stream at the configured bound without claiming a full hash', async () => {
      process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED = 'true';
      process.env.ENDPOINT_TEST_SAMPLE_MAX_BYTES = '4';
      declaredBinaryEndpoint();
      const upstream = await serve(Buffer.alloc(4096, 0xfa), 'application/octet-stream');
      sourceServiceInstancesService.buildBaseUrl.mockReturnValue(upstream.baseUrl);
      try {
        const result = await service.executeEndpointDefinitionTest('endpoint-1');
        expect(result.test.passed).toBe(true);
        expect(endpointTestingService.recordSuccessfulRun).toHaveBeenCalledWith(expect.objectContaining({
          responsePayload: expect.objectContaining({
            kind: 'binary', captureState: 'too_large', observedBytes: 5,
            isComplete: false, sha256: null,
          }),
        }));
      } finally { await upstream.close(); }
    });

    it('preserves JSON fallback and failed HTTP status when a declared binary endpoint responds with JSON', async () => {
      process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED = 'true';
      declaredBinaryEndpoint();
      const upstream = await serve(Buffer.from('{"error":"missing"}'), 'application/json', 404);
      sourceServiceInstancesService.buildBaseUrl.mockReturnValue(upstream.baseUrl);
      try {
        const result = await service.executeEndpointDefinitionTest('endpoint-1');
        expect(result.test.passed).toBe(false);
        expect(endpointTestingService.recordFailedRun).toHaveBeenCalledWith(expect.objectContaining({
          responseStatusCode: 404, responsePayload: { error: 'missing' },
        }));
      } finally { await upstream.close(); }
    });

    it('records a failed binary HTTP response as a bounded descriptor, never as a stream', async () => {
      process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED = 'true';
      declaredBinaryEndpoint();
      const upstream = await serve(Buffer.from([0xff, 0x00, 0xfe]), 'image/png', 500);
      sourceServiceInstancesService.buildBaseUrl.mockReturnValue(upstream.baseUrl);
      try {
        const result = await service.executeEndpointDefinitionTest('endpoint-1');
        expect(result.test.passed).toBe(false);
        expect(endpointTestingService.recordFailedRun).toHaveBeenCalledWith(expect.objectContaining({
          responseStatusCode: 500,
          responsePayload: expect.objectContaining({
            kind: 'binary', captureState: 'metadata_only', observedBytes: 3,
          }),
        }));
        expect(endpointTestingService.recordSuccessfulRun).not.toHaveBeenCalled();
      } finally { await upstream.close(); }
    });

    it('bounds unexpected text and stores only unavailable evidence when it exceeds the limit', async () => {
      process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED = 'true';
      process.env.ENDPOINT_TEST_SAMPLE_MAX_BYTES = '4';
      declaredBinaryEndpoint();
      const upstream = await serve(Buffer.alloc(4096, 0x61), 'text/plain');
      sourceServiceInstancesService.buildBaseUrl.mockReturnValue(upstream.baseUrl);
      try {
        const result = await service.executeEndpointDefinitionTest('endpoint-1');
        expect(result.test.passed).toBe(true);
        expect(endpointTestingService.recordSuccessfulRun).toHaveBeenCalledWith(expect.objectContaining({
          responsePayload: {
            captureState: 'unavailable', reason: 'non_binary_response_over_limit',
            mediaType: 'text/plain', observedBytes: 5, isComplete: false,
          },
        }));
      } finally { await upstream.close(); }
    });

    it.each([
      ['application/json', '{"ok":true}', { ok: true }],
      ['text/plain; charset=utf-8', 'plain response', 'plain response'],
    ])('preserves enabled-stream %s success payloads', async (contentType, body, expected) => {
      process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED = 'true';
      declaredBinaryEndpoint();
      const upstream = await serve(Buffer.from(body), contentType);
      sourceServiceInstancesService.buildBaseUrl.mockReturnValue(upstream.baseUrl);
      try {
        const result = await service.executeEndpointDefinitionTest('endpoint-1');
        expect(result.test.passed).toBe(true);
        expect(endpointTestingService.recordSuccessfulRun).toHaveBeenCalledWith(expect.objectContaining({
          responsePayload: expected,
        }));
      } finally { await upstream.close(); }
    });

    it.each([undefined, 'false'])('leaves %s binary capture disabled with legacy JSON request settings and payload', async flag => {
      if (flag === undefined) delete process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED;
      else process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED = flag;
      declaredBinaryEndpoint();
      const upstream = await serve(Buffer.from('{"ok":true}'), 'application/json');
      sourceServiceInstancesService.buildBaseUrl.mockReturnValue(upstream.baseUrl);
      try {
        const result = await service.executeEndpointDefinitionTest('endpoint-1');
        expect(result.test.passed).toBe(true);
        expect(httpService.request.mock.calls[0][0].responseType).toBeUndefined();
        expect(endpointTestingService.recordSuccessfulRun).toHaveBeenCalledWith(expect.objectContaining({
          responsePayload: { ok: true },
        }));
      } finally { await upstream.close(); }
    });

    it('does not reconstruct undeclared binary bytes after the default Axios decoding path', async () => {
      process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED = 'true';
      endpointDefinitionRepository.findOne.mockResolvedValue({ ...endpointDefinition, rawOperation: {} });
      httpService.request.mockImplementation(config => from(axios.request(config)));
      const upstream = await serve(Buffer.from([0x89, 0xff, 0x00, 0x50]), 'image/png');
      sourceServiceInstancesService.buildBaseUrl.mockReturnValue(upstream.baseUrl);
      try {
        const result = await service.executeEndpointDefinitionTest('endpoint-1');
        expect(result.test.passed).toBe(true);
        expect(httpService.request.mock.calls[0][0].responseType).toBeUndefined();
        expect(endpointTestingService.recordSuccessfulRun).toHaveBeenCalledWith(expect.objectContaining({
          responsePayload: {
            kind: 'binary', schemaVersion: 1, mediaType: 'image/png',
            measurement: 'decoded_response_body', observedBytes: null,
            isComplete: false, sha256: null, captureState: 'unavailable',
            declaredBytes: 4,
          },
        }));
      } finally { await upstream.close(); }
    });

    it('does not reconstruct original bytes from a JSON Buffer shape', async () => {
      process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED = 'true';
      endpointDefinitionRepository.findOne.mockResolvedValue({ ...endpointDefinition, rawOperation: {} });
      httpService.request.mockReturnValue(of({
        status: 200, headers: { 'content-type': 'image/png' }, data: { type: 'Buffer', data: [137, 80, 78, 71] },
      }));
      const result = await service.executeEndpointDefinitionTest('endpoint-1');
      expect(result.test.passed).toBe(true);
      expect(endpointTestingService.recordSuccessfulRun).toHaveBeenCalledWith(expect.objectContaining({
        responsePayload: expect.objectContaining({
          kind: 'binary', captureState: 'unavailable', observedBytes: null,
          isComplete: false, sha256: null,
        }),
      }));
    });
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
