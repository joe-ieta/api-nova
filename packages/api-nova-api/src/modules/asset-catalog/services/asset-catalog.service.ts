import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Like, Repository } from 'typeorm';
import {
  EndpointDefinitionEntity,
  EndpointDefinitionStatus,
} from '../../../database/entities/endpoint-definition.entity';
import { SourceServiceAssetEntity } from '../../../database/entities/source-service-asset.entity';
import {
  AssetCatalogQueryDto,
  EndpointCatalogQueryDto,
  UpdateEndpointDefinitionGovernanceDto,
} from '../dto/asset-catalog.dto';

@Injectable()
export class AssetCatalogService {
  private readonly logger = new Logger(AssetCatalogService.name);

  constructor(
    @InjectRepository(SourceServiceAssetEntity)
    private readonly sourceServiceRepository: Repository<SourceServiceAssetEntity>,
    @InjectRepository(EndpointDefinitionEntity)
    private readonly endpointDefinitionRepository: Repository<EndpointDefinitionEntity>,
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
