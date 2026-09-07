import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Like, In, Repository } from 'typeorm';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import {
  EndpointDefinitionEntity,
  EndpointDefinitionStatus,
} from '../../../database/entities/endpoint-definition.entity';
import { SourceServiceAssetEntity } from '../../../database/entities/source-service-asset.entity';
import {
  EndpointPublishBindingEntity,
  PublicationBindingStatus,
} from '../../../database/entities/endpoint-publish-binding.entity';
import {
  GatewayRouteBindingEntity,
  GatewayRouteBindingStatus,
  GatewayRoutePathMatchMode,
} from '../../../database/entities/gateway-route-binding.entity';
import { PublicationAuditEventEntity } from '../../../database/entities/publication-audit-event.entity';
import { PublicationProfileEntity } from '../../../database/entities/publication-profile.entity';
import { PublicationProfileHistoryEntity } from '../../../database/entities/publication-profile-history.entity';
import { RuntimeAssetEndpointBindingEntity, RuntimeAssetEndpointBindingStatus } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import { RuntimeUpstreamBindingEntity } from '../../../database/entities/runtime-upstream-binding.entity';
import { RuntimeUpstreamBindingInstanceEntity } from '../../../database/entities/runtime-upstream-binding-instance.entity';
import { MCPServerEntity } from '../../../database/entities/mcp-server.entity';
import { RuntimeAssetEntity } from '../../../database/entities/runtime-asset.entity';
import {
  AssetCatalogQueryDto,
  ExecuteEndpointDefinitionTestDto,
  EndpointCatalogQueryDto,
  ManualEndpointParameterDto,
  ManualEndpointRequestBodyDto,
  RegisterManualEndpointAssetDto,
  UpdateEndpointDefinitionGovernanceDto,
  UpdateManualEndpointAssetDto,
} from '../dto/asset-catalog.dto';
import { evaluateEndpointGovernanceReadiness } from '../endpoint-readiness.policy';
import { EndpointTestingService } from '../../endpoint-testing/services/endpoint-testing.service';
import { SourceServiceInstancesService } from '../../source-service-instances/services/source-service-instances.service';

@Injectable()
export class AssetCatalogService {
  private readonly logger = new Logger(AssetCatalogService.name);

  constructor(
    @InjectRepository(SourceServiceAssetEntity)
    private readonly sourceServiceRepository: Repository<SourceServiceAssetEntity>,
    @InjectRepository(EndpointDefinitionEntity)
    private readonly endpointDefinitionRepository: Repository<EndpointDefinitionEntity>,
    @InjectRepository(RuntimeAssetEndpointBindingEntity)
    private readonly runtimeBindingRepository: Repository<RuntimeAssetEndpointBindingEntity>,
    @InjectRepository(EndpointPublishBindingEntity)
    private readonly publishBindingRepository: Repository<EndpointPublishBindingEntity>,
    @InjectRepository(GatewayRouteBindingEntity)
    private readonly routeBindingRepository: Repository<GatewayRouteBindingEntity>,
    @InjectRepository(PublicationProfileEntity)
    private readonly profileRepository: Repository<PublicationProfileEntity>,
    @InjectRepository(PublicationProfileHistoryEntity)
    private readonly profileHistoryRepository: Repository<PublicationProfileHistoryEntity>,
    @InjectRepository(PublicationAuditEventEntity)
    private readonly publicationAuditRepository: Repository<PublicationAuditEventEntity>,
    private readonly httpService: HttpService,
    private readonly endpointTestingService: EndpointTestingService,
    private readonly sourceServiceInstancesService: SourceServiceInstancesService,
  ) {}

  normalizeSourceKey(input: {
    scheme: string;
    host: string;
    port: number;
    normalizedBasePath: string;
  }) {
    const scheme = String(input.scheme || '').toLowerCase();
    const host = String(input.host || '').toLowerCase();
    const port = Number(input.port || 0);
    const normalizedBasePath = this.normalizeBasePath(input.normalizedBasePath);
    return `${scheme}://${host}:${port}${normalizedBasePath}`;
  }

  normalizeBasePath(basePath?: string) {
    const value = String(basePath || '/').trim() || '/';
    const withLeadingSlash = value.startsWith('/') ? value : `/${value}`;
    return withLeadingSlash.length > 1
      ? withLeadingSlash.replace(/\/+$/, '')
      : withLeadingSlash;
  }

  async listSourceServiceAssets(query: AssetCatalogQueryDto = {}) {
    const where: Record<string, unknown> = {};
    if (query.sourceKey) {
      where.sourceKey = Like(`%${query.sourceKey}%`);
    }
    if (query.host) {
      where.sourceKey = Like(`%${query.host.toLowerCase()}%`);
    }

    const assets = await this.sourceServiceRepository.find({
      where,
      order: {
        updatedAt: 'DESC',
      },
    });
    const runtimeAwareAssets = await Promise.all(
      assets.map(asset => this.buildSourceAssetRuntimeView(asset)),
    );

    return {
      total: runtimeAwareAssets.length,
      data: runtimeAwareAssets,
    };
  }

  async getSourceServiceAssetDetail(id: string) {
    const asset = await this.sourceServiceRepository.findOne({ where: { id } });
    if (!asset) {
      throw new NotFoundException(`Source service asset '${id}' not found`);
    }

    const endpoints = await this.endpointDefinitionRepository.find({
      where: { sourceServiceAssetId: id },
      order: {
        method: 'ASC',
        path: 'ASC',
      },
    });

    return {
      asset: await this.buildSourceAssetRuntimeView(asset),
      endpoints,
      endpointCount: endpoints.length,
    };
  }

