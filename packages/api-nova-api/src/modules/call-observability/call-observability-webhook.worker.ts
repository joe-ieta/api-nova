import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CallObservabilityWebhookSender } from './call-observability-webhook-sender';

export const WEBHOOK_SENDER = Symbol('observability.webhookSender');
export type WebhookWorkerState = 'disabled' | 'blocked' | 'running' | 'stopped';
export interface WebhookWorkerStatus {
  state: WebhookWorkerState;
  active: boolean;
  lastRunFailed: boolean;
  runCount: number;
  failedRunCount: number;
}

/** Opt-in scheduler only. Sender configuration, secrets and network clients are provided externally. */
@Injectable()
export class CallObservabilityWebhookWorker implements OnModuleInit, OnModuleDestroy {
  private state: WebhookWorkerState = 'stopped';
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private stopping?: Promise<void>;
  private lastRunFailed = false;
  private runCount = 0;
  private failedRunCount = 0;

  constructor(private readonly config: ConfigService,
    @Optional() @Inject(WEBHOOK_SENDER)
    private readonly sender?: Pick<CallObservabilityWebhookSender, 'runOnce'>) {}

  onModuleInit(): void { this.start(); }
  onModuleDestroy(): Promise<void> { return this.stop(); }

  /** Idempotent. A start during shutdown is ignored; await stop() before restarting. */
  start(): void {
    if (this.stopping || this.state === 'running') return;
    if (this.config.get<unknown>('API_NOVA_OBSERVABILITY_WEBHOOK_ENABLED') !== 'true') {
      this.state = 'disabled';
      return;
    }
    if (!this.sender || typeof this.sender.runOnce !== 'function') {
      this.state = 'blocked';
      return;
    }
    this.state = 'running';
    this.schedule();
  }

  /** Prevents further runs immediately and resolves only when the active sender call settles. */
  stop(): Promise<void> {
    this.state = 'stopped';
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.stopping) return this.stopping;
    const draining = this.active ?? Promise.resolve();
    const stopping = draining.finally(() => {
      if (this.stopping === stopping) this.stopping = undefined;
    });
    this.stopping = stopping;
    return stopping;
  }

  getStatus(): WebhookWorkerStatus {
    return { state: this.state, active: this.active !== undefined, lastRunFailed: this.lastRunFailed,
      runCount: this.runCount, failedRunCount: this.failedRunCount };
  }

  private schedule(): void {
    if (this.state !== 'running' || this.timer !== undefined || this.active || this.stopping) return;
    // Fixed delay after completion, not setInterval: a slow sender never builds a pending queue.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.tick();
    }, 1000);
    this.timer.unref();
  }

  private tick(): void {
    if (this.state !== 'running' || this.active || this.stopping) return;
    const sender = this.sender;
    if (!sender || typeof sender.runOnce !== 'function') {
      this.state = 'blocked';
      return;
    }
    this.runCount = Math.min(Number.MAX_SAFE_INTEGER, this.runCount + 1);
    // Defer invocation until active is assigned; synchronous exceptions are handled like rejections.
    const active = Promise.resolve().then(() => sender.runOnce(1)).then(() => {
      this.lastRunFailed = false;
    }).catch(() => {
      // Do not retain exception messages, URLs, response bodies or secrets in status or logs.
      this.lastRunFailed = true;
      this.failedRunCount = Math.min(Number.MAX_SAFE_INTEGER, this.failedRunCount + 1);
    }).finally(() => {
      if (this.active === active) this.active = undefined;
      this.schedule();
    });
    this.active = active;
  }
}
