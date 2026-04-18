import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MCPServerEntity } from '../../../database/entities/mcp-server.entity';
import {
  EndpointPublishBindingEntity,
  PublicationBindingStatus,
  PublicationReviewStatus,
} from '../../../database/entities/endpoint-publish-binding.entity';
import {
  GatewayRouteBindingEntity,
  GatewayRouteBindingStatus,
} from '../../../database/entities/gateway-route-binding.entity';
import {
  PublicationProfileEntity,
  PublicationProfileStatus,
} from '../../../database/entities/publication-profile.entity';
import { PublicationProfileHistoryEntity } from '../../../database/entities/publication-profile-history.entity';
import {
  RuntimeAssetEndpointBindingEntity,
  RuntimeAssetEndpointBindingStatus,
} from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import {
  RuntimeAssetEntity,
  RuntimeAssetStatus,
  RuntimeAssetType,
} from '../../../database/entities/runtime-asset.entity';
import { EndpointDefinitionEntity } from '../../../database/entities/endpoint-definition.entity';
import { SourceServiceAssetEntity } from '../../../database/entities/source-service-asset.entity';
import { AssetCatalogService } from '../../asset-catalog/services/asset-catalog.service';
import {
  ConfigureGatewayRouteBindingDto,
  OfflineEndpointDto,
  PublicationMembershipQueryDto,
  PublishEndpointDto,
  UpdatePublicationProfileDto,
} from '../dto/publication.dto';

type EndpointSummary = {
  path?: string;
  method?: string;
};

type PublicationContext = {
  endpoint: MCPServerEntity;
  endpointDefinition: EndpointDefinitionEntity;
  mcpRuntimeAsset: RuntimeAssetEntity;
  mcpMembership: RuntimeAssetEndpointBindingEntity;
  gatewayRuntimeAsset: RuntimeAssetEntity;
  gatewayMembership: RuntimeAssetEndpointBindingEntity;
};

type MembershipPublicationContext = {
  endpoint: MCPServerEntity;
  endpointDefinition: EndpointDefinitionEntity;
  sourceServiceAsset: SourceServiceAssetEntity;
  runtimeAsset: RuntimeAssetEntity;
  membership: RuntimeAssetEndpointBindingEntity;
};

@Injectable()
export class PublicationService {
  constructor(
    @InjectRepository(MCPServerEntity)
    private readonly serverRepository: Repository<MCPServerEntity>,
    @InjectRepository(EndpointDefinitionEntity)
    private readonly endpointDefinitionRepository: Repository<EndpointDefinitionEntity>,
    @InjectRepository(RuntimeAssetEntity)
    private readonly runtimeAssetRepository: Repository<RuntimeAssetEntity>,
    @InjectRepository(RuntimeAssetEndpointBindingEntity)
    private readonly runtimeBindingRepository: Repository<RuntimeAssetEndpointBindingEntity>,
    @InjectRepository(SourceServiceAssetEntity)
    private readonly sourceServiceRepository: Repository<SourceServiceAssetEntity>,
    @InjectRepository(PublicationProfileEntity)
    private readonly profileRepository: Repository<PublicationProfileEntity>,
    @InjectRepository(PublicationProfileHistoryEntity)
    private readonly historyRepository: Repository<PublicationProfileHistoryEntity>,
    @InjectRepository(EndpointPublishBindingEntity)
    private readonly bindingRepository: Repository<EndpointPublishBindingEntity>,
    @InjectRepository(GatewayRouteBindingEntity)
    private readonly routeBindingRepository: Repository<GatewayRouteBindingEntity>,
    private readonly assetCatalogService: AssetCatalogService,
  ) {}

  async listRuntimeMemberships(query: PublicationMembershipQueryDto = {}) {
    const where: Record<string, unknown> = {};
    if (query.runtimeAssetId) {
      where.runtimeAssetId = query.runtimeAssetId;
    }

    let memberships = await this.runtimeBindingRepository.find({
      where,
      order: {
        updatedAt: 'DESC',
      },
    });

    if (query.endpointId) {
      memberships = memberships.filter(membership => {
        const legacyEndpointId = this.readLegacyEndpointIdFromBindingConfig(
          membership.bindingConfig,
        );
        return legacyEndpointId === query.endpointId;
      });
    }

    const data = await Promise.all(
      memberships.map(async membership => {
        const context = await this.resolveMembershipPublicationContext(membership.id);
        const profile = await this.ensureProfile(context.membership, context.endpoint);
        const publishBinding = await this.ensurePublishBinding(
          context.membership,
          context.endpoint.id,
        );
        const routeBinding =
          context.runtimeAsset.type === RuntimeAssetType.GATEWAY_SERVICE
            ? await this.findGatewayRouteBinding(context.membership.id)
            : null;

        return {
          membership,
          runtimeAsset: context.runtimeAsset,
          endpoint: {
            id: context.endpoint.id,
            name: context.endpoint.name,
          },
          endpointDefinition: {
            id: context.endpointDefinition.id,
            method: context.endpointDefinition.method,
            path: context.endpointDefinition.path,
            status: context.endpointDefinition.status,
          },
          profile,
          publishBinding,
          routeBinding,
          readiness: this.buildReadiness(profile, routeBinding),
        };
      }),
    );

    return {
      total: data.length,
      data,
    };
  }

