import { ServiceUnavailableException, type FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { GATEWAY_UPSTREAM_CREDENTIAL_CONFIG } from './gateway-upstream-credential.config';
import { GATEWAY_HOST_NETWORK_PLAN, inspectGatewayHostNetworkPlan, type GatewayHostNetworkPlan } from './gateway-host-network-plan';
import { createGatewayTrustedNetworkFacade, GATEWAY_TRUSTED_NETWORK_PROVIDER } from './gateway-trusted-network.provider';
import { createGatewayNetworkRegistrationBundle, inspectGatewayNetworkRegistrationBundle, closeGatewayNetworkRegistrationBundle, type GatewayNetworkRegistrationBundle } from './gateway-network-registration-coordinator';
import { inspectGatewayActiveRouteCapture } from './gateway-active-route-capture';
import type { GatewayRouteSnapshotService } from './gateway-route-snapshot.service';
import type { GatewayResolvedRoute } from '../types/gateway-route-snapshot.types';
import {
  createGatewayHostCredentialRegistry,
  type GatewayHostCandidateAttestation,
  type GatewayHostCredentialRegistry,
} from './gateway-host-credential-registry';

/** Host code may inject a branded attestation. No request/config/env adapter exists. */
export const GATEWAY_HOST_CANDIDATE_ATTESTATION = Symbol('GATEWAY_HOST_CANDIDATE_ATTESTATION');

/**
 * A shared async dependency resolves BEFORE the legacy Registry can load/watch.
 * Policy initialization can read the snapshot, but traffic stays closed until
 * the application-bootstrap hook installs exact committed routes with fresh proofs.
 */
export class GatewayNetworkBootstrap {
  #host?: GatewayHostCredentialRegistry;
  #hostMode: boolean;
  #closed = false;
  #plan?: ReturnType<typeof inspectGatewayHostNetworkPlan>;
  #facade?: ReturnType<typeof createGatewayTrustedNetworkFacade>;
  #bundle?: GatewayNetworkRegistrationBundle;
  #installationAttempted = false;

  private constructor(hostMode: boolean) { this.#hostMode = hostMode; }

  static async create(
    config: Pick<ConfigService, 'get'>,
    database: DataSource,
    attestation?: GatewayHostCandidateAttestation | null,
    networkPlan?: GatewayHostNetworkPlan | null,
  ): Promise<GatewayNetworkBootstrap> {
    const state = new GatewayNetworkBootstrap(
      (attestation !== undefined && attestation !== null) || (networkPlan !== undefined && networkPlan !== null),
    );
    if (!state.hostMode) return state;
    try {
      // A conflict or bad token cannot silently fall back to a configured legacy file.
      if (Object.values(GATEWAY_UPSTREAM_CREDENTIAL_CONFIG).some(key => config.get(key) !== undefined)) return state;
      if (networkPlan !== undefined && networkPlan !== null) {
        state.#plan = inspectGatewayHostNetworkPlan(networkPlan);
      }
      state.#host = await createGatewayHostCredentialRegistry(attestation!, database);
      if (state.#plan) state.#facade = createGatewayTrustedNetworkFacade();
    } catch {
      // Keep unrelated Nest APIs available; no candidate/path/secret in the error.
    }
    return state;
  }

  get hostMode(): boolean { return this.#hostMode; }
  get networkProvider() { return this.#facade?.provider ?? null; }
  get credentialResolver() { return this.#facade?.resolver ?? null; }

  /** Called once by the Nest post-module hook, never by catalog events or requests. */
  installCommittedRoutes(routes: GatewayRouteSnapshotService): void {
    if (!this.#hostMode || this.#closed || this.#installationAttempted) return;
    this.#installationAttempted = true;
    let bundle: GatewayNetworkRegistrationBundle | undefined;
    try {
      if (!this.#host || !this.#plan || !this.#facade) return;
      const host = this.#host, plan = this.#plan;
      const capture = routes.captureActiveRouteCatalog(routes.readActiveRouteCatalog());
      const sources = [...new Set(inspectGatewayActiveRouteCapture(capture).map(entry => entry.route.sourceServiceAsset.id))];
      bundle = createGatewayNetworkRegistrationBundle({
        routes, capture, host, compiler: plan.compiler, policies: plan.policies,
        proofs: sources.map(sourceServiceAssetId => ({
          sourceServiceAssetId, providerEpoch: host.readEpoch(sourceServiceAssetId),
          proof: host.issueProof(sourceServiceAssetId, plan.proofTtlMs),
        })),
      });
      this.#facade.install({ bundle, compiler: plan.compiler, servers: plan.servers, ca: plan.ca });
      this.#bundle = bundle;
    } catch {
      if (bundle) closeGatewayNetworkRegistrationBundle(bundle);
      // Failure must not stop unrelated APIs or select the old Resolver.
    }
  }

  captureSnapshot() {
    try {
      if (this.#closed || !this.#host) throw new Error();
      return this.#host.captureSnapshot();
    } catch {
      throw new ServiceUnavailableException('GATEWAY_NETWORK_HOST_NOT_READY');
    }
  }

  assertTrafficAllowed(route?: GatewayResolvedRoute): void {
    try {
      if (this.#closed) throw new Error();
      if (!this.#hostMode) return;
      if (!this.#bundle || !this.#facade) throw new Error();
      inspectGatewayNetworkRegistrationBundle(this.#bundle);
      if (route && !this.#facade.provider.requires(route)) throw new Error();
    } catch {
      throw new ServiceUnavailableException('GATEWAY_NETWORK_HOST_NOT_READY');
    }
  }

  onModuleDestroy(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#bundle) closeGatewayNetworkRegistrationBundle(this.#bundle);
    this.#bundle = undefined;
    this.#facade?.close();
    const host = this.#host;
    this.#host = undefined;
    host?.close();
  }
}

export const gatewayNetworkBootstrapProvider: FactoryProvider<GatewayNetworkBootstrap> = {
  provide: GatewayNetworkBootstrap,
  inject: [ConfigService, DataSource, { token: GATEWAY_HOST_CANDIDATE_ATTESTATION, optional: true }, { token: GATEWAY_HOST_NETWORK_PLAN, optional: true }],
  useFactory: GatewayNetworkBootstrap.create,
};

export const gatewayBootstrapNetworkProvider: FactoryProvider = {
  provide: GATEWAY_TRUSTED_NETWORK_PROVIDER,
  inject: [GatewayNetworkBootstrap],
  useFactory: (bootstrap: GatewayNetworkBootstrap) => bootstrap.networkProvider,
};
