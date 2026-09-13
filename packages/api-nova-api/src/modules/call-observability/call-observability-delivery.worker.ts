import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'crypto';
import { lookup } from 'dns/promises';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { isIP } from 'net';
import {
  RuntimeEventDeliveryAttemptEntity, RuntimeEventDeliveryEntity, RuntimeEventSubscriptionEntity,
  RuntimePipelineStateEntity, RuntimeSubscriptionRevisionEntity,
} from '../../database/entities/runtime-call-observability.entity';
import { RuntimeObservabilityEventEntity } from '../../database/entities/runtime-observability-event.entity';
import { UserService } from '../security/services/user.service';
import { authorizeObservability, ObservabilityAuthorization } from './call-observability-access';
import { canonicalJson, contentHash, publicSequence, ObservabilityStorageError } from './call-observability-storage';
import { CallObservabilityStore, ObservabilityWriteTransaction } from './call-observability.store';

export const WEBHOOK_WORKER_ID = 'call-observability:webhook-worker';
const RETRY_DELAYS_MS = [5000, 30000, 120000, 600000, 1800000] as const;
const ACTIVE_RETRY_MS = 24 * 60 * 60 * 1000;
const LEASE_MS = 30000;
const MAX_ATTEMPTS = 6;
const MAX_RESPONSE_BYTES = 2048;

interface ClaimedDelivery {
  id: string;
  eventId: string;
  subscriptionId: string;
  subscriptionRevision: number;
  replayGeneration: number;
  attemptNo: number;
  generationAttempt: number;
  generationStartedAt: string;
  leaseOwner: string;
  ownerId: string;
  subscriptionScope: any;
  revisionScope: any;
  destination: unknown;
  secretRef: unknown;
  event: RuntimeObservabilityEventEntity;
}
interface DeliveryOutcome {
  disposition: 'succeeded' | 'retry' | 'dead' | 'cancelled';
  result: string;
  durationMs: number;
  httpStatus: number | null;
  errorCategory: string | null;
  responseSummary: string | null;
  retryAfterMs?: number;
}
export interface WebhookWorkerReport {
  state: 'running' | 'degraded';
  claimed: number;
  succeeded: number;
  retrying: number;
  dead: number;
  cancelled: number;
  snapshotSeq: string;
}

