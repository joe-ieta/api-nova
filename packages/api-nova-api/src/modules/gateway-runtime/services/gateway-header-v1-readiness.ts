import type { CompiledHeaderPolicyV1, UpstreamCredentialRegistrySnapshot } from 'api-nova-parser';
import { normalizeGatewayHeaderMigration } from './gateway-header-migration';
import type { GatewayRouteBindingEntity } from '../../../database/entities/gateway-route-binding.entity';

const reject = (): never => { throw new Error('GATEWAY_HEADER_POLICY_NOT_READY'); };
/** Host-only readiness. Incoming headers and caller metadata are never policy selectors. */
export function requireGatewayRegistryHeaderV1(route: Pick<GatewayRouteBindingEntity, 'id' | 'endpointDefinitionId' | 'upstreamConfig'>,
  snapshot: UpstreamCredentialRegistrySnapshot | undefined): CompiledHeaderPolicyV1 {
  try {
    const config = route.upstreamConfig;
    const migration = normalizeGatewayHeaderMigration(config?.headerPolicyMigration, route.id);
    if (migration.mode !== 'v1' || migration.source !== 'registry' || config?.headerPolicy !== undefined
      || config?.headerPolicyLegacyException !== undefined || !snapshot || snapshot.generation < 1 || !snapshot.getHeaderPolicy) return reject();
    const sites = snapshot.candidate.sites.filter(site => site.endpoints.some(endpoint =>
      'endpointDefinitionId' in endpoint && endpoint.endpointDefinitionId === route.endpointDefinitionId));
    // Activation requires an explicit durable Endpoint binding; ambiguous Site ownership is not guessed.
    if (sites.length !== 1) return reject();
    const policy = snapshot.getHeaderPolicy(sites[0].id, { endpointDefinitionId: route.endpointDefinitionId });
    if (!policy) return reject();
    return policy;
  } catch { return reject(); }
}
