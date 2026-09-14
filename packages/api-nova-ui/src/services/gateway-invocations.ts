export interface GatewayInvocationFilters {
  runtimeAssetId?: string;
  outcome?: string;
  requestId?: string;
}
export interface GatewayInvocationPageState {
  items: any[];
  loading: boolean;
  error: string | null;
  page: number;
  hasMore: boolean;
  from: string | null;
  to: string | null;
  snapshotSeq: string | null;
  isPartial: boolean;
}
export const gatewayInvocationPageState = (): GatewayInvocationPageState => ({
  items: [], loading: false, error: null, page: 1, hasMore: false,
  from: null, to: null, snapshotSeq: null, isPartial: true,
});
export async function fetchGatewayInvocations(query: Record<string, string>, token: string, signal: AbortSignal) {
  const response = await fetch("/api/monitoring/observability/invocations?" + new URLSearchParams(query), {
    headers: { Authorization: "Bearer " + token }, cache: "no-store", signal,
  });
  const body = await response.json();
  if (!response.ok || body?.status !== "success") {
    const code = body?.error?.code || (response.status === 401 ? "UNAUTHENTICATED" :
      response.status === 403 ? "FORBIDDEN" : "OBSERVABILITY_UNAVAILABLE");
    throw Object.assign(new Error(code), { code });
  }
  return body;
}

/** One bounded page and its signed continuation belong to one credential session. */
export class GatewayInvocationPager {
  private generation = 0;
  private abort: AbortController | null = null;
  private filters: GatewayInvocationFilters = {};
  private nextCursor: string | null = null;
  private session: string | null = null;
  constructor(
    readonly state: GatewayInvocationPageState,
    private readonly token: () => string | null,
    private readonly request = fetchGatewayInvocations,
  ) {}

  reset() {
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    this.filters = {};
    this.nextCursor = null;
    this.session = null;
    Object.assign(this.state, gatewayInvocationPageState());
  }

  async latest(filters?: GatewayInvocationFilters) {
    if (filters !== undefined) this.filters = { ...filters };
    this.nextCursor = null;
    const now = Date.now();
    this.state.from = new Date(now - 3600000).toISOString();
    this.state.to = new Date(now).toISOString();
    await this.read(1);
  }
  async refresh() {
    // Background updates never replace a user's pinned historical page or an in-flight navigation.
    if (this.state.page !== 1 || this.state.loading) return;
    await this.latest();
  }
  async next() {
    if (!this.state.hasMore || !this.nextCursor || this.state.loading) return;
    await this.read(this.state.page + 1, this.nextCursor);
  }
  private async read(page: number, cursor: string | null = null) {
    const token = this.token();
    if (!token) { this.reset(); return; }
    if (this.session && this.session !== token) {
      this.reset();
      await this.latest();
      return;
    }
    this.session = token;
    const generation = ++this.generation;
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;
    this.state.loading = true;
    this.state.error = null;
    this.state.items = [];
    this.state.hasMore = false;
    const deadline = setTimeout(() => controller.abort(), 10000);
    try {
      const query: Record<string, string> = cursor ? { cursor, limit: "20" } : {
        from: this.state.from!, to: this.state.to!, limit: "20",
        serverType: "gateway", spanKind: "gateway_request", origin: "external", timeBasis: "startedAt",
      };
      if (!cursor) for (const key of ["runtimeAssetId", "outcome", "requestId"] as const) {
        const value = this.filters[key]?.trim();
        if (value) query[key] = value;
      }
      const response = await this.request(query, token, controller.signal);
      if (generation !== this.generation) return;
      if (token !== this.token()) { this.reset(); return; }
      const data = response?.data;
      if (!Array.isArray(data?.items) || data.items.length > 20 || typeof data.hasMore !== "boolean" ||
        (data.nextCursor !== null && typeof data.nextCursor !== "string") ||
        (data.hasMore && !data.nextCursor) ||
        data.items.some((item: any) => !item || item.serverType !== "gateway" ||
          item.spanKind !== "gateway_request" || item.origin !== "external")) {
        throw Object.assign(new Error("INVALID_PAGE"), { code: "INVALID_PAGE" });
      }
      this.state.items = data.items;
      this.state.page = page;
      this.state.hasMore = data.hasMore;
      this.nextCursor = data.nextCursor;
      this.state.snapshotSeq = typeof response.meta?.snapshotSeq === "string" ? response.meta.snapshotSeq : null;
      this.state.isPartial = response.meta?.isPartial !== false;
    } catch (error: any) {
      if (generation !== this.generation) return;
      this.state.items = [];
      this.state.hasMore = false;
      this.state.snapshotSeq = null;
      this.state.error = controller.signal.aborted ? "QUERY_TIMEOUT" : error?.code || "OBSERVABILITY_UNAVAILABLE";
      this.nextCursor = null;
      this.state.page = 1;
    } finally {
      clearTimeout(deadline);
      if (generation === this.generation) {
        this.state.loading = false;
        this.abort = null;
      }
    }
  }
}
