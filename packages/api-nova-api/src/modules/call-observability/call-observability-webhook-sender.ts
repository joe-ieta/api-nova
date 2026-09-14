import { buildObservabilityWebhookRequestContent } from './call-observability-webhook-signature';
import { prepareObservabilityWebhookDestination, WebhookDestinationResolver } from './call-observability-webhook-destination';
import { sendObservabilityWebhook } from './call-observability-webhook-transport';
import { CallObservabilityDeliveryLeaseService, ClaimedDeliveryLease, DeliveryLeaseResult } from './call-observability-delivery-lease.service';
import { publicSequence } from './call-observability-storage';

export interface WebhookSenderDependencies {
  /** Trusted deployment config. No environment variable or permissive default is installed here. */
  allowedOrigins: readonly string[];
  resolveAll: WebhookDestinationResolver;
  /** Resolve an authorized dedicated secret; return an owned buffer which the sender will zero. */
  resolveSecret(input: { ownerId: string; subscriptionId: string; subscriptionRevision: number;
    secretRef: string; signingKeyId: string; signal: AbortSignal }): Promise<Uint8Array>;
  /** Trusted internal transport injection for isolated tests, never a request parameter. */
  send?: typeof sendObservabilityWebhook;
}

/** Explicitly invoked sender; no startup worker, polling or external sends on module import. */
export class CallObservabilityWebhookSender {
  constructor(private readonly leases: Pick<CallObservabilityDeliveryLeaseService, 'claim' | 'readForSend' | 'complete'>,
    private readonly dependencies: WebhookSenderDependencies) {}

  async runOnce(limit = 1) {
    // One lease at a time: avoid burning later leases while waiting for earlier network calls.
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('INVALID_SENDER_BATCH');
    let claimed = 0, recorded = 0, stale = 0;
    for (let index = 0; index < limit; index++) {
      const batch = await this.leases.claim({ limit: 1, leaseMs: 30000 });
      const lease = batch.leases[0];
      if (!lease) break;
      claimed++;
      const result = await this.attempt(lease);
      if (!result || !await this.leases.complete(lease, result)) stale++;
      else recorded++;
    }
    return { claimed, recorded, stale };
  }

  private async attempt(lease: ClaimedDeliveryLease): Promise<DeliveryLeaseResult | null> {
    const abort = new AbortController();
    const deadline = Math.min(Date.now() + 10000, Date.parse(lease.leaseUntil));
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<DeliveryLeaseResult>(resolve => {
      timer = setTimeout(() => { abort.abort(); resolve({ kind: 'failure', reason: 'timeout' }); },
        Math.max(0, deadline - Date.now()));
    });
    const work = async (): Promise<DeliveryLeaseResult | null> => {
      let secret: Uint8Array | undefined;
      try {
        const context = await this.leases.readForSend(lease);
        if (!context) return null;
        const destination = await prepareObservabilityWebhookDestination({ url: context.destination,
          allowedOrigins: this.dependencies.allowedOrigins }, this.dependencies.resolveAll);
        if (abort.signal.aborted || Date.now() >= deadline) return { kind: 'failure', reason: 'timeout' };
        secret = await this.dependencies.resolveSecret({ ownerId: context.ownerId,
          subscriptionId: lease.subscriptionId, subscriptionRevision: lease.subscriptionRevision,
          secretRef: context.secretRef, signingKeyId: context.signingKeyId, signal: abort.signal });
        if (abort.signal.aborted || Date.now() >= deadline) return { kind: 'failure', reason: 'timeout' };
        const current = await this.leases.readForSend(lease);
        if (!current || current.destination !== context.destination || current.secretRef !== context.secretRef ||
            current.signingKeyId !== context.signingKeyId || current.ownerId !== context.ownerId) return null;
        const row = current.event;
        // Metadata-only envelope. Never serialize stored details, headers, URLs, bodies or source IPs.
        const data: Record<string, unknown> = {};
        for (const key of ['spanKind', 'outcome', 'origin', 'callerId', 'completionSource']) {
          const value = row.details?.[key];
          if (typeof value === 'string' && value.length <= 240 && !/[\u0000-\u001f\u007f]/.test(value)) data[key] = value;
        }
        for (const key of ['durationMs', 'httpStatus']) {
          const value = row.details?.[key];
          if (typeof value === 'number' && Number.isFinite(value)) data[key] = value;
        }
        if (typeof row.details?.toolIsError === 'boolean') data.toolIsError = row.details.toolIsError;
        const invocation = ['invocation.completed', 'invocation.reconciled'].includes(row.eventName);
        const serverType = row.dimensions?.serverType ?? row.details?.serverType;
        const body = Buffer.from(JSON.stringify({ schemaVersion: '1.0', eventId: row.id,
          sequence: publicSequence(row.sequence!), eventType: row.eventName,
          occurredAt: row.occurredAt.toISOString(), recordedAt: row.createdAt.toISOString(),
          server: { type: serverType === 'gateway' || serverType === 'mcp' ? serverType : null,
            runtimeAssetId: row.runtimeAssetId ?? null },
          subject: { kind: invocation ? 'invocation' : 'runtime', id: row.subjectId ?? null,
            version: row.subjectVersion ?? null }, traceId: null, severity: row.severity, data,
          links: invocation && row.subjectId ? { invocation: '/api/v1/monitoring/observability/invocations/' +
            encodeURIComponent(row.subjectId) } : {} }), 'utf8');
        const content = buildObservabilityWebhookRequestContent({ timestamp: String(Math.floor(Date.now() / 1000)),
          eventId: row.id, deliveryId: lease.deliveryId, signingKeyId: context.signingKeyId, rawBody: body }, secret);
        const remaining = Math.floor(deadline - Date.now());
        if (abort.signal.aborted || remaining < 1) return { kind: 'failure', reason: 'timeout' };
        return await (this.dependencies.send ?? sendObservabilityWebhook)(destination, content,
          { timeoutMs: remaining, signal: abort.signal });
      } catch {
        return { kind: 'failure', reason: abort.signal.aborted ? 'timeout' : 'policy' };
      } finally {
        if (secret instanceof Uint8Array) secret.fill(0);
      }
    };
    try { return await Promise.race([work(), timeout]); }
    finally { clearTimeout(timer!); }
  }
}