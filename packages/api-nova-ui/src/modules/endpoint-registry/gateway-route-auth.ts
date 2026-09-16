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
