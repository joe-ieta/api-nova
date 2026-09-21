import { createHash } from 'node:crypto';

export interface HeaderPolicyV1 {
  readonly version: 1;
  readonly requestHeaders?: readonly string[];
  readonly responseHeaders?: readonly string[];
}
export interface CompiledHeaderPolicyV1 {
  readonly version: 1;
  readonly sourceId: string;
  readonly identity: string;
  readonly requestHeaders: readonly string[];
  readonly responseHeaders: readonly string[];
  readonly requestExtensions: readonly string[];
  readonly responseExtensions: readonly string[];
}
export class HeaderPolicyValidationError extends Error {
  constructor(readonly code: 'INVALID_HEADER_POLICY' | 'INVALID_HEADER_NAME' | 'HEADER_POLICY_LIMIT' | 'HEADER_POLICY_RESERVED_NAME' | 'HEADER_POLICY_CREDENTIAL_CONFLICT') {
    super(code); this.name = 'HeaderPolicyValidationError';
  }
}
export const HEADER_POLICY_V1_REQUEST_BASE = Object.freeze(['accept', 'accept-language', 'accept-encoding', 'content-type', 'content-encoding', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since', 'if-range', 'range', 'cache-control', 'pragma']);
export const HEADER_POLICY_V1_RESPONSE_BASE = Object.freeze(['content-type', 'content-encoding', 'content-language', 'content-disposition', 'etag', 'last-modified', 'cache-control', 'expires', 'vary', 'accept-ranges', 'content-range', 'location', 'retry-after', 'date', 'age']);
const reserved = new Set(['authorization', 'proxy-authorization', 'proxy-authenticate', 'x-api-key', 'cookie', 'set-cookie', 'www-authenticate', 'connection', 'keep-alive', 'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'forwarded', 'x-real-ip', 'x-request-id', 'content-length', 'expect', 'traceparent', 'tracestate', 'baggage', 'server', 'x-powered-by']);
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
function fail(code: HeaderPolicyValidationError['code']): never { throw new HeaderPolicyValidationError(code); }
export function normalizeHeaderPolicyName(input: unknown): string {
  if (typeof input !== 'string' || !input || input.length > 128 || !/^[!#$%&'+.^_`|~0-9A-Za-z-]+$/.test(input) || dangerous.has(input.toLowerCase())) return fail('INVALID_HEADER_NAME');
  return input.toLowerCase();
}
function isReserved(name: string): boolean { return reserved.has(name) || name.startsWith('x-forwarded-') || name.startsWith('x-apinova-'); }
function extensionList(input: unknown): readonly string[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return fail('INVALID_HEADER_POLICY');
  if (input.length > 64) return fail('HEADER_POLICY_LIMIT');
  if (Reflect.ownKeys(input).length !== input.length + 1) return fail('INVALID_HEADER_POLICY');
  const names: string[] = [];
  for (let index = 0; index < input.length; index++) {
    const property = Object.getOwnPropertyDescriptor(input, String(index));
    if (!property || !('value' in property) || !property.enumerable) return fail('INVALID_HEADER_POLICY');
    const name = normalizeHeaderPolicyName(property.value);
    if (isReserved(name)) return fail('HEADER_POLICY_RESERVED_NAME');
    names.push(name);
  }
  return Object.freeze([...new Set(names)].sort());
}
/** Plain data only; never invoke configuration accessors or retain mutable caller arrays. */
export function normalizeHeaderPolicyV1(input: unknown): HeaderPolicyV1 {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return fail('INVALID_HEADER_POLICY');
    const values: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== 'string' || !['version', 'requestHeaders', 'responseHeaders'].includes(key)) return fail('INVALID_HEADER_POLICY');
      const property = Object.getOwnPropertyDescriptor(input, key);
      if (!property || !('value' in property) || !property.enumerable) return fail('INVALID_HEADER_POLICY');
      values[key] = property.value;
    }
    if (values.version !== 1) return fail('INVALID_HEADER_POLICY');
    return Object.freeze({ version: 1, ...(Object.prototype.hasOwnProperty.call(values, 'requestHeaders') ? { requestHeaders: extensionList(values.requestHeaders) } : {}), ...(Object.prototype.hasOwnProperty.call(values, 'responseHeaders') ? { responseHeaders: extensionList(values.responseHeaders) } : {}) });
  } catch (error) { if (error instanceof HeaderPolicyValidationError) throw error; return fail('INVALID_HEADER_POLICY'); }
}
export function assertHeaderPolicyCredentialNames(policy: CompiledHeaderPolicyV1, names: readonly string[]): void {
  for (const raw of names) {
    const name = normalizeHeaderPolicyName(raw);
    if ((isReserved(name) && name !== 'authorization' && name !== 'x-api-key') || policy.requestHeaders.includes(name) || policy.responseHeaders.includes(name)) return fail('HEADER_POLICY_CREDENTIAL_CONFLICT');
  }
}
export function compileHeaderPolicyV1(options: {
  readonly policy?: unknown;
  readonly inheritedPolicy?: unknown;
  readonly sourceId: string;
  readonly credentialHeaderNames?: readonly string[];
  readonly historicalAuthenticationHeaderNames?: readonly string[];
  readonly consumerAuthenticationHeaderNames?: readonly string[];
}): CompiledHeaderPolicyV1 {
  const inherited = options.inheritedPolicy === undefined ? undefined : normalizeHeaderPolicyV1(options.inheritedPolicy);
  const policy = options.policy === undefined ? undefined : normalizeHeaderPolicyV1(options.policy);
  if (typeof options.sourceId !== 'string' || !options.sourceId || options.sourceId.length > 8192 || /[\u0000-\u001f\u007f]/.test(options.sourceId)) return fail('INVALID_HEADER_POLICY');
  const requestExtensions = Object.freeze([...(policy?.requestHeaders ?? inherited?.requestHeaders ?? [])]);
  const responseExtensions = Object.freeze([...(policy?.responseHeaders ?? inherited?.responseHeaders ?? [])]);
  const requestHeaders = Object.freeze([...new Set([...HEADER_POLICY_V1_REQUEST_BASE, ...requestExtensions])].sort());
  const responseHeaders = Object.freeze([...new Set([...HEADER_POLICY_V1_RESPONSE_BASE, ...responseExtensions])].sort());
  const identity = createHash('sha256').update(JSON.stringify([1, options.sourceId, requestHeaders, responseHeaders])).digest('hex');
  const result = Object.freeze({ version: 1 as const, sourceId: options.sourceId, identity, requestHeaders, responseHeaders, requestExtensions, responseExtensions });
  assertHeaderPolicyCredentialNames(result, options.credentialHeaderNames ?? []);
  for (const raw of [...options.historicalAuthenticationHeaderNames ?? [], ...options.consumerAuthenticationHeaderNames ?? []]) {
    const name = normalizeHeaderPolicyName(raw);
    if (requestHeaders.includes(name) || responseHeaders.includes(name)) return fail('HEADER_POLICY_CREDENTIAL_CONFLICT');
  }
  return result;
}
