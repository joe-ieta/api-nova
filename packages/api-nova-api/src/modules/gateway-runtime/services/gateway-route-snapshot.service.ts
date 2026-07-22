import {
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GatewayRouteSnapshotEntity } from '../../../database/entities/gateway-route-snapshot.entity';
import { createHash } from 'node:crypto';
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
import { RuntimeUpstreamBindingsService } from '../../runtime-upstream-bindings/services/runtime-upstream-bindings.service';
import { SourceServiceInstanceEntity } from '../../../database/entities/source-service-instance.entity';

@Injectable()
export class GatewayRouteSnapshotService implements OnModuleInit {
  private readonly logger = new Logger(GatewayRouteSnapshotService.name);
  private snapshot: GatewaySnapshotRouteEntry[] = [];
  private readonly candidateSnapshots = new Map<
    string,
    {
      runtimeAssetId: string;
      entries: GatewaySnapshotRouteEntry[];
      snapshotFingerprint: string;
      preparedAt: Date;
    }
  >();
  private readonly rollbackSnapshots = new Map<string, GatewaySnapshotRouteEntry[]>();
  private reloadPromise: Promise<void> | null = null;
  private reloadQueued = false;

  constructor(
    private readonly gatewayPolicyService: GatewayPolicyService,
    @InjectRepository(GatewayRouteBindingEntity)
    private readonly routeBindingRepository: Repository<GatewayRouteBindingEntity>,
    @InjectRepository(GatewayRouteSnapshotEntity)
    private readonly persistedSnapshotRepository: Repository<GatewayRouteSnapshotEntity>,
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
    private readonly runtimeUpstreamBindingsService: RuntimeUpstreamBindingsService,
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
    const reason = payload?.reason || 'unknown';
    this.logger.debug(`Gateway snapshot refresh requested: ${reason}`);
    if (
      payload?.runtimeAssetId &&
      ['runtime_assets.gateway_stopped', 'runtime_assets.gateway_deleted'].includes(reason)
    ) {
      this.removeRuntimeAsset(payload.runtimeAssetId);
      return;
    }
    if (reason === 'runtime_assets.gateway_deployed') {
      void this.reload();
      return;
    }
    this.logger.debug(
      `Ignored route snapshot reload for '${reason}'; a verified deployment is required`,
    );
  }

  private async performReload() {
    const persisted = await this.persistedSnapshotRepository.find({
      order: { activatedAt: 'DESC' },
    });
    if (persisted.length === 0) {
      this.snapshot = [];
      this.logger.log('Loaded gateway route snapshot with 0 persisted verified routes');
      return;
    }
    const runtimeAssetIds = Array.from(new Set(persisted.map(item => item.runtimeAssetId)));
    const runtimeAssets = await this.runtimeAssetRepository.findByIds(runtimeAssetIds);
    const runtimeAssetMap = new Map(runtimeAssets.map(item => [item.id, item]));
    const restored: GatewaySnapshotRouteEntry[] = [];
    const restoredAssets = new Set<string>();
    for (const item of persisted) {
      if (restoredAssets.has(item.runtimeAssetId)) continue;
      const runtimeAsset = runtimeAssetMap.get(item.runtimeAssetId);
      if (
        !runtimeAsset ||
        ![RuntimeAssetStatus.ACTIVE, RuntimeAssetStatus.DEGRADED].includes(runtimeAsset.status) ||
        runtimeAsset.metadata?.activeRevision !== item.revision
      ) {
        continue;
      }
      const entries = this.deserializeEntries(item.payload, runtimeAsset);
      if (this.fingerprintEntries(entries) !== item.fingerprint) {
        this.logger.warn(`Skipped corrupted Gateway snapshot '${item.revision}'`);
        continue;
      }
      restored.push(...entries);
      restoredAssets.add(item.runtimeAssetId);
    }
    this.snapshot = this.sortSnapshot(restored);
    this.logger.log(`Loaded gateway route snapshot with ${this.snapshot.length} persisted verified routes`);
  }

  async prepareCandidate(runtimeAssetId: string, candidateRevision: string) {
    const revision = String(candidateRevision || '').trim();
    if (!revision) {
      throw new Error('candidateRevision must not be blank');
    }
    const entries = await this.buildSnapshot({
      runtimeAssetId,
      allowInactiveRuntime: true,
    });
    const snapshotFingerprint = this.fingerprintEntries(entries);
    this.candidateSnapshots.set(revision, {
      runtimeAssetId,
      entries,
      snapshotFingerprint,
      preparedAt: new Date(),
    });
    return {
      runtimeAssetId,
      candidateRevision: revision,
      routeCount: entries.length,
      runtimeMembershipIds: entries.map(entry => entry.membership.id),
      snapshotFingerprint,
    };
  }

