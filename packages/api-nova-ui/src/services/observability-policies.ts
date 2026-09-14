export interface ObservabilityPolicy {
  id: string;
  revision: number;
  policyEtag: string;
  retention: { eventDays: number; payloadDays: number };
  effectiveAt: string | null;
}
export function validPolicy(value: any): value is ObservabilityPolicy {
  return value?.id === "global-event-retention" && Number.isSafeInteger(value.revision) && value.revision >= 1 &&
    typeof value.policyEtag === "string" && /^"obs\.[a-f0-9]{32}\.[1-9]\d{0,15}"$/.test(value.policyEtag) &&
    [value.retention?.eventDays, value.retention?.payloadDays].every(days =>
      Number.isSafeInteger(days) && days >= 1 && days <= 365);
}
export async function policyRequest(
  resource: "capabilities" | "policies" | "policies/global-event-retention",
  token: string, signal: AbortSignal,
  mutation?: { etag: string; eventDays: number; payloadDays: number; reason: string },
) {
  const response = await fetch("/api/monitoring/observability/" + resource, {
    method: mutation ? "PATCH" : "GET", cache: "no-store", signal,
    headers: { Authorization: "Bearer " + token,
      ...(mutation ? { "Content-Type": "application/json", "If-Match": mutation.etag } : {}) },
    ...(mutation ? { body: JSON.stringify({ retention: { eventDays: mutation.eventDays,
      payloadDays: mutation.payloadDays }, reason: mutation.reason }) } : {}),
  });
  const body = await response.json();
  if (!response.ok || body?.status !== "success") {
    throw Object.assign(new Error("Policy request failed"), {
      code: body?.error?.code || (response.status === 412 ? "PRECONDITION_FAILED" :
        response.status === 401 ? "UNAUTHENTICATED" : response.status === 403 ? "FORBIDDEN" : "OBSERVABILITY_UNAVAILABLE"),
    });
  }
  return body.data;
}
