export type StreamStatus = "stopped" | "connecting" | "live" | "retrying" | "error";
export interface StreamSocket {
  on(event: string, callback: (...args: any[]) => void): any;
  emit(event: string, payload?: any): any;
  connect(): any;
  disconnect(): any;
  removeAllListeners(): any;
}
export interface StreamDependencies {
  socket(token: string): StreamSocket;
  snapshot(token: string, signal: AbortSignal): Promise<any>;
  snapshotReceived(data: any): void;
  pageReceived(items: any[]): void | Promise<void>;
  reset(): void;
  state(status: StreamStatus, error: string | null): void;
  retryDelayMs?: number;
  snapshotTimeoutMs?: number;
}
const RECOVERABLE = new Set(["EVENT_CURSOR_EXPIRED", "CURSOR_EXPIRED", "CURSOR_SCOPE_MISMATCH", "QUERY_TOO_LARGE"]);
const TERMINAL = new Set(["UNAUTHENTICATED", "FORBIDDEN", "INVALID_QUERY"]);

/** One page in flight. Only a fully applied page can advance the in-memory signed cursor.
 * Session replacement discards both the cursor and all old asynchronous completions. */
export class ObservabilityStreamClient {
  private generation = 0;
  private token: string | null = null;
  private principal: string | null = null;
  private socket: StreamSocket | null = null;
  private cursor: string | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  private retries = 0;
  private processing = false;
  constructor(private readonly deps: StreamDependencies) {}

  setSession(token: string | null, principal: string | null) {
    if (token === this.token && principal === this.principal) return;
    this.stop();
    if (!token || !principal) return;
    this.token = token;
    this.principal = principal;
    this.open();
  }

  stop() {
    this.generation++;
    this.closeSocket();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.token = null;
    this.principal = null;
    this.cursor = null;
    this.retries = 0;
    this.deps.reset();
    this.deps.state("stopped", null);
  }

  private closeSocket() {
    this.abort?.abort();
    this.abort = null;
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.processing = false;
  }

  private open() {
    if (!this.token) return;
    const generation = ++this.generation;
    const token = this.token;
    this.deps.state(this.retries ? "retrying" : "connecting", null);
    const socket = this.deps.socket(token);
    this.socket = socket;
    const current = () => this.generation === generation && this.socket === socket;
    socket.on("connect", async () => {
      try {
        let query: Record<string, string>;
        if (this.cursor) query = { after: this.cursor };
        else {
          const abort = new AbortController();
          this.abort = abort;
          const deadline = setTimeout(() => abort.abort(), this.deps.snapshotTimeoutMs ?? 10000);
          let snapshot;
          try { snapshot = await this.deps.snapshot(token, abort.signal); }
          finally { clearTimeout(deadline); }
          if (!current()) return;
          if (snapshot?.invocationSnapshotAuthorized !== true ||
            snapshot?.invocationSnapshotScope !== "invocation_facts_only" ||
            typeof snapshot?.invocationSnapshotSeq !== "string" ||
            !/^(0|[1-9]\d{0,19})$/.test(snapshot?.invocationSnapshotSeq)) {
            throw new Error("SNAPSHOT_UNAVAILABLE");
          }
          this.deps.snapshotReceived(snapshot);
          query = { afterSequence: snapshot.invocationSnapshotSeq, origin: "external" };
        }
        if (current()) socket.emit("subscribe-observability", query);
      } catch (error: any) {
        if (current()) this.fail(this.abort?.signal.aborted ? "SNAPSHOT_TIMEOUT" : error?.code || error?.message || "SNAPSHOT_UNAVAILABLE");
      }
    });
    socket.on("observability-event", async (page: any, ack: unknown) => {
      if (!current()) return;
      if (this.processing || page?.status !== "success" || !Array.isArray(page?.data?.items) ||
        page.data.items.length > 50 || typeof page.data.nextCursor !== "string" ||
        !page.data.nextCursor || page.data.nextCursor.length > 32768 || typeof ack !== "function") {
        this.fail("INVALID_PAGE");
        return;
      }
      this.processing = true;
      try {
        await this.deps.pageReceived(page.data.items);
        if (!current()) return;
        this.cursor = page.data.nextCursor;
        (ack as Function)({ nextCursor: this.cursor });
        this.retries = 0;
        this.deps.state("live", null);
      } catch {
        if (current()) this.fail("PAGE_PROCESSING_FAILED");
      } finally {
        if (current()) this.processing = false;
      }
    });
    socket.on("observability-error", (error: any) => {
      if (current()) this.fail(typeof error?.code === "string" ? error.code : "STREAM_UNAVAILABLE");
    });
    socket.on("connect_error", () => { if (current()) this.fail("CONNECTION_FAILED"); });
    socket.on("disconnect", () => { if (current()) this.fail("CONNECTION_LOST"); });
    socket.connect();
  }

  private fail(code: string) {
    this.generation++;
    this.closeSocket();
    if (RECOVERABLE.has(code) || TERMINAL.has(code)) {
      this.cursor = null;
      this.deps.reset();
    }
    if (TERMINAL.has(code) || this.retries >= 5) {
      this.deps.state("error", code);
      return;
    }
    this.deps.state("retrying", code);
    const delay = (this.deps.retryDelayMs ?? 1000) * 2 ** this.retries++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }
}

/** The token is captured by the session, never reread after an asynchronous response. */
export async function fetchObservabilitySnapshot(token: string, signal: AbortSignal) {
  const response = await fetch("/api/monitoring/observability/overview?origin=external", {
    headers: { Authorization: "Bearer " + token }, cache: "no-store", signal,
  });
  const body = await response.json();
  if (!response.ok || body?.status !== "success") {
    const code = body?.error?.code || (response.status === 401 ? "UNAUTHENTICATED" :
      response.status === 403 ? "FORBIDDEN" : "SNAPSHOT_UNAVAILABLE");
    throw Object.assign(new Error(code), { code });
  }
  return body.data;
}
