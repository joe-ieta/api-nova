import { DataSource } from 'typeorm';
import { assertGatewayRegistryHeaderPolicyReady } from './gateway-header-policy';
import { validateGatewayCredentialOwnership } from './gateway-upstream-credential-ownership';
import type { FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UpstreamCredentialRegistry } from 'api-nova-parser';
import {
  createGatewayUpstreamCredentialResolver,
  GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER,
  type GatewayUpstreamCredentialResolver,
} from './gateway-upstream-credential-resolver';

export const GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY =
  Symbol('GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY');

export const GATEWAY_UPSTREAM_CREDENTIAL_CONFIG = Object.freeze({
  file: 'API_NOVA_UPSTREAM_CREDENTIAL_FILE',
  reloadMode: 'API_NOVA_UPSTREAM_CREDENTIAL_RELOAD_MODE',
  format: 'API_NOVA_UPSTREAM_CREDENTIAL_FORMAT',
  environment: 'API_NOVA_UPSTREAM_CREDENTIAL_ENVIRONMENT',
});

/**
 * Opt-in process-local activation. Nest awaits this factory before constructing
 * the resolver/proxy. Explicit but invalid configuration fails bootstrap.
 */
export async function createConfiguredGatewayCredentialRegistry(
  config: Pick<ConfigService, 'get'>,
  dataSource?: DataSource,
): Promise<UpstreamCredentialRegistry | null> {
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
      validateCandidateOwnership: candidate => {
        assertGatewayRegistryHeaderPolicyReady(candidate);
        return validateGatewayCredentialOwnership(dataSource, candidate);
      },
    });
    if (reloadMode === 'watch') await registry.startWatchingFile(file, format);
    else await registry.reloadFile(file, format);
    return registry;
  } catch {
    // Config values, filesystem paths and provider details must not reach logs.
    throw new Error('gateway_upstream_credential_configuration_failed');
  }
}

export const gatewayUpstreamCredentialRegistryProvider:
FactoryProvider<UpstreamCredentialRegistry | null> = {
  provide: GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY,
  inject: [ConfigService, DataSource],
  useFactory: createConfiguredGatewayCredentialRegistry,
};

export const gatewayUpstreamCredentialResolverProvider:
FactoryProvider<GatewayUpstreamCredentialResolver | null> = {
  provide: GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER,
  inject: [GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY],
  useFactory: (registry: UpstreamCredentialRegistry | null) =>
    registry ? createGatewayUpstreamCredentialResolver(() => registry.captureSnapshot()) : null,
};