  async getRuntimeMembershipPublicationState(membershipId: string) {
    const context = await this.resolveMembershipPublicationContext(membershipId);
    return this.buildMembershipPublicationState(context);
  }

  async upsertRuntimeMembershipProfile(
    membershipId: string,
    dto: UpdatePublicationProfileDto,
  ) {
    const context = await this.resolveMembershipPublicationContext(membershipId);
    const profile = await this.ensureProfile(context.membership, context.endpoint);

    Object.assign(profile, {
      ...dto,
      status: dto.status ?? profile.status,
    });

    const saved = await this.profileRepository.save(profile);
    await this.writeHistory(saved, 'profile.updated');
    return this.buildMembershipPublicationState(context);
  }

  async configureRuntimeMembershipGatewayRoute(
    membershipId: string,
    dto: ConfigureGatewayRouteBindingDto,
  ) {
    const context = await this.resolveMembershipPublicationContext(membershipId);
    if (context.runtimeAsset.type !== RuntimeAssetType.GATEWAY_SERVICE) {
      throw new BadRequestException(
        `Runtime membership '${membershipId}' is not a gateway publication membership`,
      );
    }

    const summary = this.extractPrimaryEndpoint(context.endpoint.openApiData);
    const routePath = this.normalizeRoutePath(dto.routePath ?? summary.path);
    const upstreamPath = this.normalizeRoutePath(dto.upstreamPath ?? summary.path);
    const routeMethod = this.normalizeMethod(dto.routeMethod ?? summary.method);
    const upstreamMethod = this.normalizeMethod(
      dto.upstreamMethod ?? summary.method ?? dto.routeMethod,
    );

    let binding = await this.findGatewayRouteBinding(membershipId);
    if (!binding) {
      binding = this.routeBindingRepository.create({
        endpointId: context.endpoint.id,
        runtimeAssetEndpointBindingId: membershipId,
        routePath,
        upstreamPath,
        routeMethod,
        upstreamMethod,
        routeVisibility: dto.routeVisibility ?? 'internal',
        authPolicyRef: dto.authPolicyRef,
        trafficPolicyRef: dto.trafficPolicyRef,
        timeoutMs: dto.timeoutMs,
        status: GatewayRouteBindingStatus.DRAFT,
      });
    } else {
      Object.assign(binding, {
        endpointId: context.endpoint.id,
        runtimeAssetEndpointBindingId: membershipId,
        routePath,
        upstreamPath,
        routeMethod,
        upstreamMethod,
        routeVisibility: dto.routeVisibility ?? binding.routeVisibility,
        authPolicyRef: dto.authPolicyRef ?? binding.authPolicyRef,
        trafficPolicyRef: dto.trafficPolicyRef ?? binding.trafficPolicyRef,
        timeoutMs: dto.timeoutMs ?? binding.timeoutMs,
      });
    }

    await this.ensureRouteConflictFree(membershipId, binding.routePath, binding.routeMethod);
    await this.routeBindingRepository.save(binding);
    return this.buildMembershipPublicationState(context);
  }

  async publishRuntimeMembership(
    membershipId: string,
    dto: PublishEndpointDto,
  ) {
    const context = await this.resolveMembershipPublicationContext(membershipId);

    if (context.runtimeAsset.type === RuntimeAssetType.MCP_SERVER) {
      return this.publishMembershipContext(context, dto.publishToMcp ?? true);
    }

    return this.publishMembershipContext(context, dto.publishToHttp ?? true);
  }

  async offlineRuntimeMembership(
    membershipId: string,
    dto: OfflineEndpointDto,
  ) {
    const context = await this.resolveMembershipPublicationContext(membershipId);

    if (context.runtimeAsset.type === RuntimeAssetType.MCP_SERVER) {
      return this.offlineMembershipContext(context, dto.offlineMcp ?? true);
    }

    return this.offlineMembershipContext(context, dto.offlineHttp ?? true);
  }

