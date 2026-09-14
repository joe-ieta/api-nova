import { createHmac } from 'node:crypto';
import { TextDecoder } from 'node:util';

/**
 * OBS-TP-12 preparation only; not an enabled or verified delivery API.
 *
 * Contract: docs/reference/runtime-observability-api-endpoints.md, OBS-PUSH-02.
 * POST application/json; HMAC-SHA256(secret, timestamp + "." + raw HTTP bytes).
 * The signature is lowercase hex prefixed by "sha256=". Event ID is authenticated
 * through the JSON body, not an extra field prepended to the signing input.
 *
 * INTERNAL DRAFT limits, not published API requirements: 1 MiB body; 32..4096
 * secret bytes; 1..240 ASCII token characters for header IDs; timestamp limited
 * to a canonical nonnegative safe-integer Unix second string. Secret input is
 * raw key bytes, never an implicitly decoded base64/hex string or a secretRef.
 *
 * The caller must authorize the event, supply already-redacted metadata, resolve
 * the dedicated subscription secretRef, and select its matching public key ID.
 * This helper does not implement redaction, envelope schema validation, key
 * resolution, URL/SSRF policy, network I/O, retries, persistence or replay checks.
 * A receiver must verify raw bytes, apply its clock window (suggested +/-300s),
 * match the event ID and persist deduplication. No clock is read here.
 */
export const WEBHOOK_SIGNATURE_DRAFT_LIMITS = Object.freeze({
  maxBodyBytes: 1024 * 1024,
  minSecretBytes: 32,
  maxSecretBytes: 4096,
  maxHeaderIdCharacters: 240,
});

export type WebhookSignaturePreparationErrorCode =
  | 'INVALID_WEBHOOK_BODY'
  | 'INVALID_WEBHOOK_TIMESTAMP'
  | 'INVALID_WEBHOOK_HEADER_ID'
  | 'INVALID_WEBHOOK_SECRET'
  | 'WEBHOOK_EVENT_ID_MISMATCH'
  | 'WEBHOOK_SECRET_IN_REQUEST'
  | 'WEBHOOK_SIGNATURE_FAILED';

/** Fixed local errors: no input values, crypto exceptions, secretRef or cause. */
export class WebhookSignaturePreparationError extends Error {
  constructor(readonly code: WebhookSignaturePreparationErrorCode) {
    super(code);
    this.name = 'WebhookSignaturePreparationError';
  }
}

export interface WebhookSignatureInput {
  readonly timestamp: string;
  readonly rawBody: Uint8Array;
}

export interface WebhookRequestContentInput extends WebhookSignatureInput {
  readonly eventId: string;
  readonly deliveryId: string;
  readonly signingKeyId: string;
}

export interface PreparedWebhookRequestContent {
  readonly method: 'POST';
  readonly headers: Readonly<{
    'Content-Type': 'application/json';
    'Content-Length': string;
    'X-ApiNova-Event-Id': string;
    'X-ApiNova-Delivery-Id': string;
    'X-ApiNova-Timestamp': string;
    'X-ApiNova-Signature': string;
    'X-ApiNova-Key-Id': string;
  }>;
  /** Owned copy of exactly the signed bytes. Send unchanged, never JSON.stringify it. */
  readonly body: Buffer;
}

function reject(code: WebhookSignaturePreparationErrorCode): never {
  throw new WebhookSignaturePreparationError(code);
}

function requireTimestamp(value: string): void {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value) ||
      !Number.isSafeInteger(Number(value))) reject('INVALID_WEBHOOK_TIMESTAMP');
}

function requireHeaderId(value: string): void {
  // No whitespace, CR/LF, controls, delimiter injection or arbitrary headers.
  if (typeof value !== 'string' || value.length < 1 ||
      value.length > WEBHOOK_SIGNATURE_DRAFT_LIMITS.maxHeaderIdCharacters ||
      !/^[A-Za-z0-9._:-]+$/.test(value)) reject('INVALID_WEBHOOK_HEADER_ID');
}

