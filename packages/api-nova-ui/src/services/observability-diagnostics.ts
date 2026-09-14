export async function diagnosticsRequest(resource: "capabilities" | "servers/status" | "pipeline/status",
  token: string, signal: AbortSignal) {
  const response = await fetch("/api/monitoring/observability/" + resource, {
    headers: { Authorization: "Bearer " + token }, cache: "no-store", signal,
  });
  const body = await response.json();
  if (!response.ok || body?.status !== "success") throw new Error("DIAGNOSTICS_UNAVAILABLE");
  return body.data;
}
const pick = (value: unknown, allowed: string[]) => typeof value === "string" && allowed.includes(value) ? value : "unknown";
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
export const diagnosticTime = (value: unknown): string | null =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? value : null;
export function heartbeatEvidence(raw: any) {
  if (raw?.evidenceScope !== "management_process_store_roundtrip" ||
    raw?.coverage !== "single_lease_holder" || raw?.businessServerLivenessEvaluated !== false) return null;
  return { state: pick(raw.reportedState, ["reporting", "stopped"]), freshness: pick(raw.freshnessStatus, ["recent", "stale"]),
    observedAt: diagnosticTime(raw.lastHeartbeatAt), ageMs: count(raw.observationAgeMs) };
}
export function routingEvidence(raw: any) {
  if (raw?.evidenceScope !== "local_process_routing_registry" ||
    raw?.coverage !== "single_lease_holder_process" || raw?.businessServerLivenessEvaluated !== false) return null;
  return { registration: pick(raw.registrationStatus, ["registered", "no_registered_routes"]),
    state: pick(raw.observerState, ["reporting", "stopped"]), freshness: pick(raw.freshnessStatus, ["recent", "stale"]),
    routeCount: count(raw.activeRouteCount), observedAt: diagnosticTime(raw.observedAt) };
}
export function scanEvidence(raw: any) {
  if (raw?.evidenceSource !== "retention_worker_payload_scan" ||
    raw?.scope !== "recognized_payload_objects_and_temporary_files" ||
    raw?.measurement !== "logical_file_length_before_cleanup") return null;
  return { coverage: pick(raw.scanCoverage, ["complete", "partial"]),
    freshness: pick(raw.freshnessStatus, ["recent", "stale"]),
    completedAt: diagnosticTime(raw.scanCompletedAt),
    observedBytes: count(raw.observedBytes), observedFiles: count(raw.observedFiles) };
}
export function retentionEvidence(raw: any) {
  if (raw?.evidenceSource !== "payload_retention_worker_last_report" || raw?.cleanupScope !== "payload_objects_only") return null;
  return { scanUsage: raw.currentAttemptComplete === true ? scanEvidence(raw.scanUsage) : null, state: pick(raw.state, ["disabled", "idle", "running", "waiting", "degraded", "stopped"]),
    freshness: pick(raw.freshnessStatus, ["recent", "stale"]), observedAt: diagnosticTime(raw.observedAt),
    workerConfigured: typeof raw.workerConfigured === "boolean" ? raw.workerConfigured : null,
    currentAttemptComplete: typeof raw.currentAttemptComplete === "boolean" ? raw.currentAttemptComplete : null,
    lastAttemptAt: diagnosticTime(raw.lastAttemptAt), lastReportAt: diagnosticTime(raw.lastReportAt),
    lastReport: raw.lastReport ? { scanned: count(raw.lastReport.scanned), deleted: count(raw.lastReport.deleted),
      protected: count(raw.lastReport.protected), danglingReferences: count(raw.lastReport.danglingReferences) } : null };
}
