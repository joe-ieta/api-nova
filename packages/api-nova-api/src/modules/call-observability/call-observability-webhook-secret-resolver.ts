/**
 * OBS-TP-12 secret resolution boundary. No concrete backend, environment lookup,
 * cache, logging, network client or configuration is installed here.
 *
 * resolveAuthorized MUST freshly authorize ownerId/subscriptionId/revision,
 * secretRef AND signingKeyId on EVERY call. It must check current revocation and
 * key-version policy before releasing bytes; caller-supplied context alone is not
 * authorization. The backend must return exclusively owned, mutable Uint8Array
 * bytes, not a cached/shared view. Ownership transfers to this adapter even when
 * a result arrives after cancellation. Backend failures never cross this boundary.
 *
 * INTERNAL validation policy: positive safe-integer revision; 1..240 ASCII token
 * characters for IDs/ref; 32..4096 raw key bytes. A secretRef is an opaque reference,
 * not an env name, URL fetch instruction, hex/base64 encoding or plaintext secret.
 *
 * The caller owns successful output, must call dispose() in finally, and must not
 * serialize/log it. This helper cannot erase copies retained by a backend, caller
 * or crypto runtime, nor enforce authorization inside an incorrectly implemented
 * trusted backend. Abort stops waiting, not necessarily the backend operation.
 * A backend must enforce its own bounded deadline and honor signal where possible.
 */
export interface WebhookSecretResolveRequest {
  readonly ownerId: string;
  readonly subscriptionId: string;
  readonly revision: number;
  readonly secretRef: string;
  readonly signingKeyId: string;
  readonly signal?: AbortSignal;
}

export interface AuthorizedWebhookSecret {
  readonly signingKeyId: string;
  /** Exclusive, mutable raw bytes transferred to the adapter on resolution. */
  readonly ownedBytes: Uint8Array;
}

export interface WebhookSecretBackend {
  resolveAuthorized(request: Readonly<WebhookSecretResolveRequest>): Promise<AuthorizedWebhookSecret>;
}

export interface ResolvedWebhookSecret {
  readonly signingKeyId: string;
  /** Adapter-owned copy, zeroed by dispose. Do not serialize, log or retain copies. */
  readonly ownedBytes: Uint8Array;
  dispose(): void;
}

export type WebhookSecretResolverErrorCode =
  | 'INVALID_WEBHOOK_SECRET_CONTEXT'
  | 'WEBHOOK_SECRET_ABORTED'
  | 'WEBHOOK_SECRET_UNAVAILABLE';

export class WebhookSecretResolverError extends Error {
  constructor(readonly code: WebhookSecretResolverErrorCode) {
    super(code);
    this.name = 'WebhookSecretResolverError';
  }
}

function validToken(value: unknown, reference = false): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 240 &&
    (reference ? /^[A-Za-z0-9._:/-]+$/ : /^[A-Za-z0-9._:-]+$/).test(value);
}

function wipe(bytes: Uint8Array | undefined): void {
  if (!bytes) return;
  // Do not invoke an overridden fill method on a backend-owned subclass.
  try { Uint8Array.prototype.fill.call(bytes, 0); } catch {
    // Detached buffers have no accessible bytes. Never expose backend exceptions.
  }
}

/**
 * No cache: one fresh backend authorization per non-aborted valid invocation.
 * Rejects immediately on abort; any later backend-owned bytes are still wiped.
 * Wrong key ID, unavailable/unauthorized secret and backend errors share one error.
 */