  async getEndpointPublicationState(endpointId: string) {
    const context = await this.resolvePublicationContext(endpointId);
    const mcpState = await this.buildMembershipPublicationState({
      endpoint: context.endpoint,
      endpointDefinition: context.endpointDefinition,
      sourceServiceAsset: await this.requireSourceServiceAsset(
        context.endpointDefinition.sourceServiceAssetId,
      ),
      runtimeAsset: context.mcpRuntimeAsset,
      membership: context.mcpMembership,
    });
    const gatewayState = await this.buildMembershipPublicationState({
      endpoint: context.endpoint,
      endpointDefinition: context.endpointDefinition,
      sourceServiceAsset: await this.requireSourceServiceAsset(
        context.endpointDefinition.sourceServiceAssetId,
      ),
      runtimeAsset: context.gatewayRuntimeAsset,
      membership: context.gatewayMembership,
    });

    return {
      endpoint: mcpState.endpoint,
      endpointDefinition: mcpState.endpointDefinition,
      runtimeAssets: {
        mcp: mcpState,
        gateway: gatewayState,
      },
      profile: mcpState.profile,
      publishBinding: mcpState.publishBinding,
      gatewayRouteBinding: gatewayState.routeBinding,
      readiness: gatewayState.readiness,
    };
  }

  async upsertProfile(endpointId: string, dto: UpdatePublicationProfileDto) {
    const context = await this.resolvePublicationContext(endpointId);
    return this.upsertRuntimeMembershipProfile(context.mcpMembership.id, dto);
  }

  async configureGatewayRoute(
    endpointId: string,
    dto: ConfigureGatewayRouteBindingDto,
  ) {
    const context = await this.resolvePublicationContext(endpointId);
    return this.configureRuntimeMembershipGatewayRoute(context.gatewayMembership.id, dto);
  }

  async publishEndpoint(endpointId: string, dto: PublishEndpointDto) {
    const context = await this.resolvePublicationContext(endpointId);
    const publishToMcp = dto.publishToMcp ?? true;
    const publishToHttp = dto.publishToHttp ?? false;

    if (publishToMcp) {
      await this.publishRuntimeMembership(context.mcpMembership.id, {
        publishToMcp: true,
      });
    }

    if (publishToHttp) {
      await this.publishRuntimeMembership(context.gatewayMembership.id, {
        publishToHttp: true,
      });
    }

    return this.getEndpointPublicationState(endpointId);
  }

  async offlineEndpoint(endpointId: string, dto: OfflineEndpointDto) {
    const context = await this.resolvePublicationContext(endpointId);
    const offlineMcp = dto.offlineMcp ?? true;
    const offlineHttp = dto.offlineHttp ?? true;

    if (offlineMcp) {
      await this.offlineRuntimeMembership(context.mcpMembership.id, {
        offlineMcp: true,
      });
    }

    if (offlineHttp) {
      await this.offlineRuntimeMembership(context.gatewayMembership.id, {
        offlineHttp: true,
      });
    }

    return this.getEndpointPublicationState(endpointId);
  }

  async findActiveGatewayBinding(routePath: string, routeMethod: string) {
    const normalizedPath = this.normalizeRoutePath(routePath);
    const normalizedMethod = this.normalizeMethod(routeMethod);
    const bindings = await this.routeBindingRepository.find({
      where: {
        routeMethod: normalizedMethod,
        status: GatewayRouteBindingStatus.ACTIVE,
      },
      order: {
        updatedAt: 'DESC',
      },
    });

    for (const binding of bindings) {
      const match = this.matchRoute(binding.routePath, normalizedPath);
      if (match.matched) {
        return {
          binding,
          params: match.params,
        };
      }
    }

    return null;
  }

  async getActivePublicationBinding(endpointId: string, runtimeAssetEndpointBindingId?: string) {
    if (runtimeAssetEndpointBindingId) {
      return this.bindingRepository.findOne({
        where: {
          runtimeAssetEndpointBindingId,
          publishStatus: PublicationBindingStatus.ACTIVE,
        },
      });
    }

    return this.bindingRepository.findOne({
      where: {
        endpointId,
        publishStatus: PublicationBindingStatus.ACTIVE,
      },
      order: {
        updatedAt: 'DESC',
      },
    });
  }

  async requireEndpoint(endpointId: string) {
    const endpoint = await this.serverRepository.findOne({ where: { id: endpointId } });
    if (!endpoint) {
      throw new NotFoundException(`Endpoint '${endpointId}' not found`);
    }
    return endpoint;
  }

