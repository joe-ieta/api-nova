import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  EndpointPublishBindingEntity,
  PublicationBindingStatus,
  PublicationReviewStatus,
} from '../../../database/entities/endpoint-publish-binding.entity';
import {
  PublicationAuditAction,
  PublicationAuditEventEntity,
  PublicationAuditStatus,
} from '../../../database/entities/publication-audit-event.entity';
import {
  PublicationBatchAction,
  PublicationBatchRunEntity,
  PublicationBatchStatus,
} from '../../../database/entities/publication-batch-run.entity';
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
import {
  evaluateEndpointGovernanceReadiness,
  evaluatePublicationReadiness,
} from '../../asset-catalog/endpoint-readiness.policy';
import {
  AddPublicationRuntimeMembershipsDto,
  BatchOfflineRuntimeMembershipsDto,
  BatchPublishRuntimeMembershipsDto,
  CreatePublicationRuntimeAssetDto,
  ConfigureGatewayRouteBindingDto,
  OfflineEndpointDto,
  PublicationAuditQueryDto,
  PublicationBatchRunQueryDto,
  PublicationCandidateQueryDto,
  PublicationMembershipQueryDto,
  PublishEndpointDto,
  UpdatePublicationProfileDto,
} from '../dto/publication.dto';

type EndpointSummary = {
  path?: string;
  method?: string;
};

type MembershipPublicationContext = {
  endpointDefinition: EndpointDefinitionEntity;
  sourceServiceAsset: SourceServiceAssetEntity;
  runtimeAsset: RuntimeAssetEntity;
  membership: RuntimeAssetEndpointBindingEntity;
};

type PublicationAuditContext = {
  actorId?: string;
  batchRunId?: string;
};

@Injectable()
export class PublicationService {
  constructor(
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
    @InjectRepository(PublicationBatchRunEntity)
    private readonly batchRunRepository: Repository<PublicationBatchRunEntity>,
    @InjectRepository(PublicationAuditEventEntity)
    private readonly auditEventRepository: Repository<PublicationAuditEventEntity>,
    @InjectRepository(EndpointPublishBindingEntity)
    private readonly bindingRepository: Repository<EndpointPublishBindingEntity>,
    @InjectRepository(GatewayRouteBindingEntity)
    private readonly routeBindingRepository: Repository<GatewayRouteBindingEntity>,
  ) {}

  async listPublicationCandidates(query: PublicationCandidateQueryDto = {}) {
    const endpoints = await this.endpointDefinitionRepository.find({
      order: {
        updatedAt: 'DESC',
      },
    });
    const sourceServiceIds = Array.from(
      new Set(endpoints.map(item => item.sourceServiceAssetId).filter(Boolean)),
    );
    const sourceServices = await this.sourceServiceRepository.findByIds(sourceServiceIds);
    const sourceServiceMap = new Map(sourceServices.map(item => [item.id, item]));

    const memberships = await this.runtimeBindingRepository.find({
      order: {
        updatedAt: 'DESC',
      },
    });
    const runtimeAssets = await this.runtimeAssetRepository.find();
    const runtimeAssetMap = new Map(runtimeAssets.map(item => [item.id, item]));
    const membershipMap = new Map<string, RuntimeAssetEndpointBindingEntity[]>();
    for (const membership of memberships) {
      const list = membershipMap.get(membership.endpointDefinitionId) || [];
      list.push(membership);
      membershipMap.set(membership.endpointDefinitionId, list);
    }

    const search = String(query.search || '').trim().toLowerCase();
    const includeBlocked = Boolean(query.includeBlocked);

    const data = endpoints
      .map(endpointDefinition => {
        const sourceServiceAsset = sourceServiceMap.get(endpointDefinition.sourceServiceAssetId);
        const readiness = this.buildGovernanceReadiness(endpointDefinition);
        const runtimeMemberships = (membershipMap.get(endpointDefinition.id) || [])
          .map(membership => ({
            membership,
            runtimeAsset: runtimeAssetMap.get(membership.runtimeAssetId) || null,
          }))
          .filter(item => item.runtimeAsset);

        return {
          endpointDefinition,
          sourceServiceAsset,
          readiness,
          runtimeMemberships: runtimeMemberships.map(item => ({
            membershipId: item.membership.id,
            runtimeAssetId: item.membership.runtimeAssetId,
            runtimeAssetType: item.runtimeAsset!.type,
            runtimeAssetName: item.runtimeAsset!.displayName || item.runtimeAsset!.name,
            membershipStatus: item.membership.status,
            publicationRevision: item.membership.publicationRevision,
            enabled: item.membership.enabled,
          })),
        };
      })
      .filter(item => {
        if (query.sourceServiceAssetId && item.endpointDefinition.sourceServiceAssetId !== query.sourceServiceAssetId) {
          return false;
        }
        if (!includeBlocked && !item.readiness.ready) {
          return false;
        }
        if (!search) {
          return true;
        }
        return [
          item.endpointDefinition.summary,
          item.endpointDefinition.operationId,
          item.endpointDefinition.method,
          item.endpointDefinition.path,
          item.sourceServiceAsset?.displayName,
          item.sourceServiceAsset?.sourceKey,
        ]
          .filter(Boolean)
          .some(value => String(value).toLowerCase().includes(search));
      });

    return {
      total: data.length,
      data,
    };
  }

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

