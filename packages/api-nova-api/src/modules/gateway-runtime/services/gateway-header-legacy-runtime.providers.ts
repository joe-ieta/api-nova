import { DataSource } from 'typeorm';
import { UpstreamCredentialRegistry } from 'api-nova-parser';
import type { FactoryProvider } from '@nestjs/common';
import { GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY } from './gateway-upstream-credential.providers';
import { GATEWAY_HOST_RUNTIME, resolveGatewayHostRuntime } from './gateway-host-runtime.providers';
import { GatewayHeaderLegacyRuntimeGuard } from './gateway-header-legacy-runtime.guard';

export const gatewayHeaderLegacyRuntimeGuardProvider: FactoryProvider<GatewayHeaderLegacyRuntimeGuard> = {
  provide: GatewayHeaderLegacyRuntimeGuard,
  inject: [DataSource, GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY, GATEWAY_HOST_RUNTIME],
  useFactory: (dataSource: DataSource, registry: UpstreamCredentialRegistry | null, hostRuntime: unknown) => {
    const host = resolveGatewayHostRuntime(hostRuntime);
    return new GatewayHeaderLegacyRuntimeGuard(
      dataSource,
      host ? () => true : () => registry === null ? false : registry instanceof UpstreamCredentialRegistry ? true : undefined,
      Date.now,
      host ? () => host.captureSnapshot() : registry ? () => registry.captureSnapshot() : undefined,
    );
  },
};
