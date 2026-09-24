import { createHash, randomUUID } from 'node:crypto';
import {
  resolveUpstreamCredential,
  upstreamCredentialHeaderName,
  type UpstreamCredentialRegistrySnapshot,
  type CompiledHeaderPolicyV1,
} from 'api-nova-parser';
import { assertGatewayRegistryHeaderPolicyReady, compileGatewayHeaderPolicy } from './gateway-header-policy';
import type { GatewayResolvedRoute } from '../types/gateway-route-snapshot.types';

export const GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER =
  Symbol('GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER');

export interface GatewayUpstreamCredentialHeaders {
  readonly cacheIdentity?: string;
  readonly compiledHeaderPolicy?: CompiledHeaderPolicyV1;
  readonly registryGeneration?: number;
  readonly registryRevision?: string;
  readonly registrySiteId?: string;
  readonly historicalAuthenticationHeaderNames?: readonly string[];
  readonly headers: Readonly<Record<string, string>>;
  readonly credentialHeaderNames: readonly string[];
  readonly managedHeaderNames: readonly string[];
}

export interface GatewayUpstreamCredentialResolver {
  readonly headerPolicyEnabled?: boolean;
  resolve(
    route: GatewayResolvedRoute,
    targetUrl: string,
    requestMethod?: string,
  ): Promise<GatewayUpstreamCredentialHeaders>;
}

/**
 * Creates an opt-in Gateway adapter. Snapshot acquisition remains the host's
 * responsibility so a request always resolves against one immutable revision.
 */
export function createGatewayUpstreamCredentialResolver(
  captureSnapshot: () => UpstreamCredentialRegistrySnapshot,
  options: { readonly enableHeaderPolicy?: boolean } = {},
): GatewayUpstreamCredentialResolver {
  if (typeof captureSnapshot !== 'function') {
    throw new Error('Gateway upstream credential snapshot provider is required');
  }
  const enableHeaderPolicy = options.enableHeaderPolicy === true;
  // Digests never leave this bounded closure; public cache keys only contain random epochs.
  const materials = new Map<string, { digest: string; epoch: string }>();
  return Object.freeze({
    headerPolicyEnabled: enableHeaderPolicy,
    async resolve(
      route: GatewayResolvedRoute,
      targetUrl: string,
      requestMethod?: string,
    ): Promise<GatewayUpstreamCredentialHeaders> {
      const snapshot = captureSnapshot();
      compileGatewayHeaderPolicy({ routeId: route.routeBinding?.id || 'unknown', inlinePolicy: route.routeBinding?.upstreamConfig?.headerPolicy, registryConfigured: true });
      if (!enableHeaderPolicy) assertGatewayRegistryHeaderPolicyReady(snapshot.candidate);
      const resolution = await resolveUpstreamCredential(snapshot, {
        sourceServiceAssetId: route.sourceServiceAsset.id,
        url: targetUrl,
        requestMethod,
        endpointDefinitionId: route.endpointDefinition.id,
      });
      // Resolve policy using exactly the Site and Endpoint selector that authorized
      // the credential. Outbound requestMethod constrains credential scope; it is
      // not a second Endpoint selector when an Endpoint definition ID exists.
      const compiledHeaderPolicy = enableHeaderPolicy
        ? snapshot.getHeaderPolicy?.(resolution.siteId, { endpointDefinitionId: route.endpointDefinition.id })
        : undefined;
      if (enableHeaderPolicy && !snapshot.getHeaderPolicy) {
        throw new Error('GATEWAY_HEADER_POLICY_UNAVAILABLE');
      }
      const managed = new Set<string>(['authorization', ...snapshot.historicalAuthenticationHeaderNames ?? []]);
      for (const credential of Object.values(snapshot.candidate.credentials)) {
        managed.add(upstreamCredentialHeaderName(credential));
      }
      const metadata = JSON.stringify([resolution.generation, resolution.revision, resolution.siteId, resolution.credentialId ?? null]);
      let epoch: string | null = null;
      if (resolution.mode === 'reference') {
        const digest = createHash('sha256').update(JSON.stringify(Object.entries(resolution.headers).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
        let material = materials.get(metadata);
        if (!material || material.digest !== digest) material = { digest, epoch: randomUUID() };
        materials.delete(metadata); materials.set(metadata, material);
        if (materials.size > 256) materials.delete(materials.keys().next().value!);
        epoch = material.epoch;
      }
      return Object.freeze({
        cacheIdentity: JSON.stringify([metadata, epoch, compiledHeaderPolicy?.identity ?? null]),
        compiledHeaderPolicy,
        registryGeneration: resolution.generation,
        registryRevision: resolution.revision,
        registrySiteId: resolution.siteId,
        historicalAuthenticationHeaderNames: Object.freeze([...snapshot.historicalAuthenticationHeaderNames ?? []]),
        headers: resolution.headers,
        credentialHeaderNames: Object.freeze(Object.keys(resolution.headers)),
        managedHeaderNames: Object.freeze([...managed]),
      });
    },
  });
}