    if (query.endpointDefinitionId) {
      memberships = memberships.filter(
        membership => membership.endpointDefinitionId === query.endpointDefinitionId,
      );
    }

    const data = await Promise.all(
      memberships.map(async membership => {
        const context = await this.resolveMembershipPublicationContext(membership.id);
        const profile = await this.ensureProfile(
          context.membership,
          context.endpointDefinition,
        );
        const publishBinding = await this.ensurePublishBinding(
          context.membership,
          context.endpointDefinition.id,
        );
        const routeBinding =
          context.runtimeAsset.type === RuntimeAssetType.GATEWAY_SERVICE
            ? await this.findGatewayRouteBinding(context.membership.id)
            : null;

        return {
          membership,
          runtimeAsset: context.runtimeAsset,
          endpoint: {
            id: context.endpointDefinition.id,
            name: this.buildEndpointDisplayName(context.endpointDefinition),
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
          readiness: this.buildReadiness(
            context.endpointDefinition,
            profile,
            routeBinding,
            context.runtimeAsset.type === RuntimeAssetType.GATEWAY_SERVICE,
          ),
        };
      }),
    );

    return {
      total: data.length,
      data,
    };
  }

  async listPublicationAuditEvents(query: PublicationAuditQueryDto = {}) {
    const where: Record<string, unknown> = {};
    if (query.runtimeAssetId) {
      where.runtimeAssetId = query.runtimeAssetId;
    }
    if (query.runtimeAssetEndpointBindingId) {
      where.runtimeAssetEndpointBindingId = query.runtimeAssetEndpointBindingId;
    }
    if (query.publicationBatchRunId) {
      where.publicationBatchRunId = query.publicationBatchRunId;
    }

    const limit = Math.max(1, Math.min(Number(query.limit || 20), 100));
    const data = await this.auditEventRepository.find({
      where,
      order: { createdAt: 'DESC' },
      take: limit,
    });

    return {
      total: data.length,
      data,
    };
  }

  async listPublicationBatchRuns(query: PublicationBatchRunQueryDto = {}) {
    const where: Record<string, unknown> = {};
    if (query.runtimeAssetId) {
      where.runtimeAssetId = query.runtimeAssetId;
    }
    if (query.action) {
      where.action = query.action;
    }

    const limit = Math.max(1, Math.min(Number(query.limit || 20), 100));
    const data = await this.batchRunRepository.find({
      where,
      order: { createdAt: 'DESC' },
      take: limit,
    });

    return {
      total: data.length,
      data,
    };
  }