  async listEndpointDefinitions(query: EndpointCatalogQueryDto = {}) {
    const where: Record<string, unknown> = {};
    if (query.sourceServiceAssetId) {
      where.sourceServiceAssetId = query.sourceServiceAssetId;
    }
    if (query.status) {
      where.status = query.status;
    }

    const endpoints = await this.endpointDefinitionRepository.find({
      where,
      order: {
        updatedAt: 'DESC',
      },
    });

    const filtered = query.search
      ? endpoints.filter(endpoint => {
          const search = query.search!.toLowerCase();
          return [
            endpoint.method,
            endpoint.path,
            endpoint.summary,
            endpoint.operationId,
          ]
            .filter(Boolean)
            .some(value => String(value).toLowerCase().includes(search));
        })
      : endpoints;

    return {
      total: filtered.length,
      data: filtered,
    };
  }

  async getEndpointDefinitionDetail(id: string) {
    const endpoint = await this.endpointDefinitionRepository.findOne({ where: { id } });
    if (!endpoint) {
      throw new NotFoundException(`Endpoint definition '${id}' not found`);
    }

    const sourceServiceAsset = await this.sourceServiceRepository.findOne({
      where: { id: endpoint.sourceServiceAssetId },
    });

    const instanceResult = sourceServiceAsset
      ? await this.sourceServiceInstancesService.list(sourceServiceAsset.id, { enabled: true })
      : { data: [] };

    return {
      endpoint,
      sourceServiceAsset,
      sourceServiceInstance: instanceResult.data[0] || null,
    };
  }

  async updateEndpointDefinitionGovernance(
    id: string,
    input: UpdateEndpointDefinitionGovernanceDto,
  ) {
    const endpoint = await this.endpointDefinitionRepository.findOne({ where: { id } });
    if (!endpoint) {
      throw new NotFoundException(`Endpoint definition '${id}' not found`);
    }

    if (input.status) {
      endpoint.status = input.status;
    }
    if (typeof input.publishEnabled === 'boolean') {
      endpoint.publishEnabled = input.publishEnabled;
    }
    if (input.summary !== undefined) {
      endpoint.summary = input.summary;
    }
    if (input.description !== undefined) {
      endpoint.description = input.description;
    }
    if (input.metadata) {
      endpoint.metadata = {
        ...(endpoint.metadata || {}),
        ...input.metadata,
      };
    }

    const saved = await this.endpointDefinitionRepository.save(endpoint);
    const sourceServiceAsset = await this.sourceServiceRepository.findOne({
      where: { id: saved.sourceServiceAssetId },
    });

    return {
      endpoint: saved,
      sourceServiceAsset,
    };
  }

  async probeEndpointDefinition(id: string) {
    const detail = await this.getEndpointDefinitionDetail(id);
    const endpoint = detail.endpoint;
    const sourceServiceAsset = detail.sourceServiceAsset;
    if (!sourceServiceAsset) {
      throw new NotFoundException(`Source service asset '${endpoint.sourceServiceAssetId}' not found`);
    }

    const sourceServiceInstance = await this.sourceServiceInstancesService.resolveForExecution(
      sourceServiceAsset.id,
    );
    const metadata = (endpoint.metadata || {}) as Record<string, unknown>;
    const sourceType = this.inferSourceType(endpoint);
    const runtimeBaseUrl = this.sourceServiceInstancesService.buildBaseUrl(sourceServiceInstance);
    const defaultProbeUrl =
      sourceType === 'imported'
        ? runtimeBaseUrl
        : `${runtimeBaseUrl.replace(/\/+$/, '')}${endpoint.path}`;
    const rawProbeUrl =
      typeof metadata.probeUrl === 'string' && metadata.probeUrl
        ? metadata.probeUrl
        : defaultProbeUrl;
    const probeUrl = this.substitutePathParameters(rawProbeUrl, endpoint);
    if (!probeUrl) {
      throw new BadRequestException(`Probe URL cannot be resolved for endpoint '${id}'`);
    }

    const rawResult = await this.runProbe(probeUrl);
    const result =
      sourceType === 'imported'
        ? this.normalizeSourceServiceProbeResult(rawResult)
        : rawResult;
    endpoint.metadata = {
      ...(endpoint.metadata || {}),
      lastProbeStatus: result.status,
      lastProbeAt: new Date().toISOString(),
      lastProbeError: result.errorMessage,
      lastProbeHttpStatus: result.httpStatus,
      probeUrl: rawProbeUrl,
      probeScope: sourceType === 'imported' ? 'source_service' : 'endpoint',
    };

    if (result.status === 'healthy') {
      if (
        endpoint.status === EndpointDefinitionStatus.DRAFT ||
        endpoint.status === EndpointDefinitionStatus.DEGRADED
      ) {
        endpoint.status = EndpointDefinitionStatus.VERIFIED;
      }
      endpoint.publishEnabled = true;
    } else if (endpoint.status === EndpointDefinitionStatus.PUBLISHED) {
      endpoint.status = EndpointDefinitionStatus.DEGRADED;
    }

    const saved = await this.endpointDefinitionRepository.save(endpoint);
    return {
      endpoint: saved,
      sourceServiceAsset,
      probe: result,
    };
  }

  async getEndpointDefinitionReadiness(id: string) {
    const detail = await this.getEndpointDefinitionDetail(id);
    const readiness = evaluateEndpointGovernanceReadiness(detail.endpoint);

    return {
      endpointDefinitionId: detail.endpoint.id,
      ready: readiness.ready,
      reasons: readiness.reasons,
      checks: readiness.checks,
    };
  }

  async getEndpointDefinitionTestingState(id: string) {
    const detail = await this.getEndpointDefinitionDetail(id);
    return this.buildTestingState(detail.endpoint);
  }

