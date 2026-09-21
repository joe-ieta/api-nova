import { compileHeaderPolicyV1, type CompiledHeaderPolicyV1, type UpstreamCredentialBindingsCandidate } from 'api-nova-parser';

/** Compilation is preparatory until transport/cache consumers are delivered in D1-02B/C. */
export function compileGatewayHeaderPolicy(input: {
  routeId: string; inlinePolicy?: unknown; registryConfigured?: boolean;
  registryPolicy?: CompiledHeaderPolicyV1; managedHeaderNames?: readonly string[];
}): CompiledHeaderPolicyV1 | undefined {
  if (input.registryConfigured && input.inlinePolicy !== undefined) throw new Error('GATEWAY_HEADER_POLICY_SOURCE_CONFLICT');
  if (input.registryConfigured) return input.registryPolicy;
  return input.inlinePolicy === undefined ? undefined : compileHeaderPolicyV1({ policy: input.inlinePolicy,
    sourceId: `gateway-route:${input.routeId}`, credentialHeaderNames: input.managedHeaderNames });
}

export function assertGatewayHeaderPolicyReady(inlinePolicy: unknown, routeId: string): void {
  const compiled = compileGatewayHeaderPolicy({ routeId, inlinePolicy });
  if (compiled) throw new Error('GATEWAY_HEADER_POLICY_NOT_READY');
}

/** Production activation cannot accept metadata that its data plane does not yet enforce. */
export function assertGatewayRegistryHeaderPolicyReady(candidate: UpstreamCredentialBindingsCandidate): void {
  if (candidate.sites.some(site => site.headerPolicy !== undefined || site.endpoints.some(endpoint => endpoint.headerPolicy !== undefined)))
    throw new Error('GATEWAY_HEADER_POLICY_NOT_READY');
}