  async resolveActiveGatewayTarget(routePath: string, routeMethod: string) {
    const matched = await this.findActiveGatewayBinding(routePath, routeMethod);
    if (!matched) {
      return null;
    }

    const publishBinding = await this.getActivePublicationBinding(
      matched.binding.endpointId,
      matched.binding.runtimeAssetEndpointBindingId,
    );
    if (!publishBinding?.publishedToHttp) {
      return null;
    }

    const context = await this.resolveMembershipPublicationContext(
      matched.binding.runtimeAssetEndpointBindingId || '',
    );
    if (context.runtimeAsset.type !== RuntimeAssetType.GATEWAY_SERVICE) {
      return null;
    }
    if (
      context.runtimeAsset.status !== RuntimeAssetStatus.ACTIVE &&
      context.runtimeAsset.status !== RuntimeAssetStatus.DEGRADED
    ) {
      return null;
    }

    return {
      binding: matched.binding,
      params: matched.params,
      publishBinding,
      membership: context.membership,
      runtimeAsset: context.runtimeAsset,
      endpointDefinition: context.endpointDefinition,
      sourceServiceAsset: context.sourceServiceAsset,
      upstreamBaseUrl: this.buildSourceServiceUrl(context.sourceServiceAsset),
    };
  }

  private async resolvePublicationContext(endpointId: string): Promise<PublicationContext> {
    const endpoint = await this.requireEndpoint(endpointId);
    const endpointDefinition = await this.resolveEndpointDefinition(endpoint);
    const mcpRuntimeAsset = await this.ensureRuntimeAsset(
      endpoint,
      endpointDefinition,
      RuntimeAssetType.MCP_SERVER,
    );
    const mcpMembership = await this.ensureRuntimeMembership(
      mcpRuntimeAsset,
      endpointDefinition,
    );
    const gatewayRuntimeAsset = await this.ensureRuntimeAsset(
      endpoint,
      endpointDefinition,
      RuntimeAssetType.GATEWAY_SERVICE,
    );
    const gatewayMembership = await this.ensureRuntimeMembership(
      gatewayRuntimeAsset,
      endpointDefinition,
    );

    return {
      endpoint,
      endpointDefinition,
      mcpRuntimeAsset,
      mcpMembership,
      gatewayRuntimeAsset,
      gatewayMembership,
    };
  }

  private async resolveEndpointDefinition(endpoint: MCPServerEntity) {
    const summary = this.extractPrimaryEndpoint(endpoint.openApiData);
    if (!summary.method || !summary.path) {
      throw new BadRequestException(
        `Endpoint '${endpoint.id}' does not expose a resolvable primary method/path`,
      );
    }

    const management = ((endpoint.config || {}) as Record<string, any>).management || {};
    const sourceServiceAsset = await this.assetCatalogService.findSourceServiceAssetForSpec(
      endpoint.openApiData,
      {
        originalUrl: management.sourceRef,
      },
    );
    if (!sourceServiceAsset) {
      throw new NotFoundException(
        `No source service asset found for endpoint '${endpoint.id}'`,
      );
    }

    const endpointDefinition = await this.assetCatalogService.findEndpointDefinitionByMethodAndPath({
      sourceServiceAssetId: sourceServiceAsset.id,
      method: summary.method,
      path: summary.path,
    });
    if (!endpointDefinition) {
      throw new NotFoundException(
        `No endpoint definition found for endpoint '${endpoint.id}'`,
      );
    }

    return endpointDefinition;
  }

  private async ensureRuntimeAsset(
    endpoint: MCPServerEntity,
    endpointDefinition: EndpointDefinitionEntity,
    type: RuntimeAssetType,
  ) {
    const runtimeName =
      type === RuntimeAssetType.MCP_SERVER
        ? `legacy-mcp-${endpointDefinition.id}`
        : `legacy-gateway-${endpointDefinition.id}`;

    let runtimeAsset = await this.runtimeAssetRepository.findOne({
      where: { name: runtimeName },
    });
    if (!runtimeAsset) {
      runtimeAsset = this.runtimeAssetRepository.create({
        name: runtimeName,
        type,
        status: RuntimeAssetStatus.DRAFT,
        displayName:
          type === RuntimeAssetType.MCP_SERVER
            ? `${endpoint.name} MCP`
            : `${endpoint.name} Gateway`,
        description: endpoint.description,
        metadata: {
          transitional: true,
          legacyEndpointId: endpoint.id,
          endpointDefinitionId: endpointDefinition.id,
        },
      });
    } else {
      runtimeAsset.displayName =
        runtimeAsset.displayName ||
        (type === RuntimeAssetType.MCP_SERVER
          ? `${endpoint.name} MCP`
          : `${endpoint.name} Gateway`);
      runtimeAsset.description = runtimeAsset.description || endpoint.description;
      runtimeAsset.metadata = {
        ...(runtimeAsset.metadata || {}),
        transitional: true,
        legacyEndpointId: endpoint.id,
        endpointDefinitionId: endpointDefinition.id,
      };
    }

    return this.runtimeAssetRepository.save(runtimeAsset);
  }