export function resolveObservabilityWebhookSecret(
  request: WebhookSecretResolveRequest,
  backend: WebhookSecretBackend,
): Promise<ResolvedWebhookSecret> {
  return new Promise((resolve, reject) => {
    let context: Readonly<WebhookSecretResolveRequest>;
    try {
      if (!request || typeof request !== 'object' ||
          !validToken(request.ownerId) || !validToken(request.subscriptionId) ||
          !validToken(request.secretRef, true) || !validToken(request.signingKeyId) ||
          !Number.isSafeInteger(request.revision) || request.revision < 1 ||
          !backend || typeof backend.resolveAuthorized !== 'function' ||
          (request.signal !== undefined && !(request.signal instanceof AbortSignal))) {
        throw new Error();
      }
      context = Object.freeze({
        ownerId: request.ownerId, subscriptionId: request.subscriptionId,
        revision: request.revision, secretRef: request.secretRef,
        signingKeyId: request.signingKeyId, signal: request.signal,
      });
    } catch {
      reject(new WebhookSecretResolverError('INVALID_WEBHOOK_SECRET_CONTEXT'));
      return;
    }
    const signal = context.signal;
    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const fail = (code: WebhookSecretResolverErrorCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new WebhookSecretResolverError(code));
    };
    const onAbort = () => fail('WEBHOOK_SECRET_ABORTED');
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }

    // Resolve synchronously thrown backend exceptions through the same sanitized
    // rejection path, and recheck cancellation before invoking the capability.
    void Promise.resolve().then(() => {
      if (settled || signal?.aborted) return undefined;
      return backend.resolveAuthorized(context);
    }).then(result => {
      let backendBytes: Uint8Array | undefined;
      let outputBytes: Uint8Array | undefined;
      try {
        const value = result?.ownedBytes;
        if (value instanceof Uint8Array) backendBytes = value;
        if (settled || signal?.aborted) {
          onAbort();
          return;
        }
        if (!backendBytes || backendBytes.byteLength < 32 || backendBytes.byteLength > 4096 ||
            (typeof SharedArrayBuffer !== 'undefined' && backendBytes.buffer instanceof SharedArrayBuffer) ||
            result?.signingKeyId !== context.signingKeyId) {
          fail('WEBHOOK_SECRET_UNAVAILABLE');
          return;
        }
        outputBytes = new Uint8Array(backendBytes);
        // Ownership has transferred. Clear backend bytes before handing out our copy.
        wipe(backendBytes);
        if (signal?.aborted) {
          onAbort();
          return;
        }
        const ownedBytes = outputBytes;
        let disposed = false;
        const resolved: ResolvedWebhookSecret = Object.freeze({
          signingKeyId: context.signingKeyId,
          // Non-enumerable bytes prevent accidental JSON/object-spread disclosure.
          get ownedBytes() { return ownedBytes; },
          dispose() {
            if (disposed) return;
            disposed = true;
            wipe(ownedBytes);
          },
        });
        // Build a non-enumerable byte accessor without exposing the secret to errors.
        const safeResult = Object.create(null) as ResolvedWebhookSecret;
        Object.defineProperties(safeResult, {
          signingKeyId: { value: resolved.signingKeyId, enumerable: true },
          ownedBytes: { get: () => resolved.ownedBytes, enumerable: false },
          dispose: { value: () => resolved.dispose(), enumerable: false },
        });
        Object.freeze(safeResult);
        settled = true;
        cleanup();
        outputBytes = undefined;
        resolve(safeResult);
      } catch {
        fail('WEBHOOK_SECRET_UNAVAILABLE');
      } finally {
        wipe(backendBytes);
        wipe(outputBytes);
      }
    }, () => fail('WEBHOOK_SECRET_UNAVAILABLE'));
  });
}

/** Bridge backend ownership to the sender's owned-buffer resolver contract. */
export function createObservabilityWebhookSecretResolver(backend: WebhookSecretBackend):
  import('./call-observability-webhook-sender').WebhookSenderDependencies['resolveSecret'] {
  return async input => {
    const resolved = await resolveObservabilityWebhookSecret({ ownerId: input.ownerId,
      subscriptionId: input.subscriptionId, revision: input.subscriptionRevision,
      secretRef: input.secretRef, signingKeyId: input.signingKeyId, signal: input.signal }, backend);
    try {
      if (input.signal.aborted) throw new WebhookSecretResolverError('WEBHOOK_SECRET_ABORTED');
      // The sender owns and clears this independent copy in its finally block.
      return new Uint8Array(resolved.ownedBytes);
    } finally {
      resolved.dispose();
    }
  };
}