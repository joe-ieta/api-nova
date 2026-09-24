import { ExecutionContext, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Socket } from 'socket.io';
import { ObservabilityAccessGuard } from './call-observability-access.guard';
import { ObservabilityApiError } from './call-observability-api.contract';
import { CallObservabilityServerStatusController } from './call-observability-server-status.controller';
import { CallObservabilityServerStateDeltaReader, ServerStateDeltaInput } from './call-observability-server-state-delta-reader';
import { REALTIME_PAGE_SIZE, REALTIME_MAX_CATCHUP_SCAN, REALTIME_ACK_TIMEOUT_MS, REALTIME_POLL_MS, REALTIME_MAX_SUBSCRIPTIONS } from './call-observability-realtime.service';

interface StateSubscription {
  socket: Socket;
  query: ServerStateDeltaInput;
  running: boolean;
  confirmed: boolean;
  catchupScanned: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** Explicit state protocol; the invocation-only realtime service is unchanged. */
@Injectable()
export class CallObservabilityServerStateRealtimeService implements OnModuleDestroy {
  private readonly subscriptions = new Map<string, StateSubscription>();
  private readonly inFlight = new Set<string>();
  constructor(private readonly reader: CallObservabilityServerStateDeltaReader, private readonly access: ObservabilityAccessGuard) {}

  private context(socket: Socket): ExecutionContext {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || token.length > 8185 || !/^[A-Za-z0-9_.-]+$/.test(token)) throw new ObservabilityApiError('UNAUTHENTICATED');
    const request = { headers: { authorization: `Bearer ${token}` } };
    return { switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ setHeader() {} }) }),
      getClass: () => CallObservabilityServerStatusController, getHandler: () => CallObservabilityServerStatusController.prototype.list } as unknown as ExecutionContext;
  }

  async authorize(socket: Socket) { await this.access.canActivate(this.context(socket)); }

  async subscribe(socket: Socket, raw: Record<string, unknown>) {
    if (socket.data?.observabilitySnapshotScope !== 'server_state_v1' || !raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).some(key => !['token', 'sequence', 'filter', 'after'].includes(key)) ||
      !raw.filter || typeof raw.filter !== 'object' || Array.isArray(raw.filter)) {
      this.fail(socket, 'INVALID_QUERY'); return;
    }
    if (this.subscriptions.has(socket.id) || this.inFlight.has(socket.id) ||
      new Set([...this.subscriptions.keys(), ...this.inFlight]).size >= REALTIME_MAX_SUBSCRIPTIONS) {
      this.fail(socket, 'RATE_LIMITED'); return;
    }
    const state: StateSubscription = { socket, query: { ...raw, filter: { ...raw.filter }, limit: REALTIME_PAGE_SIZE } as ServerStateDeltaInput,
      running: false, confirmed: false, catchupScanned: 0 };
    this.subscriptions.set(socket.id, state);
    await this.pump(state);
  }

  unsubscribe(socket: Socket) {
    const state = this.subscriptions.get(socket.id);
    if (state?.timer) clearTimeout(state.timer);
    this.subscriptions.delete(socket.id);
  }
  private current(state: StateSubscription) { return state.socket.connected && this.subscriptions.get(state.socket.id) === state; }

  private async pump(state: StateSubscription) {
    if (!this.current(state) || state.running) return;
    state.running = true; this.inFlight.add(state.socket.id);
    try {
      const page = await this.reader.read(state.query, this.context(state.socket));
      if (!this.current(state)) return;
      state.catchupScanned += page.scannedEvents;
      if (state.catchupScanned > REALTIME_MAX_CATCHUP_SCAN) throw new ObservabilityApiError('QUERY_TOO_LARGE');
      if (!state.confirmed) {
        state.socket.emit('state-subscription-confirmed', { protocol: 'observability.state.v1', snapshotScope: 'server_state_v1',
          highWatermark: page.highWatermark, pageSize: REALTIME_PAGE_SIZE, ackTimeoutMs: REALTIME_ACK_TIMEOUT_MS, refreshRequired: true });
        state.confirmed = true;
      }
      let ack: { nextCursor?: string };
      try { ack = await state.socket.timeout(REALTIME_ACK_TIMEOUT_MS).emitWithAck('observability-state-event', page); }
      catch { if (this.current(state)) this.fail(state.socket, 'SLOW_CONSUMER'); return; }
      if (!this.current(state)) return;
      if (!ack || ack.nextCursor !== page.nextCursor) { this.fail(state.socket, 'SLOW_CONSUMER'); return; }
      state.query = { ...state.query, after: page.nextCursor };
      if (!page.hasMore) state.catchupScanned = 0;
      state.timer = setTimeout(() => { void this.pump(state); }, page.hasMore ? 0 : REALTIME_POLL_MS);
      state.timer.unref?.();
    } catch (error) {
      if (this.current(state)) this.fail(state.socket, error instanceof ObservabilityApiError ? error.code : 'OBSERVABILITY_UNAVAILABLE');
    } finally { state.running = false; this.inFlight.delete(state.socket.id); }
  }

  private fail(socket: Socket, code: string) {
    this.unsubscribe(socket);
    socket.emit('observability-state-error', { code, ...(code === 'EVENT_CURSOR_EXPIRED' ? { resnapshotRequired: true } : {}),
      recovery: 'Resume with the last fully processed state cursor while the grant is valid, otherwise obtain a new servers/status snapshot.' });
    socket.disconnect(true);
  }
  onModuleDestroy() {
    for (const state of this.subscriptions.values()) { if (state.timer) clearTimeout(state.timer); state.socket.disconnect(true); }
    this.subscriptions.clear();
  }
}
