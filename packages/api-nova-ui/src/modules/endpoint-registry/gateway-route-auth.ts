export type GatewayRouteVisibility = "internal" | "external";

export function gatewayVisibilityForForm(value: unknown): GatewayRouteVisibility {
  // Legacy "public" was protected by JWT. Never reinterpret it as external.
  return value === "external" ? "external" : "internal";
}

export function gatewayAuthFieldsForSave(form: {
  routeVisibility: unknown;
  authPolicyRef: string;
}): { routeVisibility: GatewayRouteVisibility; authPolicyRef: string } {
  return {
    routeVisibility: gatewayVisibilityForForm(form.routeVisibility),
    // An explicit blank value clears the saved ref and blocks the next candidate.
    authPolicyRef: form.authPolicyRef.trim(),
  };
}

/** Preserve every existing option unless the operator explicitly selects v1. */
export function gatewayRegistryHeaderConfig(upstreamConfig: Record<string, unknown>, enabled: boolean): Record<string, unknown> {
  return enabled ? { ...upstreamConfig, headerPolicyMigration: { version: 1, mode: 'v1', source: 'registry' } } : { ...upstreamConfig };
}
export function usesGatewayRegistryHeaders(config: Record<string, any>): boolean {
  const policy = config?.headerPolicyMigration;
  return policy?.version === 1 && policy.mode === 'v1' && policy.source === 'registry';
}
