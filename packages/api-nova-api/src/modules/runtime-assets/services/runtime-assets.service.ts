import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Like, Repository } from 'typeorm';
import { transformOpenApiToMcpTools } from 'api-nova-server';
import { EndpointDefinitionEntity } from '../../../database/entities/endpoint-definition.entity';
import { GatewayRouteBindingEntity } from '../../../database/entities/gateway-route-binding.entity';
import { MCPServerEntity, ServerStatus, TransportType } from '../../../database/entities/mcp-server.entity';
import { PublicationProfileEntity } from '../../../database/entities/publication-profile.entity';
import { RuntimeAssetEndpointBindingEntity } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import { RuntimeAssetEntity, RuntimeAssetType } from '../../../database/entities/runtime-asset.entity';
import { SourceServiceAssetEntity } from '../../../database/entities/source-service-asset.entity';
import { EndpointPublishBindingEntity } from '../../../database/entities/endpoint-publish-binding.entity';
import {
  DeployRuntimeAssetGatewayDto,
  DeployRuntimeAssetMcpDto,
  RuntimeAssetQueryDto,
  UpdateRuntimeAssetPolicyDto,
} from '../dto/runtime-assets.dto';
import { GatewayRuntimeMetricsService } from '../../gateway-runtime/services/gateway-runtime-metrics.service';
import {
  RuntimeObservabilityEventFamily,
  RuntimeObservabilitySeverity,
  RuntimeObservabilityStatus,
} from '../../../database/entities/runtime-observability-event.entity';
import {
  RuntimeCurrentStatus,
  RuntimeHealthStatus,
} from '../../../database/entities/runtime-observability-state.entity';
import { RuntimeObservabilityService } from '../../runtime-observability/services/runtime-observability.service';

@Injectable()
export class RuntimeAssetsService {
  constructor(
    private readonly moduleRef: ModuleRef,
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
    private readonly gatewayRuntimeMetricsService: GatewayRuntimeMetricsService,
    private readonly runtimeObservabilityService: RuntimeObservabilityService,
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

        return {
          asset,
          managedServer: await this.findManagedServerSummary(asset),
          runtimeSummary: await this.buildRuntimeSummary(asset, memberships),
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

    return {
      runtimeAsset: asset,
      runtimeSummary: await this.buildRuntimeSummary(
        asset,
        await this.runtimeBindingRepository.find({ where: { runtimeAssetId } }),
      ),
      membershipCount: memberships.total,
      includedMembershipCount: includedMemberships.length,
      routes: includedMemberships.map(item => ({
        runtimeMembershipId: item.membership.id,
        endpointDefinitionId: item.endpointDefinition!.id,
        sourceServiceAssetId: item.sourceServiceAsset!.id,
        sourceServiceKey: item.sourceServiceAsset!.sourceKey,
        routePath: item.gatewayRouteBinding!.routePath,
        routeMethod: item.gatewayRouteBinding!.routeMethod,
        upstreamPath: item.gatewayRouteBinding!.upstreamPath,
        upstreamMethod: item.gatewayRouteBinding!.upstreamMethod,
        upstreamBaseUrl: this.buildSourceServiceUrl(item.sourceServiceAsset!),
        timeoutMs: item.gatewayRouteBinding!.timeoutMs ?? 30000,
        status: item.gatewayRouteBinding!.status,
        authPolicyRef: item.gatewayRouteBinding!.authPolicyRef,
        trafficPolicyRef: item.gatewayRouteBinding!.trafficPolicyRef,
      })),
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

    return {
      runtimeAsset,
      runtimeSummary: await this.buildRuntimeSummary(
        runtimeAsset,
        await this.runtimeBindingRepository.find({ where: { runtimeAssetId } }),
      ),
      action: 'update-policy-binding',
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
      server = this.mcpServerRepository.create({
        name: desiredName,
        version: '1.0.0',
        description:
          dto.description ||
          runtimeAsset.description ||
          'Managed MCP runtime asset deployment',
        port: dto.port || 9022,
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

    await serverManager.stopServer(managedServer.id);
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
    };
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
          ? persistedObservability?.state?.counters || baseSummary.gatewayMetrics
          : baseSummary.gatewayMetrics,
    };
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
