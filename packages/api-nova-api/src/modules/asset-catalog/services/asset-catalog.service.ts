import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Like, Repository } from 'typeorm';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import {
  EndpointDefinitionEntity,
  EndpointDefinitionStatus,
} from '../../../database/entities/endpoint-definition.entity';
import { SourceServiceAssetEntity } from '../../../database/entities/source-service-asset.entity';
import {
  AssetCatalogQueryDto,
  ExecuteEndpointDefinitionTestDto,
  EndpointCatalogQueryDto,
  RegisterManualEndpointAssetDto,
  UpdateEndpointDefinitionGovernanceDto,
  UpdateManualEndpointAssetDto,
} from '../dto/asset-catalog.dto';
import { evaluateEndpointGovernanceReadiness } from '../endpoint-readiness.policy';

@Injectable()
export class AssetCatalogService {
  private readonly logger = new Logger(AssetCatalogService.name);

  constructor(
    @InjectRepository(SourceServiceAssetEntity)
    private readonly sourceServiceRepository: Repository<SourceServiceAssetEntity>,
    @InjectRepository(EndpointDefinitionEntity)
    private readonly endpointDefinitionRepository: Repository<EndpointDefinitionEntity>,
    private readonly httpService: HttpService,
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
      where.host = Like(`%${query.host.toLowerCase()}%`);
    }

    const assets = await this.sourceServiceRepository.find({
      where,
      order: {
        updatedAt: 'DESC',
      },
    });

    return {
      total: assets.length,
      data: assets,
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
      asset,
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

    return {
      endpoint,
      sourceServiceAsset,
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

    const metadata = (endpoint.metadata || {}) as Record<string, unknown>;
    const sourceType = this.inferSourceType(endpoint);
    const defaultProbeUrl =
      sourceType === 'imported'
        ? this.buildBaseUrlFromSourceServiceAsset(sourceServiceAsset)
        : `${this.buildBaseUrlFromSourceServiceAsset(sourceServiceAsset)}${endpoint.path}`;
    const probeUrl =
      typeof metadata.probeUrl === 'string' && metadata.probeUrl
        ? metadata.probeUrl
        : defaultProbeUrl;
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
      probeUrl: result.probeUrl,
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

    const testUrl = `${this.buildBaseUrlFromSourceServiceAsset(sourceServiceAsset)}${endpoint.path}`;
    const method = String(endpoint.method || 'GET').toUpperCase();
    const parameters =
      input.parameters && typeof input.parameters === 'object' ? input.parameters : {};
    const startedAt = Date.now();

    try {
      const response = await firstValueFrom(
        this.httpService.request({
          url: testUrl,
          method: method as any,
          timeout: 12000,
          validateStatus: () => true,
          ...(this.isQueryOnlyMethod(method)
            ? { params: parameters }
            : { data: parameters }),
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
    endpoint.metadata = {
      ...(endpoint.metadata || {}),
      source: 'manual-registration',
      businessDomain: input.businessDomain,
      riskLevel: input.riskLevel,
      displayName: input.name,
      baseUrl: input.baseUrl,
      testStatus: 'untested',
      qualificationState: 'registered',
      lastTestAt: undefined,
      lastTestMethod: undefined,
      lastTestUrl: undefined,
      lastTestHttpStatus: undefined,
      lastTestDurationMs: undefined,
      lastTestError: undefined,
    };

    await this.endpointDefinitionRepository.save(endpoint);
    await this.cleanupOrphanSourceServiceAsset(previousSourceServiceAssetId);
    return this.buildEndpointAssetRecord(endpoint.id);
  }

  async deleteManualEndpointAssetRecord(id: string) {
    const endpoint = await this.requireEndpointDefinition(id);
    this.ensureManualEndpoint(endpoint);
    const sourceServiceAssetId = endpoint.sourceServiceAssetId;
    await this.endpointDefinitionRepository.remove(endpoint);
    await this.cleanupOrphanSourceServiceAsset(sourceServiceAssetId);

    return {
      success: true,
      endpointId: id,
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

    const endpoint = await this.upsertEndpointDefinition({
      sourceServiceAssetId: sourceServiceAsset.id,
      method: input.method.toUpperCase(),
      path: this.normalizeBasePath(input.path),
      summary: input.description || `${input.method.toUpperCase()} ${input.path}`,
      description: input.description,
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
        scheme: input.scheme.toLowerCase(),
        host: input.host.toLowerCase(),
        port: input.port,
        normalizedBasePath: this.normalizeBasePath(input.normalizedBasePath),
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

    return this.sourceServiceRepository.save(asset);
  }

  private async buildEndpointAssetRecord(id: string) {
    const detail = await this.getEndpointDefinitionDetail(id);
    const endpoint = detail.endpoint;
    const sourceServiceAsset = detail.sourceServiceAsset;
    const metadata = (endpoint.metadata || {}) as Record<string, unknown>;

    return {
      id: endpoint.id,
      endpoint,
      sourceServiceAsset,
      registration: {
        sourceType: this.inferSourceType(endpoint),
        name:
          String(metadata.displayName || sourceServiceAsset?.displayName || endpoint.summary || endpoint.path),
        baseUrl: this.buildBaseUrlFromSourceServiceAsset(sourceServiceAsset),
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

  private buildBaseUrlFromSourceServiceAsset(sourceServiceAsset?: SourceServiceAssetEntity | null) {
    if (!sourceServiceAsset) {
      return '';
    }

    const defaultPort =
      (sourceServiceAsset.scheme === 'http' && sourceServiceAsset.port === 80) ||
      (sourceServiceAsset.scheme === 'https' && sourceServiceAsset.port === 443);
    const authority = defaultPort
      ? `${sourceServiceAsset.scheme}://${sourceServiceAsset.host}`
      : `${sourceServiceAsset.scheme}://${sourceServiceAsset.host}:${sourceServiceAsset.port}`;
    const basePath = this.normalizeBasePath(sourceServiceAsset.normalizedBasePath);
    return basePath === '/' ? authority : `${authority}${basePath}`;
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

    await this.sourceServiceRepository.delete({ id: sourceServiceAssetId });
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
