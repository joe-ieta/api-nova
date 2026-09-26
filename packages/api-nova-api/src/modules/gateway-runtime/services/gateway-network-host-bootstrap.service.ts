import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FactoryProvider, ValueProvider } from '@nestjs/common';
import {
  createNetworkPolicyCompiler,
  type CompiledNetworkPolicy,
  type NetworkDenialAuditRecord,
  type UpstreamCredentialRegistrySnapshot,
} from 'api-nova-parser';
import { GATEWAY_UPSTREAM_CREDENTIAL_CONFIG } from './gateway-upstream-credential.providers';
import {
  GATEWAY_HOST_RUNTIME,
  resolveGatewayHostRuntime,
  type GatewayHostRuntime,
} from './gateway-host-runtime.providers';
import type { GatewayHostCredentialRegistry } from './gateway-host-credential-registry';
import {
  createGatewayNetworkRegistrationBundle,
} from './gateway-network-registration-coordinator';
import {
  createGatewayTrustedNetworkFacade,
  GATEWAY_TRUSTED_NETWORK_PROVIDER,
  type GatewayTrustedNetworkProvider,
} from './gateway-trusted-network.provider';
import { inspectGatewayActiveRouteCapture } from './gateway-active-route-capture';
import { GatewayRouteSnapshotService } from './gateway-route-snapshot.service';
import type { GatewayResolvedRoute } from '../types/gateway-route-snapshot.types';

/**
 * Explicit host composition only. No request, config, environment or file may
 * mint this source; null or undefined keeps the default-off legacy behavior.
 */
export const GATEWAY_NETWORK_HOST_SOURCE = Symbol('GATEWAY_NETWORK_HOST_SOURCE');
export const GATEWAY_NETWORK_HOST_FACADE = Symbol('GATEWAY_NETWORK_HOST_FACADE');

export interface GatewayNetworkHostSource {
  readonly host: GatewayHostCredentialRegistry;
  readonly compiler: ReturnType<typeof createNetworkPolicyCompiler>;
  readonly servers: readonly string[];
  readonly ca?: string;
  readonly failureAudit?: (record: Readonly<NetworkDenialAuditRecord>) => unknown;
  /** Host-owned per-route policy; the coordinator re-validates origin and Site binding. */
  readonly policyFor: (input: {
    route: GatewayResolvedRoute;
    snapshot: UpstreamCredentialRegistrySnapshot;
    siteId: string;
  }) => CompiledNetworkPolicy;
}

const sources = new WeakSet<object>();

export function createGatewayNetworkHostSource(input: {
  host: GatewayHostCredentialRegistry;
  compiler: ReturnType<typeof createNetworkPolicyCompiler>;
  servers: readonly string[];
  ca?: string;
  failureAudit?: (record: Readonly<NetworkDenialAuditRecord>) => unknown;
  policyFor: GatewayNetworkHostSource['policyFor'];
}): GatewayNetworkHostSource {
  if (!input || typeof input !== 'object' || !input.host
    || typeof input.compiler?.compile !== 'function' || typeof input.compiler?.authorizeTarget !== 'function'
    || !Array.isArray(input.servers) || input.servers.length === 0
    || input.servers.some(value => typeof value !== 'string' || !value.trim())
    || input.failureAudit !== undefined && typeof input.failureAudit !== 'function'
    || typeof input.policyFor !== 'function') {
    throw new Error('gateway_network_host_source_invalid');
  }
  const source: GatewayNetworkHostSource = Object.freeze({
    host: input.host,
    compiler: input.compiler,
    servers: Object.freeze([...input.servers]),
    ...(typeof input.ca === 'string' ? { ca: input.ca } : {}),
    ...(input.failureAudit === undefined ? {} : { failureAudit: input.failureAudit }),
    policyFor: input.policyFor,
  });
  sources.add(source);
  return source;
}

export function assertGatewayNetworkHostSource(value: unknown): GatewayNetworkHostSource {
  if (!value || typeof value !== 'object' || !sources.has(value as object)) {
    throw new Error('gateway_network_host_source_invalid');
  }
  return value as GatewayNetworkHostSource;
}

/** Only null or undefined are default-off; anything else must be a branded source. */
export function resolveGatewayNetworkHostSource(value: unknown): GatewayNetworkHostSource | null {
  if (value === null || value === undefined) return null;
  return assertGatewayNetworkHostSource(value);
}

export type GatewayNetworkHostFacade = ReturnType<typeof createGatewayTrustedNetworkFacade>;

export const gatewayNetworkHostSourceProvider: ValueProvider<null> = {
  provide: GATEWAY_NETWORK_HOST_SOURCE,
  useValue: null,
};

export const gatewayNetworkHostFacadeProvider: FactoryProvider<GatewayNetworkHostFacade | null> = {
  provide: GATEWAY_NETWORK_HOST_FACADE,
  inject: [GATEWAY_NETWORK_HOST_SOURCE],
  useFactory: (source: unknown) =>
    resolveGatewayNetworkHostSource(source) ? createGatewayTrustedNetworkFacade() : null,
};