  async executeEndpointDefinitionTest(
    id: string,
    input: ExecuteEndpointDefinitionTestDto = {},
  ) {
    const detail = await this.getEndpointDefinitionDetail(id);
    const endpoint = detail.endpoint;
    const sourceServiceAsset = detail.sourceServiceAsset;
    if (!sourceServiceAsset) {
      throw new NotFoundException(`Source service asset '${endpoint.sourceServiceAssetId}' not found`);
    }

    const sourceServiceInstance = await this.sourceServiceInstancesService.resolveForExecution(
      sourceServiceAsset.id,
      { instanceId: input.sourceServiceInstanceId, environment: input.environment },
    );
    const parameters =
      input.parameters && typeof input.parameters === 'object' ? input.parameters : {};
    const rawTestUrl = `${this.sourceServiceInstancesService.buildBaseUrl(sourceServiceInstance).replace(/\/+$/, '')}${endpoint.path}`;
    const testUrl = this.substitutePathParameters(rawTestUrl, endpoint, parameters);
    const method = String(endpoint.method || 'GET').toUpperCase();
    const request = this.buildEndpointTestRequest(endpoint, parameters);
    const startedAt = Date.now();

    try {
      const response = await firstValueFrom(
        this.httpService.request({
          url: testUrl,
          method: method as any,
          timeout: 12000,
          validateStatus: () => true,
          ...request,
        }),
      );

      const passed = response.status >= 200 && response.status < 400;
      endpoint.metadata = this.mergeTestingMetadata(endpoint, {
        testStatus: passed ? 'passed' : 'failed',
        qualificationState: passed ? 'tested' : 'test_blocked',
        lastTestAt: new Date().toISOString(),
        lastTestMethod: method,
        lastTestUrl: testUrl,
        lastTestHttpStatus: response.status,
        lastTestDurationMs: Date.now() - startedAt,
        lastTestError: passed ? undefined : `HTTP ${response.status}`,
      });
      await this.endpointDefinitionRepository.save(endpoint);

      const durationMs = Date.now() - startedAt;
      if (passed) {
        await this.endpointTestingService.recordSuccessfulRun({
          endpointDefinitionId: endpoint.id,
          sourceServiceInstanceId: sourceServiceInstance.id,
          requestPayload: parameters,
          responseStatusCode: response.status,
          responseHeaders:
            typeof response.headers?.toJSON === 'function'
              ? response.headers.toJSON()
              : { ...(response.headers || {}) },
          responsePayload: response.data,
          durationMs,
          metadata: { method, url: testUrl, origin: 'asset-catalog-endpoint-test' },
        });
      } else {
        await this.endpointTestingService.recordFailedRun({
          endpointDefinitionId: endpoint.id,
          sourceServiceInstanceId: sourceServiceInstance.id,
          requestPayload: parameters,
          responseStatusCode: response.status,
          responsePayload: response.data,
          durationMs,
          errorMessage: `HTTP ${response.status}`,
          metadata: { method, url: testUrl, origin: 'asset-catalog-endpoint-test' },
        });
      }

      return {
        endpointDefinitionId: endpoint.id,
        test: {
          passed,
          httpStatus: response.status,
          durationMs: Date.now() - startedAt,
          method,
          url: testUrl,
        },
        testingState: this.buildTestingState(endpoint),
      };
    } catch (error) {
      const axiosErr = error as AxiosError;
      endpoint.metadata = this.mergeTestingMetadata(endpoint, {
        testStatus: 'failed',
        qualificationState: 'test_blocked',
        lastTestAt: new Date().toISOString(),
        lastTestMethod: method,
        lastTestUrl: testUrl,
        lastTestHttpStatus: axiosErr.response?.status,
        lastTestDurationMs: Date.now() - startedAt,
        lastTestError:
          axiosErr.response?.status != null
            ? `HTTP ${axiosErr.response.status}`
            : axiosErr.message || 'Test request failed',
      });
      await this.endpointDefinitionRepository.save(endpoint);

      await this.endpointTestingService.recordFailedRun({
        endpointDefinitionId: endpoint.id,
        sourceServiceInstanceId: sourceServiceInstance.id,
        requestPayload: parameters,
        responseStatusCode: axiosErr.response?.status,
        responsePayload: axiosErr.response?.data,
        durationMs: Date.now() - startedAt,
        errorMessage:
          axiosErr.response?.status != null
            ? `HTTP ${axiosErr.response.status}`
            : axiosErr.message || 'Test request failed',
        metadata: { method, url: testUrl, origin: 'asset-catalog-endpoint-test' },
      });

      return {
        endpointDefinitionId: endpoint.id,
        test: {
          passed: false,
          httpStatus: axiosErr.response?.status,
          durationMs: Date.now() - startedAt,
          method,
          url: testUrl,
          errorMessage:
            axiosErr.response?.status != null
              ? `HTTP ${axiosErr.response.status}`
              : axiosErr.message || 'Test request failed',
        },
        testingState: this.buildTestingState(endpoint),
      };
    }
  }

  async registerManualEndpointAssetRecord(input: RegisterManualEndpointAssetDto) {
    const result = await this.registerManualEndpointAsset({
      name: input.name,
      baseUrl: input.baseUrl,
      method: input.method,
      path: input.path,
      description: input.description,
      parameters: input.parameters,
      requestBody: input.requestBody,
      metadata: {
        source: 'manual-registration',
        businessDomain: input.businessDomain,
        riskLevel: input.riskLevel,
      },
    });

    return this.buildEndpointAssetRecord(result.endpoint.id);
  }

