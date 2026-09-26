import { createHash } from 'node:crypto';
import { GatewayHeaderHistoryLedgerService } from '../../../database/gateway-header-history-ledger.service';
import { DataSource } from 'typeorm';
import { validateGatewayCredentialOwnership } from './gateway-upstream-credential-ownership';
import type { FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UpstreamCredentialRegistry, UpstreamCredentialRegistryError } from 'api-nova-parser';
import {
  createGatewayUpstreamCredentialResolver,
  GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER,
  type GatewayUpstreamCredentialResolver,
} from './gateway-upstream-credential-resolver';
import { GATEWAY_HOST_RUNTIME, resolveGatewayHostRuntime } from './gateway-host-runtime.providers';

export const GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY =
  Symbol('GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY');

export const GATEWAY_UPSTREAM_CREDENTIAL_CONFIG = Object.freeze({
  file: 'API_NOVA_UPSTREAM_CREDENTIAL_FILE',
  reloadMode: 'API_NOVA_UPSTREAM_CREDENTIAL_RELOAD_MODE',
  format: 'API_NOVA_UPSTREAM_CREDENTIAL_FORMAT',
  environment: 'API_NOVA_UPSTREAM_CREDENTIAL_ENVIRONMENT',
});

/** One host-owned Registry role per database. Never partition by mutable candidate or file path. */
export const GATEWAY_HEADER_HISTORY_NAMESPACE = 'gateway:upstream-credential-registry:v1';
export const GATEWAY_HEADER_HISTORY_PROVENANCE = createHash('sha256')
  .update('api-nova:gateway:database-owned-upstream-credential-registry:v1').digest('hex');

/**
 * Opt-in durable activation. Nest awaits this factory before constructing
 * the resolver/proxy. Explicit but invalid configuration fails bootstrap.
 * Explicit host mode excludes the legacy Registry before any config read or
 * file watch, so the two providers can never be active at the same time.
 */
export async function createConfiguredGatewayCredentialRegistry(
  config: Pick<ConfigService, 'get'>,
  dataSource?: DataSource,
  hostRuntime?: unknown,
): Promise<UpstreamCredentialRegistry | null> {
  if (resolveGatewayHostRuntime(hostRuntime)) return null;
  try {
    const file = config.get<unknown>(GATEWAY_UPSTREAM_CREDENTIAL_CONFIG.file);
    const format = config.get<unknown>(GATEWAY_UPSTREAM_CREDENTIAL_CONFIG.format);
    const environment = config.get<unknown>(GATEWAY_UPSTREAM_CREDENTIAL_CONFIG.environment);
    const reloadMode = config.get<unknown>(GATEWAY_UPSTREAM_CREDENTIAL_CONFIG.reloadMode);
    if (reloadMode === undefined && file === undefined && format === undefined && environment === undefined) return null;
    if ((reloadMode !== undefined && reloadMode !== 'manual' && reloadMode !== 'watch') ||
        typeof file !== 'string' || !file ||
        (format !== 'json' && format !== 'yaml') ||
        typeof environment !== 'string' || !environment) {
      throw new Error('invalid configuration');
    }
    if (!dataSource?.isInitialized) throw new Error('asset store unavailable');
    const registry = new UpstreamCredentialRegistry({ environment,
      credentialHeaderHistory: { namespace: GATEWAY_HEADER_HISTORY_NAMESPACE,
        store: new GatewayHeaderHistoryLedgerService(dataSource).asStore(GATEWAY_HEADER_HISTORY_NAMESPACE, GATEWAY_HEADER_HISTORY_PROVENANCE) },
      validateCandidateOwnership: candidate => {
        return validateGatewayCredentialOwnership(dataSource, candidate);
      },
    });
    try {
      if (reloadMode === 'watch') await registry.startWatchingFile(file, format);
      else await registry.reloadFile(file, format);
    } catch (error) {
      // Keep the configured Registry object (never the legacy null fallback). Its
      // empty snapshot rejects Gateway requests while unrelated APIs can boot.
      if (!(error instanceof UpstreamCredentialRegistryError)
        || (error.code !== 'HISTORY_UNAVAILABLE' && error.code !== 'HISTORY_CONFLICT')) throw error;
    }
    return registry;
  } catch {
    // Config values, filesystem paths and provider details must not reach logs.
    throw new Error('gateway_upstream_credential_configuration_failed');
  }
}

export const gatewayUpstreamCredentialRegistryProvider:
FactoryProvider<UpstreamCredentialRegistry | null> = {
  provide: GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY,
  inject: [ConfigService, DataSource, GATEWAY_HOST_RUNTIME],
  useFactory: createConfiguredGatewayCredentialRegistry,
};

export const gatewayUpstreamCredentialResolverProvider:
FactoryProvider<GatewayUpstreamCredentialResolver | null> = {
  provide: GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER,
  inject: [GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY],
  useFactory: (registry: UpstreamCredentialRegistry | null) =>
    registry ? createGatewayUpstreamCredentialResolver(() => registry.captureSnapshot(), { enableHeaderPolicy: true, requirePersistedV1: true }) : null,
};
