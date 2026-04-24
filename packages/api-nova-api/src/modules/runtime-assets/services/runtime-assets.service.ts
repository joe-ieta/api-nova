import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import * as http from 'node:http';
import { In, Like, Repository } from 'typeorm';
import { transformOpenApiToMcpTools } from 'api-nova-server';
import { EndpointDefinitionEntity } from '../../../database/entities/endpoint-definition.entity';
import { GatewayRouteBindingEntity } from '../../../database/entities/gateway-route-binding.entity';
import {
  GatewayConsumerCredentialEntity,
  GatewayConsumerCredentialStatus,
} from '../../../database/entities/gateway-consumer-credential.entity';
import { MCPServerEntity, ServerStatus, TransportType } from '../../../database/entities/mcp-server.entity';
import { PublicationProfileEntity } from '../../../database/entities/publication-profile.entity';
import { PublicationProfileHistoryEntity } from '../../../database/entities/publication-profile-history.entity';
import { RuntimeAssetEndpointBindingEntity } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import { RuntimeAssetEntity, RuntimeAssetType } from '../../../database/entities/runtime-asset.entity';
import { SourceServiceAssetEntity } from '../../../database/entities/source-service-asset.entity';
import { EndpointPublishBindingEntity } from '../../../database/entities/endpoint-publish-binding.entity';
import { PublicationAuditEventEntity } from '../../../database/entities/publication-audit-event.entity';
import { PublicationBatchRunEntity } from '../../../database/entities/publication-batch-run.entity';
import {
  AuditAction,
  AuditLevel,
  AuditStatus,
} from '../../../database/entities/audit-log.entity';
import {
  CreateGatewayConsumerCredentialDto,
  DeployRuntimeAssetGatewayDto,
  DeployRuntimeAssetMcpDto,
  GatewayConsumerCredentialQueryDto,
  RevokeGatewayConsumerCredentialDto,
  RuntimeAssetQueryDto,
  UpdateRuntimeAssetPolicyDto,
} from '../dto/runtime-assets.dto';
import { GatewayRuntimeMetricsService } from '../../gateway-runtime/services/gateway-runtime-metrics.service';
import { GatewayAccessLogService } from '../../gateway-runtime/services/gateway-access-log.service';
import {
  RuntimeObservabilityEventFamily,
  RuntimeObservabilitySeverity,
  RuntimeObservabilityStatus,
} from '../../../database/entities/runtime-observability-event.entity';
import {
  RuntimeCurrentStatus,
  RuntimeHealthStatus,
} from '../../../database/entities/runtime-observability-state.entity';
import { RuntimeObservabilityStateEntity } from '../../../database/entities/runtime-observability-state.entity';
import { RuntimeObservabilityEventEntity } from '../../../database/entities/runtime-observability-event.entity';
import { RuntimeMetricSeriesEntity } from '../../../database/entities/runtime-metric-series.entity';
import { RuntimeObservabilityService } from '../../runtime-observability/services/runtime-observability.service';
import {
  GATEWAY_SNAPSHOT_REFRESH_REQUESTED,
  type GatewaySnapshotRefreshPayload,
} from '../../gateway-runtime/gateway-runtime.events';
import { AuditService } from '../../security/services/audit.service';

type GatewayCredentialAuditContext = {
  actorId?: string;
  ipAddress?: string;
  userAgent?: string;
};

