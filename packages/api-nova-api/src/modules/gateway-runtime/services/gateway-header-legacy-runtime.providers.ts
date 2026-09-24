import { DataSource } from 'typeorm';
import { UpstreamCredentialRegistry } from 'api-nova-parser';
import type { FactoryProvider } from '@nestjs/common';
import { GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY } from './gateway-upstream-credential.providers';
import { GatewayHeaderLegacyRuntimeGuard } from './gateway-header-legacy-runtime.guard';

export const gatewayHeaderLegacyRuntimeGuardProvider: FactoryProvider<GatewayHeaderLegacyRuntimeGuard> = {
  provide: GatewayHeaderLegacyRuntimeGuard,
  inject: [DataSource, GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY],
  useFactory: (dataSource: DataSource, registry: UpstreamCredentialRegistry | null) =>
    new GatewayHeaderLegacyRuntimeGuard(dataSource, () => registry === null ? false : registry instanceof UpstreamCredentialRegistry ? true : undefined, Date.now, registry ? () => registry.captureSnapshot() : undefined),
};