  private async ensureRuntimeMembership(
    runtimeAsset: RuntimeAssetEntity,
    endpointDefinition: EndpointDefinitionEntity,
  ) {
    let membership = await this.runtimeBindingRepository.findOne({
      where: {
        runtimeAssetId: runtimeAsset.id,
        endpointDefinitionId: endpointDefinition.id,
      },
    });

    if (!membership) {
      membership = this.runtimeBindingRepository.create({
        runtimeAssetId: runtimeAsset.id,
        endpointDefinitionId: endpointDefinition.id,
        status: RuntimeAssetEndpointBindingStatus.DRAFT,
        publicationRevision: 0,
        enabled: true,
        bindingConfig: {
          transitional: true,
          legacyEndpointId: (runtimeAsset.metadata || {})['legacyEndpointId'],
        },
      });
    } else {
      membership.bindingConfig = {
        ...(membership.bindingConfig || {}),
        transitional: true,
        legacyEndpointId:
          this.readLegacyEndpointIdFromBindingConfig(membership.bindingConfig) ||
          (runtimeAsset.metadata || {})['legacyEndpointId'],
      };
    }

    return this.runtimeBindingRepository.save(membership);
  }

  private async resolveMembershipPublicationContext(
    membershipId: string,
  ): Promise<MembershipPublicationContext> {
    const membership = await this.runtimeBindingRepository.findOne({
      where: { id: membershipId },
    });
    if (!membership) {
      throw new NotFoundException(
        `Runtime asset endpoint binding '${membershipId}' not found`,
      );
    }

    const runtimeAsset = await this.runtimeAssetRepository.findOne({
      where: { id: membership.runtimeAssetId },
    });
    if (!runtimeAsset) {
      throw new NotFoundException(
        `Runtime asset '${membership.runtimeAssetId}' not found`,
      );
    }

    const endpointDefinition = await this.endpointDefinitionRepository.findOne({
      where: { id: membership.endpointDefinitionId },
    });
    if (!endpointDefinition) {
      throw new NotFoundException(
        `Endpoint definition '${membership.endpointDefinitionId}' not found`,
      );
    }

    const endpointId =
      this.readLegacyEndpointIdFromBindingConfig(membership.bindingConfig) ||
      this.readLegacyEndpointIdFromRuntimeAsset(runtimeAsset.metadata);
    if (!endpointId) {
      throw new NotFoundException(
        `Legacy endpoint id cannot be resolved for runtime membership '${membershipId}'`,
      );
    }

    const endpoint = await this.requireEndpoint(endpointId);
    return {
      endpoint,
      endpointDefinition,
      sourceServiceAsset: await this.requireSourceServiceAsset(
        endpointDefinition.sourceServiceAssetId,
      ),
      runtimeAsset,
      membership,
    };
  }

  private async buildMembershipPublicationState(
    context: MembershipPublicationContext,
  ) {
    const profile = await this.ensureProfile(context.membership, context.endpoint);
    const publishBinding = await this.ensurePublishBinding(
      context.membership,
      context.endpoint.id,
    );
    const routeBinding =
      context.runtimeAsset.type === RuntimeAssetType.GATEWAY_SERVICE
        ? await this.findGatewayRouteBinding(context.membership.id)
        : null;

    return {
      endpoint: {
        id: context.endpoint.id,
        name: context.endpoint.name,
        status: context.endpoint.status,
        healthy: context.endpoint.healthy,
      },
      endpointDefinition: {
        id: context.endpointDefinition.id,
        method: context.endpointDefinition.method,
        path: context.endpointDefinition.path,
        status: context.endpointDefinition.status,
        publishEnabled: context.endpointDefinition.publishEnabled,
      },
      sourceServiceAsset: {
        id: context.sourceServiceAsset.id,
        sourceKey: context.sourceServiceAsset.sourceKey,
        displayName: context.sourceServiceAsset.displayName,
        host: context.sourceServiceAsset.host,
        port: context.sourceServiceAsset.port,
        normalizedBasePath: context.sourceServiceAsset.normalizedBasePath,
      },
      runtimeAsset: context.runtimeAsset,
      membership: context.membership,
      profile,
      publishBinding,
      routeBinding,
      readiness: this.buildReadiness(profile, routeBinding),
    };
  }