@Injectable()
export class RuntimeAssetsService {
  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly eventEmitter: EventEmitter2,
    @InjectRepository(RuntimeAssetEntity)
    private readonly runtimeAssetRepository: Repository<RuntimeAssetEntity>,
    @InjectRepository(MCPServerEntity)
    private readonly mcpServerRepository: Repository<MCPServerEntity>,
    @InjectRepository(RuntimeAssetEndpointBindingEntity)
    private readonly runtimeBindingRepository: Repository<RuntimeAssetEndpointBindingEntity>,
    @InjectRepository(EndpointDefinitionEntity)
    private readonly endpointDefinitionRepository: Repository<EndpointDefinitionEntity>,
    @InjectRepository(SourceServiceAssetEntity)
    private readonly sourceServiceRepository: Repository<SourceServiceAssetEntity>,
    @InjectRepository(PublicationProfileEntity)
    private readonly profileRepository: Repository<PublicationProfileEntity>,
    @InjectRepository(EndpointPublishBindingEntity)
    private readonly publishBindingRepository: Repository<EndpointPublishBindingEntity>,
    @InjectRepository(GatewayRouteBindingEntity)
    private readonly gatewayRouteRepository: Repository<GatewayRouteBindingEntity>,
    @InjectRepository(GatewayConsumerCredentialEntity)
    private readonly gatewayConsumerCredentialRepository: Repository<GatewayConsumerCredentialEntity>,
    private readonly gatewayRuntimeMetricsService: GatewayRuntimeMetricsService,
    private readonly gatewayAccessLogService: GatewayAccessLogService,
    private readonly runtimeObservabilityService: RuntimeObservabilityService,
    private readonly auditService: AuditService,
  ) {}

  async listRuntimeAssets(query: RuntimeAssetQueryDto = {}) {
    const where: Record<string, unknown> = {};
    if (query.type) {
      where.type = query.type;
    }
    if (query.status) {
      where.status = query.status;
    }
    if (query.search) {
      where.name = Like(`%${query.search}%`);
    }

    const runtimeAssets = await this.runtimeAssetRepository.find({
      where,
      order: {
        updatedAt: 'DESC',
      },
    });

    const filtered = query.search
      ? runtimeAssets.filter(asset => {
          const search = query.search!.toLowerCase();
          return [asset.name, asset.displayName]
            .filter(Boolean)
            .some(value => String(value).toLowerCase().includes(search));
        })
      : runtimeAssets;

    const data = await Promise.all(
      filtered.map(async asset => {
        const memberships = await this.runtimeBindingRepository.find({
          where: { runtimeAssetId: asset.id },
          order: { updatedAt: 'DESC' },
        });
        const persistedObservability =
          await this.runtimeObservabilityService.getRuntimeAssetObservability(asset.id);

        return {
          asset,
          managedServer: await this.findManagedServerSummary(asset),
          runtimeSummary: persistedObservability
            ? await this.buildRuntimeSummaryFromPersistedObservability(
                asset,
                memberships,
                persistedObservability,
              )
            : await this.buildRuntimeSummary(asset, memberships),
          membershipCount: memberships.length,
          activeMembershipCount: memberships.filter(m => m.status === 'active').length,
        };
      }),
    );

    return {
      total: data.length,
      data,
    };
  }

  async getRuntimeAssetDetail(id: string) {
    const asset = await this.requireRuntimeAsset(id);
    const memberships = await this.listRuntimeAssetMemberships(id);
    const managedServer = await this.findManagedServerForRuntimeAsset(asset);
    const membershipRows = await this.runtimeBindingRepository.find({
      where: { runtimeAssetId: id },
      order: { updatedAt: 'DESC' },
    });

    return {
      asset,
      managedServer: this.toManagedServerSummary(managedServer),
      runtimeSummary: await this.buildRuntimeSummary(asset, membershipRows, managedServer),
      memberships: memberships.data,
      membershipCount: memberships.total,
    };
  }

  async listRuntimeAssetMemberships(runtimeAssetId: string) {
    await this.requireRuntimeAsset(runtimeAssetId);

    const memberships = await this.runtimeBindingRepository.find({
      where: { runtimeAssetId },
      order: {
        updatedAt: 'DESC',
      },
    });

    const data = await Promise.all(
      memberships.map(async membership => {
        const endpointDefinition = await this.endpointDefinitionRepository.findOne({
          where: { id: membership.endpointDefinitionId },
        });
        const sourceServiceAsset = endpointDefinition
          ? await this.sourceServiceRepository.findOne({
              where: { id: endpointDefinition.sourceServiceAssetId },
            })
          : null;
        const profile = await this.profileRepository.findOne({
          where: { runtimeAssetEndpointBindingId: membership.id },
          order: { version: 'DESC' },
        });
        const publishBinding = await this.publishBindingRepository.findOne({
          where: { runtimeAssetEndpointBindingId: membership.id },
        });
        const gatewayRouteBinding = await this.gatewayRouteRepository.findOne({
          where: { runtimeAssetEndpointBindingId: membership.id },
        });

        return {
          membership,
          endpointDefinition,
          sourceServiceAsset,
          profile,
          publishBinding,
          gatewayRouteBinding,
        };
      }),
    );

    return {
      total: data.length,
      data,
    };
  }

  async assembleMcpRuntimeAssetPayload(runtimeAssetId: string) {
    const asset = await this.requireRuntimeAsset(runtimeAssetId);
    if (asset.type !== RuntimeAssetType.MCP_SERVER) {
      throw new NotFoundException(
        `Runtime asset '${runtimeAssetId}' is not an MCP runtime asset`,
      );
    }

    const memberships = await this.listRuntimeAssetMemberships(runtimeAssetId);
    const includedMemberships = memberships.data.filter(item => {
      if (!item.membership.enabled) {
        return false;
      }

      const publishBinding = item.publishBinding;
      if (!publishBinding) {
        return false;
      }

      return publishBinding.publishedToMcp || publishBinding.publishStatus === 'active';
    });

    const servers = new Map<string, { url: string; description?: string }>();
    const paths: Record<string, Record<string, unknown>> = {};

    for (const item of includedMemberships) {
      if (!item.endpointDefinition || !item.sourceServiceAsset) {
        continue;
      }

      const pathKey = item.endpointDefinition.path;
      const methodKey = item.endpointDefinition.method.toLowerCase();
      const sourceUrl = this.buildSourceServiceUrl(item.sourceServiceAsset);
      servers.set(item.sourceServiceAsset.id, {
        url: sourceUrl,
        description: item.sourceServiceAsset.displayName,
      });

      const rawOperation = {
        ...((item.endpointDefinition.rawOperation || {}) as Record<string, unknown>),
      };
      const profile = item.profile;
      const operation = {
        ...rawOperation,
        operationId:
          item.endpointDefinition.operationId ||
          String(rawOperation.operationId || `${methodKey}_${pathKey}`),
        summary:
          profile?.intentName ||
          item.endpointDefinition.summary ||
          String(rawOperation.summary || ''),
        description:
          profile?.descriptionForLlm ||
          item.endpointDefinition.description ||
          String(rawOperation.description || ''),
        servers: [
          {
            url: sourceUrl,
            description: item.sourceServiceAsset.displayName,
          },
        ],
        'x-runtime-asset-id': runtimeAssetId,
        'x-runtime-membership-id': item.membership.id,
        'x-endpoint-definition-id': item.endpointDefinition.id,
      };

      if (!paths[pathKey]) {
        paths[pathKey] = {};
      }
      paths[pathKey][methodKey] = operation;
    }

    const openApiData = {
      openapi: '3.0.3',
      info: {
        title: asset.displayName || asset.name,
        version: '1.0.0',
        description: asset.description || 'Assembled MCP runtime asset payload',
      },
      servers: Array.from(servers.values()),
      paths,
    };

    const tools = await transformOpenApiToMcpTools(undefined, undefined, openApiData);

    return {
      runtimeAsset: asset,
      managedServer: await this.findManagedServerSummary(asset),
      membershipCount: memberships.total,
      includedMembershipCount: includedMemberships.length,
      openApiData,
      tools,
      toolsCount: tools.length,
    };
  }

  async assembleGatewayRuntimeAssetPayload(
    runtimeAssetId: string,
    publishedOnly = true,
  ) {
    const asset = await this.requireRuntimeAsset(runtimeAssetId);
    if (asset.type !== RuntimeAssetType.GATEWAY_SERVICE) {
      throw new NotFoundException(
        `Runtime asset '${runtimeAssetId}' is not a gateway runtime asset`,
      );
    }

    const memberships = await this.listRuntimeAssetMemberships(runtimeAssetId);
    const includedMemberships = memberships.data.filter(item => {
      if (!item.membership.enabled) {
        return false;
      }
      if (!item.gatewayRouteBinding || !item.sourceServiceAsset || !item.endpointDefinition) {
        return false;
      }
      if (!publishedOnly) {
        return true;
      }
      return (
        item.gatewayRouteBinding.status === 'active' &&
        Boolean(item.publishBinding?.publishedToHttp)
      );
    });

    const routes = includedMemberships.map(item => this.toGatewayRouteView(item));

    return {
      runtimeAsset: asset,
      runtimeSummary: await this.buildRuntimeSummary(
        asset,
        await this.runtimeBindingRepository.find({ where: { runtimeAssetId } }),
      ),
      membershipCount: memberships.total,
      includedMembershipCount: includedMemberships.length,
      gatewayGovernance: this.buildGatewayGovernanceSummary(routes),
      routes,
    };
  }

  async deployGatewayRuntimeAsset(
    runtimeAssetId: string,
    dto: DeployRuntimeAssetGatewayDto = {},
  ) {
    const runtimeAsset = await this.requireRuntimeAsset(runtimeAssetId);
    if (runtimeAsset.type !== RuntimeAssetType.GATEWAY_SERVICE) {
      throw new NotFoundException(
        `Runtime asset '${runtimeAssetId}' is not a gateway runtime asset`,
      );
    }

    const assembly = await this.assembleGatewayRuntimeAssetPayload(
      runtimeAssetId,
      dto.publishedOnly ?? true,
    );
    runtimeAsset.policyBindingRef = dto.policyBindingRef ?? runtimeAsset.policyBindingRef;
    runtimeAsset.metadata = {
      ...(runtimeAsset.metadata || {}),
      gatewayDeployment: {
        deployedAt: new Date().toISOString(),
        routeCount: assembly.includedMembershipCount,
        publishedOnly: dto.publishedOnly ?? true,
      },
    };
    await this.runtimeAssetRepository.save(runtimeAsset);
    await this.runtimeObservabilityService.recordRuntimeControlEvent({
      runtimeAssetId,
      eventFamily: RuntimeObservabilityEventFamily.RUNTIME_CONTROL,
      eventName: 'gateway.deploy',
      status: RuntimeObservabilityStatus.SUCCESS,
      severity: RuntimeObservabilitySeverity.INFO,
      currentStatus: runtimeAsset.status === 'offline'
        ? RuntimeCurrentStatus.OFFLINE
        : RuntimeCurrentStatus.ACTIVE,
      healthStatus: RuntimeHealthStatus.UNKNOWN,
      summary: `Gateway runtime asset deployed with ${assembly.includedMembershipCount} routes`,
      details: {
        routeCount: assembly.includedMembershipCount,
        publishedOnly: dto.publishedOnly ?? true,
      },
    });
    this.emitGatewaySnapshotRefresh({
      reason: 'runtime_assets.gateway_deployed',
      runtimeAssetId,
    });

    return {
      runtimeAsset: await this.requireRuntimeAsset(runtimeAssetId),
      runtimeSummary: await this.buildRuntimeSummary(
        await this.requireRuntimeAsset(runtimeAssetId),
        await this.runtimeBindingRepository.find({ where: { runtimeAssetId } }),
      ),
      gatewayAssembly: assembly,
      action: 'deploy-gateway',
    };
  }

  async updateRuntimeAssetPolicyBinding(
    runtimeAssetId: string,
    dto: UpdateRuntimeAssetPolicyDto,
  ) {
    const runtimeAsset = await this.requireRuntimeAsset(runtimeAssetId);
    runtimeAsset.policyBindingRef = dto.policyBindingRef;
    await this.runtimeAssetRepository.save(runtimeAsset);
    await this.runtimeObservabilityService.recordRuntimeControlEvent({
      runtimeAssetId,
      eventFamily: RuntimeObservabilityEventFamily.RUNTIME_POLICY,
      eventName: 'runtime.policy_binding_updated',
      status: RuntimeObservabilityStatus.SUCCESS,
      severity: RuntimeObservabilitySeverity.INFO,
      currentStatus:
        runtimeAsset.status === 'active'
          ? RuntimeCurrentStatus.ACTIVE
          : runtimeAsset.status === 'degraded'
            ? RuntimeCurrentStatus.DEGRADED
            : runtimeAsset.status === 'offline'
              ? RuntimeCurrentStatus.OFFLINE
              : RuntimeCurrentStatus.DRAFT,
      healthStatus: RuntimeHealthStatus.UNKNOWN,
      summary: `Policy binding updated for runtime asset '${runtimeAssetId}'`,
      details: {
        policyBindingRef: dto.policyBindingRef,
      },
    });
    this.emitGatewaySnapshotRefresh({
      reason: 'runtime_assets.gateway_policy_updated',
      runtimeAssetId,
    });

    return {
      runtimeAsset,
      runtimeSummary: await this.buildRuntimeSummary(
        runtimeAsset,
        await this.runtimeBindingRepository.find({ where: { runtimeAssetId } }),
      ),
      action: 'update-policy-binding',
    };
  }

  async deleteRuntimeAsset(runtimeAssetId: string) {
    const runtimeAsset = await this.requireRuntimeAsset(runtimeAssetId);
    const memberships = await this.runtimeBindingRepository.find({
      where: { runtimeAssetId },
    });
    const membershipIds = memberships.map(item => item.id);
    const managedServer = await this.findManagedServerForRuntimeAsset(runtimeAsset);

    if (managedServer) {
      const serverManager = this.getServerManager();
      await serverManager.deleteServer(managedServer.id);
    }

    await this.runtimeAssetRepository.manager.transaction(async manager => {
      const gatewayConsumerCredentialRepository =
        manager.getRepository(GatewayConsumerCredentialEntity);
      const publishBindingRepository = manager.getRepository(EndpointPublishBindingEntity);
      const gatewayRouteRepository = manager.getRepository(GatewayRouteBindingEntity);
      const profileRepository = manager.getRepository(PublicationProfileEntity);
      const profileHistoryRepository =
        manager.getRepository(PublicationProfileHistoryEntity);
      const publicationAuditRepository =
        manager.getRepository(PublicationAuditEventEntity);
      const publicationBatchRunRepository =
        manager.getRepository(PublicationBatchRunEntity);
      const runtimeObservabilityStateRepository =
        manager.getRepository(RuntimeObservabilityStateEntity);
      const runtimeObservabilityEventRepository =
        manager.getRepository(RuntimeObservabilityEventEntity);
      const runtimeMetricSeriesRepository =
        manager.getRepository(RuntimeMetricSeriesEntity);
      const runtimeBindingRepository =
        manager.getRepository(RuntimeAssetEndpointBindingEntity);
      const runtimeAssetRepository = manager.getRepository(RuntimeAssetEntity);

      await gatewayConsumerCredentialRepository.delete({ runtimeAssetId });
      await publicationBatchRunRepository.delete({ runtimeAssetId });
      await publicationAuditRepository.delete({ runtimeAssetId });
      await runtimeObservabilityStateRepository.delete({ runtimeAssetId });
      await runtimeObservabilityEventRepository.delete({ runtimeAssetId });
      await runtimeMetricSeriesRepository.delete({ runtimeAssetId });

      if (membershipIds.length > 0) {
        await publicationAuditRepository.delete({
          runtimeAssetEndpointBindingId: In(membershipIds),
        });
        await gatewayRouteRepository.delete({
          runtimeAssetEndpointBindingId: In(membershipIds),
        });
        await publishBindingRepository.delete({
          runtimeAssetEndpointBindingId: In(membershipIds),
        });
        await profileHistoryRepository.delete({
          runtimeAssetEndpointBindingId: In(membershipIds),
        });
        await profileRepository.delete({
          runtimeAssetEndpointBindingId: In(membershipIds),
        });
        await runtimeObservabilityStateRepository.delete({
          runtimeAssetEndpointBindingId: In(membershipIds),
        });
        await runtimeObservabilityEventRepository.delete({
          runtimeAssetEndpointBindingId: In(membershipIds),
        });
        await runtimeMetricSeriesRepository.delete({
          runtimeAssetEndpointBindingId: In(membershipIds),
        });
      }

      await runtimeBindingRepository.delete({ runtimeAssetId });
      await runtimeAssetRepository.delete({ id: runtimeAssetId });
    });

    if (runtimeAsset.type === RuntimeAssetType.GATEWAY_SERVICE) {
      this.emitGatewaySnapshotRefresh({
        reason: 'runtime_assets.gateway_deleted',
        runtimeAssetId,
      });
    }

    return {
      runtimeAssetId,
      deleted: true,
    };
  }

  async getRuntimeAssetObservability(runtimeAssetId: string) {
    const runtimeAsset = await this.requireRuntimeAsset(runtimeAssetId);
    const memberships = await this.runtimeBindingRepository.find({
      where: { runtimeAssetId },
    });
    const persistedObservability =
      await this.runtimeObservabilityService.getRuntimeAssetObservability(runtimeAssetId);
    const managedServer = await this.findManagedServerForRuntimeAsset(runtimeAsset);
    const managedServerSummary = this.toManagedServerSummary(managedServer);

    return {
      runtimeAsset,
      observability: persistedObservability,
      runtimeSummary: await this.buildRuntimeSummaryFromPersistedObservability(
        runtimeAsset,
        memberships,
        persistedObservability,
      ),
      normalizedObservability: this.buildNormalizedObservabilityView(
        runtimeAsset,
        persistedObservability,
        managedServerSummary,
      ),
    };
  }

  async getManagedServerRuntimeAsset(serverId: string) {
    const managedServer = await this.mcpServerRepository.findOne({
      where: { id: serverId },
    });
    if (!managedServer) {
      throw new NotFoundException(`Managed server '${serverId}' not found`);
    }

    const runtimeAssetId = managedServer.config?.runtimeAssetId;
    if (typeof runtimeAssetId !== 'string' || !runtimeAssetId) {
      throw new NotFoundException(
        `Managed server '${serverId}' is not bound to a runtime asset`,
      );
    }

    return this.requireRuntimeAsset(runtimeAssetId);
  }

  async getManagedServerObservability(serverId: string) {
    const runtimeAsset = await this.getManagedServerRuntimeAsset(serverId);
    return this.getRuntimeAssetObservability(runtimeAsset.id);
  }

  async deployMcpRuntimeAsset(
    runtimeAssetId: string,
    dto: DeployRuntimeAssetMcpDto = {},
  ) {
    const assembled = await this.assembleMcpRuntimeAssetPayload(runtimeAssetId);
    const runtimeAsset = assembled.runtimeAsset;
    const desiredName = dto.name || runtimeAsset.name;
    const desiredTransport = (dto.transport || TransportType.STREAMABLE) as TransportType;

    let server: MCPServerEntity | null = null;
    if (dto.targetServerId) {
      server = await this.mcpServerRepository.findOne({
        where: { id: dto.targetServerId },
      });
      if (!server) {
        throw new NotFoundException(`Managed server '${dto.targetServerId}' not found`);
      }
    } else {
      server = await this.mcpServerRepository.findOne({
        where: { name: desiredName },
      });
    }

    if (dto.port) {
      const portConflict = await this.mcpServerRepository.findOne({
        where: { port: dto.port },
      });
      if (portConflict && portConflict.id !== server?.id) {
        throw new ConflictException(
          `Port ${dto.port} is already used by managed server '${portConflict.name}'`,
        );
      }
    }

    if (!server) {
      const targetPort =
        dto.port || (await this.findAvailableManagedServerPort());
      server = this.mcpServerRepository.create({
        name: desiredName,
        version: '1.0.0',
        description:
          dto.description ||
          runtimeAsset.description ||
          'Managed MCP runtime asset deployment',
        port: targetPort,
        transport: desiredTransport,
        status: ServerStatus.STOPPED,
        openApiData: assembled.openApiData,
        tools: assembled.tools,
        toolsCount: assembled.toolsCount,
        healthy: false,
        autoStart: dto.autoStart ?? false,
        tags: ['runtime-asset', 'mcp-runtime'],
        config: {
          runtimeAssetId,
          managedByRuntimeAsset: true,
        },
      });
    } else {
      if (server.status === ServerStatus.RUNNING) {
        if (dto.port && dto.port !== server.port) {
          throw new ConflictException('Cannot change port while managed server is running');
        }
        if (dto.transport && dto.transport !== server.transport) {
          throw new ConflictException('Cannot change transport while managed server is running');
        }
      }

      server.name = desiredName;
      server.description =
        dto.description ||
        runtimeAsset.description ||
        server.description;
      server.port = dto.port || server.port;
      server.transport = desiredTransport || server.transport;
      server.openApiData = assembled.openApiData;
      server.tools = assembled.tools;
      server.toolsCount = assembled.toolsCount;
      server.autoStart = dto.autoStart ?? server.autoStart;
      server.config = {
        ...(server.config || {}),
        runtimeAssetId,
        managedByRuntimeAsset: true,
      };
      server.tags = Array.from(
        new Set([...(server.tags || []), 'runtime-asset', 'mcp-runtime']),
      );
    }

    const saved = await this.mcpServerRepository.save(server);

    runtimeAsset.metadata = {
      ...(runtimeAsset.metadata || {}),
      managedServerId: saved.id,
      deployedAt: new Date().toISOString(),
    };
    await this.runtimeAssetRepository.save(runtimeAsset);
    await this.runtimeObservabilityService.recordRuntimeControlEvent({
      runtimeAssetId,
      eventFamily: RuntimeObservabilityEventFamily.RUNTIME_CONTROL,
      eventName: 'mcp.deploy',
      status: RuntimeObservabilityStatus.SUCCESS,
      severity: RuntimeObservabilitySeverity.INFO,
      currentStatus:
        saved.status === ServerStatus.RUNNING
          ? RuntimeCurrentStatus.ACTIVE
          : RuntimeCurrentStatus.DRAFT,
      healthStatus: saved.healthy
        ? RuntimeHealthStatus.HEALTHY
        : RuntimeHealthStatus.UNKNOWN,
      summary: `MCP runtime asset deployed with ${assembled.toolsCount} tools`,
      details: {
        managedServerId: saved.id,
        toolsCount: assembled.toolsCount,
        membershipCount: assembled.includedMembershipCount,
        transport: saved.transport,
        port: saved.port,
      },
    });

    return {
      runtimeAsset: await this.requireRuntimeAsset(runtimeAssetId),
      managedServer: this.toManagedServerSummary(saved),
      runtimeSummary: await this.buildRuntimeSummary(
        await this.requireRuntimeAsset(runtimeAssetId),
        await this.runtimeBindingRepository.find({ where: { runtimeAssetId } }),
        saved,
      ),
      toolsCount: assembled.toolsCount,
      membershipCount: assembled.includedMembershipCount,
    };
  }

  async startRuntimeAsset(runtimeAssetId: string) {
    const runtimeAsset = await this.requireRuntimeAsset(runtimeAssetId);
    if (runtimeAsset.type === RuntimeAssetType.GATEWAY_SERVICE) {
      runtimeAsset.status = 'active' as any;
      runtimeAsset.metadata = {
        ...(runtimeAsset.metadata || {}),
        gatewayRuntime: {
          ...(((runtimeAsset.metadata || {}).gatewayRuntime || {}) as Record<string, unknown>),
          startedAt: new Date().toISOString(),
        },
      };
      await this.runtimeAssetRepository.save(runtimeAsset);
      await this.runtimeObservabilityService.recordRuntimeControlEvent({
        runtimeAssetId,
        eventFamily: RuntimeObservabilityEventFamily.RUNTIME_LIFECYCLE,
        eventName: 'gateway.started',
        status: RuntimeObservabilityStatus.ACTIVE,
        severity: RuntimeObservabilitySeverity.INFO,
        currentStatus: RuntimeCurrentStatus.ACTIVE,
        healthStatus: RuntimeHealthStatus.UNKNOWN,
        summary: `Gateway runtime asset '${runtimeAssetId}' started`,
      });
      this.emitGatewaySnapshotRefresh({
        reason: 'runtime_assets.gateway_started',
        runtimeAssetId,
      });
      return {
        runtimeAsset,
        managedServer: null,
        runtimeSummary: await this.buildRuntimeSummary(
          runtimeAsset,
          await this.runtimeBindingRepository.find({ where: { runtimeAssetId } }),
        ),
        action: 'start',
      };
    }
    const managedServer = await this.requireManagedServerForRuntimeAsset(runtimeAsset);
    const serverManager = this.getServerManager();

    await serverManager.startServer(managedServer.id);
    const nextManagedServer = await this.mcpServerRepository.findOne({
      where: { id: managedServer.id },
    });
    const memberships = await this.runtimeBindingRepository.find({
      where: { runtimeAssetId },
    });
    await this.runtimeObservabilityService.recordRuntimeControlEvent({
      runtimeAssetId,
      eventFamily: RuntimeObservabilityEventFamily.RUNTIME_LIFECYCLE,
      eventName: 'mcp.start_requested',
      status: RuntimeObservabilityStatus.ACTIVE,
      severity: RuntimeObservabilitySeverity.INFO,
      currentStatus: RuntimeCurrentStatus.ACTIVE,
      healthStatus: RuntimeHealthStatus.UNKNOWN,
      summary: `MCP runtime asset '${runtimeAssetId}' start requested`,
      details: {
        managedServerId: managedServer.id,
      },
    });

    return {
      runtimeAsset,
      managedServer: this.toManagedServerSummary(nextManagedServer),
      runtimeSummary: await this.buildRuntimeSummary(runtimeAsset, memberships, nextManagedServer),
      action: 'start',
    };
  }

  async stopRuntimeAsset(runtimeAssetId: string) {
    const runtimeAsset = await this.requireRuntimeAsset(runtimeAssetId);
    if (runtimeAsset.type === RuntimeAssetType.GATEWAY_SERVICE) {
      runtimeAsset.status = 'offline' as any;
      runtimeAsset.metadata = {
        ...(runtimeAsset.metadata || {}),
        gatewayRuntime: {
          ...(((runtimeAsset.metadata || {}).gatewayRuntime || {}) as Record<string, unknown>),
          stoppedAt: new Date().toISOString(),
        },
      };
      await this.runtimeAssetRepository.save(runtimeAsset);
      await this.runtimeObservabilityService.recordRuntimeControlEvent({
        runtimeAssetId,
        eventFamily: RuntimeObservabilityEventFamily.RUNTIME_LIFECYCLE,
        eventName: 'gateway.stopped',
        status: RuntimeObservabilityStatus.OFFLINE,
        severity: RuntimeObservabilitySeverity.INFO,
        currentStatus: RuntimeCurrentStatus.OFFLINE,
        healthStatus: RuntimeHealthStatus.UNKNOWN,
        summary: `Gateway runtime asset '${runtimeAssetId}' stopped`,
      });
      this.emitGatewaySnapshotRefresh({
        reason: 'runtime_assets.gateway_stopped',
        runtimeAssetId,
      });
      return {
        runtimeAsset,
        managedServer: null,
        runtimeSummary: await this.buildRuntimeSummary(
          runtimeAsset,
          await this.runtimeBindingRepository.find({ where: { runtimeAssetId } }),
        ),
        action: 'stop',
      };
    }
    const managedServer = await this.requireManagedServerForRuntimeAsset(runtimeAsset);
    const serverManager = this.getServerManager();
    if (
      managedServer.status === ServerStatus.STOPPED ||
      managedServer.status === ServerStatus.STOPPING
    ) {
      const memberships = await this.runtimeBindingRepository.find({
        where: { runtimeAssetId },
      });
      return {
        runtimeAsset,
        managedServer: this.toManagedServerSummary(managedServer),
        runtimeSummary: await this.buildRuntimeSummary(runtimeAsset, memberships, managedServer),
        action: 'stop',
      };
    }

    try {
      await serverManager.stopServer(managedServer.id);
    } catch (error: any) {
      if (!this.isStopAlreadySettledError(error)) {
        throw error;
      }
    }
    const nextManagedServer = await this.mcpServerRepository.findOne({
      where: { id: managedServer.id },
    });
    const memberships = await this.runtimeBindingRepository.find({
      where: { runtimeAssetId },
    });
    await this.runtimeObservabilityService.recordRuntimeControlEvent({
      runtimeAssetId,
      eventFamily: RuntimeObservabilityEventFamily.RUNTIME_LIFECYCLE,
      eventName: 'mcp.stop_requested',
      status: RuntimeObservabilityStatus.OFFLINE,
      severity: RuntimeObservabilitySeverity.INFO,
      currentStatus: RuntimeCurrentStatus.OFFLINE,
      healthStatus: RuntimeHealthStatus.UNKNOWN,
      summary: `MCP runtime asset '${runtimeAssetId}' stop requested`,
      details: {
        managedServerId: managedServer.id,
      },
    });

    return {
      runtimeAsset,
      managedServer: this.toManagedServerSummary(nextManagedServer),
      runtimeSummary: await this.buildRuntimeSummary(runtimeAsset, memberships, nextManagedServer),
      action: 'stop',
    };
  }

  async redeployRuntimeAsset(
    runtimeAssetId: string,
    dto: DeployRuntimeAssetMcpDto = {},
  ) {
    const runtimeAsset = await this.requireRuntimeAsset(runtimeAssetId);
    if (runtimeAsset.type === RuntimeAssetType.GATEWAY_SERVICE) {
      const deployed = await this.deployGatewayRuntimeAsset(runtimeAssetId);
      return {
        ...deployed,
        action: 'redeploy',
      };
    }
    const managedServer = await this.findManagedServerForRuntimeAsset(runtimeAsset);
    const deployed = await this.deployMcpRuntimeAsset(runtimeAssetId, {
      ...dto,
      targetServerId: dto.targetServerId || managedServer?.id,
    });

    const serverManager = this.getServerManager();
    const nextManagedServer = deployed.managedServer;
    if (nextManagedServer.status === ServerStatus.RUNNING) {
      await serverManager.restartServer(nextManagedServer.id);
      const refreshedManagedServer =
        (await this.mcpServerRepository.findOne({ where: { id: nextManagedServer.id } })) ||
        null;
      deployed.managedServer = this.toManagedServerSummary(
        refreshedManagedServer || undefined,
      );
    }
    await this.runtimeObservabilityService.recordRuntimeControlEvent({
      runtimeAssetId,
      eventFamily: RuntimeObservabilityEventFamily.RUNTIME_CONTROL,
      eventName: 'mcp.redeploy',
      status: RuntimeObservabilityStatus.SUCCESS,
      severity: RuntimeObservabilitySeverity.INFO,
      currentStatus:
        deployed.managedServer.status === ServerStatus.RUNNING
          ? RuntimeCurrentStatus.ACTIVE
          : RuntimeCurrentStatus.DRAFT,
      healthStatus: deployed.managedServer.healthy
        ? RuntimeHealthStatus.HEALTHY
        : RuntimeHealthStatus.UNKNOWN,
      summary: `MCP runtime asset '${runtimeAssetId}' redeployed`,
      details: {
        managedServerId: deployed.managedServer.id,
        toolsCount: deployed.toolsCount,
        membershipCount: deployed.membershipCount,
      },
    });

    return {
      ...deployed,
      action: 'redeploy',
    };
  }

  private async requireRuntimeAsset(id: string) {
    const asset = await this.runtimeAssetRepository.findOne({ where: { id } });
    if (!asset) {
      throw new NotFoundException(`Runtime asset '${id}' not found`);
    }
    return asset;
  }

  private async findManagedServerForRuntimeAsset(runtimeAsset: RuntimeAssetEntity) {
    const managedServerId = this.readManagedServerId(runtimeAsset.metadata);
    if (managedServerId) {
      const managedServer = await this.mcpServerRepository.findOne({
        where: { id: managedServerId },
      });
      if (managedServer) {
        return managedServer;
      }
    }

    const allServers = await this.mcpServerRepository.find();
    return (
      allServers.find(server => {
        const runtimeAssetId = (server.config || {})?.runtimeAssetId;
        return runtimeAssetId === runtimeAsset.id;
      }) || null
    );
  }

  private async requireManagedServerForRuntimeAsset(runtimeAsset: RuntimeAssetEntity) {
    const managedServer = await this.findManagedServerForRuntimeAsset(runtimeAsset);
    if (!managedServer) {
      throw new NotFoundException(
        `No managed MCP server is bound to runtime asset '${runtimeAsset.id}'`,
      );
    }
    return managedServer;
  }

  private readManagedServerId(metadata?: Record<string, unknown>) {
    const managedServerId = metadata?.managedServerId;
    return typeof managedServerId === 'string' ? managedServerId : undefined;
  }

  private getServerManager() {
    const { ServerManagerService } = require('../../servers/services/server-manager.service');
    const service = this.moduleRef.get(ServerManagerService, { strict: false });
    if (!service) {
      throw new NotFoundException('ServerManagerService is not available');
    }
    return service;
  }

  private isStopAlreadySettledError(error: unknown) {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const message =
      'message' in error && typeof (error as { message?: unknown }).message === 'string'
        ? ((error as { message: string }).message || '').toLowerCase()
        : '';
    return message.includes('already stopped') || message.includes('already stopping');
  }

  private buildSourceServiceUrl(sourceServiceAsset: SourceServiceAssetEntity) {
    const protocol = sourceServiceAsset.scheme || 'http';
    const defaultPort =
      protocol === 'https' ? 443 : 80;
    const portSegment =
      sourceServiceAsset.port && sourceServiceAsset.port !== defaultPort
        ? `:${sourceServiceAsset.port}`
        : '';
    const normalizedBasePath = sourceServiceAsset.normalizedBasePath || '/';
    return `${protocol}://${sourceServiceAsset.host}${portSegment}${normalizedBasePath}`;
  }

  async listRuntimeAssetAccessLogs(runtimeAssetId: string, limit: number = 20) {
    await this.requireRuntimeAsset(runtimeAssetId);
    return this.gatewayAccessLogService.listRuntimeAssetLogs(runtimeAssetId, limit);
  }

  async listGatewayConsumerCredentials(
    runtimeAssetId: string,
    query: GatewayConsumerCredentialQueryDto = {},
  ) {
    const asset = await this.requireRuntimeAsset(runtimeAssetId);
    if (asset.type !== RuntimeAssetType.GATEWAY_SERVICE) {
      throw new NotFoundException(
        `Runtime asset '${runtimeAssetId}' is not a gateway runtime asset`,
      );
    }

    const where: Record<string, unknown> = { runtimeAssetId };
    if (query.routeBindingId) {
      where.routeBindingId = query.routeBindingId;
    }
    if (query.status) {
      where.status = query.status;
    }

    const items = await this.gatewayConsumerCredentialRepository.find({
      where,
      order: { updatedAt: 'DESC' },
    });

    return {
      total: items.length,
      data: items.map(item => this.toGatewayConsumerCredentialSummary(item)),
    };
  }

  async createGatewayConsumerCredential(
    runtimeAssetId: string,
    dto: CreateGatewayConsumerCredentialDto,
    auditContext: GatewayCredentialAuditContext = {},
  ) {
    const asset = await this.requireRuntimeAsset(runtimeAssetId);
    if (asset.type !== RuntimeAssetType.GATEWAY_SERVICE) {
      throw new NotFoundException(
        `Runtime asset '${runtimeAssetId}' is not a gateway runtime asset`,
      );
    }

    await this.ensureCredentialRouteScope(runtimeAssetId, dto.routeBindingId);

    const keyId = dto.keyId?.trim() || this.generateKeyId();
    const existing = await this.gatewayConsumerCredentialRepository.findOne({
      where: { keyId },
    });
    if (existing) {
      throw new ConflictException(`Gateway consumer credential key '${keyId}' already exists`);
    }

    const secret = randomBytes(24).toString('base64url');
    const entity = this.gatewayConsumerCredentialRepository.create({
      name: dto.name,
      label: dto.label,
      keyId,
      secretHash: createHash('sha256').update(secret).digest('hex'),
      status: GatewayConsumerCredentialStatus.ACTIVE,
      runtimeAssetId,
      routeBindingId: dto.routeBindingId,
      metadata: dto.metadata,
    });
    const saved = await this.gatewayConsumerCredentialRepository.save(entity);
    await this.recordGatewayCredentialAudit({
      action: AuditAction.API_KEY_CREATED,
      actorId: auditContext.actorId,
      ipAddress: auditContext.ipAddress,
      userAgent: auditContext.userAgent,
      runtimeAssetId,
      credential: saved,
      details: {
        after: this.toGatewayConsumerCredentialSummary(saved),
      },
    });

    return {
      credential: this.toGatewayConsumerCredentialSummary(saved),
      apiKey: `${saved.keyId}.${secret}`,
    };
  }

  async revokeGatewayConsumerCredential(
    runtimeAssetId: string,
    credentialId: string,
    dto: RevokeGatewayConsumerCredentialDto = {},
    auditContext: GatewayCredentialAuditContext = {},
  ) {
    const asset = await this.requireRuntimeAsset(runtimeAssetId);
    if (asset.type !== RuntimeAssetType.GATEWAY_SERVICE) {
      throw new NotFoundException(
        `Runtime asset '${runtimeAssetId}' is not a gateway runtime asset`,
      );
    }

    const credential = await this.gatewayConsumerCredentialRepository.findOne({
      where: {
        id: credentialId,
        runtimeAssetId,
      },
    });
    if (!credential) {
      throw new NotFoundException(
        `Gateway consumer credential '${credentialId}' was not found for runtime asset '${runtimeAssetId}'`,
      );
    }

    const before = this.toGatewayConsumerCredentialSummary(credential);
    credential.status = GatewayConsumerCredentialStatus.REVOKED;
    credential.metadata = {
      ...(credential.metadata || {}),
      revokedReason: dto.reason,
      revokedAt: new Date().toISOString(),
    };
    const saved = await this.gatewayConsumerCredentialRepository.save(credential);
    await this.recordGatewayCredentialAudit({
      action: AuditAction.API_KEY_DELETED,
      actorId: auditContext.actorId,
      ipAddress: auditContext.ipAddress,
      userAgent: auditContext.userAgent,
      runtimeAssetId,
      credential: saved,
      details: {
        before,
        after: this.toGatewayConsumerCredentialSummary(saved),
      },
    });
    return this.toGatewayConsumerCredentialSummary(saved);
  }

  private emitGatewaySnapshotRefresh(payload: GatewaySnapshotRefreshPayload) {
    this.eventEmitter.emit(GATEWAY_SNAPSHOT_REFRESH_REQUESTED, payload);
  }

  private async ensureCredentialRouteScope(runtimeAssetId: string, routeBindingId?: string) {
    if (!routeBindingId) {
      return;
    }

    const routeBinding = await this.gatewayRouteRepository.findOne({
      where: { id: routeBindingId },
    });
    if (!routeBinding?.runtimeAssetEndpointBindingId) {
      throw new NotFoundException(`Gateway route binding '${routeBindingId}' was not found`);
    }

    const membership = await this.runtimeBindingRepository.findOne({
      where: {
        id: routeBinding.runtimeAssetEndpointBindingId,
        runtimeAssetId,
      },
    });
    if (!membership) {
      throw new NotFoundException(
        `Gateway route binding '${routeBindingId}' does not belong to runtime asset '${runtimeAssetId}'`,
      );
    }
  }

  private async recordGatewayCredentialAudit(input: {
    action: AuditAction;
    actorId?: string;
    ipAddress?: string;
    userAgent?: string;
    runtimeAssetId: string;
    credential: GatewayConsumerCredentialEntity;
    details?: Record<string, unknown>;
  }) {
    try {
      await this.auditService.log({
        action: input.action,
        level: AuditLevel.INFO,
        status: AuditStatus.SUCCESS,
        userId: input.actorId,
        resource: 'gateway_consumer_credential',
        resourceId: input.credential.id,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        details: {
          ...(input.details || {}),
          context: {
            runtimeAssetId: input.runtimeAssetId,
            routeBindingId: input.credential.routeBindingId,
            keyId: input.credential.keyId,
            status: input.credential.status,
          },
        },
        metadata: {
          runtimeAssetId: input.runtimeAssetId,
          routeBindingId: input.credential.routeBindingId,
          keyId: input.credential.keyId,
        },
      });
    } catch {
      // Audit persistence must not break the credential management flow.
    }
  }

  private toGatewayConsumerCredentialSummary(entity: GatewayConsumerCredentialEntity) {
    return {
      id: entity.id,
      name: entity.name,
      keyId: entity.keyId,
      label: entity.label,
      status: entity.status,
      runtimeAssetId: entity.runtimeAssetId,
      routeBindingId: entity.routeBindingId,
      metadata: entity.metadata,
      lastUsedAt: entity.lastUsedAt,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }

  private generateKeyId() {
    return `gk_${randomBytes(8).toString('hex')}`;
  }

  private async findAvailableManagedServerPort(startPort = 9022): Promise<number> {
    for (let port = startPort; port < startPort + 1000; port += 1) {
      const existingServer = await this.mcpServerRepository.findOne({
        where: { port },
      });
      if (existingServer) {
        continue;
      }

      const available = await this.isPortAvailable(port);
      if (available) {
        return port;
      }
    }

    throw new ConflictException('No available managed MCP server port found');
  }

  private async isPortAvailable(port: number): Promise<boolean> {
    return new Promise(resolve => {
      const server = http.createServer();

      server.once('error', () => {
        resolve(false);
      });

      server.listen(port, () => {
        server.close(() => resolve(true));
      });
    });
  }

  private async findManagedServerSummary(runtimeAsset: RuntimeAssetEntity) {
    const managedServer = await this.findManagedServerForRuntimeAsset(runtimeAsset);
    return this.toManagedServerSummary(managedServer);
  }

  private toManagedServerSummary(managedServer?: MCPServerEntity | null) {
    if (!managedServer) {
      return null;
    }

    return {
      id: managedServer.id,
      name: managedServer.name,
      status: managedServer.status,
      healthy: managedServer.healthy,
      endpoint: managedServer.endpoint,
      port: managedServer.port,
      transport: managedServer.transport,
      toolsCount: managedServer.toolsCount,
      lastHealthCheck: managedServer.lastHealthCheck,
      errorMessage: managedServer.errorMessage,
      runtimeAssetId: (managedServer.config || {})?.runtimeAssetId,
    };
  }

  private async buildRuntimeSummary(
    runtimeAsset: RuntimeAssetEntity,
    memberships: RuntimeAssetEndpointBindingEntity[],
    managedServer?: MCPServerEntity | null,
  ) {
    const resolvedManagedServerEntity =
      managedServer === undefined
        ? await this.findManagedServerForRuntimeAsset(runtimeAsset)
        : managedServer;
    const managedServerSummary = this.toManagedServerSummary(resolvedManagedServerEntity);
    const gatewayGovernance =
      runtimeAsset.type === RuntimeAssetType.GATEWAY_SERVICE
        ? await this.buildRuntimeAssetGatewayGovernanceSummary(
            memberships,
            managedServerSummary?.endpoint,
          )
        : null;

    return {
      runtimeAssetId: runtimeAsset.id,
      runtimeAssetType: runtimeAsset.type,
      policyBindingRef: runtimeAsset.policyBindingRef,
      membershipCount: memberships.length,
      activeMembershipCount: memberships.filter(membership => membership.status === 'active').length,
      publicationRevision: memberships.reduce(
        (maxRevision, membership) =>
          Math.max(maxRevision, membership.publicationRevision || 0),
        0,
      ),
      managedServer: managedServerSummary,
      runtimeStatus: managedServerSummary?.status || runtimeAsset.status,
      healthy: managedServerSummary?.healthy ?? null,
      endpoint: managedServerSummary?.endpoint,
      toolsCount: managedServerSummary?.toolsCount ?? 0,
      gatewayMetrics:
        runtimeAsset.type === RuntimeAssetType.GATEWAY_SERVICE
          ? this.gatewayRuntimeMetricsService.getRuntimeAssetMetrics(runtimeAsset.id)
          : null,
      gatewayGovernance,
    };
  }

  private async buildRuntimeAssetGatewayGovernanceSummary(
    memberships: RuntimeAssetEndpointBindingEntity[],
    runtimeEndpoint?: string,
  ) {
    const membershipIds = memberships.map(item => item.id).filter(Boolean);
    if (membershipIds.length === 0) {
      return this.buildGatewayGovernanceSummary([]);
    }

    const routeBindings = await this.gatewayRouteRepository.find({
      where: membershipIds.map(id => ({ runtimeAssetEndpointBindingId: id })),
      order: { updatedAt: 'DESC' },
    });

    return this.buildGatewayGovernanceSummary(
      routeBindings.map(routeBinding => ({
        authPolicyRef: routeBinding.authPolicyRef,
        trafficPolicyRef: routeBinding.trafficPolicyRef,
        loggingPolicyRef: routeBinding.loggingPolicyRef,
        cachePolicyRef: routeBinding.cachePolicyRef,
        rateLimitPolicyRef: routeBinding.rateLimitPolicyRef,
        circuitBreakerPolicyRef: routeBinding.circuitBreakerPolicyRef,
        matchHost: routeBinding.matchHost,
        routePath: routeBinding.routePath,
        upstreamConfig: routeBinding.upstreamConfig,
      })),
      runtimeEndpoint,
    );
  }

  private buildGatewayGovernanceSummary(routes: Array<Record<string, any>>, runtimeEndpoint?: string) {
    const authModes = {
      anonymous: 0,
      jwt: 0,
      apiKey: 0,
    };

    for (const route of routes) {
      const authMode = this.resolveGatewayAuthMode(route.authPolicyRef);
      if (authMode === 'jwt') {
        authModes.jwt += 1;
      } else if (authMode === 'api_key') {
        authModes.apiKey += 1;
      } else {
        authModes.anonymous += 1;
      }
    }

    return {
      totalRoutes: routes.length,
      accessUrls: this.buildGatewayAccessUrls(routes, runtimeEndpoint),
      authModes,
      cacheEnabledRoutes: routes.filter(route => Boolean(route.cachePolicyRef)).length,
      rateLimitedRoutes: routes.filter(
        route =>
          Boolean(route.rateLimitPolicyRef) ||
          Boolean((route.upstreamConfig || {})?.trafficControl?.rateLimit),
      ).length,
      breakerProtectedRoutes: routes.filter(
        route =>
          Boolean(route.circuitBreakerPolicyRef) ||
          Boolean((route.upstreamConfig || {})?.trafficControl?.breaker),
      ).length,
      refs: {
        authPolicyRefs: this.uniqueRefs(routes.map(route => route.authPolicyRef)),
        trafficPolicyRefs: this.uniqueRefs(routes.map(route => route.trafficPolicyRef)),
        loggingPolicyRefs: this.uniqueRefs(routes.map(route => route.loggingPolicyRef)),
        cachePolicyRefs: this.uniqueRefs(routes.map(route => route.cachePolicyRef)),
        rateLimitPolicyRefs: this.uniqueRefs(routes.map(route => route.rateLimitPolicyRef)),
        circuitBreakerPolicyRefs: this.uniqueRefs(routes.map(route => route.circuitBreakerPolicyRef)),
      },
    };
  }

  private buildGatewayAccessUrls(routes: Array<Record<string, any>>, runtimeEndpoint?: string) {
    const values = routes.flatMap(route => this.buildGatewayRouteAccessUrls(route, runtimeEndpoint));
    return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
  }

  private buildGatewayRouteAccessUrls(route: Record<string, any>, runtimeEndpoint?: string) {
    const routePath = this.normalizeGatewayAccessPath(route.routePath);
    if (!routePath) {
      return [];
    }

    const values: string[] = [];
    const normalizedRuntimeEndpoint = String(runtimeEndpoint || '').trim();
    const normalizedMatchHost = String(route.matchHost || '').trim();

    if (normalizedRuntimeEndpoint) {
      const runtimeUrl = this.tryBuildGatewayUrl(normalizedRuntimeEndpoint, routePath);
      if (runtimeUrl) {
        values.push(runtimeUrl);
      }
    }

    if (normalizedMatchHost) {
      const hostSpecificUrl = this.tryBuildGatewayUrl(
        this.resolveGatewayHostBase(normalizedMatchHost, normalizedRuntimeEndpoint),
        routePath,
      );
      if (hostSpecificUrl) {
        values.push(hostSpecificUrl);
      }
    }

    return values;
  }

  private normalizeGatewayAccessPath(routePath?: string) {
    const value = String(routePath || '').trim();
    if (!value) {
      return '';
    }
    return value.startsWith('/') ? value : `/${value}`;
  }

  private resolveGatewayHostBase(matchHost: string, runtimeEndpoint?: string) {
    if (/^https?:\/\//i.test(matchHost)) {
      return matchHost;
    }

    const normalizedRuntimeEndpoint = String(runtimeEndpoint || '').trim();
    if (!normalizedRuntimeEndpoint) {
      return matchHost;
    }

    try {
      const runtimeUrl = new URL(normalizedRuntimeEndpoint);
      if (matchHost.includes(':')) {
        runtimeUrl.host = matchHost;
      } else {
        runtimeUrl.hostname = matchHost;
      }
      return runtimeUrl.origin;
    } catch {
      return matchHost;
    }
  }

  private tryBuildGatewayUrl(base: string, routePath: string) {
    const normalizedBase = String(base || '').trim();
    if (!normalizedBase) {
      return '';
    }

    try {
      return new URL(routePath, this.ensureGatewayBaseUrl(normalizedBase)).toString();
    } catch {
      return '';
    }
  }

  private ensureGatewayBaseUrl(value: string) {
    const normalized = String(value || '').trim();
    if (!normalized) {
      return normalized;
    }
    const withScheme = /^https?:\/\//i.test(normalized)
      ? normalized
      : `http://${normalized}`;
    return withScheme.endsWith('/') ? withScheme : `${withScheme}/`;
  }

  private toGatewayRouteView(item: any) {
    return {
      runtimeMembershipId: item.membership.id,
      endpointDefinitionId: item.endpointDefinition!.id,
      sourceServiceAssetId: item.sourceServiceAsset!.id,
      sourceServiceKey: item.sourceServiceAsset!.sourceKey,
      matchHost: item.gatewayRouteBinding!.matchHost,
      routePath: item.gatewayRouteBinding!.routePath,
      pathMatchMode: item.gatewayRouteBinding!.pathMatchMode,
      priority: item.gatewayRouteBinding!.priority ?? 0,
      routeMethod: item.gatewayRouteBinding!.routeMethod,
      upstreamPath: item.gatewayRouteBinding!.upstreamPath,
      upstreamMethod: item.gatewayRouteBinding!.upstreamMethod,
      upstreamBaseUrl: this.buildSourceServiceUrl(item.sourceServiceAsset!),
      timeoutMs: item.gatewayRouteBinding!.timeoutMs ?? 30000,
      status: item.gatewayRouteBinding!.status,
      authPolicyRef: item.gatewayRouteBinding!.authPolicyRef,
      trafficPolicyRef: item.gatewayRouteBinding!.trafficPolicyRef,
      loggingPolicyRef: item.gatewayRouteBinding!.loggingPolicyRef,
      cachePolicyRef: item.gatewayRouteBinding!.cachePolicyRef,
      rateLimitPolicyRef: item.gatewayRouteBinding!.rateLimitPolicyRef,
      circuitBreakerPolicyRef: item.gatewayRouteBinding!.circuitBreakerPolicyRef,
      upstreamConfig: item.gatewayRouteBinding!.upstreamConfig,
      routeStatusReason: item.gatewayRouteBinding!.routeStatusReason,
    };
  }

  private resolveGatewayAuthMode(ref?: string) {
    const normalized = String(ref || '').trim().toLowerCase();
    if (!normalized) {
      return 'anonymous';
    }
    if (normalized.includes('api-key') || normalized.includes('apikey') || normalized.includes('key')) {
      return 'api_key';
    }
    if (normalized.includes('jwt') || normalized.includes('bearer') || normalized.includes('token')) {
      return 'jwt';
    }
    return 'anonymous';
  }

  private uniqueRefs(values: Array<string | undefined>) {
    return Array.from(
      new Set(values.map(value => String(value || '').trim()).filter(Boolean)),
    ).sort((left, right) => left.localeCompare(right));
  }

  private async buildRuntimeSummaryFromPersistedObservability(
    runtimeAsset: RuntimeAssetEntity,
    memberships: RuntimeAssetEndpointBindingEntity[],
    persistedObservability: any,
  ) {
    const baseSummary = await this.buildRuntimeSummary(runtimeAsset, memberships);
    const state = persistedObservability?.state;
    if (!state) {
      return baseSummary;
    }

    return {
      ...baseSummary,
      runtimeStatus: state.currentStatus || baseSummary.runtimeStatus,
      healthy:
        state.healthStatus === 'healthy'
          ? true
          : state.healthStatus === 'unhealthy'
            ? false
            : baseSummary.healthy,
      observabilityState: state,
      recentEventCount: Array.isArray(persistedObservability?.recentEvents)
        ? persistedObservability.recentEvents.length
        : 0,
      recentMetricCount: Array.isArray(persistedObservability?.recentMetrics)
        ? persistedObservability.recentMetrics.length
        : 0,
      gatewayMetrics:
        runtimeAsset.type === RuntimeAssetType.GATEWAY_SERVICE
          ? this.normalizeGatewayMetrics(
              baseSummary.gatewayMetrics,
              persistedObservability?.state,
              persistedObservability?.recentMetrics,
            )
          : baseSummary.gatewayMetrics,
    };
  }

  private normalizeGatewayMetrics(baseMetrics: any, state?: any, recentMetrics?: any[]) {
    const fallback = baseMetrics || {
      requestCount: 0,
      successCount: 0,
      errorCount: 0,
      cacheHitCount: 0,
      cacheMissCount: 0,
      policyCounts: {},
      successRate: 0,
      avgLatencyMs: 0,
      lastStatusCode: undefined,
      lastRequestAt: undefined,
      lastErrorAt: undefined,
      lastErrorMessage: undefined,
      routes: [],
    };
    const counters = state?.counters || {};
    const gauges = state?.gauges || {};
    const persistedMetrics = Array.isArray(recentMetrics) ? recentMetrics : [];
    const latestAverageLatency = persistedMetrics.find(
      (metric: any) => metric.metricName === 'gateway.latency.avg_ms',
    )?.value;
    const persistedPolicyCounts = Object.fromEntries(
      Object.entries(counters).filter(([key]) => this.isGatewayPolicyCounterKey(key)),
    );

    const requestCount = Number(counters.requestCount ?? fallback.requestCount ?? 0);
    const successCount = Number(counters.successCount ?? fallback.successCount ?? 0);
    const errorCount = Number(counters.errorCount ?? fallback.errorCount ?? 0);

    return {
      ...fallback,
      requestCount,
      successCount,
      errorCount,
      cacheHitCount: Number(counters['gateway.cache.hit'] ?? fallback.cacheHitCount ?? 0),
      cacheMissCount: Number(counters['gateway.cache.miss'] ?? fallback.cacheMissCount ?? 0),
      policyCounts: {
        ...(fallback.policyCounts || {}),
        ...persistedPolicyCounts,
      },
      successRate: requestCount > 0 ? successCount / requestCount : fallback.successRate ?? 0,
      avgLatencyMs:
        latestAverageLatency != null
          ? Math.round(Number(latestAverageLatency) * 100) / 100
          : fallback.avgLatencyMs ?? 0,
      lastStatusCode: gauges.lastStatusCode ?? fallback.lastStatusCode,
      lastRequestAt: state?.lastEventAt ?? fallback.lastRequestAt,
      lastErrorAt: state?.lastFailureAt ?? fallback.lastErrorAt,
      lastErrorMessage: state?.lastErrorMessage ?? fallback.lastErrorMessage,
      routes: Array.isArray(fallback.routes) ? fallback.routes : [],
    };
  }

  private isGatewayPolicyCounterKey(key: string) {
    if (!key.startsWith('gateway.')) {
      return false;
    }
    if (
      key === 'gateway.cache.hit' ||
      key === 'gateway.cache.miss' ||
      key === 'gateway.requests.total' ||
      key === 'gateway.requests.success' ||
      key === 'gateway.requests.error'
    ) {
      return false;
    }
    return true;
  }

  private buildNormalizedObservabilityView(
    runtimeAsset: RuntimeAssetEntity,
    persistedObservability: any,
    managedServer: any,
  ) {
    const state = persistedObservability?.state || null;
    const persistedEvents = Array.isArray(persistedObservability?.recentEvents)
      ? persistedObservability.recentEvents
      : [];
    const persistedMetrics = Array.isArray(persistedObservability?.recentMetrics)
      ? persistedObservability.recentMetrics
      : [];

    const normalizedPersistedEvents = persistedEvents.map((event: any) => ({
      id: event.id,
      source: 'runtime_observability_events',
      capability: this.mapEventCapability(event),
      family: event.eventFamily,
      eventAt: event.occurredAt || event.createdAt,
      eventName: event.eventName,
      severity: event.severity,
      status: event.status,
      summary: event.summary,
      details: event.details || null,
      dimensions: event.dimensions || null,
    }));

    const timeline = normalizedPersistedEvents
      .sort((a, b) => {
        const aTime = new Date(a.eventAt || 0).getTime();
        const bTime = new Date(b.eventAt || 0).getTime();
        return bTime - aTime;
      })
      .slice(0, 50);

    const metricsSummary = this.buildNormalizedMetricsSummary(
      runtimeAsset,
      state,
      persistedMetrics,
      managedServer,
    );

    return {
      runtimeAssetId: runtimeAsset.id,
      runtimeAssetType: runtimeAsset.type,
      currentState: {
        source: state ? 'runtime_observability_states' : 'runtime_asset',
        currentStatus: state?.currentStatus || runtimeAsset.status,
        healthStatus: state?.healthStatus || 'unknown',
        summary: state?.summary || null,
        lastEventAt: state?.lastEventAt || null,
        lastSuccessAt: state?.lastSuccessAt || null,
        lastFailureAt: state?.lastFailureAt || null,
        lastErrorMessage: state?.lastErrorMessage || null,
        managedServer: managedServer || null,
      },
      metricsSummary,
      timeline,
      capabilities: {
        systemLogs: timeline.map(event => ({
          id: event.id || `${event.source}-${event.eventAt}-${event.eventName}`,
          source: event.source,
          occurredAt: event.eventAt,
          eventType: event.eventName,
          level: event.severity,
          status: event.status,
          description: event.summary,
          details: event.details,
        })),
        auditLogs: timeline
          .filter(event => event.capability === 'audit')
          .map(event => ({
            source: event.source,
            occurredAt: event.eventAt,
            action: event.eventName,
            status: event.status,
            level: event.severity,
            summary: event.summary,
            details: event.details,
          })),
        serverMetrics: metricsSummary,
      },
      sources: {
        runtimeObservability: {
          state: state ? 1 : 0,
          events: persistedEvents.length,
          metrics: persistedMetrics.length,
        },
      },
    };
  }

  private buildNormalizedMetricsSummary(
    runtimeAsset: RuntimeAssetEntity,
    state: any,
    persistedMetrics: any[],
    managedServer: any,
  ) {
    const latestMetricValue = (metricName: string) => {
      const metric = persistedMetrics.find((item: any) => item.metricName === metricName);
      return metric?.value ?? null;
    };

    const counters = state?.counters || {};
    const gauges = state?.gauges || {};
    const distinctMetricNames = Array.from(
      new Set(persistedMetrics.map((metric: any) => metric.metricName)),
    );

    return {
      source: 'runtime_observability',
      persistedSeriesCount: persistedMetrics.length,
      persistedMetricNames: distinctMetricNames,
      counters: {
        requestCount: counters.requestCount ?? 0,
        successCount: counters.successCount ?? 0,
        errorCount: counters.errorCount ?? 0,
      },
      latency: {
        lastMs: gauges.lastLatencyMs ?? null,
        averageMs:
          latestMetricValue('gateway.latency.avg_ms') ??
          latestMetricValue('mcp.tool_call.latency.avg_ms') ??
          null,
      },
      lastStatusCode: gauges.lastStatusCode ?? null,
      runtime: {
        runtimeAssetType: runtimeAsset.type,
        managedServer: managedServer || null,
        toolsCount: managedServer?.toolsCount ?? 0,
      },
      raw: {
        latestCounters: counters,
        latestGauges: gauges,
      },
    };
  }

  private mapEventCapability(event: any) {
    const family = String(event?.eventFamily || '');
    if (
      family === RuntimeObservabilityEventFamily.RUNTIME_CONTROL ||
      family === RuntimeObservabilityEventFamily.RUNTIME_POLICY ||
      family === RuntimeObservabilityEventFamily.RUNTIME_PUBLICATION
    ) {
      return 'audit';
    }
    return 'system';
  }
}