function copyBody(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 ||
      value.byteLength > WEBHOOK_SIGNATURE_DRAFT_LIMITS.maxBodyBytes) {
    reject('INVALID_WEBHOOK_BODY');
  }
  return Buffer.from(value);
}

function copySecret(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) ||
      value.byteLength < WEBHOOK_SIGNATURE_DRAFT_LIMITS.minSecretBytes ||
      value.byteLength > WEBHOOK_SIGNATURE_DRAFT_LIMITS.maxSecretBytes) {
    reject('INVALID_WEBHOOK_SECRET');
  }
  return Buffer.from(value);
}

function signBytes(timestamp: string, body: Buffer, secret: Uint8Array): string {
  const key = copySecret(secret);
  try {
    return 'sha256=' + createHmac('sha256', key)
      .update(timestamp, 'ascii').update('.', 'ascii').update(body).digest('hex');
  } catch {
    return reject('WEBHOOK_SIGNATURE_FAILED');
  } finally {
    // Only clear our copy. The caller owns the original and its lifetime.
    // This does not promise erasure of runtime/crypto engine internal copies.
    key.fill(0);
  }
}

/** Signs exact bytes; does not parse, normalize, stringify or re-encode the body. */
export function signObservabilityWebhookBody(
  input: WebhookSignatureInput,
  secret: Uint8Array,
): string {
  if (!input || typeof input !== 'object') reject('INVALID_WEBHOOK_BODY');
  requireTimestamp(input.timestamp);
  return signBytes(input.timestamp, copyBody(input.rawBody), secret);
}

/**
 * Builds fixed safe headers and an owned body snapshot. No custom header bag is
 * accepted, so callers cannot override framing, signature or credential headers.
 * Matching eventId prevents an unsigned ID header from naming a different event.
 * Delivery/key ID headers are not independently signed by the published formula.
 */
export function buildObservabilityWebhookRequestContent(
  input: WebhookRequestContentInput,
  secret: Uint8Array,
): PreparedWebhookRequestContent {
  if (!input || typeof input !== 'object') reject('INVALID_WEBHOOK_BODY');
  const { timestamp, eventId, deliveryId, signingKeyId } = input;
  requireTimestamp(timestamp);
  requireHeaderId(eventId);
  requireHeaderId(deliveryId);
  requireHeaderId(signingKeyId);
  const body = copyBody(input.rawBody);
  let event: unknown;
  try {
    // Fatal decoding rejects invalid UTF-8; parsing is only for ID consistency.
    // Keep the original snapshot for signing and transmission.
    event = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body));
  } catch {
    return reject('INVALID_WEBHOOK_BODY');
  }
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
      (event as Record<string, unknown>).eventId !== eventId) {
    reject('WEBHOOK_EVENT_ID_MISMATCH');
  }

  const key = copySecret(secret);
  let signature: string;
  try {
    // Catch accidental direct embedding of the signing key. This is not a
    // general secret scanner: escaped/encoded secrets and other credentials
    // remain the responsibility of the authorized metadata projector.
    if (body.indexOf(key) !== -1 || [eventId, deliveryId, signingKeyId, timestamp]
      .some(value => Buffer.from(value, 'ascii').indexOf(key) !== -1)) {
      reject('WEBHOOK_SECRET_IN_REQUEST');
    }
    signature = signBytes(timestamp, body, key);
  } finally {
    key.fill(0);
  }

  return Object.freeze({
    method: 'POST' as const,
    headers: Object.freeze({
      'Content-Type': 'application/json' as const,
      'Content-Length': String(body.byteLength),
      'X-ApiNova-Event-Id': eventId,
      'X-ApiNova-Delivery-Id': deliveryId,
      'X-ApiNova-Timestamp': timestamp,
      'X-ApiNova-Signature': signature,
      'X-ApiNova-Key-Id': signingKeyId,
    }),
    body,
  });
}
