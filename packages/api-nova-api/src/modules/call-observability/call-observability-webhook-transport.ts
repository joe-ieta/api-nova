import * as https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { isIP } from 'node:net';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { PreparedWebhookDestination } from './call-observability-webhook-destination';
import type { PreparedWebhookRequestContent } from './call-observability-webhook-signature';
import type { DeliveryLeaseResult } from './call-observability-delivery-lease.service';

export interface WebhookTransportOptions {
  /** Remaining sender deadline, including its DNS/secret preparation; at most 10s. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Trusted test dependency only, never user configuration. */
  readonly request?: typeof https.request;
}
export const WEBHOOK_TRANSPORT_LIMITS = Object.freeze({
  timeoutMs: 10000, maxResponseBytes: 64 * 1024, maxResponseHeaderBytes: 16 * 1024,
});

/**
 * One physical attempt. Inputs must come from the authorized destination/signature
 * preparation flow; structural checks here are not a substitute for its allowlist.
 * No proxy, DNS resolution, redirects, retries, pooled sockets or business auditing.
 * TLS verifies the original hostname even though the socket connects to a literal IP.
 *
 * No response body is retained. On end or drain cap, HTTP status is authoritative
 * (including 202); the cap closes the socket rather than triggering a duplicate
 * delivery after a known 2xx acknowledgement. An interrupted response or total
 * timeout before that point is a failure. Abort maps to timeout in the lease contract.
 * Retry-After is bounded and forwarded as text; retry policy owns interpretation.
 * Malformed prepared input throws a fixed TypeError before network activity.
 */
