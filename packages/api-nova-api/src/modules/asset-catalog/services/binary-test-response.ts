import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

export type BinaryCaptureState = 'metadata_only' | 'too_large' | 'unavailable';

export interface BinaryResponseDescriptor {
  kind: 'binary';
  schemaVersion: 1;
  mediaType: string;
  measurement: 'decoded_response_body';
  observedBytes: number | null;
  isComplete: boolean;
  sha256: string | null;
  captureState: BinaryCaptureState;
  declaredBytes?: number;
}

export function binaryCaptureEnabled(): boolean {
  return process.env.ENDPOINT_TEST_SAMPLE_BINARY_CAPTURE_ENABLED === 'true';
}

export function binaryCaptureLimit(): number {
  const configured = Number(process.env.ENDPOINT_TEST_SAMPLE_MAX_BYTES);
  return Number.isSafeInteger(configured) && configured > 0 && configured <= 128 * 1024 * 1024
    ? configured : 256 * 1024;
}

export function responseMediaType(headers: unknown): string {
  if (!headers || typeof headers !== 'object') return '';
  const raw = Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return '';
  const mediaType = value.split(';')[0].trim().toLowerCase();
  return mediaType.length <= 128 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)
    ? mediaType : '';
}

export function isBinaryMediaType(mediaType: string): boolean {
  return ['application/octet-stream', 'application/pdf', 'application/zip'].includes(mediaType)
    || (/^(image|audio|video)\/[a-z0-9!#$&^_.+-]+$/.test(mediaType) && mediaType !== 'image/svg+xml');
}

export function declaresBinaryResponse(operation: unknown): boolean {
  if (!operation || typeof operation !== 'object') return false;
  const responses = (operation as Record<string, unknown>).responses;
  if (!responses || typeof responses !== 'object') return false;
  return Object.values(responses).some(response => {
    if (!response || typeof response !== 'object') return false;
    const content = (response as Record<string, unknown>).content;
    return !!content && typeof content === 'object'
      && Object.keys(content).some(type => isBinaryMediaType(type.split(';')[0].trim().toLowerCase()));
  });
}

function declaredLength(headers: unknown): number | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const raw = Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-length')?.[1];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function unavailableBinaryDescriptor(mediaType: string, headers?: unknown): BinaryResponseDescriptor {
  const declaredBytes = declaredLength(headers);
  return {
    kind: 'binary', schemaVersion: 1, mediaType, measurement: 'decoded_response_body',
    observedBytes: null, isComplete: false, sha256: null, captureState: 'unavailable',
    ...(declaredBytes === undefined ? {} : { declaredBytes }),
  };
}

/** Axios's Node adapter supplies a decoded Readable only with responseType=stream. */
export async function readBoundedTestResponse(
  data: unknown, headers: unknown, maxBytes: number,
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024 * 1024) {
    if (data instanceof Readable) data.destroy();
    throw new Error('BINARY_CAPTURE_LIMIT_INVALID');
  }
  const mediaType = responseMediaType(headers);
  const binary = isBinaryMediaType(mediaType);
  if (!(data instanceof Readable)) {
    return binary ? unavailableBinaryDescriptor(mediaType, headers) : {
      captureState: 'unavailable', reason: 'response_stream_unavailable', mediaType,
    };
  }
  if (data.readableObjectMode) {
    data.destroy();
    return binary ? unavailableBinaryDescriptor(mediaType, headers) : {
      captureState: 'unavailable', reason: 'response_stream_unavailable', mediaType,
    };
  }
  const { chunks, observedBytes, complete } = await new Promise<{
    chunks: Buffer[]; observedBytes: number; complete: boolean;
  }>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let observedBytes = 0;
    let settled = false;
    const cleanup = () => {
      data.off('readable', drain);
      data.off('end', end);
      data.off('error', fail);
      data.off('close', close);
    };
    const finish = (complete: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      data.destroy();
      resolve({ chunks, observedBytes, complete });
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      data.destroy();
      reject(error);
    };
    const close = () => fail(new Error('RESPONSE_STREAM_CLOSED'));
    const end = () => {
      drain();
      finish(true);
    };
    const drain = () => {
      if (settled) return;
      try {
        let chunk: Buffer | null;
        while ((chunk = data.read(Math.min(64 * 1024, maxBytes + 1 - observedBytes))) !== null) {
          if (!Buffer.isBuffer(chunk)) {
            fail(new Error('UNTRUSTED_RESPONSE_CHUNK'));
            return;
          }
          observedBytes += chunk.length;
          if (observedBytes > maxBytes) {
            finish(false);
            return;
          }
          chunks.push(Buffer.from(chunk));
        }
      } catch (error) {
        fail(error as Error);
      }
    };
    data.on('readable', drain);
    data.once('end', end);
    data.once('error', fail);
    data.once('close', close);
    drain();
  });
  if (!binary) {
    if (!mediaType) return { captureState: 'unavailable', reason: 'untrusted_media_type', observedBytes, isComplete: complete };
    if (!complete) return {
      captureState: 'unavailable', reason: 'non_binary_response_over_limit', mediaType,
      observedBytes, isComplete: false,
    };
    const text = Buffer.concat(chunks).toString('utf8');
    try { return JSON.parse(text); } catch { return text; }
  }
  const declaredBytes = declaredLength(headers);
  return {
    kind: 'binary', schemaVersion: 1, mediaType, measurement: 'decoded_response_body',
    observedBytes, isComplete: complete,
    sha256: complete ? createHash('sha256').update(Buffer.concat(chunks)).digest('hex') : null,
    captureState: complete ? 'metadata_only' : 'too_large',
    ...(declaredBytes === undefined ? {} : { declaredBytes }),
  } satisfies BinaryResponseDescriptor;
}
