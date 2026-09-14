import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CallObservabilityEventsDispatcher } from './call-observability-events.dispatcher';

/** Materialize durable delivery work only; this worker performs no network sends. */
@Injectable()
export class CallObservabilityDispatchWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private started = false;
  private stopping = false;
  constructor(private readonly dispatcher: CallObservabilityEventsDispatcher,
    private readonly config: ConfigService) {}
  onApplicationBootstrap(): void {
    if (this.started || this.stopping || this.config.get('API_NOVA_OBSERVABILITY_DISPATCH_ENABLED') !== 'true') return;
    this.started = true;
    this.tick();
  }
  private tick(): void {
    if (this.stopping || this.active) return;
    this.active = Promise.resolve().then(() => this.dispatcher.dispatchBatch()).then(() => undefined)
      .catch(() => {
        // The transaction rolled back, so its checkpoint remains available for the next tick.
      }).finally(() => {
        this.active = undefined;
        if (!this.stopping) {
          this.timer = setTimeout(() => this.tick(), 1000);
          this.timer.unref();
        }
      });
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await this.active;
  }
}