  async updateManualEndpointAssetRecord(id: string, input: UpdateManualEndpointAssetDto) {
    const endpoint = await this.requireEndpointDefinition(id);
    this.ensureManualEndpoint(endpoint);
    await this.ensureManualEndpointMutatable(endpoint);
    const previousEndpoint = { ...endpoint };
    const previousSourceServiceAssetId = endpoint.sourceServiceAssetId;

    const parsed = new URL(input.baseUrl);
    const sourceServiceAsset = await this.upsertSourceServiceAsset({
      scheme: parsed.protocol.replace(':', ''),
      host: parsed.hostname,
      port: this.resolvePort(parsed),
      normalizedBasePath: this.normalizeBasePath(parsed.pathname || '/'),
      displayName: input.name,
      description: input.description,
      metadata: {
        source: 'manual-registration',
        baseUrl: input.baseUrl,
        businessDomain: input.businessDomain,
        riskLevel: input.riskLevel,
      },
    });

    endpoint.sourceServiceAssetId = sourceServiceAsset.id;
    endpoint.method = input.method.toUpperCase();
    endpoint.path = this.normalizeBasePath(input.path);
    endpoint.summary = input.description || `${input.method.toUpperCase()} ${input.path}`;
    endpoint.description = input.description;
    const template = { ...(endpoint.rawOperation || {}) };
    const changes = this.buildManualOperationTemplate(input.parameters, input.requestBody);
    if (input.parameters !== undefined) template.parameters = changes.parameters || [];
    if (input.requestBody !== undefined) {
      if (changes.requestBody) template.requestBody = changes.requestBody;
      else delete template.requestBody;
    }
    endpoint.rawOperation = template;
    endpoint.status = EndpointDefinitionStatus.DRAFT;
    endpoint.publishEnabled = false;
    endpoint.metadata = {
      ...(endpoint.metadata || {}),
      source: 'manual-registration',
      businessDomain: input.businessDomain,
      riskLevel: input.riskLevel,
      displayName: input.name,
      baseUrl: input.baseUrl,
      probeUrl: `${input.baseUrl.replace(/\/+$/, '')}${this.normalizeBasePath(input.path)}`,
      lastProbeStatus: undefined,
      lastProbeAt: undefined,
      lastProbeHttpStatus: undefined,
      lastProbeError: undefined,
      testStatus: 'untested',
      qualificationState: 'registered',
      lastTestAt: undefined,
      lastTestMethod: undefined,
      lastTestUrl: undefined,
      lastTestHttpStatus: undefined,
      lastTestDurationMs: undefined,
      lastTestError: undefined,
    };

    await this.endpointDefinitionRepository.manager.transaction(async manager => {
      await this.ensureManualEndpointMutatable(previousEndpoint, manager);
      await this.syncEndpointRouteBindings(endpoint, previousEndpoint, manager);
      await manager.getRepository(EndpointDefinitionEntity).save(endpoint);
    });
    await this.cleanupOrphanSourceServiceAsset(previousSourceServiceAssetId);
    return this.buildEndpointAssetRecord(endpoint.id);
  }

  async deleteManualEndpointAssetRecord(id: string) {
    const endpoint = await this.requireEndpointDefinition(id);
    this.ensureManualEndpoint(endpoint);
    await this.ensureManualEndpointRemovable(endpoint);
    const sourceServiceAssetId = endpoint.sourceServiceAssetId;
    await this.cascadeDeleteEndpointRecord(endpoint);
    await this.cleanupOrphanSourceServiceAsset(sourceServiceAssetId);

    return {
      success: true,
      endpointId: id,
      deletedBindings: true,
    };
  }

  async findSourceServiceAssetForSpec(spec: any, metadata?: Record<string, any>) {
    const descriptor = this.resolveSourceDescriptor(spec, metadata);
    const sourceKey = this.normalizeSourceKey(descriptor);
    return this.sourceServiceRepository.findOne({
      where: { sourceKey },
    });
  }

  async countEndpointsBySourceServiceAssetId(sourceServiceAssetId: string) {
    return this.endpointDefinitionRepository.count({
      where: { sourceServiceAssetId },
    });
  }

  async findEndpointDefinitionByMethodAndPath(input: {
    sourceServiceAssetId: string;
    method?: string;
    path?: string;
  }) {
    if (!input.method || !input.path) {
      return null;
    }

    return this.endpointDefinitionRepository.findOne({
      where: {
        sourceServiceAssetId: input.sourceServiceAssetId,
        method: input.method.toUpperCase(),
        path: this.normalizeBasePath(input.path),
      },
    });
  }

  async syncDocumentToAssets(input: {
    documentId: string;
    documentName: string;
    description?: string;
    spec: any;
    metadata?: Record<string, any>;
  }) {
    const descriptor = this.resolveSourceDescriptor(input.spec, input.metadata);
    const sourceServiceAsset = await this.upsertSourceServiceAsset({
      ...descriptor,
      displayName: input.documentName,
      description: input.description,
      metadata: {
        documentId: input.documentId,
        importSource: input.metadata?.importSource,
        originalUrl: input.metadata?.originalUrl,
      },
    });

    const endpoints = this.extractEndpoints(input.spec);
    const syncedEndpoints: EndpointDefinitionEntity[] = [];
    for (const endpoint of endpoints) {
      const saved = await this.upsertEndpointDefinition({
        sourceServiceAssetId: sourceServiceAsset.id,
        method: endpoint.method,
        path: endpoint.path,
        operationId: endpoint.operationId,
        summary: endpoint.summary,
        description: endpoint.description,
        status: EndpointDefinitionStatus.DRAFT,
        publishEnabled: false,
        rawOperation: endpoint.rawOperation,
        metadata: {
          documentId: input.documentId,
          source: 'document-import',
          testStatus: 'untested',
          qualificationState: 'registered',
        },
      });
      syncedEndpoints.push(saved);
    }

    this.logger.log(
      `Synced document ${input.documentId} into source asset ${sourceServiceAsset.id} with ${syncedEndpoints.length} endpoints`,
    );

    return {
      sourceServiceAsset,
      endpoints: syncedEndpoints,
    };
  }

