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
  format: 'API_NOVA_UPSTREAM_CREDENTIAL_FORMAT',
  environment: 'API_NOVA_UPSTREAM_CREDENTIAL_ENVIRONMENT',
});

/**
 * Opt-in process-local activation. Nest awaits this factory before constructing
 * the resolver/proxy. Explicit but invalid configuration fails bootstrap.
 */
export async function createConfiguredGatewayCredentialRegistry(
  config: Pick<ConfigService, 'get'>,
): Promise<UpstreamCredentialRegistry | null> {
  try {
    const file = config.get<unknown>(GATEWAY_UPSTREAM_CREDENTIAL_CONFIG.file);
    const format = config.get<unknown>(GATEWAY_UPSTREAM_CREDENTIAL_CONFIG.format);
    const environment = config.get<unknown>(GATEWAY_UPSTREAM_CREDENTIAL_CONFIG.environment);
    if (file === undefined && format === undefined && environment === undefined) return null;
    if (typeof file !== 'string' || !file ||
        (format !== 'json' && format !== 'yaml') ||
        typeof environment !== 'string' || !environment) {
      throw new Error('invalid configuration');
    }
    const registry = new UpstreamCredentialRegistry({ environment });
    await registry.reloadFile(file, format);
    return registry;
  } catch {
    // Config values, filesystem paths and provider details must not reach logs.
    throw new Error('gateway_upstream_credential_configuration_failed');
  }
}

export const gatewayUpstreamCredentialRegistryProvider:
FactoryProvider<UpstreamCredentialRegistry | null> = {
  provide: GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY,
  inject: [ConfigService],
  useFactory: createConfiguredGatewayCredentialRegistry,
};

export const gatewayUpstreamCredentialResolverProvider:
FactoryProvider<GatewayUpstreamCredentialResolver | null> = {
  provide: GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER,
  inject: [GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY],
  useFactory: (registry: UpstreamCredentialRegistry | null) =>
    registry ? createGatewayUpstreamCredentialResolver(() => registry.captureSnapshot()) : null,
};
