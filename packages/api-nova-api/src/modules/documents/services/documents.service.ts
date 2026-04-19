import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, In } from 'typeorm';
import { OpenAPIDocument, DocumentStatus } from '../../../database/entities/openapi-document.entity';
import { User } from '../../../database/entities/user.entity';
import { CreateDocumentDto } from '../dto/create-document.dto';
import { UpdateDocumentDto } from '../dto/update-document.dto';
import { QueryDocumentDto } from '../dto/query-document.dto';
import {
  DocumentResponseDto,
  DocumentDetailResponseDto,
  DocumentListResponseDto,
  DocumentInfoDto,
} from '../dto/document-response.dto';
import { AssetCatalogService } from '../../asset-catalog/services/asset-catalog.service';
import { QuickPublishDocumentMcpDto } from '../dto/quick-publish-document-mcp.dto';
import { OpenAPIService } from '../../openapi/services/openapi.service';
import { InputSourceType } from '../../openapi/dto/configure-openapi.dto';
import { PublicationService } from '../../publication/services/publication.service';
import { RuntimeAssetsService } from '../../runtime-assets/services/runtime-assets.service';
import { RuntimeAssetEntity, RuntimeAssetType } from '../../../database/entities/runtime-asset.entity';
import { RuntimeAssetEndpointBindingEntity } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import { MCPServerEntity } from '../../../database/entities/mcp-server.entity';
import {
  PublicationProfileEntity,
  PublicationProfileStatus,
} from '../../../database/entities/publication-profile.entity';
import { PublicationProfileHistoryEntity } from '../../../database/entities/publication-profile-history.entity';
import { EndpointPublishBindingEntity } from '../../../database/entities/endpoint-publish-binding.entity';
import { GatewayRouteBindingEntity } from '../../../database/entities/gateway-route-binding.entity';
import {
  EndpointDefinitionEntity,
  EndpointDefinitionStatus,
} from '../../../database/entities/endpoint-definition.entity';
import { SourceServiceAssetEntity } from '../../../database/entities/source-service-asset.entity';

type QuickPublishLogLevel = 'info' | 'success' | 'warning' | 'error';

