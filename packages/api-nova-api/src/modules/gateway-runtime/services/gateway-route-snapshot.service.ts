import {
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  EndpointPublishBindingEntity,
  PublicationBindingStatus,
} from '../../../database/entities/endpoint-publish-binding.entity';
import {
  GatewayRouteBindingEntity,
  GatewayRoutePathMatchMode,
  GatewayRouteBindingStatus,
} from '../../../database/entities/gateway-route-binding.entity';
import { EndpointDefinitionEntity } from '../../../database/entities/endpoint-definition.entity';
import {
  RuntimeAssetEndpointBindingEntity,
  RuntimeAssetEndpointBindingStatus,
} from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import {
  RuntimeAssetEntity,
  RuntimeAssetStatus,
  RuntimeAssetType,
} from '../../../database/entities/runtime-asset.entity';
import { SourceServiceAssetEntity } from '../../../database/entities/source-service-asset.entity';
import {
  GatewayResolvedRoute,
  GatewaySnapshotRouteEntry,
} from '../types/gateway-route-snapshot.types';
import {
  GATEWAY_SNAPSHOT_REFRESH_REQUESTED,
  type GatewaySnapshotRefreshPayload,
} from '../gateway-runtime.events';
import { GatewayPolicyService } from './gateway-policy.service';

@Injectable()
export class GatewayRouteSnapshotService implements OnModuleInit {
  private readonly logger = new Logger(GatewayRouteSnapshotService.name);
  private snapshot: GatewaySnapshotRouteEntry[] = [];
  private reloadPromise: Promise<void> | null = null;
  private reloadQueued = false;

  constructor(
    private readonly gatewayPolicyService: GatewayPolicyService,
    @InjectRepository(GatewayRouteBindingEntity)
    private readonly routeBindingRepository: Repository<GatewayRouteBindingEntity>,
    @InjectRepository(RuntimeAssetEndpointBindingEntity)
    private readonly runtimeBindingRepository: Repository<RuntimeAssetEndpointBindingEntity>,
    @InjectRepository(EndpointPublishBindingEntity)
    private readonly publishBindingRepository: Repository<EndpointPublishBindingEntity>,
    @InjectRepository(RuntimeAssetEntity)
    private readonly runtimeAssetRepository: Repository<RuntimeAssetEntity>,
    @InjectRepository(EndpointDefinitionEntity)
    private readonly endpointDefinitionRepository: Repository<EndpointDefinitionEntity>,
    @InjectRepository(SourceServiceAssetEntity)
    private readonly sourceServiceRepository: Repository<SourceServiceAssetEntity>,
  ) {}

  async onModuleInit() {
    await this.reload();
  }

  async reload() {
    if (this.reloadPromise) {
      this.reloadQueued = true;
      await this.reloadPromise;
      return;
    }

    this.reloadPromise = this.performReload();
    try {
      await this.reloadPromise;
    } finally {
      this.reloadPromise = null;
      if (this.reloadQueued) {
        this.reloadQueued = false;
        await this.reload();
      }
    }
  }

  @OnEvent(GATEWAY_SNAPSHOT_REFRESH_REQUESTED)
  handleSnapshotRefreshRequested(payload?: GatewaySnapshotRefreshPayload) {
    this.logger.debug(
      `Gateway snapshot refresh requested: ${payload?.reason || 'unknown'}`,
    );
    void this.reload();
  }

  private async performReload() {
    const routeBindings = await this.routeBindingRepository.find({
      where: {
        status: GatewayRouteBindingStatus.ACTIVE,
      },
      order: {
        updatedAt: 'DESC',
      },
    });

    if (routeBindings.length === 0) {
      this.snapshot = [];
      this.logger.log('Loaded gateway route snapshot with 0 active routes');
      return;
    }

    const membershipIds = Array.from(
      new Set(
        routeBindings
          .map(binding => binding.runtimeAssetEndpointBindingId)
          .filter((value): value is string => Boolean(value)),
      ),
    );

    const memberships = await this.runtimeBindingRepository.findByIds(membershipIds);
    const membershipMap = new Map(memberships.map(item => [item.id, item]));

    const publishBindings = await this.publishBindingRepository.find({
      where: {
        publishStatus: PublicationBindingStatus.ACTIVE,
      },
    });
    const publishBindingMap = new Map(
      publishBindings
        .filter(item => item.runtimeAssetEndpointBindingId)
        .map(item => [item.runtimeAssetEndpointBindingId as string, item]),
    );

    const runtimeAssetIds = Array.from(
      new Set(memberships.map(item => item.runtimeAssetId).filter(Boolean)),
    );
    const runtimeAssets = await this.runtimeAssetRepository.findByIds(runtimeAssetIds);
    const runtimeAssetMap = new Map(runtimeAssets.map(item => [item.id, item]));

    const endpointDefinitionIds = Array.from(
      new Set(memberships.map(item => item.endpointDefinitionId).filter(Boolean)),
    );
    const endpointDefinitions = await this.endpointDefinitionRepository.findByIds(
      endpointDefinitionIds,
    );
    const endpointDefinitionMap = new Map(endpointDefinitions.map(item => [item.id, item]));

    const sourceServiceIds = Array.from(
      new Set(endpointDefinitions.map(item => item.sourceServiceAssetId).filter(Boolean)),
    );
    const sourceServices = await this.sourceServiceRepository.findByIds(sourceServiceIds);
    const sourceServiceMap = new Map(sourceServices.map(item => [item.id, item]));

    const nextSnapshot: GatewaySnapshotRouteEntry[] = [];

    for (const routeBinding of routeBindings) {
      const membershipId = routeBinding.runtimeAssetEndpointBindingId;
      if (!membershipId) {
        continue;
      }

      const membership = membershipMap.get(membershipId);
      if (
        !membership ||
        membership.status !== RuntimeAssetEndpointBindingStatus.ACTIVE ||
        !membership.enabled
      ) {
        continue;
      }

      const publishBinding = publishBindingMap.get(membership.id);
      if (!publishBinding?.publishedToHttp) {
        continue;
      }

      const runtimeAsset = runtimeAssetMap.get(membership.runtimeAssetId);
      if (
        !runtimeAsset ||
        runtimeAsset.type !== RuntimeAssetType.GATEWAY_SERVICE ||
        ![RuntimeAssetStatus.ACTIVE, RuntimeAssetStatus.DEGRADED].includes(runtimeAsset.status)
      ) {
        continue;
      }

      const endpointDefinition = endpointDefinitionMap.get(membership.endpointDefinitionId);
      if (!endpointDefinition) {
        continue;
      }

      const sourceServiceAsset = sourceServiceMap.get(endpointDefinition.sourceServiceAssetId);
      if (!sourceServiceAsset) {
        continue;
      }

      nextSnapshot.push({
        routeBinding,
        runtimeAsset,
        membership,
        publishBinding,
        endpointDefinition,
        sourceServiceAsset,
        upstreamBaseUrl: this.buildSourceServiceUrl(sourceServiceAsset),
        normalizedRoutePath: this.normalizeRoutePath(routeBinding.routePath),
        routeMethod: this.normalizeMethod(routeBinding.routeMethod),
        priorityScore: this.computePriorityScore(routeBinding),
        policies: this.gatewayPolicyService.compileForRoute(routeBinding),
      });
    }

    nextSnapshot.sort((left, right) => {
      if (right.priorityScore !== left.priorityScore) {
        return right.priorityScore - left.priorityScore;
      }
      return right.routeBinding.updatedAt.getTime() - left.routeBinding.updatedAt.getTime();
    });

    this.snapshot = nextSnapshot;
    this.logger.log(`Loaded gateway route snapshot with ${nextSnapshot.length} active routes`);
  }

