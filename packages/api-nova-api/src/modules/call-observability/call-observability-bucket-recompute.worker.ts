import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { CallObservabilityBucketRecomputeService } from './call-observability-bucket-recompute.service';

/** Optional scheduler. Register with a factory; only the literal string "true" opts in. */
export class CallObservabilityBucketRecomputeWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private initialized = false;
  private stopping = false;
  private enabled = false;
  private lastRunFailed = false;

  constructor(private readonly service: Pick<CallObservabilityBucketRecomputeService, 'runOnce'>,
    private readonly config: Pick<ConfigService, 'get'>, private readonly pollMs = 1000) {
    if (!Number.isInteger(pollMs) || pollMs < 10 || pollMs > 3600000) throw new Error('INVALID_BUCKET_POLL_INTERVAL');
  }

  get status() {
    return { enabled: this.enabled, running: !!this.active, stopping: this.stopping, lastRunFailed: this.lastRunFailed };
  }

  onModuleInit(): void {
    if (this.initialized || this.stopping) return;
    this.initialized = true;
    this.enabled = this.config.get('API_NOVA_OBSERVABILITY_AGGREGATION_ENABLED') === 'true';
    if (this.enabled) this.tick();
  }

  private tick(): void {
    if (!this.enabled || this.stopping || this.active) return;
    this.active = Promise.resolve().then(() => this.service.runOnce()).then(report => {
      this.lastRunFailed = report.failed > 0;
    }).catch(() => {
      // Database/lease failures remain recoverable; do not expose arbitrary exception text.
      this.lastRunFailed = true;
    }).finally(() => {
      this.active = undefined;
      if (this.stopping) return;
      this.timer = setTimeout(() => { this.timer = undefined; this.tick(); }, this.pollMs);
      this.timer.unref?.();
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    await this.active;
  }
}
