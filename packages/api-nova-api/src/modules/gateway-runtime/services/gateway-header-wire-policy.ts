import { assertHeaderPolicyCredentialNames, type CompiledHeaderPolicyV1 } from 'api-nova-parser';

type HeaderMap = Record<string, string | string[] | number | undefined>;
interface RawHeaderInput { rawHeaders?: readonly string[]; headers?: HeaderMap; }
export class GatewayHeaderWireError extends Error {
  constructor(readonly statusCode: number, readonly code: string, readonly headerName?: string) {
    super(code); this.name = 'GatewayHeaderWireError';
  }
}
const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const auth = ['authorization', 'proxy-authorization', 'x-api-key', 'cookie', 'set-cookie', 'www-authenticate', 'proxy-authenticate'];
const reserved = new Set([...auth, 'connection', 'keep-alive', 'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'forwarded', 'x-real-ip', 'x-request-id', 'content-length', 'expect', 'traceparent', 'tracestate', 'baggage', 'server', 'x-powered-by']);
const requestLists = new Set(['accept', 'accept-language', 'accept-encoding', 'cache-control', 'pragma', 'if-match', 'if-none-match', 'prefer']);
const responseLists = new Set(['cache-control', 'vary', 'accept-ranges', 'link', 'allow']);
const isReserved = (name: string) => reserved.has(name) || name.startsWith('x-forwarded-') || name.startsWith('x-apinova-');
function fail(status: number, code: string, name?: string): never { throw new GatewayHeaderWireError(status, code, name); }

/** Internal adapters retain arrays and case aliases; a missing raw list never bypasses validation. */
function collect(input: RawHeaderInput, status: number): Map<string, string[]> {
  const raw: unknown[] = [];
  if (input.rawHeaders !== undefined) {
    if (!Array.isArray(input.rawHeaders) || input.rawHeaders.length % 2) fail(status, 'gateway_header_invalid');
    if (input.rawHeaders.length > 200) fail(status === 400 ? 431 : status, 'gateway_header_limit');
    raw.push(...input.rawHeaders);
  } else {
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        raw.push(name, typeof item === 'number' ? String(item) : item);
        if (raw.length > 200) fail(status === 400 ? 431 : status, 'gateway_header_limit');
      }
    }
  }
  const limitStatus = status === 400 ? 431 : status;
  if (raw.length > 200) fail(limitStatus, 'gateway_header_limit');
  let bytes = 0;
  const result = new Map<string, string[]>();
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i], value = raw[i + 1];
    if (typeof name !== 'string' || !token.test(name) || typeof value !== 'string') fail(status, 'gateway_header_invalid');
    const lower = name.toLowerCase();
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value) || /[^\x00-\xff]/.test(value)) fail(status, 'gateway_header_invalid', lower);
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (Buffer.byteLength(value) > 8192 || bytes > 16384) fail(limitStatus, 'gateway_header_limit', lower);
    result.set(lower, [...result.get(lower) ?? [], value.replace(/^[ \t]+|[ \t]+$/g, '')]);
  }
  return result;
}
function framing(fields: Map<string, string[]>, status: number): { contentLength?: number; chunked: boolean } {
  const lengths = fields.get('content-length'), encoding = fields.get('transfer-encoding');
  if (lengths && encoding) fail(status, 'gateway_header_framing');
  let contentLength: number | undefined;
  if (lengths) {
    if (lengths.length !== 1 || !/^\d+$/.test(lengths[0]) || !Number.isSafeInteger(Number(lengths[0]))) fail(status, 'gateway_header_framing', 'content-length');
    contentLength = Number(lengths[0]);
  }
  if (encoding && (encoding.length !== 1 || encoding[0].toLowerCase() !== 'chunked')) fail(status, 'gateway_header_framing', 'transfer-encoding');
  return { contentLength, chunked: !!encoding };
}
function filter(fields: Map<string, string[]>, allowed: readonly string[], lists: Set<string>, names: readonly string[], status: number): Record<string, string> {
  const blocked = new Set([...auth, ...names.map(name => name.toLowerCase())]);
  const nominated = new Set<string>();
  for (const connection of fields.get('connection') ?? []) for (const item of connection.split(',')) {
    const name = item.trim().toLowerCase();
    if (name && !token.test(name)) fail(status, 'gateway_header_invalid', 'connection');
    if (name) nominated.add(name);
  }
  const result: Record<string, string> = Object.create(null);
  for (const [name, values] of fields) {
    // Set-Cookie is a legal repeated upstream field, but is never forwarded or cached.
    if (blocked.has(name) && !(status === 502 && name === 'set-cookie') && values.length !== 1) fail(status, 'gateway_header_duplicate', name);
    if (blocked.has(name) || isReserved(name) || nominated.has(name) || !allowed.includes(name)) continue;
    if (values.length !== 1 && !lists.has(name)) fail(status, 'gateway_header_duplicate', name);
    result[name] = values.join(', ');
  }
  return result;
}
function validatedHost(fields: Map<string, string[]>): string {
  const hosts = fields.get('host');
  if (!hosts || hosts.length !== 1 || !hosts[0] || /[\s\/@\\?#,%]/.test(hosts[0])) fail(400, 'gateway_header_host', 'host');
  try {
    const parsed = new URL(`http://${hosts[0]}`);
    if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || !/^[\x21-\x7e]+$/.test(hosts[0])) fail(400, 'gateway_header_host', 'host');
  } catch { fail(400, 'gateway_header_host', 'host'); }
  return hosts[0];
}

/** Explicit compiled v1 only; legacy activation/migration remains the caller's responsibility. */
export function filterGatewayRequestHeadersV1(input: RawHeaderInput & {
  policy: CompiledHeaderPolicyV1; targetUrl: URL; peerAddress?: string; tls?: boolean; requestId: string;
  managedHeaderNames?: readonly string[]; consumerAuthenticationHeaderNames?: readonly string[];
  historicalAuthenticationHeaderNames?: readonly string[]; credentialHeaders?: Record<string, string>;
}): { headers: Record<string, string>; contentLength?: number; chunked: boolean; cacheBypass: boolean; normalizedRequestHeaders: Record<string, string> } {
  const fields = collect(input, 400);
  const frame = framing(fields, 400);
  if (fields.has('expect')) fail(417, 'gateway_header_expect_unsupported', 'expect');
  if (fields.has('upgrade') || (fields.get('connection') ?? []).some(v => v.split(',').some(n => n.trim().toLowerCase() === 'upgrade'))) fail(400, 'gateway_header_upgrade_unsupported');
  if (fields.has('trailer') || fields.has('trailers')) fail(400, 'gateway_header_trailers_unsupported');
  const host = validatedHost(fields);
  const names = [...input.managedHeaderNames ?? [], ...input.consumerAuthenticationHeaderNames ?? [], ...input.historicalAuthenticationHeaderNames ?? [], ...Object.keys(input.credentialHeaders ?? {})];
  const business = filter(fields, input.policy.requestHeaders, requestLists, names, 400);
  const headers = { ...business };
  if (frame.contentLength !== undefined) headers['content-length'] = String(frame.contentLength);
  headers.host = input.targetUrl.host;
  headers['x-forwarded-host'] = host;
  headers['x-forwarded-proto'] = input.tls ? 'https' : 'http';
  if (input.peerAddress) headers['x-forwarded-for'] = input.peerAddress;
  headers['x-request-id'] = input.requestId;
  collect({ headers }, 503);
  const credentialHeaders = input.credentialHeaders ?? {};
  if (Object.values(credentialHeaders).some(value => typeof value !== 'string')) fail(503, 'gateway_upstream_credential_unavailable');
  let credentials: Map<string, string[]>;
  try {
    credentials = collect({ headers: credentialHeaders }, 503);
    assertHeaderPolicyCredentialNames(input.policy, [...input.managedHeaderNames ?? [], ...credentials.keys()]);
  } catch { fail(503, 'gateway_upstream_credential_unavailable'); }
  for (const [name, values] of credentials) {
    if (values.length !== 1 || !values[0]) fail(503, 'gateway_upstream_credential_unavailable');
    // Do not trim secret bytes after validating their syntax.
    const original = Object.entries(credentialHeaders).find(([key]) => key.toLowerCase() === name)![1];
    headers[name] = original;
  }
  try { collect({ headers }, 503); } catch { fail(503, 'gateway_upstream_credential_unavailable'); }
  return { headers, ...frame, normalizedRequestHeaders: business,
    cacheBypass: [...fields.keys()].some(name => name === 'range' || name.startsWith('if-') || name === 'cache-control' || name === 'pragma') };
}

export function filterGatewayResponseHeadersV1(input: RawHeaderInput & {
  policy: CompiledHeaderPolicyV1; statusCode: number; requestMethod: string; managedHeaderNames?: readonly string[];
  consumerAuthenticationHeaderNames?: readonly string[]; historicalAuthenticationHeaderNames?: readonly string[];
}): { headers: Record<string, string>; contentLength?: number; bodyAllowed: boolean;
  cacheSignals: { setCookie: boolean; pragma: boolean; cacheControl?: string; vary?: string; contentType?: string; age?: string } } {
  const fields = collect(input, 502);
  const frame = framing(fields, 502);
  if (!Number.isInteger(input.statusCode) || input.statusCode < 200 || input.statusCode > 599) fail(502, 'gateway_header_response_status');
  if (fields.has('upgrade') || (fields.get('connection') ?? []).some(v => v.split(',').some(n => n.trim().toLowerCase() === 'upgrade'))) fail(502, 'gateway_header_upgrade_unsupported');
  if (input.statusCode === 204 && (frame.contentLength !== undefined || frame.chunked)) fail(502, 'gateway_header_framing');
  const headers = filter(fields, input.policy.responseHeaders, responseLists, [...input.managedHeaderNames ?? [], ...input.consumerAuthenticationHeaderNames ?? [], ...input.historicalAuthenticationHeaderNames ?? []], 502);
  if (frame.contentLength !== undefined) headers['content-length'] = String(frame.contentLength);
  return { headers, contentLength: frame.contentLength, bodyAllowed: input.requestMethod.toUpperCase() !== 'HEAD' && ![204, 304].includes(input.statusCode),
    cacheSignals: { age: fields.get('age')?.join(', '), contentType: fields.get('content-type')?.join(', '), setCookie: fields.has('set-cookie'), pragma: fields.has('pragma'), cacheControl: fields.get('cache-control')?.join(', '), vary: fields.get('vary')?.join(', ') } };
}
