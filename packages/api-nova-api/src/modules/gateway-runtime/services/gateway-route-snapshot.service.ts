import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
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
import {
  GATEWAY_HOST_RUNTIME,
  resolveGatewayHostRuntime,
  type GatewayHostRuntime,
} from './gateway-host-runtime.providers';
import { RuntimeUpstreamBindingsService } from '../../runtime-upstream-bindings/services/runtime-upstream-bindings.service';
import {
  GatewayActiveRouteCatalog,
  GatewayActiveRouteCatalogEvent,
  type GatewayActiveRouteCatalogSnapshot,
} from './gateway-active-route-catalog';
import {
  createGatewayActiveRouteCapture,
  type GatewayActiveRouteCapture,
} from './gateway-active-route-capture';
import { SourceServiceInstanceEntity } from '../../../database/entities/source-service-instance.entity';

@Injectable()
export class GatewayRouteSnapshotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GatewayRouteSnapshotService.name);
  private snapshot: GatewaySnapshotRouteEntry[] = [];
  private snapshotInitialized = false;
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
  private readonly activeRouteCatalog = new GatewayActiveRouteCatalog();
  private readonly activeRouteCaptures =
    new WeakMap<GatewayActiveRouteCatalogSnapshot, readonly GatewaySnapshotRouteEntry[]>();
  private lifecycleGeneration = 0;
  private readonly removedAssets = new Set<string>();
  private destroyed = false;

  /** Host-only evidence, never a network permission or candidate route view. */
  readActiveRouteCatalog() { return this.activeRouteCatalog.read(); }

  observeActiveRouteCatalog(listener: (event: GatewayActiveRouteCatalogEvent) => void) {
    return this.activeRouteCatalog.subscribe(listener);
  }

  /**
   * Captures exact committed route object references for the current catalog object.
   * Catalog identifiers are consistency checks and never mint this host-only token.
   */
  captureActiveRouteCatalog(
    catalog: GatewayActiveRouteCatalogSnapshot,
  ): GatewayActiveRouteCapture {
    let current: GatewayActiveRouteCatalogSnapshot;
    try {
      current = this.activeRouteCatalog.read();
    } catch {
      throw new Error('GATEWAY_ACTIVE_ROUTE_CAPTURE_NOT_READY');
    }
    if (catalog !== current) throw new Error('GATEWAY_ACTIVE_ROUTE_CAPTURE_INVALID');
    const routes = this.activeRouteCaptures.get(catalog);
    if (!routes || routes.length !== catalog.routes.length) {
      throw new Error('GATEWAY_ACTIVE_ROUTE_CAPTURE_INVALID');
    }

    const byKey = new Map<string, GatewaySnapshotRouteEntry>();
    for (const route of routes) {
      const key = `${route.runtimeAsset.id}/${route.routeBinding.id}`;
      if (byKey.has(key)) throw new Error('GATEWAY_ACTIVE_ROUTE_CAPTURE_INVALID');
      byKey.set(key, route);
    }
    const captured = catalog.routes.map(identity => {
      const route = byKey.get(`${identity.runtimeAssetId}/${identity.routeBindingId}`);
      if (!route ||
          route.runtimeAsset.metadata?.activeRevision !== identity.revision ||
          route.runtimeAsset.metadata?.activeGatewaySnapshotFingerprint !== identity.fingerprint) {
        throw new Error('GATEWAY_ACTIVE_ROUTE_CAPTURE_INVALID');
      }
      return Object.freeze({ identity, route });
    });
    if (captured.length !== byKey.size) {
      throw new Error('GATEWAY_ACTIVE_ROUTE_CAPTURE_INVALID');
    }
    const byAsset = new Map<string, GatewaySnapshotRouteEntry[]>();
    for (const item of captured) {
      const group = byAsset.get(item.identity.runtimeAssetId) || [];
      group.push(item.route);
      byAsset.set(item.identity.runtimeAssetId, group);
    }
    for (const [runtimeAssetId, entries] of byAsset) {
      const expected = captured.find(item => item.identity.runtimeAssetId === runtimeAssetId)!
        .identity.fingerprint;
      if (this.fingerprintEntries(entries) !== expected ||
          captured.some(item => item.identity.runtimeAssetId === runtimeAssetId &&
            item.identity.fingerprint !== expected)) {
        throw new Error('GATEWAY_ACTIVE_ROUTE_CAPTURE_INVALID');
      }
    }

    return createGatewayActiveRouteCapture(
      catalog,
      captured,
      expected => {
        if (this.destroyed || this.activeRouteCatalog.read() !== expected ||
            this.activeRouteCaptures.get(expected) !== routes) {
          throw new Error('GATEWAY_ACTIVE_ROUTE_CAPTURE_STALE');
        }
      },
    );
  }

  onModuleDestroy() {
    this.destroyed = true;
    this.lifecycleGeneration++;
    this.activeRouteCatalog.close();
  }

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
    @Optional() @Inject(GATEWAY_HOST_RUNTIME) private readonly hostRuntime?: GatewayHostRuntime | null,
  ) {}

  async onModuleInit() {
    try {
      await this.reload();
    } catch (error) {
      const host = resolveGatewayHostRuntime(this.hostRuntime);
      if (!host) throw error;
      // Host mode fails closed: lock the whole Gateway and keep unrelated
      // Nest surfaces healthy instead of aborting application startup.
      host.lock('gateway_host_snapshot_unavailable');
      this.snapshot = [];
      this.snapshotInitialized = true;
      if (!this.destroyed) {
        this.activeRouteCatalog.replace([], catalog => {
          this.activeRouteCaptures.set(catalog, Object.freeze([]));
        });
      }
      this.logger.error('Locked Gateway host runtime after route initialization failure');
    }
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
      if (payload?.runtimeAssetId) {
        this.lifecycleGeneration++;
        this.removedAssets.delete(payload.runtimeAssetId);
      }
      void this.reload().catch(() => {
        // A hot reload failure keeps the last verified in-memory registry.
        // Startup still propagates the same validation failure to Nest.
        this.logger.error('Rejected invalid Gateway snapshot during hot reload');
      });
      return;
    }
    this.logger.debug(
      `Ignored route snapshot reload for '${reason}'; a verified deployment is required`,
    );
  }

  private async readCommittedSnapshotRows() {
    const connection = this.persistedSnapshotRepository.manager?.connection;
    const read = async (assets: Repository<RuntimeAssetEntity>, snapshots: Repository<GatewayRouteSnapshotEntity>) => ({
      runtimeAssets: await assets.find({ where: {
        type: RuntimeAssetType.GATEWAY_SERVICE,
        status: In([RuntimeAssetStatus.ACTIVE, RuntimeAssetStatus.DEGRADED]),
      } }),
      persisted: await snapshots.find({ order: { activatedAt: 'DESC' } }),
    });
    // Repository doubles have no connection. Production uses an isolated read view.
    if (!connection) return read(this.runtimeAssetRepository, this.persistedSnapshotRepository);
    const runner = connection.createQueryRunner();
    // SQL.js returns the shared runner: a separate object is NOT isolation.
    // Never commit, roll back, or release a transaction owned by another caller.
    if (runner.isTransactionActive) throw new Error('GATEWAY_SNAPSHOT_TRANSACTION_PENDING');
    if (connection.options.type === 'sqljs') {
      // No await between the shared transaction check and synchronous export.
      // SQL.js transactions on the live connection can otherwise nest during reads.
      const database = (connection.driver as unknown as { export(): Uint8Array }).export();
      const isolated = new DataSource({ type: 'sqljs', database,
        entities: [RuntimeAssetEntity, GatewayRouteSnapshotEntity], synchronize: false,
        logging: false, autoSave: false });
      try {
        await isolated.initialize();
        await isolated.query('PRAGMA query_only = ON');
        return await read(isolated.getRepository(RuntimeAssetEntity), isolated.getRepository(GatewayRouteSnapshotEntity));
      } finally { if (isolated.isInitialized) await isolated.destroy(); }
    }
    try {
      await runner.startTransaction('SERIALIZABLE');
      const rows = await read(runner.manager.getRepository(RuntimeAssetEntity),
        runner.manager.getRepository(GatewayRouteSnapshotEntity));
      await runner.commitTransaction();
      return rows;
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    } finally { await runner.release(); }
  }

  private async performReload() {
    const generation = this.lifecycleGeneration;
    if (this.destroyed) throw new Error('GATEWAY_ACTIVE_CATALOG_NOT_READY');
    const { runtimeAssets, persisted } = await this.readCommittedSnapshotRows();
    const activePublishedAssets = runtimeAssets.filter(asset =>
      typeof asset.metadata?.activeRevision === 'string' &&
      Boolean(asset.metadata.activeRevision.trim()),
    );
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
      let entries: GatewaySnapshotRouteEntry[];
      try {
        entries = this.deserializeEntries(item.payload, runtimeAsset);
        this.assertSnapshotPolicies(entries);
        if (entries.length === 0 || entries.length !== item.routeCount ||
          this.fingerprintEntries(entries) !== item.fingerprint ||
          runtimeAsset.metadata?.activeGatewaySnapshotFingerprint !== item.fingerprint) {
          throw new Error('fingerprint mismatch');
        }
      } catch {
        // Only the selected active revision can be routed. A corrupt one must
        // reject startup/reload while leaving any in-memory registry unchanged.
        throw new Error('GATEWAY_ACTIVE_SNAPSHOT_INVALID');
      }
      restored.push(...entries);
      restoredAssets.add(item.runtimeAssetId);
    }
    if (restoredAssets.size !== activePublishedAssets.length) {
      // A published active revision without its persisted snapshot cannot be
      // reconstructed; retain the last verified registry on hot reload.
      throw new Error('GATEWAY_ACTIVE_SNAPSHOT_MISSING');
    }
    if (this.destroyed || generation !== this.lifecycleGeneration) return;
    const verified = this.sortSnapshot(restored.filter(entry => !this.removedAssets.has(entry.runtimeAsset.id)));
    this.activeRouteCatalog.replace(verified.map(entry => ({
      runtimeAssetId: entry.runtimeAsset.id,
      routeBindingId: entry.routeBinding.id,
      revision: entry.runtimeAsset.metadata.activeRevision as string,
      fingerprint: entry.runtimeAsset.metadata.activeGatewaySnapshotFingerprint as string,
    })), catalog => {
      const captured = Object.freeze([...verified]);
      this.snapshot = verified;
      this.snapshotInitialized = true;
      this.activeRouteCaptures.set(catalog, captured);
    });
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
    this.assertSnapshotPolicies(entries);
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

  async activateCandidate(candidateRevision: string, manager?: EntityManager) {
    const candidate = this.candidateSnapshots.get(candidateRevision);
    if (!candidate) {
      throw new Error(`Gateway candidate snapshot '${candidateRevision}' was not found`);
    }
    this.assertSnapshotPolicies(candidate.entries);
    if (this.fingerprintEntries(candidate.entries) !== candidate.snapshotFingerprint) {
      throw new Error('GATEWAY_CANDIDATE_FINGERPRINT_INVALID');
    }
    const previousEntries = this.snapshot.filter(
      entry => entry.runtimeAsset.id === candidate.runtimeAssetId,
    );
    const repository = manager?.getRepository(GatewayRouteSnapshotEntity) || this.persistedSnapshotRepository;
    await repository.save(
      repository.create({
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
    this.snapshotInitialized = true;
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
    this.snapshotInitialized = true;
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
    this.lifecycleGeneration++;
    this.removedAssets.add(runtimeAssetId);
    const remaining = this.snapshot.filter(entry => entry.runtimeAsset.id !== runtimeAssetId);
    this.activeRouteCatalog.remove(runtimeAssetId, catalog => {
      const captured = Object.freeze([...remaining]);
      this.snapshot = remaining;
      this.activeRouteCaptures.set(catalog, captured);
    });
  }

  /** A bounded copy of this process's actual active registry; never a network/health probe. */
  observeRoutingAssets(): ReadonlyArray<Readonly<{ runtimeAssetId: string; activeRouteCount: number }>> {
    if (!this.snapshotInitialized) throw new Error('GATEWAY_ROUTE_REGISTRY_NOT_READY');
    // Capture one array reference synchronously; candidate and rollback maps are excluded.
    const snapshot = this.snapshot;
    if (snapshot.length > 10000) throw new Error('GATEWAY_ROUTE_OBSERVATION_TOO_LARGE');
    const counts = new Map<string, number>();
    for (const entry of snapshot) {
      const id = entry.runtimeAsset?.id;
      if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
        entry.runtimeAsset.type !== RuntimeAssetType.GATEWAY_SERVICE) throw new Error('INVALID_GATEWAY_ROUTE_OBSERVATION');
      counts.set(id, (counts.get(id) || 0) + 1);
      if (counts.size > 200) throw new Error('GATEWAY_ROUTE_OBSERVATION_TOO_LARGE');
    }
    return Object.freeze([...counts].sort(([a], [b]) => a.localeCompare(b))
      .map(([runtimeAssetId, activeRouteCount]) => Object.freeze({ runtimeAssetId, activeRouteCount })));
  }

  private assertSnapshotPolicies(entries: GatewaySnapshotRouteEntry[]) {
    for (const entry of entries) {
      try {
        const compiled = this.gatewayPolicyService.compileForRoute(entry.routeBinding);
        if (JSON.stringify(this.canonicalize(compiled)) !==
          JSON.stringify(this.canonicalize(entry.policies))) {
          throw new Error('policy mismatch');
        }
      } catch {
        // Do not echo persisted policy text or references in startup errors.
        throw new Error('GATEWAY_SNAPSHOT_POLICY_INVALID');
      }
    }
  }

  private serializeEntries(entries: GatewaySnapshotRouteEntry[]) {
    return JSON.parse(JSON.stringify(entries)) as unknown[];
  }

  private deserializeEntries(payload: unknown[], runtimeAsset: RuntimeAssetEntity) {
    if (!Array.isArray(payload)) throw new Error('GATEWAY_SNAPSHOT_PAYLOAD_INVALID');
    return payload.map(raw => {
      const entry = raw as GatewaySnapshotRouteEntry;
      if (!entry || typeof entry !== 'object' ||
        !entry.routeBinding || typeof entry.routeBinding !== 'object' ||
        !entry.policies || typeof entry.policies !== 'object') {
        throw new Error('GATEWAY_SNAPSHOT_PAYLOAD_INVALID');
      }
      return {
        ...entry,
        runtimeAsset,
        routeBinding: {
          ...entry.routeBinding,
          updatedAt: new Date(entry.routeBinding.updatedAt),
          createdAt: new Date(entry.routeBinding.createdAt),
        },
      };
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