  private async ensureProfile(
    membership: RuntimeAssetEndpointBindingEntity,
    endpoint: MCPServerEntity,
  ) {
    const current = await this.profileRepository.findOne({
      where: { runtimeAssetEndpointBindingId: membership.id },
      order: { version: 'DESC' },
    });

    if (current) {
      if (!current.endpointId) {
        current.endpointId = endpoint.id;
        return this.profileRepository.save(current);
      }
      return current;
    }

    const created = this.profileRepository.create({
      endpointId: endpoint.id,
      runtimeAssetEndpointBindingId: membership.id,
      version: 1,
      intentName: endpoint.name,
      descriptionForLlm: endpoint.description,
      visibility: 'internal',
      status: PublicationProfileStatus.DRAFT,
      draftSource: 'stage3-membership-bootstrap',
    });

    const saved = await this.profileRepository.save(created);
    await this.writeHistory(saved, 'profile.created');
    return saved;
  }

  private async ensurePublishBinding(
    membership: RuntimeAssetEndpointBindingEntity,
    endpointId: string,
  ) {
    let binding = await this.bindingRepository.findOne({
      where: { runtimeAssetEndpointBindingId: membership.id },
    });

    if (!binding) {
      binding = this.bindingRepository.create({
        endpointId,
        runtimeAssetEndpointBindingId: membership.id,
      });
    } else if (!binding.endpointId) {
      binding.endpointId = endpointId;
    }

    return this.bindingRepository.save(binding);
  }

  private async findGatewayRouteBinding(runtimeAssetEndpointBindingId: string) {
    return this.routeBindingRepository.findOne({
      where: { runtimeAssetEndpointBindingId },
    });
  }

  private async publishMembershipContext(
    context: MembershipPublicationContext,
    shouldPublish: boolean,
  ) {
    if (!shouldPublish) {
      return this.buildMembershipPublicationState(context);
    }

    const profile = await this.ensureProfile(context.membership, context.endpoint);
    const routeBinding =
      context.runtimeAsset.type === RuntimeAssetType.GATEWAY_SERVICE
        ? await this.findGatewayRouteBinding(context.membership.id)
        : null;
    const reasons = this.buildReadiness(profile, routeBinding).reasons;
    if (
      context.runtimeAsset.type === RuntimeAssetType.GATEWAY_SERVICE &&
      !this.hasActiveRouteCandidate(routeBinding)
    ) {
      reasons.push('gateway route binding is missing');
    }
    if (reasons.length > 0) {
      throw new BadRequestException(`Publish blocked: ${reasons.join('; ')}`);
    }

    profile.status = PublicationProfileStatus.PUBLISHED;
    const savedProfile = await this.profileRepository.save(profile);
    const binding = await this.ensurePublishBinding(context.membership, context.endpoint.id);
    Object.assign(binding, {
      publicationProfileId: savedProfile.id,
      publicationRevision: binding.publicationRevision + 1,
      reviewStatus: PublicationReviewStatus.REVIEWED,
      publishStatus: PublicationBindingStatus.ACTIVE,
      publishedToMcp: context.runtimeAsset.type === RuntimeAssetType.MCP_SERVER,
      publishedToHttp: context.runtimeAsset.type === RuntimeAssetType.GATEWAY_SERVICE,
      publishedAt: new Date(),
      offlineAt: null,
      offlineBy: null,
    });
    const savedBinding = await this.bindingRepository.save(binding);

    if (routeBinding) {
      routeBinding.publishBindingId = savedBinding.id;
      routeBinding.status = GatewayRouteBindingStatus.ACTIVE;
      routeBinding.lastPublishedAt = new Date();
      await this.routeBindingRepository.save(routeBinding);
    }

    context.membership.status = RuntimeAssetEndpointBindingStatus.ACTIVE;
    context.membership.publicationRevision = binding.publicationRevision;
    await this.runtimeBindingRepository.save(context.membership);
    await this.activateRuntimeAsset(context.runtimeAsset);
    await this.writeHistory(savedProfile, 'profile.published');

    await this.syncLegacyManagementProfile(context.endpoint, {
      lifecycleStatus: 'published',
      publishEnabled: true,
      clearLastProbeError: true,
    });

    return this.buildMembershipPublicationState(context);
  }

