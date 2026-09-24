import { EndpointPublishBindingEntity } from '../../../database/entities/endpoint-publish-binding.entity';
import { RuntimeAssetEndpointBindingEntity } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import type { UpstreamCredentialRegistrySnapshot } from 'api-nova-parser';
import { requireGatewayRegistryHeaderV1 } from './gateway-header-v1-readiness';
import { ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { GatewayRouteBindingEntity } from '../../../database/entities/gateway-route-binding.entity';
import { GatewayResolvedRoute } from '../types/gateway-route-snapshot.types';
import { GatewayHeaderLegacyExceptionService } from './gateway-header-legacy-exception.service';
const reject = (): never => { throw new ServiceUnavailableException('gateway_header_legacy_exception_unavailable'); };
function policyView(route: GatewayRouteBindingEntity): string {
  const { headerPolicyLegacyException: _record, headerPolicyMigration: _migration, ...config } = route.upstreamConfig || {};
  const value = { id: route.id, endpointDefinitionId: route.endpointDefinitionId, membershipId: route.runtimeAssetEndpointBindingId,
    matchHost: route.matchHost ?? null, routePath: route.routePath, routeMethod: route.routeMethod,
    upstreamPath: route.upstreamPath, upstreamMethod: route.upstreamMethod, authPolicyRef: route.authPolicyRef ?? null,
    routeVisibility: route.routeVisibility, pathMatchMode: route.pathMatchMode, priority: route.priority,
    publishBindingId: route.publishBindingId ?? null, cachePolicyRef: route.cachePolicyRef ?? null,
    trafficPolicyRef: route.trafficPolicyRef ?? null, loggingPolicyRef: route.loggingPolicyRef ?? null,
    rateLimitPolicyRef: route.rateLimitPolicyRef ?? null, circuitBreakerPolicyRef: route.circuitBreakerPolicyRef ?? null,
    timeoutMs: route.timeoutMs ?? null, retryPolicy: route.retryPolicy ?? null, config };
  const normalize = (input: any): any => Array.isArray(input) ? input.map(normalize) : input && typeof input === 'object' ? Object.fromEntries(Object.keys(input).sort().map(key => [key, normalize(input[key])])) : input;
  return JSON.stringify(normalize(value));
}
/** Independent pre-cache guard; production registration/wiring is a separate step. */
export class GatewayHeaderLegacyRuntimeGuard {
  constructor(private readonly dataSource: DataSource,
    /** Trusted host registry state; undefined means no reliable provider observation. */
    private readonly registryConfigured: () => boolean | undefined,
    private readonly now: () => number = Date.now,
    private readonly captureRegistry?: () => UpstreamCredentialRegistrySnapshot) {}

  async assertAllowed(route: GatewayResolvedRoute): Promise<void> {
    try {
      const active = route.routeBinding;
      const current = await this.dataSource.getRepository(GatewayRouteBindingEntity).findOneBy({ id: active.id });
      if (!current) return reject();
      const old = active.upstreamConfig || {}, config = current.upstreamConfig || {};
      const marked = [old, config].some(value => value.headerPolicyMigration !== undefined || value.headerPolicyLegacyException !== undefined || value.headerPolicy !== undefined);
      if (!marked) return reject(); // No grant is not proof of an unmigrated safe exception.
      const registry = this.registryConfigured();
      if (typeof registry !== 'boolean' || policyView(active) !== policyView(current)) return reject();
      if ((config.headerPolicyMigration as any)?.mode === 'v1') {
        if (!registry || JSON.stringify(old.headerPolicyMigration) !== JSON.stringify(config.headerPolicyMigration)) return reject();
        const membership = await this.dataSource.getRepository(RuntimeAssetEndpointBindingEntity).findOneBy({ id: current.runtimeAssetEndpointBindingId! });
        if (!membership || !membership.enabled || membership.status !== 'active' || membership.runtimeAssetId !== route.runtimeAsset.id
          || membership.endpointDefinitionId !== route.endpointDefinition.id || membership.publicationRevision !== route.membership.publicationRevision
          || current.status !== 'active') return reject();
        if (!current.publishBindingId) return reject();
        const published = await this.dataSource.getRepository(EndpointPublishBindingEntity).findOneBy({ id: current.publishBindingId });
        if (!published || published.publishStatus !== 'active' || !published.publishedToHttp || published.endpointDefinitionId !== current.endpointDefinitionId
          || published.runtimeAssetEndpointBindingId !== membership.id || published.publicationRevision !== membership.publicationRevision) return reject();
        requireGatewayRegistryHeaderV1(current, this.captureRegistry?.());
        return;
      }
      const record: any = config.headerPolicyLegacyException;
      if (config.headerPolicy !== undefined || (config.headerPolicyMigration as any)?.mode !== 'legacy' || !record || record.source?.source !== 'inline' || registry) return reject();
      // Registry provenance cannot be inferred from the stored grant itself.
      // Until its trusted live bridge exists, Registry exceptions always reject.
      await new GatewayHeaderLegacyExceptionService(this.dataSource, this.now).validate(current.id, record.id,
        { actorId: 'runtime-guard', source: { source: 'inline' }, registryConfigured: false });
    } catch { return reject(); }
  }
}
