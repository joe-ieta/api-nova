import type { LogEntry, LogLevel } from "@/stores/log";

export const runtimeLogState = () => ({
  items: [] as LogEntry[], loading: false, error: null as string | null,
  page: 1, total: 0, hasNext: false, hasPrev: false,
});
export async function fetchRuntimeLogs(query: Record<string, string>, token: string, signal: AbortSignal) {
  const response = await fetch("/api/v1/monitoring/management/events?" + new URLSearchParams(query), {
    headers: { Authorization: "Bearer " + token }, cache: "no-store", signal,
  });
  if (!response.ok) throw new Error(response.status === 401 ? "unauthenticated" :
    response.status === 403 ? "forbidden" : "unavailable");
  const body = await response.json();
  if (body?.status !== "success") throw new Error("invalid");
  return body.data;
}
const levels: Record<string, string> = {
  debug: "debug", info: "info", warning: "warn", error: "error", critical: "fatal",
};
const serverLevels: Record<string, string> = { warn: "warning", fatal: "critical" };

/** One bounded page belongs to one login session. Never substitute sample data. */
export class RuntimeLogPager {
  private generation = 0;
  private controller: AbortController | null = null;
  constructor(
    readonly state: ReturnType<typeof runtimeLogState>,
    private readonly token: () => string | null,
    private readonly request = fetchRuntimeLogs,
  ) {}
  reset() {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    Object.assign(this.state, runtimeLogState());
  }
  async read(page = 1, level = "all") {
    this.reset();
    const token = this.token();
    if (!token) { this.state.error = "unauthenticated"; return; }
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.state.loading = true;
    const deadline = setTimeout(() => controller.abort(), 10000);
    try {
      const query: Record<string, string> = { page: String(page), limit: "50" };
      if (level !== "all") query.level = serverLevels[level] || level;
      const data = await this.request(query, token, controller.signal);
      if (generation !== this.generation) return;
      if (token !== this.token()) { this.reset(); return; }
      if (controller.signal.aborted) throw new Error("timeout");
      if (!Array.isArray(data?.data) || data.data.length > 50 || data.page !== page ||
          data.limit !== 50 || !Number.isInteger(data.total) || data.total < data.data.length ||
          typeof data.hasNext !== "boolean" || typeof data.hasPrev !== "boolean") throw new Error("invalid");
      const items: LogEntry[] = data.data.map((event: Record<string, unknown>) => {
        if (!event || typeof event.id !== "string" || !event.id ||
            typeof event.occurredAt !== "string" || !Number.isFinite(Date.parse(event.occurredAt)) ||
            typeof event.severity !== "string" || typeof levels[event.severity] !== "string" ||
            (event.summary != null && typeof event.summary !== "string") ||
            typeof event.eventName !== "string" || !event.eventName ||
            typeof event.eventFamily !== "string") throw new Error("invalid");
        return {
          id: event.id, timestamp: new Date(event.occurredAt), level: levels[event.severity] as LogLevel,
          source: event.eventFamily, message: typeof event.summary === "string" && event.summary ? event.summary : event.eventName,
          tags: [event.eventName],
          context: { runtimeAssetId: event.runtimeAssetId, endpointDefinitionId: event.endpointDefinitionId,
            status: event.status, details: event.details, dimensions: event.dimensions },
        };
      });
      Object.assign(this.state, { items, page, total: data.total, hasNext: data.hasNext, hasPrev: data.hasPrev });
    } catch (error) {
      if (generation !== this.generation) return;
      if (token !== this.token()) { this.reset(); return; }
      const code = error instanceof Error ? error.message : "";
      this.state.error = controller.signal.aborted ? "timeout" :
        ["unauthenticated", "forbidden", "invalid"].includes(code) ? code : "unavailable";
    } finally {
      clearTimeout(deadline);
      if (generation === this.generation) { this.state.loading = false; this.controller = null; }
    }
  }
}