  resolveCandidate(
    candidateRevision: string,
    host: string | undefined,
    method: string,
    path: string,
  ) {
    const candidate = this.candidateSnapshots.get(candidateRevision);
    return candidate
      ? this.resolveFromSnapshot(candidate.entries, host, method, path)
      : null;
  }

  getCandidateRoute(candidateRevision: string, runtimeMembershipId: string) {
    return this.candidateSnapshots
      .get(candidateRevision)
      ?.entries.find(entry => entry.membership.id === runtimeMembershipId) || null;
  }

  async activateCandidate(candidateRevision: string) {
    const candidate = this.candidateSnapshots.get(candidateRevision);
    if (!candidate) {
      throw new Error(`Gateway candidate snapshot '${candidateRevision}' was not found`);
    }
    const previousEntries = this.snapshot.filter(
      entry => entry.runtimeAsset.id === candidate.runtimeAssetId,
    );
    await this.persistedSnapshotRepository.save(
      this.persistedSnapshotRepository.create({
        runtimeAssetId: candidate.runtimeAssetId,
        revision: candidateRevision,
        fingerprint: candidate.snapshotFingerprint,
        routeCount: candidate.entries.length,
        payload: this.serializeEntries(candidate.entries),
        activatedAt: new Date(),
      }),
    );
    this.rollbackSnapshots.set(candidate.runtimeAssetId, previousEntries);
    this.snapshot = this.sortSnapshot([
      ...this.snapshot.filter(entry => entry.runtimeAsset.id !== candidate.runtimeAssetId),
      ...candidate.entries,
    ]);
    this.candidateSnapshots.delete(candidateRevision);
    return {
      runtimeAssetId: candidate.runtimeAssetId,
      candidateRevision,
      activeRouteCount: candidate.entries.length,
      previousRouteCount: previousEntries.length,
      snapshotFingerprint: candidate.snapshotFingerprint,
    };
  }

  rollbackRuntimeAsset(runtimeAssetId: string) {
    if (!this.rollbackSnapshots.has(runtimeAssetId)) {
      return { runtimeAssetId, rolledBack: false, activeRouteCount: 0 };
    }
    const previousEntries = this.rollbackSnapshots.get(runtimeAssetId) || [];
    this.snapshot = this.sortSnapshot([
      ...this.snapshot.filter(entry => entry.runtimeAsset.id !== runtimeAssetId),
      ...previousEntries,
    ]);
    this.rollbackSnapshots.delete(runtimeAssetId);
    return {
      runtimeAssetId,
      rolledBack: true,
      activeRouteCount: previousEntries.length,
    };
  }

  discardCandidate(candidateRevision: string) {
    return this.candidateSnapshots.delete(candidateRevision);
  }

  private removeRuntimeAsset(runtimeAssetId: string) {
    this.snapshot = this.snapshot.filter(entry => entry.runtimeAsset.id !== runtimeAssetId);
  }

  private serializeEntries(entries: GatewaySnapshotRouteEntry[]) {
    return JSON.parse(JSON.stringify(entries)) as unknown[];
  }

  private deserializeEntries(payload: unknown[], runtimeAsset: RuntimeAssetEntity) {
    return (Array.isArray(payload) ? payload : []).map(raw => {
      const entry = raw as GatewaySnapshotRouteEntry;
      entry.runtimeAsset = runtimeAsset;
      entry.routeBinding.updatedAt = new Date(entry.routeBinding.updatedAt);
      entry.routeBinding.createdAt = new Date(entry.routeBinding.createdAt);
      return entry;
    });
  }

  private fingerprintEntries(entries: GatewaySnapshotRouteEntry[]) {
    const behavior = entries
      .map(entry => ({
        runtimeAssetId: entry.runtimeAsset.id,
        servicePrefix: entry.runtimeAsset.servicePrefix || null,
        policyBindingRef: entry.runtimeAsset.policyBindingRef || null,
        membershipId: entry.membership.id,
        publicationRevision: entry.membership.publicationRevision,
        publishBindingId: entry.publishBinding.id,
        routeBindingId: entry.routeBinding.id,
        normalizedRoutePath: entry.normalizedRoutePath,
        routeMethod: entry.routeMethod,
        matchHost: entry.routeBinding.matchHost || null,
        pathMatchMode: entry.routeBinding.pathMatchMode,
        upstreamPath: entry.routeBinding.upstreamPath,
        upstreamMethod: entry.routeBinding.upstreamMethod,
        upstreamBaseUrl: entry.upstreamBaseUrl,
        sourceServiceInstanceId: entry.sourceServiceInstance.id,
        credentialRef: entry.sourceServiceInstance.credentialRef || null,
        timeoutMs: entry.routeBinding.timeoutMs,
        policies: entry.policies,
      }))
      .sort((left, right) => left.membershipId.localeCompare(right.membershipId));
    return createHash('sha256')
      .update(JSON.stringify(this.canonicalize(behavior)))
      .digest('hex');
  }

