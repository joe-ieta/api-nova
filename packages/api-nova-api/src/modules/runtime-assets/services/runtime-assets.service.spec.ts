import { ConflictException } from '@nestjs/common';
import { RuntimeAssetType } from '../../../database/entities/runtime-asset.entity';
import { ServerStatus } from '../../../database/entities/mcp-server.entity';
import { AuditAction } from '../../../database/entities/audit-log.entity';
import { RuntimeAssetsService } from './runtime-assets.service';

describe('RuntimeAssetsService', () => {
  const moduleRef = {
    get: jest.fn(),
  };
  const eventEmitter = {
    emit: jest.fn(),
  };
  const runtimeAssetRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
    manager: {
      transaction: jest.fn(),
    },
  };
  const mcpServerRepository = {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    manager: {
      transaction: jest.fn(),
    },
  };
  const runtimeBindingRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
    delete: jest.fn(),
  };
  const endpointDefinitionRepository = {
    findOne: jest.fn(),
  };
  const sourceServiceRepository = {
    findOne: jest.fn(),
  };
  const profileRepository = {
    findOne: jest.fn(),
    delete: jest.fn(),
  };
  const publishBindingRepository = {
    findOne: jest.fn(),
    delete: jest.fn(),
  };
  const gatewayRouteRepository = {
    findOne: jest.fn(),
    find: jest.fn(),
    delete: jest.fn(),
  };
  const gatewayConsumerCredentialRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
  };
  const publicationProfileHistoryRepository = {
    delete: jest.fn(),
  };
  const publicationAuditEventRepository = {
    delete: jest.fn(),
  };
  const publicationBatchRunRepository = {
    delete: jest.fn(),
  };
  const runtimeObservabilityStateRepository = {
    delete: jest.fn(),
  };
  const runtimeObservabilityEventRepository = {
    delete: jest.fn(),
  };
  const runtimeMetricSeriesRepository = {
    delete: jest.fn(),
  };
  const entityRepositoryMap = new Map<any, any>();
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
    getRuntimeAssetObservability: jest.fn(),
  };
  const auditService = {
    log: jest.fn().mockResolvedValue(undefined),
  };
  const runtimeUpstreamBindingsService = {
    resolve: jest.fn(),
    buildBaseUrl: jest.fn(),
  };
  const runtimeVerificationService = {
    planCandidate: jest.fn(),
    executeGatewayCandidate: jest.fn(),
    executeMcpCandidate: jest.fn(),
    activateMcpCandidate: jest.fn(),
  };
  const serverManager = {
    stopServer: jest.fn(),
    startServer: jest.fn(),
    deleteServer: jest.fn(),
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
    gatewayConsumerCredentialRepository as any,
    gatewayRuntimeMetricsService as any,
    gatewayAccessLogService as any,
    runtimeObservabilityService as any,
    auditService as any,
    runtimeUpstreamBindingsService as any,
    runtimeVerificationService as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    runtimeUpstreamBindingsService.resolve.mockResolvedValue({
      resolved: true,
      reason: 'resolved',
      instance: {
        id: 'instance-1',
        scheme: 'https',
        host: 'api.example.com',
        port: 443,
        basePath: '/base',
      },
    });
    runtimeUpstreamBindingsService.buildBaseUrl.mockReturnValue('https://api.example.com/base');
    entityRepositoryMap.clear();
    entityRepositoryMap
      .set(require('../../../database/entities/gateway-consumer-credential.entity').GatewayConsumerCredentialEntity, gatewayConsumerCredentialRepository)
      .set(require('../../../database/entities/endpoint-publish-binding.entity').EndpointPublishBindingEntity, publishBindingRepository)
      .set(require('../../../database/entities/gateway-route-binding.entity').GatewayRouteBindingEntity, gatewayRouteRepository)
      .set(require('../../../database/entities/publication-profile.entity').PublicationProfileEntity, profileRepository)
      .set(require('../../../database/entities/publication-profile-history.entity').PublicationProfileHistoryEntity, publicationProfileHistoryRepository)
      .set(require('../../../database/entities/publication-audit-event.entity').PublicationAuditEventEntity, publicationAuditEventRepository)
      .set(require('../../../database/entities/publication-batch-run.entity').PublicationBatchRunEntity, publicationBatchRunRepository)
      .set(require('../../../database/entities/runtime-observability-state.entity').RuntimeObservabilityStateEntity, runtimeObservabilityStateRepository)
      .set(require('../../../database/entities/runtime-observability-event.entity').RuntimeObservabilityEventEntity, runtimeObservabilityEventRepository)
      .set(require('../../../database/entities/runtime-metric-series.entity').RuntimeMetricSeriesEntity, runtimeMetricSeriesRepository)
      .set(require('../../../database/entities/runtime-asset-endpoint-binding.entity').RuntimeAssetEndpointBindingEntity, runtimeBindingRepository)
      .set(require('../../../database/entities/runtime-asset.entity').RuntimeAssetEntity, runtimeAssetRepository)
      .set(require('../../../database/entities/mcp-server.entity').MCPServerEntity, mcpServerRepository);
    runtimeAssetRepository.manager.transaction.mockImplementation(
      async (callback: (manager: { getRepository: (entity: any) => any }) => Promise<unknown>) =>
        callback({
          getRepository: (entity: any) => entityRepositoryMap.get(entity),
        }),
    );
    mcpServerRepository.manager.transaction.mockImplementation(
      async (callback: (manager: { getRepository: (entity: any) => any }) => Promise<unknown>) =>
        callback({
          getRepository: (entity: any) => entityRepositoryMap.get(entity),
        }),
    );
    runtimeAssetRepository.findOne.mockResolvedValue({
      id: 'runtime-gateway-1',
      type: RuntimeAssetType.GATEWAY_SERVICE,
      status: 'draft',
      name: 'orders-gateway',
      displayName: 'Orders Gateway',
      metadata: {},
    });
    runtimeAssetRepository.find.mockResolvedValue([
      {
        id: 'runtime-gateway-1',
        type: RuntimeAssetType.GATEWAY_SERVICE,
        status: 'draft',
        name: 'orders-gateway',
        displayName: 'Orders Gateway',
        metadata: {},
      },
    ]);
    runtimeAssetRepository.save.mockImplementation(async (value: unknown) => value);
    runtimeAssetRepository.delete.mockResolvedValue({ affected: 1 });
    runtimeBindingRepository.find.mockResolvedValue([]);
    runtimeBindingRepository.findOne.mockResolvedValue(null);
    runtimeBindingRepository.delete.mockResolvedValue({ affected: 1 });
    mcpServerRepository.find.mockResolvedValue([]);
    mcpServerRepository.create.mockImplementation((value: Record<string, unknown>) => ({
      id: 'managed-server-new',
      ...value,
    }));
    mcpServerRepository.save.mockImplementation(async (value: unknown) => value);
    runtimeObservabilityService.recordRuntimeControlEvent.mockResolvedValue(undefined);
    runtimeObservabilityService.getRuntimeAssetObservability.mockResolvedValue(null);
    eventEmitter.emit.mockReset();
    auditService.log.mockClear();
    gatewayConsumerCredentialRepository.find.mockResolvedValue([]);
    gatewayConsumerCredentialRepository.findOne.mockResolvedValue(null);
    gatewayConsumerCredentialRepository.create.mockImplementation(
      (value: Record<string, unknown>) => ({
        id: 'credential-1',
        ...value,
        createdAt: new Date('2026-04-21T00:00:00Z'),
        updatedAt: new Date('2026-04-21T00:00:00Z'),
      }),
    );
    gatewayConsumerCredentialRepository.save.mockImplementation(async (value: unknown) => value);
    gatewayConsumerCredentialRepository.delete.mockResolvedValue({ affected: 1 });
    gatewayRouteRepository.find.mockResolvedValue([]);
    gatewayRouteRepository.delete.mockResolvedValue({ affected: 1 });
    publishBindingRepository.delete.mockResolvedValue({ affected: 1 });
    profileRepository.delete.mockResolvedValue({ affected: 1 });
    publicationProfileHistoryRepository.delete.mockResolvedValue({ affected: 1 });
    publicationAuditEventRepository.delete.mockResolvedValue({ affected: 1 });
    publicationBatchRunRepository.delete.mockResolvedValue({ affected: 1 });
    runtimeObservabilityStateRepository.delete.mockResolvedValue({ affected: 1 });
    runtimeObservabilityEventRepository.delete.mockResolvedValue({ affected: 1 });
    runtimeMetricSeriesRepository.delete.mockResolvedValue({ affected: 1 });
    moduleRef.get.mockReturnValue(serverManager);
  });

  it('routes gateway start through verified deployment instead of activating directly', async () => {
    const deployResult = {
      runtimeAsset: { id: 'runtime-gateway-1', status: 'active' },
      runtimeSummary: { runtimeAssetId: 'runtime-gateway-1' },
      gatewayAssembly: { includedMembershipCount: 1 },
      verification: {
        run: { id: 'verification-1', candidateRevision: 'revision-1' },
      },
      action: 'deploy-gateway',
    };
    const deploySpy = jest
      .spyOn(service, 'deployGatewayRuntimeAsset')
      .mockResolvedValueOnce(deployResult as any);

    const result = await service.startRuntimeAsset('runtime-gateway-1');

    expect(deploySpy).toHaveBeenCalledWith('runtime-gateway-1', {}, {});
    expect(result).toEqual(
      expect.objectContaining({ action: 'start', verification: deployResult.verification }),
    );
    expect(runtimeObservabilityService.recordRuntimeControlEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'gateway.started',
        details: expect.objectContaining({ verificationRunId: 'verification-1' }),
      }),
    );
    deploySpy.mockRestore();
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

  it('creates gateway consumer credentials and returns the generated api key once', async () => {
    const result = await service.createGatewayConsumerCredential('runtime-gateway-1', {
      name: 'Orders integration',
      label: 'orders-ext',
    }, {
      actorId: 'user-1',
      ipAddress: '127.0.0.1',
      userAgent: 'jest',
    });

    expect(result.credential).toEqual(
      expect.objectContaining({
        id: 'credential-1',
        name: 'Orders integration',
        label: 'orders-ext',
        status: 'active',
      }),
    );
    expect(result.apiKey).toMatch(/^gk_[0-9a-f]+\.[A-Za-z0-9\-_]+$/);
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.API_KEY_CREATED,
        userId: 'user-1',
        resource: 'gateway_consumer_credential',
        ipAddress: '127.0.0.1',
      }),
    );
  });

  it('lists gateway consumer credentials scoped to one runtime asset', async () => {
    gatewayConsumerCredentialRepository.find.mockResolvedValue([
      {
        id: 'credential-1',
        name: 'Orders integration',
        keyId: 'gk_123',
        status: 'active',
        runtimeAssetId: 'runtime-gateway-1',
        createdAt: new Date('2026-04-21T00:00:00Z'),
        updatedAt: new Date('2026-04-21T00:00:00Z'),
      },
    ]);

    const result = await service.listGatewayConsumerCredentials('runtime-gateway-1');

    expect(result.total).toBe(1);
    expect(result.data[0]).toEqual(
      expect.objectContaining({
        id: 'credential-1',
        keyId: 'gk_123',
      }),
    );
  });

  it('revokes gateway consumer credentials', async () => {
    gatewayConsumerCredentialRepository.findOne.mockResolvedValue({
      id: 'credential-1',
      name: 'Orders integration',
      keyId: 'gk_123',
      status: 'active',
      runtimeAssetId: 'runtime-gateway-1',
      metadata: {},
      createdAt: new Date('2026-04-21T00:00:00Z'),
      updatedAt: new Date('2026-04-21T00:00:00Z'),
    });

    const result = await service.revokeGatewayConsumerCredential(
      'runtime-gateway-1',
      'credential-1',
      { reason: 'rotated' },
      {
        actorId: 'user-2',
        ipAddress: '127.0.0.2',
      },
    );

    expect(result).toEqual(
      expect.objectContaining({
        id: 'credential-1',
        status: 'revoked',
      }),
    );
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.API_KEY_DELETED,
        userId: 'user-2',
        resourceId: 'credential-1',
        ipAddress: '127.0.0.2',
      }),
    );
  });

  it('includes gateway governance summary in gateway assembly', async () => {
    runtimeBindingRepository.find.mockResolvedValue([
      {
        id: 'membership-1',
        runtimeAssetId: 'runtime-gateway-1',
        endpointDefinitionId: 'endpoint-1',
        status: 'active',
        enabled: true,
      },
    ]);
    endpointDefinitionRepository.findOne.mockResolvedValue({
      id: 'endpoint-1',
      sourceServiceAssetId: 'source-1',
    });
    sourceServiceRepository.findOne.mockResolvedValue({
      id: 'source-1',
      sourceKey: 'orders',
      scheme: 'https',
      host: 'api.example.com',
      port: 443,
      normalizedBasePath: '/base',
    });
    publishBindingRepository.findOne.mockResolvedValue({
      runtimeAssetEndpointBindingId: 'membership-1',
      publishedToHttp: true,
    });
    gatewayRouteRepository.findOne.mockResolvedValue({
      id: 'route-1',
      runtimeAssetEndpointBindingId: 'membership-1',
      matchHost: 'gateway.internal',
      routePath: '/orders',
      routeMethod: 'GET',
      upstreamPath: '/orders',
      upstreamMethod: 'GET',
      status: 'active',
      authPolicyRef: 'jwt-default',
      cachePolicyRef: 'cache-readonly',
      rateLimitPolicyRef: 'limit-standard',
      circuitBreakerPolicyRef: 'breaker-default',
      upstreamConfig: {},
    });
    gatewayRouteRepository.find.mockResolvedValue([
      {
        id: 'route-1',
        runtimeAssetEndpointBindingId: 'membership-1',
        matchHost: 'gateway.internal',
        routePath: '/orders',
        authPolicyRef: 'jwt-default',
        trafficPolicyRef: 'traffic-standard',
        loggingPolicyRef: 'body-preview',
        cachePolicyRef: 'cache-readonly',
        rateLimitPolicyRef: 'limit-standard',
        circuitBreakerPolicyRef: 'breaker-default',
        upstreamConfig: {},
      },
    ]);

    const result = await service.assembleGatewayRuntimeAssetPayload('runtime-gateway-1');

    expect(result.gatewayGovernance).toEqual(
      expect.objectContaining({
        totalRoutes: 1,
        accessUrls: expect.arrayContaining(['http://gateway.internal/orders']),
        cacheEnabledRoutes: 1,
        rateLimitedRoutes: 1,
        breakerProtectedRoutes: 1,
        authModes: {
          anonymous: 0,
          jwt: 1,
          apiKey: 0,
          oauth: 0,
        },
      }),
    );
    expect(result.runtimeSummary.gatewayGovernance).toEqual(
      expect.objectContaining({
        totalRoutes: 1,
        accessUrls: expect.arrayContaining(['http://gateway.internal/orders']),
      }),
    );
    expect(result.routes[0]).toEqual(
      expect.objectContaining({
        sourceServiceInstanceId: 'instance-1',
        upstreamBaseUrl: 'https://api.example.com/base',
      }),
    );
    expect(runtimeUpstreamBindingsService.resolve).toHaveBeenCalledWith('membership-1');
  });

  it('normalizes persisted gateway metrics into the runtime summary shape', async () => {
    runtimeBindingRepository.find.mockResolvedValue([]);
    runtimeObservabilityService.getRuntimeAssetObservability.mockResolvedValue({
      state: {
        currentStatus: 'active',
        healthStatus: 'healthy',
        lastEventAt: '2026-04-21T00:00:00Z',
        lastFailureAt: '2026-04-21T00:00:00Z',
        lastErrorMessage: 'Gateway rate limit exceeded',
        counters: {
          requestCount: 12,
          successCount: 10,
          errorCount: 2,
          'gateway.cache.hit': 4,
          'gateway.cache.miss': 3,
          'gateway.auth_rejected': 2,
        },
        gauges: {
          lastStatusCode: 429,
        },
      },
      recentEvents: [],
      recentMetrics: [
        {
          metricName: 'gateway.latency.avg_ms',
          value: 21.5,
        },
      ],
    });

    const result = await service.getRuntimeAssetObservability('runtime-gateway-1');

    expect(result.runtimeSummary.gatewayMetrics).toEqual(
      expect.objectContaining({
        requestCount: 12,
        successCount: 10,
        errorCount: 2,
        cacheHitCount: 4,
        cacheMissCount: 3,
        avgLatencyMs: 21.5,
        policyCounts: expect.objectContaining({
          'gateway.auth_rejected': 2,
        }),
      }),
    );
  });

  it('merges persisted observability into runtime asset list summaries', async () => {
    runtimeBindingRepository.find.mockResolvedValue([]);
    runtimeObservabilityService.getRuntimeAssetObservability.mockResolvedValue({
      state: {
        currentStatus: 'active',
        healthStatus: 'healthy',
        counters: {
          requestCount: 5,
          successCount: 4,
          errorCount: 1,
          'gateway.cache.hit': 2,
          'gateway.auth_rejected': 1,
        },
        gauges: {},
      },
      recentEvents: [],
      recentMetrics: [],
    });

    const result = await service.listRuntimeAssets();

    expect(result.data[0].runtimeSummary.gatewayMetrics).toEqual(
      expect.objectContaining({
        requestCount: 5,
        cacheHitCount: 2,
        policyCounts: expect.objectContaining({
          'gateway.auth_rejected': 1,
        }),
      }),
    );
  });

  it('treats stopping an already stopped MCP runtime asset as a successful no-op', async () => {
    runtimeAssetRepository.findOne.mockResolvedValue({
      id: 'runtime-mcp-1',
      type: RuntimeAssetType.MCP_SERVER,
      status: 'draft',
      name: 'orders-mcp',
      displayName: 'Orders MCP',
      metadata: {
        managedServerId: 'managed-server-1',
      },
    });
    mcpServerRepository.findOne.mockResolvedValue({
      id: 'managed-server-1',
      name: 'orders-mcp',
      status: ServerStatus.STOPPED,
      healthy: false,
      endpoint: 'http://localhost:9022/mcp',
      port: 9022,
      transport: 'streamable',
      toolsCount: 3,
      config: {
        runtimeAssetId: 'runtime-mcp-1',
      },
    });

    const result = await service.stopRuntimeAsset('runtime-mcp-1');

    expect(serverManager.stopServer).not.toHaveBeenCalled();
    expect(result.action).toBe('stop');
    expect(result.managedServer).toEqual(
      expect.objectContaining({
        id: 'managed-server-1',
        status: ServerStatus.STOPPED,
      }),
    );
  });

  it('treats already-stopped conflicts from the server manager as a successful stop', async () => {
    runtimeAssetRepository.findOne.mockResolvedValue({
      id: 'runtime-mcp-1',
      type: RuntimeAssetType.MCP_SERVER,
      status: 'draft',
      name: 'orders-mcp',
      displayName: 'Orders MCP',
      metadata: {
        managedServerId: 'managed-server-1',
      },
    });
    mcpServerRepository.findOne
      .mockResolvedValueOnce({
        id: 'managed-server-1',
        name: 'orders-mcp',
        status: ServerStatus.RUNNING,
        healthy: true,
        endpoint: 'http://localhost:9022/mcp',
        port: 9022,
        transport: 'streamable',
        toolsCount: 3,
        config: {
          runtimeAssetId: 'runtime-mcp-1',
        },
      })
      .mockResolvedValueOnce({
        id: 'managed-server-1',
        name: 'orders-mcp',
        status: ServerStatus.STOPPED,
        healthy: false,
        endpoint: 'http://localhost:9022/mcp',
        port: 9022,
        transport: 'streamable',
        toolsCount: 3,
        config: {
          runtimeAssetId: 'runtime-mcp-1',
        },
      });
    serverManager.stopServer.mockRejectedValueOnce(
      new ConflictException('Server is already stopped'),
    );

    const result = await service.stopRuntimeAsset('runtime-mcp-1');

    expect(serverManager.stopServer).toHaveBeenCalledWith('managed-server-1');
    expect(result.action).toBe('stop');
    expect(result.managedServer).toEqual(
      expect.objectContaining({
        id: 'managed-server-1',
      }),
    );
  });

  it('deletes a gateway runtime asset and refreshes the gateway snapshot', async () => {
    runtimeAssetRepository.findOne.mockResolvedValue({
      id: 'runtime-gateway-1',
      type: RuntimeAssetType.GATEWAY_SERVICE,
      status: 'draft',
      name: 'orders-gateway',
      displayName: 'Orders Gateway',
      metadata: {},
    });
    runtimeBindingRepository.find.mockResolvedValue([
      {
        id: 'binding-1',
        runtimeAssetId: 'runtime-gateway-1',
        endpointDefinitionId: 'endpoint-1',
      },
    ]);

    const result = await service.deleteRuntimeAsset('runtime-gateway-1');

    expect(serverManager.deleteServer).not.toHaveBeenCalled();
    expect(runtimeAssetRepository.delete).toHaveBeenCalledWith({ id: 'runtime-gateway-1' });
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'gateway.snapshot.refresh_requested',
      expect.objectContaining({
        reason: 'runtime_assets.gateway_deleted',
        runtimeAssetId: 'runtime-gateway-1',
      }),
    );
    expect(result).toEqual({
      runtimeAssetId: 'runtime-gateway-1',
      deleted: true,
    });
  });

  it('deletes the bound managed server before removing an MCP runtime asset', async () => {
    runtimeAssetRepository.findOne.mockResolvedValue({
      id: 'runtime-mcp-1',
      type: RuntimeAssetType.MCP_SERVER,
      status: 'draft',
      name: 'orders-mcp',
      displayName: 'Orders MCP',
      metadata: {
        managedServerId: 'managed-server-1',
      },
    });
    runtimeBindingRepository.find.mockResolvedValue([]);
    mcpServerRepository.findOne.mockResolvedValue({
      id: 'managed-server-1',
      name: 'orders-mcp',
      status: ServerStatus.STOPPED,
      config: {
        runtimeAssetId: 'runtime-mcp-1',
      },
    });

    await service.deleteRuntimeAsset('runtime-mcp-1');

    expect(serverManager.deleteServer).toHaveBeenCalledWith('managed-server-1');
    expect(runtimeAssetRepository.delete).toHaveBeenCalledWith({ id: 'runtime-mcp-1' });
  });

  it('blocks Gateway deployment before activation when verification prerequisites fail', async () => {
    const runtimeAsset = {
      id: 'runtime-gateway-verify',
      type: RuntimeAssetType.GATEWAY_SERVICE,
      status: 'draft',
      metadata: {},
    };
    jest.spyOn(service as any, 'requireRuntimeAsset').mockResolvedValue(runtimeAsset);
    jest.spyOn(service, 'assembleGatewayRuntimeAssetPayload').mockResolvedValue({
      includedMembershipCount: 1,
    } as any);
    runtimeVerificationService.planCandidate.mockResolvedValue({
      canExecute: false,
      run: {
        id: 'verification-blocked',
        blockers: [{ code: 'smoke_sample_missing' }],
      },
      results: [],
    });

    await expect(
      service.deployGatewayRuntimeAsset('runtime-gateway-verify'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'RUNTIME_VERIFICATION_BLOCKED' }),
    });
    expect(runtimeVerificationService.executeGatewayCandidate).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalledWith(
      'gateway.snapshot.refresh_requested',
      expect.anything(),
    );
  });

  it('keeps the public Gateway snapshot unchanged when candidate replay fails', async () => {
    const runtimeAsset = {
      id: 'runtime-gateway-verify',
      type: RuntimeAssetType.GATEWAY_SERVICE,
      status: 'active',
      metadata: { activeRevision: 'revision-1' },
    };
    jest.spyOn(service as any, 'requireRuntimeAsset').mockResolvedValue(runtimeAsset);
    jest.spyOn(service, 'assembleGatewayRuntimeAssetPayload').mockResolvedValue({
      includedMembershipCount: 1,
    } as any);
    runtimeVerificationService.planCandidate.mockResolvedValue({
      canExecute: true,
      run: { id: 'verification-failed' },
      results: [],
    });
    runtimeVerificationService.executeGatewayCandidate.mockResolvedValue({
      run: {
        id: 'verification-failed',
        status: 'failed',
        failedCount: 1,
        activationStatus: 'retained_previous',
        previousActiveRevision: 'revision-1',
      },
      results: [],
      activation: { activated: false, retainedPrevious: true },
    });

    await expect(
      service.deployGatewayRuntimeAsset('runtime-gateway-verify'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'RUNTIME_VERIFICATION_FAILED' }),
    });
    expect(eventEmitter.emit).not.toHaveBeenCalledWith(
      'gateway.snapshot.refresh_requested',
      expect.anything(),
    );
  });

  it('embeds only the per-operation credential reference in assembled MCP behavior', async () => {
    const mcpAsset = {
      id: 'runtime-mcp-credential',
      type: RuntimeAssetType.MCP_SERVER,
      status: 'draft',
      name: 'orders-mcp',
      displayName: 'Orders MCP',
      metadata: {},
    };
    const requireSpy = jest.spyOn(service as any, 'requireRuntimeAsset').mockResolvedValue(mcpAsset);
    const membershipSpy = jest.spyOn(service, 'listRuntimeAssetMemberships').mockResolvedValue({
      total: 1,
      data: [{
        membership: { id: 'membership-credential', enabled: true },
        endpointDefinition: {
          id: 'endpoint-credential',
          path: '/orders',
          method: 'POST',
          operationId: 'createOrder',
          rawOperation: { responses: { 200: { description: 'ok' } } },
        },
        sourceServiceAsset: { id: 'source-orders', displayName: 'Orders API' },
        profile: null,
        publishBinding: { publishedToMcp: true, publishStatus: 'active' },
      }],
    } as any);
    runtimeUpstreamBindingsService.resolve.mockResolvedValue({
      resolved: true,
      reason: 'resolved',
      instance: {
        id: 'instance-credential',
        scheme: 'https',
        host: 'orders.example',
        port: 443,
        basePath: '/',
        credentialRef: 'env-headers:Authorization=UPSTREAM_ORDER_TOKEN',
      },
    });
    runtimeUpstreamBindingsService.buildBaseUrl.mockReturnValue('https://orders.example');

    const assembled = await service.assembleMcpRuntimeAssetPayload(mcpAsset.id);

    expect((assembled.openApiData.paths['/orders'].post as any)['x-api-nova-credential-ref'])
      .toBe('env-headers:Authorization=UPSTREAM_ORDER_TOKEN');
    expect(JSON.stringify(assembled.openApiData)).not.toContain('upstream-secret');
    membershipSpy.mockRestore();
    requireSpy.mockRestore();
  });

  it('does not overwrite the managed MCP server when candidate replay fails', async () => {
    const mcpAsset = {
      id: 'runtime-mcp-verify',
      type: RuntimeAssetType.MCP_SERVER,
      status: 'active',
      name: 'orders-mcp',
      displayName: 'Orders MCP',
      metadata: { activeRevision: 'revision-1' },
    };
    const requireSpy = jest.spyOn(service as any, 'requireRuntimeAsset').mockResolvedValue(mcpAsset);
    const assembleSpy = jest.spyOn(service, 'assembleMcpRuntimeAssetPayload').mockResolvedValue({
      runtimeAsset: mcpAsset,
      openApiData: { openapi: '3.0.3' },
      tools: [{ name: 'createOrder' }],
      verificationTools: [{ runtimeMembershipId: 'membership-1', tool: { name: 'createOrder' } }],
      toolsCount: 1,
      includedMembershipCount: 1,
    } as any);
    mcpServerRepository.findOne.mockResolvedValue({
      id: 'managed-server-1',
      name: 'orders-mcp',
      port: 9022,
      transport: 'streamable',
      status: ServerStatus.RUNNING,
      tools: [{ name: 'oldTool' }],
      config: { runtimeAssetId: mcpAsset.id },
    });
    runtimeVerificationService.planCandidate.mockResolvedValue({
      canExecute: true,
      run: { id: 'verification-mcp-failed' },
      results: [],
    });
    runtimeVerificationService.executeMcpCandidate.mockResolvedValue({
      run: { id: 'verification-mcp-failed', status: 'failed' },
      results: [],
    });

    await expect(service.deployMcpRuntimeAsset(mcpAsset.id)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'RUNTIME_VERIFICATION_FAILED' }),
    });

    expect(mcpServerRepository.save).not.toHaveBeenCalled();
    expect(runtimeVerificationService.activateMcpCandidate).not.toHaveBeenCalled();
    assembleSpy.mockRestore();
    requireSpy.mockRestore();
  });

  it('persists and activates an MCP candidate only after replay passes', async () => {
    const mcpAsset = {
      id: 'runtime-mcp-verify',
      type: RuntimeAssetType.MCP_SERVER,
      status: 'draft',
      name: 'orders-mcp',
      displayName: 'Orders MCP',
      metadata: {},
    };
    const requireSpy = jest.spyOn(service as any, 'requireRuntimeAsset').mockResolvedValue(mcpAsset);
    const assembleSpy = jest.spyOn(service, 'assembleMcpRuntimeAssetPayload').mockResolvedValue({
      runtimeAsset: mcpAsset,
      openApiData: { openapi: '3.0.3' },
      tools: [{ name: 'createOrder' }],
      verificationTools: [{ runtimeMembershipId: 'membership-1', tool: { name: 'createOrder' } }],
      toolsCount: 1,
      includedMembershipCount: 1,
    } as any);
    mcpServerRepository.findOne.mockResolvedValue(null);
    runtimeVerificationService.planCandidate.mockResolvedValue({
      canExecute: true,
      run: { id: 'verification-mcp-passed' },
      results: [],
    });
    runtimeVerificationService.executeMcpCandidate.mockResolvedValue({
      run: { id: 'verification-mcp-passed', status: 'passed' },
      results: [],
    });
    runtimeVerificationService.activateMcpCandidate.mockResolvedValue({
      run: { id: 'verification-mcp-passed', activationStatus: 'activated' },
      runtimeAsset: mcpAsset,
    });

    const deployed = await service.deployMcpRuntimeAsset(mcpAsset.id, { port: 9033 });

    expect(runtimeVerificationService.executeMcpCandidate).toHaveBeenCalledWith(
      mcpAsset.id,
      'verification-mcp-passed',
      expect.arrayContaining([expect.objectContaining({ runtimeMembershipId: 'membership-1' })]),
    );
    expect(mcpServerRepository.save).toHaveBeenCalled();
    expect(runtimeVerificationService.activateMcpCandidate).toHaveBeenCalledWith(
      mcpAsset.id,
      'verification-mcp-passed',
      expect.objectContaining({ getRepository: expect.any(Function) }),
    );
    expect(deployed.verification.activation.run.activationStatus).toBe('activated');
    assembleSpy.mockRestore();
    requireSpy.mockRestore();
  });

});
