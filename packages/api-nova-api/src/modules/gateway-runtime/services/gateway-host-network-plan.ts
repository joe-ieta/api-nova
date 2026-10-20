import { types } from 'node:util';
import type { CompiledNetworkPolicy, createNetworkPolicyCompiler } from 'api-nova-parser';

export const GATEWAY_HOST_NETWORK_PLAN = Symbol('GATEWAY_HOST_NETWORK_PLAN');
export interface GatewayHostNetworkPlan { readonly kind: 'gateway-host-network-plan' }
type Plan = Readonly<{
  compiler: ReturnType<typeof createNetworkPolicyCompiler>;
  servers: readonly string[];
  policies: readonly Readonly<{ routeBindingId: string; siteId: string; policy: CompiledNetworkPolicy }>[];
  ca?: string;
  proofTtlMs: number;
}>;
const plans = new WeakMap<object, Plan>();
const fail = (): never => { throw new Error('gateway_host_network_plan_invalid'); };
const data = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !('value' in descriptor)) return fail();
    result[key] = descriptor.value;
  }
  return result;
};
/** Trusted host code only; no request, environment or persisted configuration adapter. */
export function attestGatewayHostNetworkPlan(input: {
  compiler: Plan['compiler']; servers: readonly string[]; policies: Plan['policies'];
  ca?: string; proofTtlMs?: number;
}): GatewayHostNetworkPlan {
  const value = data(input);
  if (Object.keys(value).some(key => !['compiler', 'servers', 'policies', 'ca', 'proofTtlMs'].includes(key))) return fail();
  if (!value.compiler || typeof value.compiler !== 'object' || types.isProxy(value.compiler)) return fail();
  if (!Array.isArray(value.servers) || types.isProxy(value.servers) || value.servers.length < 1 || value.servers.length > 16 ||
      !Array.isArray(value.policies) || types.isProxy(value.policies) || value.policies.length < 1 || value.policies.length > 1024) return fail();
  // Copy only own data entries; getters/sparse arrays never execute host callbacks.
  const copy = (array: unknown[]) => Array.from({ length: array.length }, (_, i) => {
    const descriptor = Object.getOwnPropertyDescriptor(array, String(i));
    if (!descriptor || !('value' in descriptor)) return fail();
    return descriptor.value;
  });
  const servers = copy(value.servers);
  if (servers.some(server => typeof server !== 'string' || !server || server.length > 256 || /[\s\u0000-\u001f]/u.test(server))) return fail();
  const ids = new Set<string>();
  const policies = copy(value.policies).map(entry => {
    const item = data(entry);
    if (Object.keys(item).length !== 3 || typeof item.routeBindingId !== 'string' || !item.routeBindingId ||
        typeof item.siteId !== 'string' || !item.siteId || !item.policy || typeof item.policy !== 'object' ||
        ids.has(item.routeBindingId)) return fail();
    ids.add(item.routeBindingId);
    return Object.freeze({ routeBindingId: item.routeBindingId, siteId: item.siteId, policy: item.policy as CompiledNetworkPolicy });
  });
  const proofTtlMs = value.proofTtlMs ?? 30000;
  if (!Number.isSafeInteger(proofTtlMs) || (proofTtlMs as number) < 1 || (proofTtlMs as number) > 60000 ||
      (value.ca !== undefined && (typeof value.ca !== 'string' || value.ca.length > 256 * 1024))) return fail();
  const token = Object.freeze({ kind: 'gateway-host-network-plan' as const });
  plans.set(token, Object.freeze({
    compiler: value.compiler as Plan['compiler'], servers: Object.freeze(servers),
    policies: Object.freeze(policies), ca: value.ca as string | undefined, proofTtlMs: proofTtlMs as number,
  }));
  return token;
}
export function inspectGatewayHostNetworkPlan(token: GatewayHostNetworkPlan): Plan {
  const plan = token && typeof token === 'object' ? plans.get(token) : undefined;
  return plan ?? fail();
}