  async createPublicationRuntimeAsset(
    dto: CreatePublicationRuntimeAssetDto,
    actorId?: string,
  ) {
    const normalizedName = String(dto.name || '').trim();
    if (!normalizedName) {
      throw new BadRequestException('runtime asset name is required');
    }

    const existing = await this.runtimeAssetRepository.findOne({
      where: { name: normalizedName },
    });
    if (existing) {
      throw new BadRequestException(`Runtime asset '${normalizedName}' already exists`);
    }

    const runtimeAsset = this.runtimeAssetRepository.create({
      name: normalizedName,
      type: dto.type,
      status: RuntimeAssetStatus.DRAFT,
      displayName: dto.displayName?.trim() || normalizedName,
      description: dto.description?.trim() || undefined,
      policyBindingRef: dto.policyBindingRef?.trim() || undefined,
      metadata: {
        source: 'api-publication',
        lifecycleStage: 'publication-draft',
      },
    });
    const saved = await this.runtimeAssetRepository.save(runtimeAsset);
    await this.recordAuditEvent({
      action: PublicationAuditAction.RUNTIME_ASSET_CREATED,
      status: PublicationAuditStatus.SUCCESS,
      summary: `Runtime asset '${saved.displayName || saved.name}' created`,
      runtimeAssetId: saved.id,
      operatorId: actorId,
      details: {
        type: saved.type,
        name: saved.name,
        displayName: saved.displayName,
      },
    });

    return {
      runtimeAsset: saved,
      membershipCount: 0,
    };
  }

  async addPublicationRuntimeMemberships(
    runtimeAssetId: string,
    dto: AddPublicationRuntimeMembershipsDto,
    actorId?: string,
  ) {
    const runtimeAsset = await this.requireRuntimeAsset(runtimeAssetId);
    const created: RuntimeAssetEndpointBindingEntity[] = [];
    const existing: RuntimeAssetEndpointBindingEntity[] = [];

    for (const endpointDefinitionId of dto.endpointDefinitionIds) {
      const endpointDefinition = await this.requireEndpointDefinition(endpointDefinitionId);
      const readiness = this.buildGovernanceReadiness(endpointDefinition);
      if (!readiness.ready) {
        throw new BadRequestException(
          `Endpoint definition '${endpointDefinitionId}' is not ready for publication: ${readiness.reasons.join('; ')}`,
        );
      }

      let membership = await this.runtimeBindingRepository.findOne({
        where: {
          runtimeAssetId,
          endpointDefinitionId,
        },
      });

      if (membership) {
        existing.push(membership);
        continue;
      }

      membership = this.runtimeBindingRepository.create({
        runtimeAssetId,
        endpointDefinitionId,
        status: RuntimeAssetEndpointBindingStatus.DRAFT,
        publicationRevision: 0,
        enabled: dto.enabled ?? true,
        bindingConfig: {
          source: 'api-publication',
        },
      });
      created.push(await this.runtimeBindingRepository.save(membership));
    }

    if (created.length > 0) {
      await this.recordAuditEvent({
        action: PublicationAuditAction.MEMBERSHIPS_ADDED,
        status: PublicationAuditStatus.SUCCESS,
        summary: `${created.length} memberships added to runtime asset '${runtimeAsset.displayName || runtimeAsset.name}'`,
        runtimeAssetId: runtimeAsset.id,
        operatorId: actorId,
        details: {
          createdMembershipIds: created.map(item => item.id),
          endpointDefinitionIds: dto.endpointDefinitionIds,
          existingMembershipIds: existing.map(item => item.id),
        },
      });
    }

    return {
      runtimeAsset,
      createdCount: created.length,
      existingCount: existing.length,
      createdMemberships: created,
      existingMemberships: existing,
    };
  }

  async getRuntimeMembershipPublicationState(membershipId: string) {
    const context = await this.resolveMembershipPublicationContext(membershipId);
    return this.buildMembershipPublicationState(context);
  }