  async registerManualEndpointAsset(input: {
    name: string;
    baseUrl: string;
    method: string;
    path: string;
    description?: string;
    parameters?: RegisterManualEndpointAssetDto['parameters'];
    requestBody?: RegisterManualEndpointAssetDto['requestBody'];
    metadata?: Record<string, unknown>;
  }) {
    const parsed = new URL(input.baseUrl);
    const sourceServiceAsset = await this.upsertSourceServiceAsset({
      scheme: parsed.protocol.replace(':', ''),
      host: parsed.hostname,
      port: this.resolvePort(parsed),
      normalizedBasePath: this.normalizeBasePath(parsed.pathname || '/'),
      displayName: input.name,
      description: input.description,
      metadata: {
        source: 'manual-registration',
        baseUrl: input.baseUrl,
        ...input.metadata,
      },
    });

    const existing = await this.endpointDefinitionRepository.findOne({
      where: {
        sourceServiceAssetId: sourceServiceAsset.id,
        method: input.method.toUpperCase(),
        path: this.normalizeBasePath(input.path),
      },
    });
    if (existing) {
      throw new ConflictException('This endpoint is already registered; update the existing endpoint instead');
    }
    const endpoint = await this.upsertEndpointDefinition({
      sourceServiceAssetId: sourceServiceAsset.id,
      method: input.method.toUpperCase(),
      path: this.normalizeBasePath(input.path),
      summary: input.description || `${input.method.toUpperCase()} ${input.path}`,
      description: input.description,
      rawOperation: this.buildManualOperationTemplate(input.parameters, input.requestBody),
      status: EndpointDefinitionStatus.DRAFT,
      publishEnabled: false,
      metadata: {
        source: 'manual-registration',
        displayName: input.name,
        probeUrl: `${input.baseUrl.replace(/\/+$/, '')}${this.normalizeBasePath(input.path)}`,
        testStatus: 'untested',
        qualificationState: 'registered',
        ...(input.metadata || {}),
      },
    });

    return {
      sourceServiceAsset,
      endpoint,
    };
  }

  private async upsertSourceServiceAsset(input: {
    scheme: string;
    host: string;
    port: number;
    normalizedBasePath: string;
    displayName?: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }) {
    const sourceKey = this.normalizeSourceKey(input);
    let asset = await this.sourceServiceRepository.findOne({
      where: { sourceKey },
    });

    if (!asset) {
      asset = this.sourceServiceRepository.create({
        sourceKey,
        displayName: input.displayName,
        description: input.description,
        metadata: input.metadata,
      });
    } else {
      asset.displayName = input.displayName ?? asset.displayName;
      asset.description = input.description ?? asset.description;
      asset.metadata = {
        ...(asset.metadata || {}),
        ...(input.metadata || {}),
      };
    }

    const saved = await this.sourceServiceRepository.save(asset);
    if (input.host.toLowerCase() !== 'unknown-host') {
      await this.sourceServiceInstancesService.ensureImportedInstance(saved.id, {
        scheme: input.scheme.toLowerCase(),
        host: input.host.toLowerCase(),
        port: input.port,
        basePath: this.normalizeBasePath(input.normalizedBasePath),
        provenance: input.metadata,
      });
    }
    return saved;
  }

  private async buildEndpointAssetRecord(id: string) {
    const detail = await this.getEndpointDefinitionDetail(id);
    const endpoint = detail.endpoint;
    const sourceServiceAsset = detail.sourceServiceAsset;
    const metadata = (endpoint.metadata || {}) as Record<string, unknown>;
    const instanceResult = sourceServiceAsset
      ? await this.sourceServiceInstancesService.list(sourceServiceAsset.id, { enabled: true })
      : { data: [] };
    const defaultInstance = instanceResult.data[0];

    return {
      id: endpoint.id,
      endpoint,
      sourceServiceAsset,
      registration: {
        sourceType: this.inferSourceType(endpoint),
        name:
          String(metadata.displayName || sourceServiceAsset?.displayName || endpoint.summary || endpoint.path),
        baseUrl: defaultInstance
          ? this.sourceServiceInstancesService.buildBaseUrl(defaultInstance)
          : undefined,
        businessDomain:
          typeof metadata.businessDomain === 'string' ? metadata.businessDomain : undefined,
        riskLevel: typeof metadata.riskLevel === 'string' ? metadata.riskLevel : undefined,
      },
    };
  }

  private async runProbe(probeUrl: string) {
    const startedAt = Date.now();
    try {
      const head = await firstValueFrom(
        this.httpService.head(probeUrl, {
          timeout: 8000,
          validateStatus: () => true,
        }),
      );
      const responseTimeMs = Date.now() - startedAt;
      const healthy = this.isReachableProbeStatus(head.status);
      if (!healthy && this.shouldFallbackToGet(head.status)) {
        return this.runGetProbe(probeUrl, startedAt);
      }
      return {
        status: healthy ? 'healthy' : 'unhealthy',
        httpStatus: head.status,
        responseTimeMs,
        errorMessage: healthy ? undefined : `HTTP ${head.status}`,
        probeUrl,
      };
    } catch (headError) {
      return this.runGetProbe(probeUrl, startedAt, headError);
    }
  }

  private async buildSourceAssetRuntimeView(asset: SourceServiceAssetEntity) {
    const instanceResult = await this.sourceServiceInstancesService.list(asset.id, {
      enabled: true,
    });
    return {
      ...asset,
      defaultInstance: instanceResult.data[0] || null,
      instanceCount: instanceResult.total,
    };
  }

  private async runGetProbe(probeUrl: string, startedAt: number, headError?: unknown) {
    try {
      const getResp = await firstValueFrom(
        this.httpService.get(probeUrl, {
          timeout: 8000,
          validateStatus: () => true,
        }),
      );
      const responseTimeMs = Date.now() - startedAt;
      const healthy = this.isReachableProbeStatus(getResp.status);
      return {
        status: healthy ? 'healthy' : 'unhealthy',
        httpStatus: getResp.status,
        responseTimeMs,
        errorMessage: healthy ? undefined : `HTTP ${getResp.status}`,
        probeUrl,
      };
    } catch (getError) {
      const axiosErr = getError as AxiosError;
      return {
        status: 'unhealthy',
        responseTimeMs: Date.now() - startedAt,
        errorMessage:
          axiosErr.response?.status != null
            ? `HTTP ${axiosErr.response.status}`
            : axiosErr.message || (headError as Error | undefined)?.message || 'Probe request failed',
        probeUrl,
      };
    }
  }