  private canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(item => this.canonicalize(item));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, this.canonicalize(item)]),
    );
  }

  private async buildSnapshot(
    options: { runtimeAssetId?: string; allowInactiveRuntime?: boolean } = {},
  ) {
    const routeBindings = await this.routeBindingRepository.find({
      where: {
        status: GatewayRouteBindingStatus.ACTIVE,
      },
      order: {
        updatedAt: 'DESC',
      },
    });

    if (routeBindings.length === 0) {
      return [];
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
        (options.runtimeAssetId && runtimeAsset.id !== options.runtimeAssetId) ||
        (!options.allowInactiveRuntime &&
          ![RuntimeAssetStatus.ACTIVE, RuntimeAssetStatus.DEGRADED].includes(runtimeAsset.status))
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
      const upstreamResolution = await this.runtimeUpstreamBindingsService.resolve(membership.id);
      if (!upstreamResolution.resolved || !upstreamResolution.instance) {
        this.logger.warn(
          `Skipping gateway membership '${membership.id}': ${upstreamResolution.reason}`,
        );
        continue;
      }

      nextSnapshot.push({
        routeBinding,
        runtimeAsset,
        membership,
        publishBinding,
        endpointDefinition,
        sourceServiceAsset,
        sourceServiceInstance: upstreamResolution.instance,
        upstreamBaseUrl: this.buildSourceServiceUrl(upstreamResolution.instance),
        normalizedRoutePath: this.buildPublishedRoutePath(
          runtimeAsset.servicePrefix,
          routeBinding.routePath,
        ),
        routeMethod: this.normalizeMethod(routeBinding.routeMethod),
        priorityScore: this.computePriorityScore(routeBinding),
        policies: this.gatewayPolicyService.compileForRoute(routeBinding),
      });
    }

    return this.sortSnapshot(nextSnapshot);
  }

  private sortSnapshot(entries: GatewaySnapshotRouteEntry[]) {
    return [...entries].sort((left, right) => {
      if (right.priorityScore !== left.priorityScore) {
        return right.priorityScore - left.priorityScore;
      }
      return right.routeBinding.updatedAt.getTime() - left.routeBinding.updatedAt.getTime();
    });
  }

  resolve(host: string | undefined, method: string, path: string): GatewayResolvedRoute | null {
    return this.resolveFromSnapshot(this.snapshot, host, method, path);
  }

  private resolveFromSnapshot(
    snapshot: GatewaySnapshotRouteEntry[],
    host: string | undefined,
    method: string,
    path: string,
  ): GatewayResolvedRoute | null {
    const normalizedMethod = this.normalizeMethod(method);
    const normalizedPath = this.normalizeRoutePath(path);
    const normalizedHost = this.normalizeHost(host);

    for (const route of snapshot) {
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
        sourceServiceInstance: route.sourceServiceInstance,
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

  private buildPublishedRoutePath(servicePrefix: string | undefined, routePath?: string) {
    const normalizedRoutePath = this.normalizeRoutePath(routePath);
    const normalizedPrefix = String(servicePrefix || '')
      .trim()
      .replace(/^\/+|\/+$/g, '');
    return normalizedPrefix
      ? this.normalizeRoutePath(`/${normalizedPrefix}${normalizedRoutePath}`)
      : normalizedRoutePath;
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

  private buildSourceServiceUrl(sourceServiceInstance: SourceServiceInstanceEntity) {
    const protocol = sourceServiceInstance.scheme || 'http';
    const defaultPort = protocol === 'https' ? 443 : 80;
    const portSegment =
      sourceServiceInstance.port && sourceServiceInstance.port !== defaultPort
        ? `:${sourceServiceInstance.port}`
        : '';
    const normalizedBasePath = sourceServiceInstance.basePath || '/';
    return `${protocol}://${sourceServiceInstance.host}${portSegment}${normalizedBasePath}`.replace(
      /\/+$/,
      '',
    );
  }
}