  async upsertRuntimeMembershipProfile(
    membershipId: string,
    dto: UpdatePublicationProfileDto,
    actorId?: string,
  ) {
    const context = await this.resolveMembershipPublicationContext(membershipId);
    const profile = await this.ensureProfile(
      context.membership,
      context.endpointDefinition,
    );

    Object.assign(profile, {
      ...dto,
      status: dto.status ?? profile.status,
    });

    const saved = await this.profileRepository.save(profile);
    await this.writeHistory(saved, 'profile.updated');
    await this.recordAuditEvent({
      action: PublicationAuditAction.PROFILE_UPDATED,
      status: PublicationAuditStatus.SUCCESS,
      summary: `Publication profile updated for membership '${membershipId}'`,
      runtimeAssetId: context.runtimeAsset.id,
      runtimeAssetEndpointBindingId: membershipId,
      endpointDefinitionId: context.endpointDefinition.id,
      sourceServiceAssetId: context.sourceServiceAsset.id,
      operatorId: actorId,
      details: {
        profileId: saved.id,
        profileStatus: saved.status,
      },
    });
    return this.buildMembershipPublicationState(context);
  }

  async configureRuntimeMembershipGatewayRoute(
    membershipId: string,
    dto: ConfigureGatewayRouteBindingDto,
    actorId?: string,
  ) {
    const context = await this.resolveMembershipPublicationContext(membershipId);
    if (context.runtimeAsset.type !== RuntimeAssetType.GATEWAY_SERVICE) {
      throw new BadRequestException(
        `Runtime membership '${membershipId}' is not a gateway publication membership`,
      );
    }

    const summary = this.extractPrimaryEndpoint(context.endpointDefinition);
    const routePath = this.normalizeRoutePath(dto.routePath ?? summary.path);
    const upstreamPath = this.normalizeRoutePath(dto.upstreamPath ?? summary.path);
    const routeMethod = this.normalizeMethod(dto.routeMethod ?? summary.method);
    const upstreamMethod = this.normalizeMethod(
      dto.upstreamMethod ?? summary.method ?? dto.routeMethod,
    );

    let binding = await this.findGatewayRouteBinding(membershipId);
    if (!binding) {
      binding = this.routeBindingRepository.create({
        endpointDefinitionId: context.endpointDefinition.id,
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
        endpointDefinitionId: context.endpointDefinition.id,
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
    await this.recordAuditEvent({
      action: PublicationAuditAction.GATEWAY_ROUTE_UPDATED,
      status: PublicationAuditStatus.SUCCESS,
      summary: `Gateway route updated for membership '${membershipId}'`,
      runtimeAssetId: context.runtimeAsset.id,
      runtimeAssetEndpointBindingId: membershipId,
      endpointDefinitionId: context.endpointDefinition.id,
      sourceServiceAssetId: context.sourceServiceAsset.id,
      operatorId: actorId,
      details: {
        routePath: binding.routePath,
        routeMethod: binding.routeMethod,
        upstreamPath: binding.upstreamPath,
        upstreamMethod: binding.upstreamMethod,
      },
    });
    return this.buildMembershipPublicationState(context);
  }

  async publishRuntimeMembership(
    membershipId: string,
    dto: PublishEndpointDto,
    actorId?: string,
  ) {
    const context = await this.resolveMembershipPublicationContext(membershipId);

    if (context.runtimeAsset.type === RuntimeAssetType.MCP_SERVER) {
      return this.publishMembershipContext(
        context,
        dto.publishToMcp ?? true,
        { actorId },
      );
    }

    return this.publishMembershipContext(
      context,
      dto.publishToHttp ?? true,
      { actorId },
    );
  }

  async offlineRuntimeMembership(
    membershipId: string,
    dto: OfflineEndpointDto,
    actorId?: string,
  ) {
    const context = await this.resolveMembershipPublicationContext(membershipId);

    if (context.runtimeAsset.type === RuntimeAssetType.MCP_SERVER) {
      return this.offlineMembershipContext(
        context,
        dto.offlineMcp ?? true,
        { actorId },
      );
    }

    return this.offlineMembershipContext(
      context,
      dto.offlineHttp ?? true,
      { actorId },
    );
  }

  async batchPublishRuntimeMemberships(
    dto: BatchPublishRuntimeMembershipsDto,
    actorId?: string,
  ) {
    return this.executeBatchMembershipAction(
      PublicationBatchAction.PUBLISH,
      dto.membershipIds,
      async (context, batchRunId) =>
        this.publishMembershipContext(
          context,
          context.runtimeAsset.type === RuntimeAssetType.MCP_SERVER
            ? dto.publishToMcp ?? true
            : dto.publishToHttp ?? true,
          { actorId, batchRunId },
        ),
      actorId,
      dto,
    );
  }

  async batchOfflineRuntimeMemberships(
    dto: BatchOfflineRuntimeMembershipsDto,
    actorId?: string,
  ) {
    return this.executeBatchMembershipAction(
      PublicationBatchAction.OFFLINE,
      dto.membershipIds,
      async (context, batchRunId) =>
        this.offlineMembershipContext(
          context,
          context.runtimeAsset.type === RuntimeAssetType.MCP_SERVER
            ? dto.offlineMcp ?? true
            : dto.offlineHttp ?? true,
          { actorId, batchRunId },
        ),
      actorId,
      dto,
    );
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

  async getActivePublicationBinding(
    endpointDefinitionId: string,
    runtimeAssetEndpointBindingId?: string,
  ) {
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
        endpointDefinitionId,
        publishStatus: PublicationBindingStatus.ACTIVE,
      },
      order: {
        updatedAt: 'DESC',
      },
    });
  }

  async resolveActiveGatewayTarget(routePath: string, routeMethod: string) {
    const matched = await this.findActiveGatewayBinding(routePath, routeMethod);
    if (!matched) {
      return null;
    }

    const publishBinding = await this.getActivePublicationBinding(
      matched.binding.endpointDefinitionId,
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

  private async executeBatchMembershipAction(
    action: PublicationBatchAction,
    membershipIds: string[],
    executor: (
      context: MembershipPublicationContext,
      batchRunId: string,
    ) => Promise<unknown>,
    actorId?: string,
    requestPayload?: unknown,
  ) {
    const contexts = await Promise.all(
      membershipIds.map(async membershipId => this.resolveMembershipPublicationContext(membershipId)),
    );
    const runtimeAsset = contexts[0]?.runtimeAsset || null;
    if (
      runtimeAsset &&
      contexts.some(context => context.runtimeAsset.id !== runtimeAsset.id)
    ) {
      throw new BadRequestException(
        'Batch publication actions must target memberships under the same runtime asset',
      );
    }

    const batchRun = await this.createBatchRun({
      action,
      runtimeAssetId: runtimeAsset?.id,
      runtimeAssetType: runtimeAsset?.type,
      totalCount: membershipIds.length,
      operatorId: actorId,
      requestPayload:
        requestPayload && typeof requestPayload === 'object'
          ? (requestPayload as Record<string, unknown>)
          : undefined,
    });

    const items: Array<{
      membershipId: string;
      endpointDefinitionId: string;
      status: 'success' | 'failed';
      message?: string;
    }> = [];

    for (const context of contexts) {
      try {
        await executor(context, batchRun.id);
        items.push({
          membershipId: context.membership.id,
          endpointDefinitionId: context.endpointDefinition.id,
          status: 'success',
        });
      } catch (error: any) {
        await this.recordAuditEvent({
          action:
            action === PublicationBatchAction.PUBLISH
              ? PublicationAuditAction.MEMBERSHIP_PUBLISHED
              : PublicationAuditAction.MEMBERSHIP_OFFLINED,
          status: PublicationAuditStatus.FAILED,
          summary: `Membership '${context.membership.id}' ${action} failed`,
          publicationBatchRunId: batchRun.id,
          runtimeAssetId: context.runtimeAsset.id,
          runtimeAssetEndpointBindingId: context.membership.id,
          endpointDefinitionId: context.endpointDefinition.id,
          sourceServiceAssetId: context.sourceServiceAsset.id,
          operatorId: actorId,
          details: {
            action,
            error: error?.message || 'Unknown error',
          },
        });
        items.push({
          membershipId: context.membership.id,
          endpointDefinitionId: context.endpointDefinition.id,
          status: 'failed',
          message: error?.message || 'Unknown error',
        });
      }
    }

    const successCount = items.filter(item => item.status === 'success').length;
    const failedCount = items.length - successCount;
    const finalStatus =
      failedCount === 0
        ? PublicationBatchStatus.SUCCESS
        : successCount > 0
          ? PublicationBatchStatus.PARTIAL
          : PublicationBatchStatus.FAILED;

    const completedBatchRun = await this.completeBatchRun(batchRun, {
      status: finalStatus,
      successCount,
      failedCount,
      resultSummary: {
        items,
      },
    });

    await this.recordAuditEvent({
      action:
        action === PublicationBatchAction.PUBLISH
          ? PublicationAuditAction.BATCH_PUBLISH
          : PublicationAuditAction.BATCH_OFFLINE,
      status:
        finalStatus === PublicationBatchStatus.SUCCESS
          ? PublicationAuditStatus.SUCCESS
          : finalStatus === PublicationBatchStatus.PARTIAL
            ? PublicationAuditStatus.PARTIAL
            : PublicationAuditStatus.FAILED,
      summary: `Batch ${action} completed for ${successCount}/${items.length} memberships`,
      publicationBatchRunId: completedBatchRun.id,
      runtimeAssetId: completedBatchRun.runtimeAssetId,
      operatorId: actorId,
      details: {
        action,
        successCount,
        failedCount,
        items,
      },
    });

    return {
      batchRun: completedBatchRun,
      items,
    };
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
    return {
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
    const profile = await this.ensureProfile(
      context.membership,
      context.endpointDefinition,
    );
    const publishBinding = await this.ensurePublishBinding(
      context.membership,
      context.endpointDefinition.id,
    );
    const routeBinding =
      context.runtimeAsset.type === RuntimeAssetType.GATEWAY_SERVICE
        ? await this.findGatewayRouteBinding(context.membership.id)
        : null;

    return {
      endpoint: {
        id: context.endpointDefinition.id,
        name: this.buildEndpointDisplayName(context.endpointDefinition),
        status: context.endpointDefinition.status,
        healthy:
          ((context.endpointDefinition.metadata || {}) as Record<string, unknown>)
            .lastProbeStatus === 'healthy',
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
      readiness: this.buildReadiness(
        context.endpointDefinition,
        profile,
        routeBinding,
        context.runtimeAsset.type === RuntimeAssetType.GATEWAY_SERVICE,
      ),
    };
  }

  private async ensureProfile(
    membership: RuntimeAssetEndpointBindingEntity,
    endpointDefinition: EndpointDefinitionEntity,
  ) {
    const current = await this.profileRepository.findOne({
      where: { runtimeAssetEndpointBindingId: membership.id },
      order: { version: 'DESC' },
    });

    if (current) {
      if (!current.endpointDefinitionId) {
        current.endpointDefinitionId = endpointDefinition.id;
        return this.profileRepository.save(current);
      }
      return current;
    }

    const created = this.profileRepository.create({
      endpointDefinitionId: endpointDefinition.id,
      runtimeAssetEndpointBindingId: membership.id,
      version: 1,
      intentName: this.buildEndpointDisplayName(endpointDefinition),
      descriptionForLlm:
        endpointDefinition.description ||
        endpointDefinition.summary ||
        `${endpointDefinition.method} ${endpointDefinition.path}`,
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
    endpointDefinitionId: string,
  ) {
    let binding = await this.bindingRepository.findOne({
      where: { runtimeAssetEndpointBindingId: membership.id },
    });

    if (!binding) {
      binding = this.bindingRepository.create({
        endpointDefinitionId,
        runtimeAssetEndpointBindingId: membership.id,
      });
    } else if (!binding.endpointDefinitionId) {
      binding.endpointDefinitionId = endpointDefinitionId;
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
    auditContext: PublicationAuditContext = {},
  ) {
    if (!shouldPublish) {
      return this.buildMembershipPublicationState(context);
    }

    const profile = await this.ensureProfile(
      context.membership,
      context.endpointDefinition,
    );
    const routeBinding =
      context.runtimeAsset.type === RuntimeAssetType.GATEWAY_SERVICE
        ? await this.findGatewayRouteBinding(context.membership.id)
        : null;
    const reasons = this.buildReadiness(
      context.endpointDefinition,
      profile,
      routeBinding,
      context.runtimeAsset.type === RuntimeAssetType.GATEWAY_SERVICE,
    ).reasons;
    if (reasons.length > 0) {
      throw new BadRequestException(`Publish blocked: ${reasons.join('; ')}`);
    }

    profile.status = PublicationProfileStatus.PUBLISHED;
    const savedProfile = await this.profileRepository.save(profile);
    const binding = await this.ensurePublishBinding(
      context.membership,
      context.endpointDefinition.id,
    );
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
    await this.recordAuditEvent({
      action: PublicationAuditAction.MEMBERSHIP_PUBLISHED,
      status: PublicationAuditStatus.SUCCESS,
      summary: `Membership '${context.membership.id}' published`,
      publicationBatchRunId: auditContext.batchRunId,
      runtimeAssetId: context.runtimeAsset.id,
      runtimeAssetEndpointBindingId: context.membership.id,
      endpointDefinitionId: context.endpointDefinition.id,
      sourceServiceAssetId: context.sourceServiceAsset.id,
      operatorId: auditContext.actorId,
      details: {
        publicationRevision: binding.publicationRevision,
        runtimeAssetType: context.runtimeAsset.type,
      },
    });

    return this.buildMembershipPublicationState(context);
  }

  private async offlineMembershipContext(
    context: MembershipPublicationContext,
    shouldOffline: boolean,
    auditContext: PublicationAuditContext = {},
  ) {
    if (!shouldOffline) {
      return this.buildMembershipPublicationState(context);
    }

    const binding = await this.ensurePublishBinding(
      context.membership,
      context.endpointDefinition.id,
    );
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

    const profile = await this.ensureProfile(
      context.membership,
      context.endpointDefinition,
    );
    profile.status = PublicationProfileStatus.OFFLINE;
    await this.profileRepository.save(profile);

    context.membership.status =
      binding.publishStatus === PublicationBindingStatus.ACTIVE
        ? RuntimeAssetEndpointBindingStatus.ACTIVE
        : RuntimeAssetEndpointBindingStatus.OFFLINE;
    await this.runtimeBindingRepository.save(context.membership);
    await this.recordAuditEvent({
      action: PublicationAuditAction.MEMBERSHIP_OFFLINED,
      status: PublicationAuditStatus.SUCCESS,
      summary: `Membership '${context.membership.id}' offlined`,
      publicationBatchRunId: auditContext.batchRunId,
      runtimeAssetId: context.runtimeAsset.id,
      runtimeAssetEndpointBindingId: context.membership.id,
      endpointDefinitionId: context.endpointDefinition.id,
      sourceServiceAssetId: context.sourceServiceAsset.id,
      operatorId: auditContext.actorId,
      details: {
        publishStatus: binding.publishStatus,
        runtimeAssetType: context.runtimeAsset.type,
      },
    });

    return this.buildMembershipPublicationState(context);
  }

  private buildReadiness(
    endpointDefinition: EndpointDefinitionEntity,
    profile: PublicationProfileEntity,
    routeBinding?: GatewayRouteBindingEntity | null,
    routeRequired = false,
  ) {
    return evaluatePublicationReadiness(endpointDefinition, profile, {
      routeRequired,
      routeConfigured: this.hasActiveRouteCandidate(routeBinding),
    });
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
        `Route conflict: ${routeMethod} ${routePath} is already bound to runtime membership '${existing.runtimeAssetEndpointBindingId || existing.endpointDefinitionId}'`,
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
      endpointDefinitionId: profile.endpointDefinitionId,
      runtimeAssetEndpointBindingId: profile.runtimeAssetEndpointBindingId,
      publicationProfileId: profile.id,
      version: profile.version,
      action,
      snapshot,
    });

    await this.historyRepository.save(history);
  }

  private async createBatchRun(input: {
    action: PublicationBatchAction;
    runtimeAssetId?: string;
    runtimeAssetType?: string;
    totalCount: number;
    operatorId?: string;
    requestPayload?: Record<string, unknown>;
  }) {
    const batchRun = this.batchRunRepository.create({
      action: input.action,
      status: PublicationBatchStatus.PENDING,
      runtimeAssetId: input.runtimeAssetId,
      runtimeAssetType: input.runtimeAssetType,
      totalCount: input.totalCount,
      operatorId: input.operatorId,
      requestPayload: input.requestPayload,
      startedAt: new Date(),
    });
    return this.batchRunRepository.save(batchRun);
  }

  private async completeBatchRun(
    batchRun: PublicationBatchRunEntity,
    input: {
      status: PublicationBatchStatus;
      successCount: number;
      failedCount: number;
      resultSummary?: Record<string, unknown>;
    },
  ) {
    batchRun.status = input.status;
    batchRun.successCount = input.successCount;
    batchRun.failedCount = input.failedCount;
    batchRun.resultSummary = input.resultSummary;
    batchRun.finishedAt = new Date();
    return this.batchRunRepository.save(batchRun);
  }

  private async recordAuditEvent(input: {
    action: PublicationAuditAction;
    status: PublicationAuditStatus;
    summary: string;
    details?: Record<string, unknown>;
    publicationBatchRunId?: string;
    runtimeAssetId?: string;
    runtimeAssetEndpointBindingId?: string;
    endpointDefinitionId?: string;
    sourceServiceAssetId?: string;
    operatorId?: string;
  }) {
    const event = this.auditEventRepository.create(input);
    return this.auditEventRepository.save(event);
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

  private async requireRuntimeAsset(runtimeAssetId: string) {
    const runtimeAsset = await this.runtimeAssetRepository.findOne({
      where: { id: runtimeAssetId },
    });
    if (!runtimeAsset) {
      throw new NotFoundException(`Runtime asset '${runtimeAssetId}' not found`);
    }
    return runtimeAsset;
  }

  private async requireEndpointDefinition(endpointDefinitionId: string) {
    const endpointDefinition = await this.endpointDefinitionRepository.findOne({
      where: { id: endpointDefinitionId },
    });
    if (!endpointDefinition) {
      throw new NotFoundException(`Endpoint definition '${endpointDefinitionId}' not found`);
    }
    return endpointDefinition;
  }

  private async activateRuntimeAsset(runtimeAsset: RuntimeAssetEntity) {
    if (runtimeAsset.status !== RuntimeAssetStatus.ACTIVE) {
      runtimeAsset.status = RuntimeAssetStatus.ACTIVE;
      await this.runtimeAssetRepository.save(runtimeAsset);
    }
  }

  private extractPrimaryEndpoint(
    endpointDefinition: EndpointDefinitionEntity,
  ): EndpointSummary {
    return {
      path: endpointDefinition.path,
      method: endpointDefinition.method,
    };
  }

  private buildEndpointDisplayName(endpointDefinition: EndpointDefinitionEntity) {
    return (
      endpointDefinition.summary ||
      endpointDefinition.operationId ||
      `${endpointDefinition.method} ${endpointDefinition.path}`
    );
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

  private buildGovernanceReadiness(endpointDefinition: EndpointDefinitionEntity) {
    return evaluateEndpointGovernanceReadiness(endpointDefinition);
  }
}