  private isReachableProbeStatus(status?: number) {
    if (status == null) return false;
    if (status >= 200 && status < 300) return true;
    return [400, 401, 403, 405, 409, 415, 422, 429].includes(status);
  }

  private isQueryOnlyMethod(method: string) {
    return ['GET', 'DELETE', 'HEAD'].includes(method.toUpperCase());
  }

  private shouldFallbackToGet(status?: number) {
    if (status == null) return true;
    return status === 404 || status === 405 || status >= 500;
  }

  private mergeTestingMetadata(
    endpoint: EndpointDefinitionEntity,
    metadata: Record<string, unknown>,
  ) {
    return {
      ...(endpoint.metadata || {}),
      ...metadata,
    };
  }

  private buildTestingState(endpoint: EndpointDefinitionEntity) {
    const metadata = (endpoint.metadata || {}) as Record<string, unknown>;
    const testStatus = String(metadata.testStatus || 'untested');
    const qualificationState = String(
      metadata.qualificationState ||
        (testStatus === 'passed'
          ? 'tested'
          : testStatus === 'failed'
            ? 'test_blocked'
            : 'registered'),
    );
    const reasons: string[] = [];

    if (testStatus !== 'passed') {
      reasons.push(`testStatus is ${testStatus}, expected passed`);
    }

    return {
      endpointDefinitionId: endpoint.id,
      testStatus,
      qualificationState,
      qualified: testStatus === 'passed',
      reasons,
      lastTestAt: metadata.lastTestAt,
      lastTestMethod: metadata.lastTestMethod,
      lastTestUrl: metadata.lastTestUrl,
      lastTestHttpStatus: metadata.lastTestHttpStatus,
      lastTestDurationMs: metadata.lastTestDurationMs,
      lastTestError: metadata.lastTestError,
    };
  }

  private inferSourceType(endpoint: EndpointDefinitionEntity): 'manual' | 'imported' {
    const source = (endpoint.metadata || {}).source;
    return source === 'manual-registration' ? 'manual' : 'imported';
  }

  private normalizeSourceServiceProbeResult(result: {
    status: string;
    httpStatus?: number;
    responseTimeMs?: number;
    errorMessage?: string;
    probeUrl: string;
  }) {
    if (result.status === 'healthy') {
      return result;
    }

    if (result.httpStatus != null && [404, 405].includes(result.httpStatus)) {
      return {
        ...result,
        status: 'healthy',
        errorMessage: undefined,
      };
    }

    return result;
  }

  private async requireEndpointDefinition(id: string) {
    const endpoint = await this.endpointDefinitionRepository.findOne({ where: { id } });
    if (!endpoint) {
      throw new NotFoundException(`Endpoint definition '${id}' not found`);
    }
    return endpoint;
  }

  private ensureManualEndpoint(endpoint: EndpointDefinitionEntity) {
    if (this.inferSourceType(endpoint) !== 'manual') {
      throw new NotFoundException(`Manual endpoint definition '${endpoint.id}' not found`);
    }
  }

  private async cleanupOrphanSourceServiceAsset(sourceServiceAssetId: string) {
    const count = await this.countEndpointsBySourceServiceAssetId(sourceServiceAssetId);
    if (count > 0) {
      return;
    }

    // Runtime instances may still be referenced by retained test/audit evidence.
    const instances = await this.sourceServiceInstancesService.list(sourceServiceAssetId);
    if (instances.total > 0) return;
    await this.sourceServiceRepository.delete({ id: sourceServiceAssetId });
  }

  private buildManualOperationTemplate(
    parameters?: ManualEndpointParameterDto[],
    requestBody?: ManualEndpointRequestBodyDto | null,
  ): Record<string, any> {
    const template: Record<string, unknown> = {};
    const normalizedParameters = Array.isArray(parameters) ? parameters : [];
    const names = new Set<string>();
    for (const parameter of normalizedParameters) {
      const name = parameter?.name?.trim();
      if (!name || names.has(name)) {
        throw new BadRequestException('Manual endpoint parameters must have non-empty, unique names');
      }
      names.add(name);
    }
    if (normalizedParameters.length > 0) {
      template.parameters = normalizedParameters
        .filter(
          (param): param is ManualEndpointParameterDto =>
            Boolean(param && typeof param.name === 'string' && param.name.trim()),
        )
        .map(param => ({
          name: param.name.trim(),
          in: param.in,
          description: param.description,
          required: param.in === 'path' || (param.required ?? false),
          schema: {
            ...(param.schema || { type: param.type || 'string' }),
            ...(param.example !== undefined ? { example: param.example } : {}),
          },
        }));
    }

    if (requestBody) {
      const bodySchema =
        requestBody.schema && Object.keys(requestBody.schema).length > 0
          ? requestBody.schema
          : { type: requestBody.type || 'object' };
      template.requestBody = {
        required: requestBody.required ?? false,
        description: requestBody.description,
        content: {
          'application/json': {
            schema: bodySchema,
            ...(requestBody.example !== undefined ? { example: requestBody.example } : {}),
          },
        },
      };
    }

    return template;
  }

