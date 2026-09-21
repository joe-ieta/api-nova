import {
  resolveUpstreamCredential,
  type UpstreamCredentialRegistrySnapshot,
} from 'api-nova-parser';
import { assertGatewayRegistryHeaderPolicyReady, compileGatewayHeaderPolicy } from './gateway-header-policy';
import type { GatewayResolvedRoute } from '../types/gateway-route-snapshot.types';

export const GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER =
  Symbol('GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER');

export interface GatewayUpstreamCredentialHeaders {
  readonly headers: Readonly<Record<string, string>>;
  readonly credentialHeaderNames: readonly string[];
  readonly managedHeaderNames: readonly string[];
}

export interface GatewayUpstreamCredentialResolver {
  resolve(
    route: GatewayResolvedRoute,
    targetUrl: string,
  ): Promise<GatewayUpstreamCredentialHeaders>;
}

/**
 * Creates an opt-in Gateway adapter. Snapshot acquisition remains the host's
 * responsibility so a request always resolves against one immutable revision.
 */
export function createGatewayUpstreamCredentialResolver(
  captureSnapshot: () => UpstreamCredentialRegistrySnapshot,
): GatewayUpstreamCredentialResolver {
  if (typeof captureSnapshot !== 'function') {
    throw new Error('Gateway upstream credential snapshot provider is required');
  }
  return Object.freeze({
    async resolve(
      route: GatewayResolvedRoute,
      targetUrl: string,
    ): Promise<GatewayUpstreamCredentialHeaders> {
      const snapshot = captureSnapshot();
      compileGatewayHeaderPolicy({ routeId: route.routeBinding?.id || 'unknown', inlinePolicy: route.routeBinding?.upstreamConfig?.headerPolicy, registryConfigured: true });
      assertGatewayRegistryHeaderPolicyReady(snapshot.candidate);
      const resolution = await resolveUpstreamCredential(snapshot, {
        sourceServiceAssetId: route.sourceServiceAsset.id,
        url: targetUrl,
        endpointDefinitionId: route.endpointDefinition.id,
      });
      const managed = new Set<string>(['authorization']);
      for (const credential of Object.values(snapshot.candidate.credentials)) {
        if (credential.type === 'apiKey') managed.add(credential.placement.name);
      }
      return Object.freeze({
        headers: resolution.headers,
        credentialHeaderNames: Object.freeze(Object.keys(resolution.headers)),
        managedHeaderNames: Object.freeze([...managed]),
      });
    },
  });
}