export const gatewayTrustedNetworkProvider: FactoryProvider<GatewayTrustedNetworkProvider | null> = {
  provide: GATEWAY_TRUSTED_NETWORK_PROVIDER,
  inject: [GATEWAY_NETWORK_HOST_FACADE],
  useFactory: (facade: GatewayNetworkHostFacade | null) => facade ? facade.provider : null,
};

const DEFAULT_ASSEMBLY_WAIT_MS = 30000;

/**
 * After Nest startup, wait for the real committed route catalog and the host
 * snapshot, then assemble c2/d1 with fresh one-time proofs. Failures lock the
 * whole host Gateway instead of falling back to legacy networking.
 */
@Injectable()
export class GatewayNetworkHostBootstrapService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(GatewayNetworkHostBootstrapService.name);
  assemblyWaitMs = DEFAULT_ASSEMBLY_WAIT_MS;

  constructor(
    @Optional() @Inject(GATEWAY_NETWORK_HOST_SOURCE) private readonly source?: unknown,
    @Optional() @Inject(GATEWAY_NETWORK_HOST_FACADE) private readonly facade?: GatewayNetworkHostFacade | null,
    @Optional() @Inject(GATEWAY_HOST_RUNTIME) private readonly hostRuntime?: GatewayHostRuntime | null,
    @Optional() private readonly routes?: GatewayRouteSnapshotService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const source = resolveGatewayNetworkHostSource(this.source);
    if (!source) return;
    if (this.legacyConfigured()) throw new Error('gateway_network_host_installation_conflict');
    const hostRuntime = resolveGatewayHostRuntime(this.hostRuntime);
    if (!hostRuntime) throw new Error('gateway_network_host_installation_conflict');
    if (!this.facade || !this.routes) {
      hostRuntime.lock('gateway_network_host_installation_unavailable');
      return;
    }
    try {
      const { catalog, snapshot } = await this.waitForCommittedState(source);
      if (catalog.routes.length === 0) {
        this.logger.log('No committed Gateway routes; host network assembly deferred');
        return;
      }
      const capture = this.routes.captureActiveRouteCatalog(catalog);
      const captured = inspectGatewayActiveRouteCapture(capture);
      const policies = captured.map(entry => {
        const sourceServiceAssetId = entry.route.sourceServiceAsset?.id;
        const sites = snapshot.candidate.sites.filter(site =>
          site.sourceServiceAssetId === sourceServiceAssetId
          && site.endpoints.some(endpoint =>
            'endpointDefinitionId' in endpoint
            && endpoint.endpointDefinitionId === entry.route.endpointDefinition?.id));
        if (!sourceServiceAssetId || sites.length !== 1) {
          throw new Error('gateway_network_host_installation_unavailable');
        }
        return {
          routeBindingId: entry.identity.routeBindingId,
          siteId: sites[0].id,
          policy: source.policyFor({ route: { ...entry.route, params: {} }, snapshot, siteId: sites[0].id }),
        };
      });
      const sources = new Set(captured.map(entry => entry.route.sourceServiceAsset?.id));
      if (sources.size === 0 || sources.has(undefined)) {
        throw new Error('gateway_network_host_installation_unavailable');
      }
      const proofs = [...sources].map(sourceServiceAssetId => {
        const id = sourceServiceAssetId as string;
        return {
          sourceServiceAssetId: id,
          providerEpoch: source.host.readEpoch(id),
          proof: source.host.issueProof(id),
        };
      });
      const bundle = createGatewayNetworkRegistrationBundle({
        routes: this.routes,
        capture,
        host: source.host,
        compiler: source.compiler,
        policies,
        proofs,
      });
      this.facade.install({
        bundle,
        compiler: source.compiler,
        servers: source.servers,
        ...(source.ca === undefined ? {} : { ca: source.ca }),
        ...(source.failureAudit === undefined ? {} : { failureAudit: source.failureAudit }),
      });
      this.logger.log(`Installed Gateway host network assembly for ${captured.length} route(s)`);
    } catch {
      hostRuntime.lock('gateway_network_host_installation_unavailable');
      this.logger.error('Gateway host network assembly failed; host mode remains locked');
    }
  }

  onModuleDestroy(): void {
    this.facade?.close();
  }

  private async waitForCommittedState(source: GatewayNetworkHostSource) {
    const deadline = Date.now() + Math.max(0, this.assemblyWaitMs);
    for (;;) {
      try {
        const catalog = this.routes!.readActiveRouteCatalog();
        const snapshot = source.host.captureSnapshot();
        return { catalog, snapshot };
      } catch {
        if (Date.now() >= deadline) throw new Error('gateway_network_host_installation_unavailable');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  }

  private legacyConfigured(): boolean {
    if (!this.config) return false;
    const keys = GATEWAY_UPSTREAM_CREDENTIAL_CONFIG;
    return [keys.file, keys.reloadMode, keys.format, keys.environment]
      .some(key => this.config!.get(key) !== undefined);
  }
}