export async function sendObservabilityWebhook(
  destination: PreparedWebhookDestination,
  content: PreparedWebhookRequestContent,
  options: WebhookTransportOptions = {},
): Promise<DeliveryLeaseResult> {
  const timeoutMs = options.timeoutMs ?? WEBHOOK_TRANSPORT_LIMITS.timeoutMs;
  const signal = options.signal;
  if (signal?.aborted || (Number.isFinite(timeoutMs) && timeoutMs <= 0)) {
    return { kind: 'failure', reason: 'timeout' };
  }
  const invalid = () => { throw new TypeError('INVALID_WEBHOOK_TRANSPORT_INPUT'); };
  if (!Number.isFinite(timeoutMs) || timeoutMs > WEBHOOK_TRANSPORT_LIMITS.timeoutMs) invalid();
  if (!destination || !content || !destination.connection || !content.headers ||
      !Buffer.isBuffer(content.body) || content.body.length < 1 || content.body.length > 1024 * 1024 ||
      content.method !== 'POST' || destination.useProxy !== false || destination.followRedirects !== false) invalid();
  const { host, port, family, servername, rejectUnauthorized } = destination.connection;
  const hostname = destination.hostname;
  let origin: URL;
  try { origin = new URL(destination.origin); } catch { return invalid(); }
  if (origin.protocol !== 'https:' || origin.origin !== destination.origin ||
      origin.hostname !== hostname || isIP(hostname) !== 0 || hostname.includes(':') ||
      origin.host !== destination.hostHeader || servername !== hostname || rejectUnauthorized !== true ||
      !Number.isInteger(port) || port < 1 || port > 65535 ||
      port !== Number(origin.port || 443) || (family !== 4 && family !== 6) || isIP(host) !== family ||
      !Array.isArray(destination.checkedAddresses) ||
      !destination.checkedAddresses.some(item => item.address === host && item.family === family) ||
      typeof destination.requestPath !== 'string' || !destination.requestPath.startsWith('/') ||
      destination.requestPath.startsWith('//') || destination.requestPath.length > 4096 ||
      !/^[\x21-\x7e]+$/.test(destination.requestPath) || /[?#\\\\]/.test(destination.requestPath)) invalid();
  const body = Buffer.from(content.body);
  const headerNames = ['Content-Type', 'Content-Length', 'X-ApiNova-Event-Id', 'X-ApiNova-Delivery-Id',
    'X-ApiNova-Timestamp', 'X-ApiNova-Signature', 'X-ApiNova-Key-Id'] as const;
  const headers: Record<string, string> = {};
  for (const name of headerNames) {
    const value = content.headers[name];
    if (typeof value !== 'string' || value.length < 1 || value.length > 256 || !/^[\x21-\x7e]+$/.test(value)) invalid();
    headers[name] = value;
  }
  if (headers['Content-Type'] !== 'application/json' || headers['Content-Length'] !== String(body.length) ||
      !/^sha256=[a-f0-9]{64}$/.test(headers['X-ApiNova-Signature'])) invalid();
  headers.Host = origin.host;
  headers.Connection = 'close';
  const requestOptions: https.RequestOptions = {
    protocol: 'https:', hostname: host, port, family, servername: hostname,
    rejectUnauthorized: true,
    checkServerIdentity: (_name, certificate) => checkServerIdentity(hostname, certificate),
    method: 'POST', path: destination.requestPath, headers, agent: false,
    maxHeaderSize: WEBHOOK_TRANSPORT_LIMITS.maxResponseHeaderBytes,
  };
  // Prepared objects/bytes are snapshotted before the first asynchronous operation.
  const requestFactory = options.request ?? https.request;
  if (typeof requestFactory !== 'function') invalid();
  return new Promise<DeliveryLeaseResult>(resolve => {
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let settled = false;
    let receivedBytes = 0;
    let status: number | undefined;
    let retryAfter: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ignoreLateError = () => undefined;
    const onError = () => finish({ kind: 'failure', reason: 'network' });
    const onAbort = () => finish({ kind: 'failure', reason: 'timeout' });
    const onClose = () => { if (!settled) onError(); };
    const httpResult = (): DeliveryLeaseResult => status! >= 200 && status! < 300
      ? { kind: 'success', httpStatus: status! }
      : { kind: 'failure', reason: 'http', httpStatus: status!,
        ...(retryAfter === undefined ? {} : { retryAfter }) };
    const onEnd = () => finish(httpResult());
    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      receivedBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
      if (receivedBytes >= WEBHOOK_TRANSPORT_LIMITS.maxResponseBytes) finish(httpResult());
    };
    function finish(result: DeliveryLeaseResult): void {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (response) {
        response.removeListener('data', onData);
        response.removeListener('end', onEnd);
        response.removeListener('aborted', onError);
        response.removeListener('close', onClose);
        response.removeListener('error', onError);
        // Native destroy can deliver a late socket error after this attempt ends.
        response.on('error', ignoreLateError);
        response.destroy();
      }
      if (request) {
        request.removeListener('close', onClose);
        request.removeListener('error', onError);
        request.on('error', ignoreLateError);
        request.destroy();
      }
      resolve(result);
    }
    const onResponse = (incoming: IncomingMessage) => {
      if (settled) { incoming.on('error', ignoreLateError); incoming.destroy(); return; }
      response = incoming;
      status = incoming.statusCode;
      if (!Number.isInteger(status) || status! < 200 || status! > 599) { onError(); return; }
      const value = incoming.headers['retry-after'];
      const occurrences = incoming.rawHeaders.filter((_, index) => index % 2 === 0 &&
        incoming.rawHeaders[index].toLowerCase() === 'retry-after').length;
      if (occurrences === 1 && typeof value === 'string' && value.length <= 128 &&
          /^[\x20-\x7e]+$/.test(value)) retryAfter = value;
      incoming.on('error', onError);
      incoming.once('aborted', onError);
      incoming.once('close', onClose);
      incoming.once('end', onEnd);
      incoming.on('data', onData);
      incoming.resume();
    };
    timer = setTimeout(onAbort, Math.max(1, Math.floor(timeoutMs)));
    signal?.addEventListener('abort', onAbort, { once: true });
    // Covers cancellation during synchronous input preparation/registration.
    if (signal?.aborted) { onAbort(); return; }
    try {
      request = requestFactory(requestOptions, onResponse);
      request.on('error', onError);
      request.once('close', onClose);
      request.once('upgrade', (_res, socket) => { socket.destroy(); onError(); });
      if (settled) {
        request.removeListener('error', onError);
        request.on('error', ignoreLateError);
        request.destroy();
        return;
      }
      request.end(body);
    } catch {
      onError();
    }
  });
}
