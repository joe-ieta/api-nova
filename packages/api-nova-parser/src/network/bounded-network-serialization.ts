import { ControlledDnsError } from './controlled-dns';
import { normalizeNetworkUrl } from './network-policy';
import { PINNED_HTTP_MAX_REQUEST_BYTES, PinnedHttpResponse } from './pinned-http-transport';
export interface SerializedBoundedRequest { readonly url: string; readonly body?: Buffer }
function reject(): never { throw new ControlledDnsError('upstream_network_policy_denied'); }
/** Deliberate opt-in subset: form/explode query scalars or repeated scalar arrays, JSON/string/Buffer bodies.
 * No custom serializer, toJSON/getter execution, multipart, streams or implicit decompression.
 */
export function serializeBoundedNetworkRequest(url: string, query: Record<string, unknown>, rawBody: unknown): SerializedBoundedRequest {
  try {
    const finalUrl = new URL(normalizeNetworkUrl(url).url);
    if (!query || Object.getPrototypeOf(query) !== Object.prototype) return reject();
    for (const key of Reflect.ownKeys(query)) {
      if (typeof key !== 'string') return reject(); const descriptor = Object.getOwnPropertyDescriptor(query, key)!;
      if (!('value' in descriptor)) return reject();
      const values: unknown[] = [];
      if (Array.isArray(descriptor.value)) {
        const array = descriptor.value;
        if (Object.getPrototypeOf(array) !== Array.prototype || Reflect.ownKeys(array).length !== array.length + 1) return reject();
        for (let index = 0; index < array.length; index++) {
          const item = Object.getOwnPropertyDescriptor(array, String(index));
          if (!item || !('value' in item)) return reject(); values.push(item.value);
        }
      } else values.push(descriptor.value);
      for (const value of values) {
        if (value === null || value === undefined) continue;
        if (!['string', 'boolean', 'number'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) return reject();
        finalUrl.searchParams.append(key, String(value));
      }
    }
    const normalized = normalizeNetworkUrl(finalUrl.toString());
    let body: Buffer | undefined;
    if (rawBody !== undefined) {
      if (Buffer.isBuffer(rawBody)) { if (rawBody.length > PINNED_HTTP_MAX_REQUEST_BYTES) return reject(); body = Buffer.from(rawBody); }
      else if (typeof rawBody === 'string') { if (Buffer.byteLength(rawBody) > PINNED_HTTP_MAX_REQUEST_BYTES) return reject(); body = Buffer.from(rawBody); }
      else {
        const seen = new Set<object>(); let budget = 0;
        const copy = (value: unknown, depth: number): unknown => {
          if (depth > 64) return reject();
          if (value === null || typeof value === 'boolean') return value;
          if (typeof value === 'string') { budget += Buffer.byteLength(value); if (budget > PINNED_HTTP_MAX_REQUEST_BYTES) return reject(); return value; }
          if (typeof value === 'number' && Number.isFinite(value)) return value;
          if (!value || typeof value !== 'object' || seen.has(value) || ![Object.prototype, Array.prototype].includes(Object.getPrototypeOf(value))) return reject();
          seen.add(value); const result: any = Array.isArray(value) ? [] : {};
          for (const key of Reflect.ownKeys(value)) {
            if (Array.isArray(value) && key === 'length') continue;
            if (typeof key !== 'string') return reject(); const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
            if (!('value' in descriptor) || key === 'toJSON') return reject(); budget += Buffer.byteLength(key) + 4;
            if (budget > PINNED_HTTP_MAX_REQUEST_BYTES) return reject();
            Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
          }
          if (Array.isArray(value) && Reflect.ownKeys(value).length !== value.length + 1) return reject();
          seen.delete(value); return result;
        };
        body = Buffer.from(JSON.stringify(copy(rawBody, 0)));
      }
      if (body.length > PINNED_HTTP_MAX_REQUEST_BYTES) return reject();
    }
    return Object.freeze({ url: normalized.url, ...(body === undefined ? {} : { body }) });
  } catch { return reject(); }
}
/** Identity-only response contract; reject compression before interpreting any bytes as JSON/text. */
export function decodeBoundedNetworkResponse(response: PinnedHttpResponse): unknown {
  const encoding = response.headers['content-encoding'];
  if (encoding !== undefined && encoding !== 'identity') return reject();
  const contentType = response.headers['content-type'];
  if (Array.isArray(contentType)) return reject();
  if (contentType && !/^(?:application\/(?:json|[^;\s]+\+json)|text\/[^;\s]+)(?:\s*;|$)/i.test(contentType as string)) return reject();
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
    if (!text) return '';
    try { return JSON.parse(text); } catch { if (contentType && /json/i.test(contentType as string)) return reject(); return text; }
  } catch { return reject(); }
}