  resolve(host: string | undefined, method: string, path: string): GatewayResolvedRoute | null {
    const normalizedMethod = this.normalizeMethod(method);
    const normalizedPath = this.normalizeRoutePath(path);
    const normalizedHost = this.normalizeHost(host);

    for (const route of this.snapshot) {
      if (route.routeMethod !== normalizedMethod) {
        continue;
      }

      const matchHost = this.normalizeHost((route.routeBinding as any).matchHost);
      if (matchHost && matchHost !== normalizedHost) {
        continue;
      }

      const match = this.matchRoute(route, normalizedPath);
      if (!match.matched) {
        continue;
      }

      return {
        routeBinding: route.routeBinding,
        runtimeAsset: route.runtimeAsset,
        membership: route.membership,
        publishBinding: route.publishBinding,
        endpointDefinition: route.endpointDefinition,
        sourceServiceAsset: route.sourceServiceAsset,
        upstreamBaseUrl: route.upstreamBaseUrl,
        params: match.params,
        policies: route.policies,
      };
    }

    return null;
  }

  private computePriorityScore(routeBinding: GatewayRouteBindingEntity) {
    const segments = this.normalizeRoutePath(routeBinding.routePath).split('/').filter(Boolean);
    return segments.reduce((score, segment) => {
      if (/^\{.+\}$/.test(segment)) {
        return score + 1;
      }
      return score + 10;
    }, routeBinding.priority || 0);
  }

  private matchRoute(route: GatewaySnapshotRouteEntry, actualPath: string) {
    const pathMatchMode = this.resolvePathMatchMode(route.routeBinding);
    if (pathMatchMode === GatewayRoutePathMatchMode.PREFIX) {
      return this.matchPrefixRoute(route.normalizedRoutePath, actualPath);
    }
    if (pathMatchMode === GatewayRoutePathMatchMode.EXACT) {
      return this.matchExactRoute(route.normalizedRoutePath, actualPath);
    }

    return this.matchParameterizedRoute(route.normalizedRoutePath, actualPath);
  }

  private matchExactRoute(template: string, actualPath: string) {
    return {
      matched: template === actualPath,
      params: {} as Record<string, string>,
    };
  }

  private matchPrefixRoute(template: string, actualPath: string) {
    if (template === '/') {
      return { matched: true, params: {} as Record<string, string> };
    }

    return {
      matched: actualPath === template || actualPath.startsWith(`${template}/`),
      params: {} as Record<string, string>,
    };
  }

  private matchParameterizedRoute(template: string, actualPath: string) {
    const templateSegments = template.split('/').filter(Boolean);
    const actualSegments = actualPath.split('/').filter(Boolean);

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
      return '/';
    }
    return value.startsWith('/') ? value : `/${value}`;
  }

  private normalizeMethod(method?: string) {
    return String(method || '').trim().toUpperCase();
  }

  private normalizeHost(host?: string) {
    const value = String(host || '')
      .trim()
      .toLowerCase();
    return value.replace(/:\d+$/, '');
  }

  private resolvePathMatchMode(routeBinding: GatewayRouteBindingEntity) {
    return routeBinding.pathMatchMode || this.inferPathMatchMode(routeBinding.routePath);
  }

  private inferPathMatchMode(routePath?: string) {
    return /\{[^}]+\}/.test(String(routePath || ''))
      ? GatewayRoutePathMatchMode.PARAMETER
      : GatewayRoutePathMatchMode.EXACT;
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
