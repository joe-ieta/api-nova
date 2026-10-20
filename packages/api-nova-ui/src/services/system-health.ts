export interface HealthSnapshot {
  status: "unknown" | "healthy" | "error";
  errorCount: number;
  lastCheck: Date | null;
}

// Full health is intentionally outside /api. A Terminus 503 is a valid
// unhealthy snapshot; transport failures and invalid bodies are unavailable.
export function parseHealthSnapshot(body: unknown, httpStatus: number): HealthSnapshot {
  const envelope = body as { success?: boolean; error?: { details?: unknown } } | null;
  const result = (httpStatus === 503 && envelope?.success === false
    ? envelope.error?.details : body) as { status?: string; details?: Record<string, { status?: string }> };
  if (!result || !["ok", "error", "shutting_down"].includes(result.status || "") ||
      !result.details || typeof result.details !== "object" || Array.isArray(result.details)) {
    throw new Error("Invalid health response");
  }
  const checks = Object.values(result.details);
  if (!checks.length || checks.some(check => !check || !["up", "down"].includes(check.status || ""))) {
    throw new Error("Invalid health indicators");
  }
  const failed = checks.filter(check => check.status !== "up").length;
  const healthy = httpStatus === 200 && result.status === "ok" && failed === 0;
  return { status: healthy ? "healthy" : "error", errorCount: healthy ? 0 : Math.max(1, failed), lastCheck: new Date() };
}

export async function fetchSystemHealth(): Promise<HealthSnapshot> {
  const response = await fetch("/health", {
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
    headers: { Accept: "application/json" },
  });
  if (response.status !== 200 && response.status !== 503) {
    throw new Error(`Health request failed (${response.status})`);
  }
  return parseHealthSnapshot(await response.json(), response.status);
}