@Injectable()
export class CallObservabilityDeliveryWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly owner = 'webhook-' + process.pid + '-' + randomUUID();
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<WebhookWorkerReport>;
  private stopping = false;
  private lastWarning = 0;

  constructor(private readonly store: CallObservabilityStore, private readonly config: ConfigService,
    private readonly users: UserService) {}

  onApplicationBootstrap(): void {
    if (this.config.get('API_NOVA_OBSERVABILITY_WEBHOOK_ENABLED') !== 'true') return;
    const tick = async () => {
      try { await this.runOnce(); }
      catch {
        if (Date.now() - this.lastWarning >= 15000) {
          this.lastWarning = Date.now();
          process.stderr.write('[OBSERVABILITY_WEBHOOK_DEGRADED] Delivery state retained for retry.\n');
        }
      } finally {
        if (!this.stopping) {
          this.timer = setTimeout(tick, 1000);
          this.timer.unref();
        }
      }
    };
    this.timer = setTimeout(tick, 0);
    this.timer.unref();
  }

  runOnce(limit = 10): Promise<WebhookWorkerReport> {
    if (this.stopping) return Promise.reject(new ObservabilityStorageError('WEBHOOK_WORKER_STOPPED'));
    if (this.active) return Promise.reject(new ObservabilityStorageError('STORAGE_BUSY'));
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return Promise.reject(new ObservabilityStorageError('INVALID_WEBHOOK_LIMIT'));
    }
    this.active = this.run(limit).finally(() => { this.active = undefined; });
    return this.active;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await this.active?.catch(() => undefined);
  }

  private async run(limit: number): Promise<WebhookWorkerReport> {
    const report: WebhookWorkerReport = {
      state: 'running', claimed: 0, succeeded: 0, retrying: 0, dead: 0, cancelled: 0,
      snapshotSeq: await this.store.watermark(),
    };
    for (let index = 0; index < limit; index++) {
      const claimed = await this.claim();
      if (!claimed) break;
      report.claimed++;
      let outcome: DeliveryOutcome;
      if (!(await this.currentlyAuthorized(claimed))) {
        outcome = this.outcome('cancelled', 'authorization_revoked', 0, null, null);
      } else {
        outcome = await this.send(claimed);
      }
      const status = await this.complete(claimed, outcome);
      if (status === 'succeeded') report.succeeded++;
      else if (status === 'retry_wait') report.retrying++;
      else if (status === 'dead') report.dead++;
      else if (status === 'cancelled') report.cancelled++;
    }
    report.state = report.dead || report.cancelled ? 'degraded' : 'running';
    await this.store.transaction(async tx => {
      report.snapshotSeq = publicSequence(tx.currentSequence());
      await tx.manager.getRepository(RuntimePipelineStateEntity).save({
        id: WEBHOOK_WORKER_ID, updatedAt: tx.now,
        value: { ...report, lastAttemptAt: tx.now, workerConfigured: true },
      });
    });
    return report;
  }

  private async claim(): Promise<ClaimedDelivery | null> {
    return this.store.transaction(async tx => {
      const deliveries = tx.manager.getRepository(RuntimeEventDeliveryEntity);
      const query = deliveries.createQueryBuilder('delivery')
        .where('(delivery.status IN (:...ready) OR ' +
          '(delivery.status = :inFlight AND delivery.leaseUntil IS NOT NULL AND delivery.leaseUntil <= :now))', {
          ready: ['pending', 'retry_wait'], inFlight: 'in_flight', now: tx.now,
        })
        .andWhere('delivery.nextAttemptAt <= :now', { now: tx.now })
        .andWhere('delivery.expiresAt > :now', { now: tx.now })
        .orderBy('delivery.nextAttemptAt', 'ASC').addOrderBy('delivery.createdAt', 'ASC')
        .addOrderBy('delivery.id', 'ASC').take(32);
      if (tx.manager.connection.options.type === 'postgres') query.setLock('pessimistic_write').setOnLocked('skip_locked');
      const candidates = await query.getMany();
      for (const delivery of candidates) {
        const subscription = await tx.manager.getRepository(RuntimeEventSubscriptionEntity)
          .findOneBy({ id: delivery.subscriptionId });
        if (!subscription || subscription.deletedAt || subscription.state === 'deleted') {
          await this.cancelUnsendable(tx, delivery, 'subscription_deleted');
          continue;
        }
        if (subscription.state !== 'enabled') continue;
        const revision = await tx.manager.getRepository(RuntimeSubscriptionRevisionEntity)
          .findOneBy({ subscriptionId: delivery.subscriptionId, version: delivery.subscriptionRevision });
        if (!revision || revision.revoked) {
          await this.cancelUnsendable(tx, delivery, 'subscription_revision_revoked');
          continue;
        }
        const event = await tx.manager.getRepository(RuntimeObservabilityEventEntity)
          .findOneBy({ id: delivery.eventId });
        if (!event || !event.expiresAt || event.expiresAt.getTime() <= Date.parse(tx.now)) {
          await this.cancelUnsendable(tx, delivery, 'event_expired', 'dead');
          continue;
        }
        const oldError = object(delivery.lastError) ? delivery.lastError : {};
        const generationStartedAt = typeof oldError.generationStartedAt === 'string'
          ? oldError.generationStartedAt : delivery.replayGeneration > 0 ? delivery.updatedAt : delivery.createdAt;
        const generationAttempt = Number(oldError.generationAttempt || 0) + 1;
        if (!Number.isSafeInteger(generationAttempt) || generationAttempt < 1 || generationAttempt > MAX_ATTEMPTS) {
          await this.cancelUnsendable(tx, delivery, 'attempt_limit_reached', 'dead');
          continue;
        }
        const leaseUntil = new Date(Date.parse(tx.now) + LEASE_MS).toISOString();
        Object.assign(delivery, { status: 'in_flight', leaseOwner: this.owner, leaseUntil,
          version: delivery.version + 1, updatedAt: tx.now,
          lastError: { ...oldError, generationAttempt, generationStartedAt } });
        await deliveries.save(delivery);
        const config = revision.config || {};
        return {
          id: delivery.id, eventId: delivery.eventId, subscriptionId: delivery.subscriptionId,
          subscriptionRevision: delivery.subscriptionRevision, replayGeneration: delivery.replayGeneration,
          attemptNo: delivery.attemptCount + 1, generationAttempt, generationStartedAt,
          leaseOwner: this.owner, ownerId: subscription.ownerId, subscriptionScope: subscription.scope,
          revisionScope: config.scope, destination: config.destination, secretRef: config.secretRef, event,
        };
      }
      return null;
    });
  }

  private async currentlyAuthorized(claimed: ClaimedDelivery): Promise<boolean> {
    try {
      const user = await this.users.findUserById(claimed.ownerId);
      const authorization = authorizeObservability(user, ['monitoring:subscription:manage']);
      return this.visible(claimed.subscriptionScope, authorization) &&
        this.visible(claimed.revisionScope, authorization);
    } catch { return false; }
  }

  private async send(claimed: ClaimedDelivery): Promise<DeliveryOutcome> {
    const started = Date.now();
    try {
      const destination = this.destination(claimed.destination);
      const secret = this.secret(claimed.secretRef);
      const timeout = this.timeoutMs();
      const addresses = await this.addresses(destination.hostname, timeout);
      const address = addresses[this.addressIndex(claimed.id, claimed.attemptNo, addresses.length)];
      const timestamp = String(Math.floor(Date.now() / 1000));
      const body = canonicalJson({
        schemaVersion: '1.0', eventId: claimed.event.id,
        eventType: claimed.event.eventName, sequence: publicSequence(claimed.event.sequence!),
        occurredAt: claimed.event.occurredAt.toISOString(), severity: claimed.event.severity,
        status: claimed.event.status,
        subject: { id: claimed.event.subjectId || null, version: claimed.event.subjectVersion || null },
        data: claimed.event.details || {}, dimensions: claimed.event.dimensions || {},
        delivery: { id: claimed.id, attemptNo: claimed.attemptNo,
          replayGeneration: claimed.replayGeneration, subscriptionRevision: claimed.subscriptionRevision },
      });
      if (Buffer.byteLength(body) > 256 * 1024) {
        return this.outcome('dead', 'payload_too_large', Date.now() - started, null, null);
      }
      const signature = createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex');
      const remaining = timeout - (Date.now() - started);
      if (remaining <= 0) this.deliveryError('timeout');
      const response = await this.post(destination, address, body, {
        'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)),
        'user-agent': 'ApiNova-Observability-Webhook/1.0',
        'x-apinova-event-id': claimed.eventId, 'x-apinova-delivery-id': claimed.id,
        'x-apinova-timestamp': timestamp, 'x-apinova-signature': 'sha256=' + signature,
      }, remaining);
      const duration = Date.now() - started;
      if (response.status >= 200 && response.status < 300) {
        return this.outcome('succeeded', null, duration, response.status, response.summary);
      }
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        return { ...this.outcome('retry', 'http_response', duration, response.status, response.summary),
          retryAfterMs: this.retryAfter(response.retryAfter) };
      }
      return this.outcome('dead', 'http_response', duration, response.status, response.summary);
    } catch (error: any) {
      const category = typeof error?.deliveryCategory === 'string' ? error.deliveryCategory : this.networkCategory(error);
      const disposition = ['address_blocked', 'configuration', 'payload_too_large'].includes(category) ? 'dead' : 'retry';
      return this.outcome(disposition, category, Date.now() - started, null, null);
    }
  }

  private async complete(claimed: ClaimedDelivery, outcome: DeliveryOutcome): Promise<string | null> {
    return this.store.transaction(async tx => {
      const deliveries = tx.manager.getRepository(RuntimeEventDeliveryEntity);
      const query = deliveries.createQueryBuilder('delivery').where('delivery.id = :id', { id: claimed.id });
      if (tx.manager.connection.options.type === 'postgres') query.setLock('pessimistic_write');
      const delivery = await query.getOne();
      if (!delivery || delivery.status !== 'in_flight' || delivery.leaseOwner !== claimed.leaseOwner) return null;
      const attempts = tx.manager.getRepository(RuntimeEventDeliveryAttemptEntity);
      await attempts.insert({
        id: randomUUID(), deliveryId: delivery.id, attemptNo: claimed.attemptNo,
        startedAt: new Date(Date.parse(tx.now) - outcome.durationMs).toISOString(), completedAt: tx.now,
        result: outcome.result, durationMs: outcome.durationMs, httpStatus: outcome.httpStatus,
        errorCategory: outcome.errorCategory, responseSummary: this.safeSummary(outcome.responseSummary),
      });
      let status: string = outcome.disposition;
      let nextAttemptAt = tx.now;
      if (outcome.disposition === 'retry') {
        const delay = Math.max(this.retryDelay(delivery.id, claimed.generationAttempt), outcome.retryAfterMs || 0);
        const deadline = Math.min(Date.parse(claimed.generationStartedAt) + ACTIVE_RETRY_MS,
          Date.parse(delivery.expiresAt));
        if (claimed.generationAttempt >= MAX_ATTEMPTS || Date.parse(tx.now) + delay > deadline) status = 'dead';
        else { status = 'retry_wait'; nextAttemptAt = new Date(Date.parse(tx.now) + delay).toISOString(); }
      }
      Object.assign(delivery, {
        status, nextAttemptAt, attemptCount: claimed.attemptNo, version: delivery.version + 1,
        leaseOwner: null, leaseUntil: null, updatedAt: tx.now,
        lastError: status === 'succeeded' ? {} : {
          category: outcome.errorCategory || (status === 'cancelled' ? 'authorization_revoked' : 'delivery_failed'),
          code: outcome.result, httpStatus: outcome.httpStatus, at: tx.now,
          generationAttempt: claimed.generationAttempt, generationStartedAt: claimed.generationStartedAt,
        },
      });
      await deliveries.save(delivery);
      return status;
    });
  }

  private async cancelUnsendable(tx: ObservabilityWriteTransaction, delivery: RuntimeEventDeliveryEntity,
    category: string, status = 'cancelled'): Promise<void> {
    Object.assign(delivery, { status, version: delivery.version + 1, leaseOwner: null, leaseUntil: null,
      updatedAt: tx.now, lastError: { category, at: tx.now } });
    await tx.manager.getRepository(RuntimeEventDeliveryEntity).save(delivery);
  }

  private destination(value: unknown): URL {
    if (!object(value) || value.type !== 'webhook' || typeof value.url !== 'string') this.deliveryError('configuration');
    let url: URL;
    try { url = new URL(value.url as string); } catch { return this.deliveryError('configuration'); }
    const allowHttp = this.config.get<string>('API_NOVA_OBSERVABILITY_WEBHOOK_ALLOW_HTTP') === 'true';
    if (!['https:', ...(allowHttp ? ['http:'] : [])].includes(url.protocol) ||
      url.username || url.password || url.search || url.hash) this.deliveryError('configuration');
    const allowed = (this.config.get<string>('API_NOVA_OBSERVABILITY_WEBHOOK_ALLOWED_HOSTS') || '')
      .split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
    if (!allowed.includes(url.host.toLowerCase())) this.deliveryError('address_blocked');
    return url;
  }

  private secret(reference: unknown): string {
    if (typeof reference !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(reference)) {
      return this.deliveryError('configuration');
    }
    const raw = this.config.get<string>('API_NOVA_OBSERVABILITY_WEBHOOK_SECRETS');
    if (!raw || Buffer.byteLength(raw) > 65536) return this.deliveryError('configuration');
    let values: unknown;
    try { values = JSON.parse(raw); } catch { return this.deliveryError('configuration'); }
    if (!object(values) || Object.keys(values).length > 1000) return this.deliveryError('configuration');
    const secret = values[reference];
    if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32 || Buffer.byteLength(secret) > 4096) {
      return this.deliveryError('configuration');
    }
    return secret;
  }

  private async addresses(hostname: string, timeout: number) {
    const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    if (['169.254.169.254', 'fd00:ec2::254'].includes(host.toLowerCase())) this.deliveryError('address_blocked');
    const timer = new Promise<never>((_, reject) => {
      const handle = setTimeout(() => {
        const error: any = new Error('DNS timeout'); error.deliveryCategory = 'timeout'; reject(error);
      }, timeout);
      handle.unref();
    });
    const records = await Promise.race([lookup(host, { all: true, verbatim: true }), timer]);
    const unique = [...new Map(records.map(record => [record.address, record])).values()];
    if (!unique.length) this.deliveryError('dns');
    const privateAllowed = new Set((this.config.get<string>('API_NOVA_OBSERVABILITY_WEBHOOK_ALLOWED_PRIVATE_IPS') || '')
      .split(',').map(item => item.trim().toLowerCase()).filter(Boolean));
    for (const record of unique) {
      if (this.privateAddress(record.address, record.family) && !privateAllowed.has(record.address.toLowerCase())) {
        this.deliveryError('address_blocked');
      }
      if (['169.254.169.254', 'fd00:ec2::254'].includes(record.address.toLowerCase())) {
        this.deliveryError('address_blocked');
      }
    }
    return unique;
  }

  private post(url: URL, address: { address: string; family: number }, body: string,
    headers: Record<string, string>, timeout: number): Promise<{ status: number; summary: string | null; retryAfter?: string }> {
    return new Promise((resolve, reject) => {
      const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const options: any = {
        protocol: url.protocol, hostname: address.address, family: address.family,
        port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname,
        method: 'POST', headers: { ...headers, host: url.host },
        ...(url.protocol === 'https:' && !isIP(url.hostname) ? { servername: url.hostname } : {}),
      };
      const request = transport(options, response => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', chunk => {
          if (bytes >= MAX_RESPONSE_BYTES) return;
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const remaining = MAX_RESPONSE_BYTES - bytes;
          chunks.push(data.subarray(0, remaining));
          bytes += Math.min(data.length, remaining);
        });
        response.on('end', () => resolve({
          status: response.statusCode || 0,
          summary: 'bytes=' + bytes + ';sha256=' +
            contentHash(Buffer.concat(chunks).toString('base64')),
          retryAfter: Array.isArray(response.headers['retry-after'])
            ? response.headers['retry-after'][0] : response.headers['retry-after'],
        }));
      });
      request.setTimeout(timeout, () => {
        const error: any = new Error('Request timeout'); error.code = 'ETIMEDOUT'; request.destroy(error);
      });
      request.on('error', reject);
      request.end(body);
    });
  }

  private retryDelay(id: string, generationAttempt: number): number {
    const base = RETRY_DELAYS_MS[Math.min(generationAttempt - 1, RETRY_DELAYS_MS.length - 1)];
    const sample = parseInt(contentHash(id + ':' + generationAttempt).slice(0, 8), 16) / 0xffffffff;
    return Math.round(base * (0.8 + sample * 0.4));
  }
  private retryAfter(value?: string): number {
    if (!value) return 0;
    if (/^\d{1,8}$/.test(value)) return Math.min(Number(value) * 1000, ACTIVE_RETRY_MS + 1);
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.min(Math.max(0, date - Date.now()), ACTIVE_RETRY_MS + 1) : 0;
  }
  private timeoutMs(): number {
    const raw = this.config.get<string>('API_NOVA_OBSERVABILITY_WEBHOOK_TIMEOUT_MS');
    const value = raw === undefined ? 10000 : Number(raw);
    return Number.isSafeInteger(value) && value >= 100 && value <= 30000 ? value : 10000;
  }
  private addressIndex(id: string, attempt: number, length: number): number {
    return parseInt(contentHash(id + ':' + attempt).slice(0, 8), 16) % length;
  }
  private privateAddress(address: string, family: number): boolean {
    const lower = address.toLowerCase();
    if (family === 6) {
      if (lower.startsWith('::ffff:')) return this.privateAddress(lower.slice(7), 4);
      return lower === '::' || lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') ||
        /^fe[89ab]/.test(lower) || lower.startsWith('ff') || lower.startsWith('2001:db8:');
    }
    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b, c] = parts;
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 192 && b === 2) || (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
  }
  private visible(scope: any, authorization: ObservabilityAuthorization): boolean {
    if (scope?.mode === 'all') return authorization.runtimeAssetIds === null;
    return scope?.mode === 'assets' && Array.isArray(scope.runtimeAssetIds) &&
      (authorization.runtimeAssetIds === null ||
        scope.runtimeAssetIds.every((id: string) => authorization.runtimeAssetIds!.includes(id)));
  }
  private safeSummary(value: string | null): string | null {
    if (value === null) return null;
    return value.slice(0, MAX_RESPONSE_BYTES)
      .replace(/(authorization|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  }
  private networkCategory(error: any): string {
    const code = String(error?.code || '');
    if (code === 'ETIMEDOUT') return 'timeout';
    if (code.startsWith('EAI_') || code === 'ENOTFOUND') return 'dns';
    if (['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code)) return 'tls';
    return 'connection';
  }
  private outcome(disposition: DeliveryOutcome['disposition'], category: string | null,
    durationMs: number, httpStatus: number | null, summary: string | null): DeliveryOutcome {
    return { disposition, result: disposition === 'succeeded' ? 'succeeded' :
      disposition === 'cancelled' ? 'cancelled' : disposition === 'retry' ? 'retryable_failure' : 'permanent_failure',
      durationMs: Math.max(0, Math.min(durationMs, 2147483647)), httpStatus,
      errorCategory: category, responseSummary: this.safeSummary(summary) };
  }
  private deliveryError(category: string): never {
    const error: any = new Error('Webhook delivery rejected');
    error.deliveryCategory = category;
    throw error;
  }
}

function object(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