  private substitutePathParameters(
    url: string,
    endpoint: EndpointDefinitionEntity,
    supplied: Record<string, unknown> = {},
  ) {
    return url.replace(/\{([^}]+)\}/g, (_match, name: string) =>
      encodeURIComponent(String(this.resolvePathSample(name, endpoint, supplied))),
    );
  }

  private resolvePathSample(
    name: string,
    endpoint: EndpointDefinitionEntity,
    supplied: Record<string, unknown>,
  ) {
    if (Object.prototype.hasOwnProperty.call(supplied, name) && supplied[name] != null) {
      return supplied[name];
    }
    const stored = endpoint.metadata?.testParameters as Record<string, unknown> | undefined;
    if (stored && Object.prototype.hasOwnProperty.call(stored, name) && stored[name] != null) {
      return stored[name];
    }
    const parameters = endpoint.rawOperation?.parameters;
    const parameter = Array.isArray(parameters)
      ? parameters.find(item => item?.name === name && item.in === 'path')
      : undefined;
    const sample = parameter?.example ?? parameter?.schema?.example ?? parameter?.schema?.default;
    if (sample != null) return sample;
    throw new BadRequestException(`Path parameter '${name}' requires a test value or an example`);
  }

  private buildEndpointTestRequest(
    endpoint: EndpointDefinitionEntity,
    supplied: Record<string, unknown>,
  ) {
    const operation = endpoint.rawOperation || {};
    if (!Array.isArray(operation.parameters) && !operation.requestBody) {
      return this.isQueryOnlyMethod(endpoint.method.toUpperCase())
        ? { params: supplied } : { data: supplied };
    }
    const params: Record<string, unknown> = {};
    const headers: Record<string, string> = {};
    const body = { ...supplied };
    for (const parameter of (Array.isArray(operation.parameters) ? operation.parameters : [])) {
      const value = supplied[parameter.name] ?? parameter.example ??
        parameter.schema?.example ?? parameter.schema?.default;
      delete body[parameter.name];
      if (value == null) continue;
      if (parameter.in === 'query') params[parameter.name] = value;
      if (parameter.in === 'header') headers[parameter.name] = String(value);
    }
    const requestBody = operation.requestBody as any;
    const data = requestBody
      ? (supplied.body ?? (Object.keys(body).length ? body :
          requestBody.content?.['application/json']?.example))
      : undefined;
    return { params, headers, ...(data !== undefined ? { data } : {}) };
  }

  private async hasActivePublicationBinding(
    endpoint: EndpointDefinitionEntity,
    manager?: EntityManager,
  ) {
    if (endpoint.status === EndpointDefinitionStatus.PUBLISHED) return true;
    const [publications, routes, memberships] = await Promise.all([
      (manager?.getRepository(EndpointPublishBindingEntity) || this.publishBindingRepository).find({
        where: { endpointDefinitionId: endpoint.id, publishStatus: PublicationBindingStatus.ACTIVE },
      }),
      (manager?.getRepository(GatewayRouteBindingEntity) || this.routeBindingRepository).find({
        where: { endpointDefinitionId: endpoint.id, status: GatewayRouteBindingStatus.ACTIVE },
      }),
      (manager?.getRepository(RuntimeAssetEndpointBindingEntity) || this.runtimeBindingRepository).find({
        where: { endpointDefinitionId: endpoint.id, status: RuntimeAssetEndpointBindingStatus.ACTIVE },
      }),
    ]);
    if (publications.length > 0 || routes.length > 0 || memberships.length > 0) return true;
    const entityManager = manager || this.endpointDefinitionRepository.manager;
    const related = await entityManager.getRepository(RuntimeAssetEndpointBindingEntity).find({
      where: { endpointDefinitionId: endpoint.id },
    });
    if (!related.length) return false;
    const runtimes = await entityManager.getRepository(RuntimeAssetEntity).find({
      where: { id: In([...new Set(related.map(item => item.runtimeAssetId))]) },
    });
    // Published snapshots are immutable and remain live until the runtime is stopped/redeployed.
    if (runtimes.some(runtime => runtime.type === 'gateway_service' &&
      ['active', 'degraded'].includes(runtime.status) && runtime.metadata?.activeRevision)) return true;
    const serverIds = runtimes.map(runtime => runtime.metadata?.managedServerId)
      .filter((id): id is string => typeof id === 'string');
    if (!serverIds.length) return false;
    const servers = await entityManager.getRepository(MCPServerEntity).find({
      where: { id: In(serverIds) },
    });
    return servers.some(server => ['running', 'starting', 'restarting'].includes(server.status));
  }

  private async ensureManualEndpointMutatable(
    endpoint: EndpointDefinitionEntity,
    manager?: EntityManager,
  ) {
    if (await this.hasActivePublicationBinding(endpoint, manager)) {
      throw new ConflictException(
        `Manual endpoint '${endpoint.id}' has active publication bindings; offline its memberships and stop deployed runtimes before editing or deleting it`,
      );
    }
  }

  private async ensureManualEndpointRemovable(endpoint: EndpointDefinitionEntity) {
    await this.ensureManualEndpointMutatable(endpoint);
  }

  private async syncEndpointRouteBindings(
    endpoint: EndpointDefinitionEntity,
    previous: EndpointDefinitionEntity,
    manager: EntityManager,
  ) {
    const repository = manager.getRepository(GatewayRouteBindingEntity);
    const routes = await repository.find({ where: { endpointDefinitionId: endpoint.id } });
    for (const route of routes) {
      if (route.routePath === previous.path) {
        route.routePath = endpoint.path;
        route.pathMatchMode = /\{[^}]+\}/.test(endpoint.path)
          ? GatewayRoutePathMatchMode.PARAMETER : GatewayRoutePathMatchMode.EXACT;
      }
      if (route.upstreamPath === previous.path) route.upstreamPath = endpoint.path;
      if (route.routeMethod === previous.method) route.routeMethod = endpoint.method;
      if (route.upstreamMethod === previous.method) route.upstreamMethod = endpoint.method;
      const candidates = await repository.find({
        where: { routePath: route.routePath, routeMethod: route.routeMethod },
      });
      if (candidates.some(candidate => candidate.id !== route.id &&
        (candidate.matchHost || '').toLowerCase() === (route.matchHost || '').toLowerCase())) {
        throw new ConflictException('The updated endpoint conflicts with an existing gateway route');
      }
      await repository.save(route);
    }
    const memberships = await manager.getRepository(RuntimeAssetEndpointBindingEntity).find({
      where: { endpointDefinitionId: endpoint.id },
    });
    if (memberships.length === 0) return;
    if (endpoint.sourceServiceAssetId !== previous.sourceServiceAssetId) {
      await this.deleteMembershipUpstreamBindings(manager, memberships.map(item => item.id));
    }
    await this.markRuntimeVerificationRequired(manager, memberships);
  }

  private async deleteMembershipUpstreamBindings(manager: EntityManager, membershipIds: string[]) {
    if (!membershipIds.length) return;
    const repository = manager.getRepository(RuntimeUpstreamBindingEntity);
    const criteria = { runtimeAssetEndpointBindingId: In(membershipIds) };
    const bindings = await repository.find({ where: criteria });
    if (bindings.length) {
      await manager.getRepository(RuntimeUpstreamBindingInstanceEntity).delete({
        runtimeUpstreamBindingId: In(bindings.map(binding => binding.id)),
      });
    }
    await repository.delete(criteria);
  }

  private async markRuntimeVerificationRequired(
    manager: EntityManager,
    memberships: RuntimeAssetEndpointBindingEntity[],
  ) {
    if (memberships.length === 0) return;
    const repository = manager.getRepository(RuntimeAssetEntity);
    const runtimes = await repository.find({
      where: { id: In([...new Set(memberships.map(item => item.runtimeAssetId))]) },
    });
    for (const runtime of runtimes) {
      runtime.metadata = {
        ...(runtime.metadata || {}),
        verificationRequired: true,
        verificationRequiredAt: new Date().toISOString(),
        verificationRequiredReason: 'manual_endpoint_changed',
      };
      await repository.save(runtime);
    }
  }

  private async cascadeDeleteEndpointRecord(endpoint: EndpointDefinitionEntity) {
    await this.endpointDefinitionRepository.manager.transaction(async manager => {
      await this.ensureManualEndpointMutatable(endpoint, manager);
      const runtimeRepository = manager.getRepository(RuntimeAssetEndpointBindingEntity);
      const memberships = await runtimeRepository.find({
        where: { endpointDefinitionId: endpoint.id },
      });
      const criteria = [
        { endpointDefinitionId: endpoint.id },
        ...(memberships.length ? [{
          runtimeAssetEndpointBindingId: In(memberships.map(item => item.id)),
        }] : []),
      ];
      await manager.getRepository(EndpointPublishBindingEntity).delete(criteria);
      await manager.getRepository(GatewayRouteBindingEntity).delete(criteria);
      await manager.getRepository(PublicationProfileEntity).delete(criteria);
      if (memberships.length) {
        await this.deleteMembershipUpstreamBindings(manager, memberships.map(item => item.id));
        await this.markRuntimeVerificationRequired(manager, memberships);
      }
      await runtimeRepository.delete({ endpointDefinitionId: endpoint.id });
      // History, audit events and test evidence deliberately survive catalog deletion.
      await manager.getRepository(EndpointDefinitionEntity).delete({ id: endpoint.id });
    });
  }

  private async upsertEndpointDefinition(
    input: Partial<EndpointDefinitionEntity> & {
      sourceServiceAssetId: string;
      method: string;
      path: string;
    },
  ) {
    let endpoint = await this.endpointDefinitionRepository.findOne({
      where: {
        sourceServiceAssetId: input.sourceServiceAssetId,
        method: input.method,
        path: input.path,
      },
    });

    if (!endpoint) {
      endpoint = this.endpointDefinitionRepository.create({
        ...input,
      });
    } else {
      Object.assign(endpoint, {
        operationId: input.operationId ?? endpoint.operationId,
        summary: input.summary ?? endpoint.summary,
        description: input.description ?? endpoint.description,
        rawOperation: input.rawOperation ?? endpoint.rawOperation,
        metadata: {
          ...(endpoint.metadata || {}),
          ...(input.metadata || {}),
        },
      });
    }

    return this.endpointDefinitionRepository.save(endpoint);
  }

  private resolveSourceDescriptor(spec: any, metadata?: Record<string, any>) {
    const serverUrl = this.resolveServerUrl(spec, metadata);
    if (serverUrl) {
      const parsed = new URL(serverUrl);
      return {
        scheme: parsed.protocol.replace(':', ''),
        host: parsed.hostname,
        port: this.resolvePort(parsed),
        normalizedBasePath: this.normalizeBasePath(parsed.pathname || '/'),
      };
    }

    return {
      scheme: 'http',
      host: 'unknown-host',
      port: 80,
      normalizedBasePath: '/',
    };
  }

  private resolveServerUrl(spec: any, metadata?: Record<string, any>) {
    const serverUrl = spec?.servers?.[0]?.url;
    if (typeof serverUrl === 'string' && this.isAbsoluteHttpUrl(serverUrl)) {
      return serverUrl;
    }

    const originalUrl = metadata?.originalUrl;
    if (typeof serverUrl === 'string' && typeof originalUrl === 'string' && this.isAbsoluteHttpUrl(originalUrl)) {
      try {
        return new URL(serverUrl, originalUrl).toString();
      } catch {
        return originalUrl;
      }
    }

    if (typeof originalUrl === 'string' && this.isAbsoluteHttpUrl(originalUrl)) {
      return originalUrl;
    }

    return undefined;
  }

  private isAbsoluteHttpUrl(value?: string) {
    if (!value) {
      return false;
    }
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  private resolvePort(parsed: URL) {
    if (parsed.port) {
      return Number(parsed.port);
    }
    return parsed.protocol === 'https:' ? 443 : 80;
  }

  private extractEndpoints(spec: any) {
    const paths = spec?.paths;
    if (!paths || typeof paths !== 'object') {
      return [];
    }

    const endpoints: Array<{
      method: string;
      path: string;
      operationId?: string;
      summary?: string;
      description?: string;
      rawOperation?: Record<string, unknown>;
    }> = [];

    for (const [path, operations] of Object.entries(paths)) {
      if (!operations || typeof operations !== 'object') {
        continue;
      }

      for (const [method, operation] of Object.entries(operations as Record<string, any>)) {
        endpoints.push({
          method: method.toUpperCase(),
          path: this.normalizeBasePath(path),
          operationId: operation?.operationId,
          summary: operation?.summary,
          description: operation?.description,
          rawOperation: operation,
        });
      }
    }

    return endpoints;
  }
}
