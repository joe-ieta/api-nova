import { ExecutionContext, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Socket } from 'socket.io';
import { ObservabilityAccessGuard, getObservabilityAuthorization } from './call-observability-access.guard';
import { ObservabilityApiError } from './call-observability-api.contract';
import { CallObservabilityEventsController } from './call-observability-events.controller';
import { CallObservabilityEventsService } from './call-observability-events.service';

export const REALTIME_PAGE_SIZE = 50;
export const REALTIME_MAX_CATCHUP_SCAN = 10000;
export const REALTIME_ACK_TIMEOUT_MS = 5000;
export const REALTIME_POLL_MS = 1000;
export const REALTIME_MAX_SUBSCRIPTIONS = 100;
interface Subscription {
  socket: Socket;
  query: Record<string, unknown>;
  fingerprint?: string;
  running: boolean;
  confirmed: boolean;
  catchupScanned: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** A bounded reader of the REST durable event stream; never an additional event source. */
@Injectable()
export class CallObservabilityRealtimeService implements OnModuleDestroy {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly inFlight = new Set<string>();
  constructor(private readonly events: CallObservabilityEventsService,
    private readonly access: ObservabilityAccessGuard) {}

  async authorize(socket: Socket) {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || token.length > 8185 || !/^[A-Za-z0-9_.-]+$/.test(token)) {
      throw new ObservabilityApiError('UNAUTHENTICATED');
    }
    // Reuse the exact REST management JWT validation and fresh database role lookup.
    const request = { headers: { authorization: `Bearer ${token}` } };
    await this.access.canActivate({
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ setHeader() {} }) }),
      getClass: () => CallObservabilityEventsController,
      getHandler: () => CallObservabilityEventsController.prototype.list,
    } as unknown as ExecutionContext);
    return getObservabilityAuthorization(request);
  }

  async subscribe(socket: Socket, raw: Record<string, unknown>) {
    // Reserve before awaiting authorization to prevent concurrent subscriptions accumulating readers.
    if (this.subscriptions.has(socket.id) || this.inFlight.has(socket.id) ||
      new Set([...this.subscriptions.keys(), ...this.inFlight]).size >= REALTIME_MAX_SUBSCRIPTIONS) {
      this.fail(socket, 'RATE_LIMITED');
      return;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.until !== undefined ||
      raw.limit !== undefined || (raw.after === undefined && raw.afterSequence === undefined)) {
      this.fail(socket, 'INVALID_QUERY');
      return;
    }
    const state: Subscription = { socket, query: { ...raw, limit: String(REALTIME_PAGE_SIZE) },
      running: false, confirmed: false, catchupScanned: 0 };
    this.subscriptions.set(socket.id, state);
    await this.pump(state);
  }

  unsubscribe(socket: Socket) {
    const state = this.subscriptions.get(socket.id);
    if (state?.timer) clearTimeout(state.timer);
    this.subscriptions.delete(socket.id);
  }

  private current(state: Subscription) {
    return state.socket.connected && this.subscriptions.get(state.socket.id) === state;
  }

  private async pump(state: Subscription) {
    if (!this.current(state) || state.running) return;
    state.running = true;
    this.inFlight.add(state.socket.id);
    try {
      const scope = await this.authorize(state.socket);
      if (!this.current(state)) return;
      if (state.fingerprint && state.fingerprint !== scope.fingerprint) {
        throw new ObservabilityApiError('CURSOR_SCOPE_MISMATCH');
      }
      state.fingerprint = scope.fingerprint;
      // EventsService pins H for incomplete pages and advances H only after a complete signed cursor.
      const page = await this.events.list(state.query, scope);
      const refreshed = await this.authorize(state.socket);
      if (!this.current(state)) return;
      if (refreshed.fingerprint !== scope.fingerprint) throw new ObservabilityApiError('CURSOR_SCOPE_MISMATCH');
      state.catchupScanned += page.data.scannedEvents;
      if (state.catchupScanned > REALTIME_MAX_CATCHUP_SCAN) throw new ObservabilityApiError('QUERY_TOO_LARGE');
      if (!state.confirmed) {
        state.socket.emit('subscription-confirmed', { protocol: 'observability.v1',
          snapshotScope: 'invocation_facts_only', highWatermark: page.data.highWatermark,
          pageSize: REALTIME_PAGE_SIZE, ackTimeoutMs: REALTIME_ACK_TIMEOUT_MS });
        state.confirmed = true;
      }
      // A frame is one REST event page, including empty checkpoints. Client ACKs only after processing
      // the whole frame; it persists nextCursor itself. No server-side durable browser ACK is created.
      let ack: { nextCursor?: string };
      try { ack = await state.socket.timeout(REALTIME_ACK_TIMEOUT_MS).emitWithAck('observability-event', page); }
      catch {
        if (this.current(state)) this.fail(state.socket, 'SLOW_CONSUMER');
        return;
      }
      if (!this.current(state)) return;
      if (!ack || ack.nextCursor !== page.data.nextCursor) {
        this.fail(state.socket, 'SLOW_CONSUMER');
        return;
      }
      state.query = { after: page.data.nextCursor, limit: String(REALTIME_PAGE_SIZE) };
      if (!page.data.hasMore) state.catchupScanned = 0;
      state.timer = setTimeout(() => { void this.pump(state); }, page.data.hasMore ? 0 : REALTIME_POLL_MS);
      state.timer.unref?.();
    } catch (error) {
      if (this.current(state)) this.fail(state.socket,
        error instanceof ObservabilityApiError ? error.code : 'OBSERVABILITY_UNAVAILABLE');
    } finally {
      state.running = false;
      this.inFlight.delete(state.socket.id);
    }
  }

  private fail(socket: Socket, code: string, details?: object) {
    this.unsubscribe(socket);
    socket.emit('observability-error', { code, ...(details ? { details } : {}),
      recovery: 'Resume with the last fully processed signed cursor, or obtain a new invocation snapshot.' });
    socket.disconnect(true);
  }

  onModuleDestroy() {
    for (const state of this.subscriptions.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.socket.disconnect(true);
    }
    this.subscriptions.clear();
  }
}