  private async offlineMembershipContext(
    context: MembershipPublicationContext,
    shouldOffline: boolean,
  ) {
    if (!shouldOffline) {
      return this.buildMembershipPublicationState(context);
    }

    const binding = await this.ensurePublishBinding(context.membership, context.endpoint.id);
    binding.publishedToMcp =
      context.runtimeAsset.type === RuntimeAssetType.MCP_SERVER ? false : binding.publishedToMcp;
    binding.publishedToHttp =
      context.runtimeAsset.type === RuntimeAssetType.GATEWAY_SERVICE
        ? false
        : binding.publishedToHttp;
    binding.publishStatus =
      binding.publishedToMcp || binding.publishedToHttp
        ? PublicationBindingStatus.ACTIVE
        : PublicationBindingStatus.OFFLINE;
    binding.offlineAt = new Date();
    await this.bindingRepository.save(binding);

    if (context.runtimeAsset.type === RuntimeAssetType.GATEWAY_SERVICE) {
      const routeBinding = await this.findGatewayRouteBinding(context.membership.id);
      if (routeBinding) {
        routeBinding.status = GatewayRouteBindingStatus.OFFLINE;
        await this.routeBindingRepository.save(routeBinding);
      }
    }

    const profile = await this.ensureProfile(context.membership, context.endpoint);
    profile.status = PublicationProfileStatus.OFFLINE;
    await this.profileRepository.save(profile);

    context.membership.status =
      binding.publishStatus === PublicationBindingStatus.ACTIVE
        ? RuntimeAssetEndpointBindingStatus.ACTIVE
        : RuntimeAssetEndpointBindingStatus.OFFLINE;
    await this.runtimeBindingRepository.save(context.membership);

    const publishEnabled = await this.hasAnyActivePublication(context.endpoint.id);
    await this.syncLegacyManagementProfile(context.endpoint, {
      lifecycleStatus: publishEnabled ? 'published' : 'offline',
      publishEnabled,
    });

    return this.buildMembershipPublicationState(context);
  }

  private readLegacyEndpointIdFromBindingConfig(bindingConfig?: Record<string, unknown>) {
    const legacyEndpointId = bindingConfig?.legacyEndpointId;
    return typeof legacyEndpointId === 'string' ? legacyEndpointId : undefined;
  }

  private readLegacyEndpointIdFromRuntimeAsset(metadata?: Record<string, unknown>) {
    const legacyEndpointId = metadata?.legacyEndpointId;
    return typeof legacyEndpointId === 'string' ? legacyEndpointId : undefined;
  }

  private buildReadiness(
    profile: PublicationProfileEntity,
    routeBinding?: GatewayRouteBindingEntity | null,
  ) {
    const reasons: string[] = [];

    if (
      profile.status !== PublicationProfileStatus.REVIEWED &&
      profile.status !== PublicationProfileStatus.PUBLISHED
    ) {
      reasons.push(`profile status is ${profile.status}, expected reviewed or published`);
    }

    if (!profile.intentName) {
      reasons.push('intentName is empty');
    }

    if (!profile.descriptionForLlm) {
      reasons.push('descriptionForLlm is empty');
    }

    return {
      ready: reasons.length === 0,
      reasons,
      routeConfigured: this.hasActiveRouteCandidate(routeBinding),
    };
  }

  private hasActiveRouteCandidate(routeBinding?: GatewayRouteBindingEntity | null) {
    return Boolean(routeBinding?.routePath && routeBinding?.routeMethod);
  }

  private async ensureRouteConflictFree(
    runtimeAssetEndpointBindingId: string,
    routePath: string,
    routeMethod: string,
  ) {
    const existing = await this.routeBindingRepository.findOne({
      where: {
        routePath: this.normalizeRoutePath(routePath),
        routeMethod: this.normalizeMethod(routeMethod),
      },
    });

    if (
      existing &&
      existing.runtimeAssetEndpointBindingId !== runtimeAssetEndpointBindingId
    ) {
      throw new BadRequestException(
        `Route conflict: ${routeMethod} ${routePath} is already bound to runtime membership '${existing.runtimeAssetEndpointBindingId || existing.endpointId}'`,
      );
    }
  }