interface QuickPublishProcessLog {
  step: string;
  level: QuickPublishLogLevel;
  summary: string;
  details?: string;
  timestamp: string;
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    @InjectRepository(OpenAPIDocument)
    private readonly documentRepository: Repository<OpenAPIDocument>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(RuntimeAssetEntity)
    private readonly runtimeAssetRepository: Repository<RuntimeAssetEntity>,
    @InjectRepository(RuntimeAssetEndpointBindingEntity)
    private readonly runtimeBindingRepository: Repository<RuntimeAssetEndpointBindingEntity>,
    @InjectRepository(MCPServerEntity)
    private readonly mcpServerRepository: Repository<MCPServerEntity>,
    @InjectRepository(PublicationProfileEntity)
    private readonly publicationProfileRepository: Repository<PublicationProfileEntity>,
    @InjectRepository(PublicationProfileHistoryEntity)
    private readonly publicationProfileHistoryRepository: Repository<PublicationProfileHistoryEntity>,
    @InjectRepository(EndpointPublishBindingEntity)
    private readonly endpointPublishBindingRepository: Repository<EndpointPublishBindingEntity>,
    @InjectRepository(GatewayRouteBindingEntity)
    private readonly gatewayRouteBindingRepository: Repository<GatewayRouteBindingEntity>,
    @InjectRepository(EndpointDefinitionEntity)
    private readonly endpointDefinitionRepository: Repository<EndpointDefinitionEntity>,
    @InjectRepository(SourceServiceAssetEntity)
    private readonly sourceServiceRepository: Repository<SourceServiceAssetEntity>,
    private readonly assetCatalogService: AssetCatalogService,
    private readonly openApiService: OpenAPIService,
    private readonly publicationService: PublicationService,
    private readonly runtimeAssetsService: RuntimeAssetsService,
  ) {}

  /**
   * 创建新文档
   */
  async create(userId: string, createDocumentDto: CreateDocumentDto): Promise<DocumentDetailResponseDto> {
    try {
      // 验证内容是否为有效的JSON
      this.validateJsonContent(createDocumentDto.content);

      const document = this.documentRepository.create({
        ...createDocumentDto,
        userId,
      });

      const savedDocument = await this.documentRepository.save(document);
      await this.assetCatalogService.syncDocumentToAssets({
        documentId: savedDocument.id,
        documentName: savedDocument.name,
        description: savedDocument.description,
        spec: JSON.parse(savedDocument.content),
        metadata: savedDocument.metadata,
      });
      
      this.logger.log(`Created document ${savedDocument.id} for user ${userId}`);
      
      return this.toDetailResponseDto(savedDocument);
    } catch (error) {
      this.logger.error(`Failed to create document for user ${userId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * 获取用户文档列表
   */
  async findAll(userId: string, queryDto: QueryDocumentDto): Promise<DocumentListResponseDto> {
    try {
      const { page, limit, search, status, tags, sortBy, sortOrder } = queryDto;
      const skip = (page - 1) * limit;

      const queryBuilder = this.documentRepository
        .createQueryBuilder('document')
        .where('document.userId = :userId', { userId });

      // 搜索过滤
      if (search) {
        queryBuilder.andWhere(
          '(document.name ILIKE :search OR document.description ILIKE :search)',
          { search: `%${search}%` }
        );
      }

      // 状态过滤
      if (status) {
        queryBuilder.andWhere('document.status = :status', { status });
      }

      // 标签过滤
      if (tags && tags.length > 0) {
        queryBuilder.andWhere('document.tags && :tags', { tags });
      }

      // 排序
      queryBuilder.orderBy(`document.${sortBy}`, sortOrder);

      // 分页
      queryBuilder.skip(skip).take(limit);

      const [documents, total] = await queryBuilder.getManyAndCount();
      const totalPages = Math.ceil(total / limit);

      this.logger.log(`Found ${documents.length} documents for user ${userId}`);

      return {
        documents: documents.map(doc => this.toResponseDto(doc)),
        total,
        page,
        limit,
        totalPages,
      };
    } catch (error) {
      this.logger.error(`Failed to get documents for user ${userId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * 获取单个文档详情
   */
  async findOne(userId: string | null, id: string): Promise<DocumentDetailResponseDto> {
    try {
      const whereCondition = userId ? { id, userId } : { id };
      const document = await this.documentRepository.findOne({
        where: whereCondition,
      });

      if (!document) {
        throw new NotFoundException(`Document with ID ${id} not found`);
      }

      this.logger.log(`Retrieved document ${id}${userId ? ` for user ${userId}` : ''}`);
      
      return this.toDetailResponseDto(document);
    } catch (error) {
      this.logger.error(`Failed to get document ${id}${userId ? ` for user ${userId}` : ''}: ${error.message}`);
      throw error;
    }
  }

  /**
   * 更新文档
   */
  async update(userId: string, id: string, updateDocumentDto: UpdateDocumentDto): Promise<DocumentDetailResponseDto> {
    try {
      const document = await this.documentRepository.findOne({
        where: { id, userId },
      });

      if (!document) {
        throw new NotFoundException(`Document with ID ${id} not found`);
      }

      // 如果更新内容，验证JSON格式
      if (updateDocumentDto.content) {
        this.validateJsonContent(updateDocumentDto.content);
      }

      // 更新文档
      Object.assign(document, updateDocumentDto);
      const updatedDocument = await this.documentRepository.save(document);
      await this.assetCatalogService.syncDocumentToAssets({
        documentId: updatedDocument.id,
        documentName: updatedDocument.name,
        description: updatedDocument.description,
        spec: JSON.parse(updatedDocument.content),
        metadata: updatedDocument.metadata,
      });

      this.logger.log(`Updated document ${id} for user ${userId}`);
      
      return this.toDetailResponseDto(updatedDocument);
    } catch (error) {
      this.logger.error(`Failed to update document ${id} for user ${userId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * 删除文档
   */
  async remove(userId: string, id: string): Promise<void> {
    try {
      const document = await this.documentRepository.findOne({
        where: { id, userId },
      });

      if (!document) {
        throw new NotFoundException(`Document with ID ${id} not found`);
      }

      await this.documentRepository.remove(document);
      
      this.logger.log(`Deleted document ${id} for user ${userId}`);
    } catch (error) {
      this.logger.error(`Failed to delete document ${id} for user ${userId}: ${error.message}`);
      throw error;
    }
  }

  async quickPublishDocumentToMcp(
    userId: string,
    id: string,
    input: QuickPublishDocumentMcpDto = {},
  ) {
    const processLogs: QuickPublishProcessLog[] = [];
    const logStep = (
      step: string,
      level: QuickPublishLogLevel,
      summary: string,
      details?: string,
    ) => {
      processLogs.push({
        step,
        level,
        summary,
        details,
        timestamp: new Date().toISOString(),
      });
    };

    try {
      const document = await this.documentRepository.findOne({
        where: { id, userId },
      });
      if (!document) {
        throw new NotFoundException(`Document with ID ${id} not found`);
      }

      const publicationName = String(document.name || '').trim();
      if (!publicationName) {
        throw new BadRequestException('Document name is required for MCP quick publish');
      }

      const nextContent =
        typeof input.content === 'string' && input.content.trim()
          ? input.content.trim()
          : document.content;
      this.validateJsonContent(nextContent);
      logStep(
        'document.loaded',
        'success',
        `Loaded document '${document.name}' for MCP quick publish`,
      );

      const parseResult = await this.openApiService.parseOpenAPI({
        source: {
          type: InputSourceType.CONTENT,
          content: nextContent,
        },
      });
      logStep(
        'document.parsed',
        'success',
        `Parsed OpenAPI document into ${parseResult.tools?.length || 0} MCP tools`,
        `Endpoints: ${parseResult.endpoints?.length || 0}`,
      );

      const parsedSpec = JSON.parse(nextContent);
      if (nextContent !== document.content) {
        document.content = nextContent;
        document.status = DocumentStatus.VALID;
        await this.documentRepository.save(document);
        logStep(
          'document.saved',
          'success',
          'Persisted latest editor content before publication',
        );
      }

      const synced = await this.assetCatalogService.syncDocumentToAssets({
        documentId: document.id,
        documentName: document.name,
        description: document.description,
        spec: parsedSpec,
        metadata: document.metadata,
      });
      logStep(
        'asset.synced',
        'success',
        `Synchronized ${synced.endpoints.length} endpoints into the asset catalog`,
        `Source asset: ${synced.sourceServiceAsset.sourceKey}`,
      );

      const replaceExisting = input.replaceExisting ?? true;
      const existingRuntimeAsset = await this.runtimeAssetRepository.findOne({
        where: { name: publicationName },
      });
      if (existingRuntimeAsset) {
        if (existingRuntimeAsset.type !== RuntimeAssetType.MCP_SERVER) {
          throw new BadRequestException(
            `Runtime asset '${publicationName}' already exists and is not an MCP runtime asset`,
          );
        }
        if (!replaceExisting) {
          throw new BadRequestException(
            `Runtime asset '${publicationName}' already exists`,
          );
        }
        await this.removeExistingMcpRuntimeAsset(existingRuntimeAsset, logStep);
      }

      const conflictingManagedServer = await this.mcpServerRepository.findOne({
        where: { name: publicationName },
      });
      if (
        conflictingManagedServer &&
        !((conflictingManagedServer.config || {}).managedByRuntimeAsset === true)
      ) {
        throw new BadRequestException(
          `Managed server '${publicationName}' already exists and is not runtime-asset-managed`,
        );
      }

      const matchedEndpoints = await this.matchDocumentEndpointsForQuickPublish(
        synced.sourceServiceAsset.id,
        parseResult.endpoints || [],
      );
      if (matchedEndpoints.length === 0) {
        throw new BadRequestException(
          'No endpoint definitions were matched from the imported document',
        );
      }

      await this.bootstrapEndpointReadinessForQuickPublish(
        matchedEndpoints,
        synced.sourceServiceAsset,
        document,
      );
      logStep(
        'endpoint.bootstrap',
        'success',
        `Bootstrapped ${matchedEndpoints.length} endpoints to quick-publish readiness`,
        'Testing/probe metadata were marked as satisfied by the explicit quick publish action.',
      );

      const createdAsset = await this.publicationService.createPublicationRuntimeAsset(
        {
          type: RuntimeAssetType.MCP_SERVER,
          name: publicationName,
          displayName: document.name,
          description:
            document.description ||
            parseResult.info?.description ||
            `Quick published from document '${document.name}'`,
        },
        userId,
      );
      logStep(
        'runtime.created',
        'success',
        `Created MCP runtime asset '${publicationName}'`,
        `Runtime asset ID: ${createdAsset.runtimeAsset.id}`,
      );

      const membershipResult =
        await this.publicationService.addPublicationRuntimeMemberships(
          createdAsset.runtimeAsset.id,
          {
            endpointDefinitionIds: matchedEndpoints.map(item => item.id),
            enabled: true,
          },
          userId,
        );
      logStep(
        'membership.created',
        'success',
        `Created ${membershipResult.createdCount} runtime memberships`,
        membershipResult.existingCount > 0
          ? `Existing memberships reused: ${membershipResult.existingCount}`
          : undefined,
      );

      const membershipIds = [
        ...membershipResult.createdMemberships.map(item => item.id),
        ...membershipResult.existingMemberships.map(item => item.id),
      ];

      for (const membershipId of membershipIds) {
        const membershipState =
          await this.publicationService.getRuntimeMembershipPublicationState(
            membershipId,
          );
        await this.publicationService.upsertRuntimeMembershipProfile(
          membershipId,
          {
            intentName:
              membershipState.profile?.intentName ||
              membershipState.endpoint?.name ||
              `${membershipState.endpointDefinition.method} ${membershipState.endpointDefinition.path}`,
            descriptionForLlm:
              membershipState.profile?.descriptionForLlm ||
              membershipState.endpoint?.name ||
              `${membershipState.endpointDefinition.method} ${membershipState.endpointDefinition.path}`,
            operatorNotes: `Quick published from document '${document.name}' (${document.id})`,
            status: PublicationProfileStatus.REVIEWED,
          },
          userId,
        );
      }
      logStep(
        'profile.reviewed',
        'success',
        `Prepared ${membershipIds.length} publication profiles for MCP publish`,
      );

      const publishResult =
        await this.publicationService.batchPublishRuntimeMemberships(
          {
            membershipIds,
            publishToMcp: true,
            publishToHttp: false,
          },
          userId,
        );
      const publishFailures = publishResult.items.filter(
        item => item.status === 'failed',
      );
      if (publishFailures.length > 0) {
        logStep(
          'membership.publish',
          publishFailures.length === publishResult.items.length ? 'error' : 'warning',
          `Published ${publishResult.items.length - publishFailures.length}/${publishResult.items.length} memberships`,
          publishFailures
            .map(item => `${item.membershipId}: ${item.message || 'Unknown error'}`)
            .join('\n'),
        );
      } else {
        logStep(
          'membership.publish',
          'success',
          `Published ${publishResult.items.length} memberships into MCP runtime`,
          `Batch run ID: ${publishResult.batchRun.id}`,
        );
      }

      const deployment = await this.runtimeAssetsService.deployMcpRuntimeAsset(
        createdAsset.runtimeAsset.id,
        {
          name: publicationName,
          description:
            document.description ||
            parseResult.info?.description ||
            `Quick published from document '${document.name}'`,
        },
      );
      logStep(
        'runtime.deployed',
        'success',
        `Deployed MCP runtime asset into managed server '${deployment.managedServer?.name || publicationName}'`,
        `Managed server ID: ${deployment.managedServer?.id || 'n/a'}`,
      );

      document.status = DocumentStatus.PUBLISHED;
      document.metadata = {
        ...(document.metadata || {}),
        quickPublishMcp: {
          runtimeAssetId: createdAsset.runtimeAsset.id,
          managedServerId: deployment.managedServer?.id,
          batchRunId: publishResult.batchRun.id,
          toolsCount: parseResult.tools?.length || 0,
          endpointCount: matchedEndpoints.length,
          publishedAt: new Date().toISOString(),
        },
      };
      const updatedDocument = await this.documentRepository.save(document);
      logStep(
        'document.updated',
        'success',
        `Updated document metadata after MCP quick publish`,
      );

      return {
        document: this.toDetailResponseDto(updatedDocument),
        sourceServiceAsset: synced.sourceServiceAsset,
        runtimeAsset: deployment.runtimeAsset,
        managedServer: deployment.managedServer,
        runtimeSummary: deployment.runtimeSummary,
        publicationBatchRun: publishResult.batchRun,
        memberships: publishResult.items,
        tools: parseResult.tools || [],
        toolsCount: parseResult.tools?.length || 0,
        endpointCount: matchedEndpoints.length,
        processLogs,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'MCP quick publish failed';
      logStep('quick-publish.failed', 'error', message);
      this.logger.error(
        `Failed to quick publish document ${id} for user ${userId}: ${message}`,
      );

      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw new BadRequestException({
          message,
          processLogs,
        });
      }

      throw new InternalServerErrorException({
        message,
        processLogs,
      });
    }
  }

  /**
   * 验证JSON内容格式
   */
  private validateJsonContent(content: string): void {
    try {
      const parsed = JSON.parse(content);
      
      // 基本的OpenAPI规范验证
      if (!parsed.openapi && !parsed.swagger) {
        throw new BadRequestException('Content must be a valid OpenAPI/Swagger specification');
      }
      
      if (!parsed.info || !parsed.info.title || !parsed.info.version) {
        throw new BadRequestException('OpenAPI specification must have info.title and info.version');
      }
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException('Content must be valid JSON');
    }
  }

  private async matchDocumentEndpointsForQuickPublish(
    sourceServiceAssetId: string,
    parsedEndpoints: Array<{ method?: string; path?: string }>,
  ) {
    const matched: EndpointDefinitionEntity[] = [];
    const missing: string[] = [];

    for (const parsedEndpoint of parsedEndpoints) {
      const endpoint = await this.assetCatalogService.findEndpointDefinitionByMethodAndPath({
        sourceServiceAssetId,
        method: parsedEndpoint.method,
        path: parsedEndpoint.path,
      });
      if (!endpoint) {
        missing.push(`${parsedEndpoint.method || 'UNKNOWN'} ${parsedEndpoint.path || '/'}`);
        continue;
      }
      matched.push(endpoint);
    }

    if (missing.length > 0) {
      this.logger.warn(
        `Quick publish skipped ${missing.length} unmatched endpoints for source asset ${sourceServiceAssetId}: ${missing.join(', ')}`,
      );
    }

    return matched;
  }

  private async bootstrapEndpointReadinessForQuickPublish(
    endpoints: EndpointDefinitionEntity[],
    sourceServiceAsset: SourceServiceAssetEntity,
    document: OpenAPIDocument,
  ) {
    const now = new Date().toISOString();
    const baseUrl = this.buildBaseUrlFromSourceServiceAsset(sourceServiceAsset);

    for (const endpoint of endpoints) {
      endpoint.status = EndpointDefinitionStatus.VERIFIED;
      endpoint.publishEnabled = true;
      endpoint.metadata = {
        ...(endpoint.metadata || {}),
        lastProbeStatus: 'healthy',
        lastProbeAt: now,
        probeScope: 'quick_publish_mcp',
        probeUrl: `${baseUrl}${endpoint.path}`,
        testStatus: 'passed',
        qualificationState: 'tested',
        lastTestAt: now,
        lastTestMethod: endpoint.method,
        lastTestUrl: `${baseUrl}${endpoint.path}`,
        lastTestError: undefined,
        quickPublishBootstrap: {
          documentId: document.id,
          documentName: document.name,
          at: now,
        },
      };
    }

    await this.endpointDefinitionRepository.save(endpoints);
  }

  private async removeExistingMcpRuntimeAsset(
    existingRuntimeAsset: RuntimeAssetEntity,
    logStep: (
      step: string,
      level: QuickPublishLogLevel,
      summary: string,
      details?: string,
    ) => void,
  ) {
    logStep(
      'runtime.replace',
      'info',
      `Replacing existing MCP runtime asset '${existingRuntimeAsset.name}'`,
      `Runtime asset ID: ${existingRuntimeAsset.id}`,
    );

    try {
      await this.runtimeAssetsService.stopRuntimeAsset(existingRuntimeAsset.id);
      logStep(
        'runtime.stop',
        'success',
        `Stopped existing runtime asset '${existingRuntimeAsset.name}' before replacement`,
      );
    } catch (error) {
      logStep(
        'runtime.stop',
        'warning',
        `Failed to stop existing runtime asset '${existingRuntimeAsset.name}' before deletion`,
        error instanceof Error ? error.message : String(error),
      );
    }

    const memberships = await this.runtimeBindingRepository.find({
      where: { runtimeAssetId: existingRuntimeAsset.id },
    });
    const membershipIds = memberships.map(item => item.id);
    const profileIds =
      membershipIds.length > 0
        ? (
            await this.publicationProfileRepository.find({
              where: {
                runtimeAssetEndpointBindingId: In(membershipIds),
              },
            })
          ).map(item => item.id)
        : [];

    if (membershipIds.length > 0) {
      await this.gatewayRouteBindingRepository.delete({
        runtimeAssetEndpointBindingId: In(membershipIds),
      });
      await this.endpointPublishBindingRepository.delete({
        runtimeAssetEndpointBindingId: In(membershipIds),
      });
      await this.publicationProfileRepository.delete({
        runtimeAssetEndpointBindingId: In(membershipIds),
      });
      await this.runtimeBindingRepository.delete({
        runtimeAssetId: existingRuntimeAsset.id,
      });
    }

    if (profileIds.length > 0) {
      await this.publicationProfileHistoryRepository.delete({
        publicationProfileId: In(profileIds),
      });
    }

    const managedServers = await this.mcpServerRepository.find();
    const boundManagedServers = managedServers.filter(server => {
      const serverRuntimeAssetId = (server.config || {}).runtimeAssetId;
      return (
        serverRuntimeAssetId === existingRuntimeAsset.id ||
        (server.name === existingRuntimeAsset.name &&
          (server.config || {}).managedByRuntimeAsset === true)
      );
    });

    for (const managedServer of boundManagedServers) {
      await this.mcpServerRepository.delete({ id: managedServer.id });
    }

    await this.runtimeAssetRepository.delete({ id: existingRuntimeAsset.id });
    logStep(
      'runtime.deleted',
      'success',
      `Deleted existing MCP runtime asset '${existingRuntimeAsset.name}' before republish`,
      `Removed memberships: ${membershipIds.length}, managed servers: ${boundManagedServers.length}`,
    );
  }

  private buildBaseUrlFromSourceServiceAsset(sourceServiceAsset: SourceServiceAssetEntity) {
    const protocol = sourceServiceAsset.scheme || 'http';
    const port =
      (protocol === 'http' && sourceServiceAsset.port === 80) ||
      (protocol === 'https' && sourceServiceAsset.port === 443)
        ? ''
        : `:${sourceServiceAsset.port}`;
    const basePath =
      sourceServiceAsset.normalizedBasePath &&
      sourceServiceAsset.normalizedBasePath !== '/'
        ? sourceServiceAsset.normalizedBasePath
        : '';
    return `${protocol}://${sourceServiceAsset.host}${port}${basePath}`;
  }

  /**
   * 转换为响应DTO（不包含content）
   */
  private toResponseDto(document: OpenAPIDocument): DocumentResponseDto {
    const info = document.getInfo();
    const endpointCount = document.getEndpointCount();

    return {
      id: document.id,
      name: document.name,
      description: document.description,
      status: document.status,
      version: document.version,
      tags: document.tags,
      metadata: document.metadata,
      userId: document.userId,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      info,
      endpointCount,
    };
  }

  /**
   * 转换为详细响应DTO（包含content）
   */
  private toDetailResponseDto(document: OpenAPIDocument): DocumentDetailResponseDto {
    const baseDto = this.toResponseDto(document);
    
    return {
      ...baseDto,
      content: document.content,
    };
  }
}