  private async writeHistory(profile: PublicationProfileEntity, action: string) {
    const snapshot = {
      intentName: profile.intentName,
      descriptionForLlm: profile.descriptionForLlm,
      operatorNotes: profile.operatorNotes,
      inputAliases: profile.inputAliases,
      constraints: profile.constraints,
      examples: profile.examples,
      visibility: profile.visibility,
      status: profile.status,
      version: profile.version,
    };

    const history = this.historyRepository.create({
      endpointId: profile.endpointId,
      runtimeAssetEndpointBindingId: profile.runtimeAssetEndpointBindingId,
      publicationProfileId: profile.id,
      version: profile.version,
      action,
      snapshot,
    });

    await this.historyRepository.save(history);
  }

  private async syncLegacyManagementProfile(
    endpoint: MCPServerEntity,
    options: {
      lifecycleStatus: 'published' | 'offline';
      publishEnabled: boolean;
      clearLastProbeError?: boolean;
    },
  ) {
    const raw = (endpoint.config || {}) as Record<string, any>;
    const management = (raw.management || {}) as Record<string, any>;
    endpoint.config = {
      ...raw,
      management: {
        ...management,
        lifecycleStatus: options.lifecycleStatus,
        publishEnabled: options.publishEnabled,
        ...(options.clearLastProbeError ? { lastProbeError: undefined } : {}),
      },
    };
    await this.serverRepository.save(endpoint);
  }

  private async requireSourceServiceAsset(sourceServiceAssetId: string) {
    const sourceServiceAsset = await this.sourceServiceRepository.findOne({
      where: { id: sourceServiceAssetId },
    });
    if (!sourceServiceAsset) {
      throw new NotFoundException(
        `Source service asset '${sourceServiceAssetId}' not found`,
      );
    }
    return sourceServiceAsset;
  }

  private async activateRuntimeAsset(runtimeAsset: RuntimeAssetEntity) {
    if (runtimeAsset.status !== RuntimeAssetStatus.ACTIVE) {
      runtimeAsset.status = RuntimeAssetStatus.ACTIVE;
      await this.runtimeAssetRepository.save(runtimeAsset);
    }
  }

  private async hasAnyActivePublication(endpointId: string) {
    const active = await this.bindingRepository.count({
      where: {
        endpointId,
        publishStatus: PublicationBindingStatus.ACTIVE,
      },
    });
    return active > 0;
  }

  private extractPrimaryEndpoint(openApiData: any): EndpointSummary {
    const paths = openApiData?.paths;
    if (!paths || typeof paths !== 'object') {
      return {};
    }

    const firstPath = Object.keys(paths)[0];
    if (!firstPath) {
      return {};
    }

    const operations = paths[firstPath];
    if (!operations || typeof operations !== 'object') {
      return { path: firstPath };
    }

    const firstMethod = Object.keys(operations)[0];
    return {
      path: firstPath,
      method: firstMethod?.toUpperCase(),
    };
  }

  private matchRoute(template: string, actualPath: string) {
    const templateSegments = this.normalizeRoutePath(template).split('/').filter(Boolean);
    const actualSegments = this.normalizeRoutePath(actualPath).split('/').filter(Boolean);

    if (templateSegments.length !== actualSegments.length) {
      return { matched: false, params: {} as Record<string, string> };
    }

    const params: Record<string, string> = {};
    for (let i = 0; i < templateSegments.length; i += 1) {
      const templateSegment = templateSegments[i];
      const actualSegment = actualSegments[i];
      const paramMatch = templateSegment.match(/^\{(.+)\}$/);
      if (paramMatch) {
        params[paramMatch[1]] = decodeURIComponent(actualSegment);
        continue;
      }
      if (templateSegment !== actualSegment) {
        return { matched: false, params: {} as Record<string, string> };
      }
    }

    return { matched: true, params };
  }

  private normalizeRoutePath(routePath?: string) {
    const value = String(routePath || '').trim();
    if (!value) {
      throw new BadRequestException('routePath is required');
    }
    return value.startsWith('/') ? value : `/${value}`;
  }

  private normalizeMethod(method?: string) {
    const value = String(method || '').trim().toUpperCase();
    if (!value) {
      throw new BadRequestException('routeMethod is required');
    }
    return value;
  }

  private buildSourceServiceUrl(sourceServiceAsset: SourceServiceAssetEntity) {
    const protocol = sourceServiceAsset.scheme || 'http';
    const defaultPort = protocol === 'https' ? 443 : 80;
    const portSegment =
      sourceServiceAsset.port && sourceServiceAsset.port !== defaultPort
        ? `:${sourceServiceAsset.port}`
        : '';
    const normalizedBasePath = sourceServiceAsset.normalizedBasePath || '/';
    return `${protocol}://${sourceServiceAsset.host}${portSegment}${normalizedBasePath}`.replace(
      /\/+$/,
      '',
    );
  }
}
