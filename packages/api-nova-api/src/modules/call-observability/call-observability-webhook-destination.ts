import { isIP } from 'node:net';

/**
 * OBS-TP-12 preparation, not an enabled or verified sender.
 *
 * Existing server/tools/httpServer.ts origin helpers are private inbound CORS
 * helpers with localhost defaults and error logging, not outbound SSRF guards.
 * Do not reuse those defaults for a delivery destination.
 *
 * INTERNAL conservative policy: HTTPS; exact canonical deployment origins;
 * no credentials, query (even empty), fragment, IP-literal URL, trailing-dot
 * hostname, single-label/local name or non-ASCII URL. Explicitly allowlisted
 * nondefault HTTPS ports are supported. Limits below are internal draft limits.
 *
 * No resolver/default DNS or network sender is installed by this module.
 * The injected resolver MUST return ALL A/AAAA answers for this resolution,
 * including CNAME targets, or reject on incomplete/error results. It must apply
 * its own bounded deadline/cancellation. An empty/oversized/mixed-private result
 * is rejected; a public answer never excuses a private answer.
 *
 * A sender MUST connect to connection.host, NOT re-resolve hostname/origin.
 * Use connection.servername for TLS SNI AND certificate hostname verification,
 * preserve hostHeader, keep rejectUnauthorized=true, and send requestPath.
 * No proxy/env proxy, alternate DNS, automatic redirects, connection-pool reuse
 * for an unchecked address or library fallback is permitted. A failed connection
 * needs a new complete resolution/validation, never an unchecked fallback.
 *
 * Address classification is deliberately conservative, not a complete current
 * IANA registry or deployment routing guarantee. Reserved IPv4 ranges, IPv6
 * outside ordinary 2000::/3 global unicast, known special/transition ranges and
 * Azure's platform virtual address are denied. Mapped/embedded IPv4 is denied.
 * Deployments still need egress controls for custom metadata routes and public
 * addresses routed internally. This helper alone does not secure a sender.
 */
export const WEBHOOK_DESTINATION_DRAFT_LIMITS = Object.freeze({
  maxUrlCharacters: 4096,
  maxAllowedOrigins: 128,
  maxDnsAnswers: 64,
});

export type WebhookDestinationErrorCode =
  | 'INVALID_WEBHOOK_DESTINATION'
  | 'INVALID_WEBHOOK_ORIGIN_ALLOWLIST'
  | 'WEBHOOK_ORIGIN_NOT_ALLOWED'
  | 'WEBHOOK_DNS_FAILED'
  | 'INVALID_WEBHOOK_DNS_ANSWERS'
  | 'UNSAFE_WEBHOOK_ADDRESS';

export class WebhookDestinationError extends Error {
  constructor(readonly code: WebhookDestinationErrorCode) {
    super(code);
    this.name = 'WebhookDestinationError';
  }
}

export interface WebhookDnsAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** Must return a complete answer set; do not return just the first address. */
export type WebhookDestinationResolver = (
  hostname: string,
  options: Readonly<{ all: true; verbatim: true }>,
) => Promise<readonly WebhookDnsAddress[]>;

export interface WebhookDestinationInput {
  readonly url: string;
  /** Trusted deployment configuration, never subscription/user-controlled. */
  readonly allowedOrigins: readonly string[];
}

export interface PreparedWebhookDestination {
  readonly origin: string;
  readonly hostname: string;
  readonly hostHeader: string;
  readonly requestPath: string;
  readonly checkedAddresses: readonly Readonly<WebhookDnsAddress>[];
  readonly connection: Readonly<{
    /** Literal checked IP: use this as the actual socket destination. */
    host: string;
    port: number;
    family: 4 | 6;
    /** Original canonical DNS hostname, not the pinned IP. */
    servername: string;
    rejectUnauthorized: true;
  }>;
  readonly followRedirects: false;
  readonly useProxy: false;
}

function fail(code: WebhookDestinationErrorCode): never {
  // Never attach raw destination, credentials, DNS errors or causes.
  throw new WebhookDestinationError(code);
}

function parseDestination(value: string): URL {
  if (typeof value !== 'string' || value.length === 0 ||
      value.length > WEBHOOK_DESTINATION_DRAFT_LIMITS.maxUrlCharacters ||
      !/^[\x21-\x7e]+$/.test(value) || !value.startsWith('https://') ||
      /[?#\\\\]/.test(value)) fail('INVALID_WEBHOOK_DESTINATION');
  let url: URL;
  try { url = new URL(value); } catch { return fail('INVALID_WEBHOOK_DESTINATION'); }
  const authority = value.slice('https://'.length).split('/')[0];
  if (url.protocol !== 'https:' || url.username || url.password || authority.includes('@') ||
      url.search || url.hash || !safeHostname(url.hostname)) fail('INVALID_WEBHOOK_DESTINATION');
  return url;
}

function safeHostname(hostname: string): boolean {
  // Reject URL IPv4 canonicalizations too (integer, octal, hex and short forms).
  if (!hostname || hostname.length > 253 || isIP(hostname) !== 0 ||
      hostname.includes(':') || hostname.endsWith('.') || !hostname.includes('.')) return false;
  const labels = hostname.split('.');
  if (labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false;
  const blockedSuffixes = ['localhost', 'local', 'internal', 'home', 'lan', 'test',
    'invalid', 'example', 'onion', 'arpa'];
  if (blockedSuffixes.some(suffix => hostname === suffix || hostname.endsWith('.' + suffix))) return false;
  if (['example.com', 'example.net', 'example.org'].some(name =>
    hostname === name || hostname.endsWith('.' + name))) return false;
  return true;
}

function publicIpv4(address: string): boolean {
  const [a, b, c, d] = address.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) ||
        (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) ||
      (a === 168 && b === 63 && c === 129 && d === 16)) return false;
  return true;
}

function publicIpv6(address: string): boolean {
  // isIP already checked syntax. Deny zone IDs and ALL dotted IPv4 embeddings.
  if (address.includes('%') || address.includes('.')) return false;
  const halves = address.toLowerCase().split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const words = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  if (words.length !== 8) return false;
  const first = parseInt(words[0], 16);
  const second = parseInt(words[1], 16);
  // This positive range also excludes ::, ::1, ::ffff:xxxx:xxxx, NAT64,
  // ULA/site-local/link-local and multicast, regardless of textual spelling.
  if (first < 0x2000 || first > 0x3fff) return false;
  if ((first === 0x2001 && (second < 0x0200 || second === 0x0db8)) ||
      first === 0x2002 || first === 0x3fff) return false;
  return true;
}

/** Resolves only through the injected capability; never opens an HTTP connection. */
export async function prepareObservabilityWebhookDestination(
  input: WebhookDestinationInput,
  resolveAll: WebhookDestinationResolver,
): Promise<PreparedWebhookDestination> {
  if (!input || typeof input !== 'object') fail('INVALID_WEBHOOK_DESTINATION');
  const destination = parseDestination(input.url);
  const suppliedOrigins = input.allowedOrigins;
  if (!Array.isArray(suppliedOrigins) || suppliedOrigins.length < 1 ||
      suppliedOrigins.length > WEBHOOK_DESTINATION_DRAFT_LIMITS.maxAllowedOrigins) {
    fail('INVALID_WEBHOOK_ORIGIN_ALLOWLIST');
  }
  const origins = new Set<string>();
  for (const value of suppliedOrigins) {
    let parsed: URL;
    try { parsed = parseDestination(value); }
    catch { return fail('INVALID_WEBHOOK_ORIGIN_ALLOWLIST'); }
    // No wildcard, path, slash, implicit port rewrite or partial host match.
    if (value !== parsed.origin) fail('INVALID_WEBHOOK_ORIGIN_ALLOWLIST');
    origins.add(parsed.origin);
  }
  if (!origins.has(destination.origin)) fail('WEBHOOK_ORIGIN_NOT_ALLOWED');
  if (typeof resolveAll !== 'function') fail('WEBHOOK_DNS_FAILED');

  let answers: readonly WebhookDnsAddress[];
  try {
    answers = await resolveAll(destination.hostname, Object.freeze({ all: true, verbatim: true }));
  } catch {
    return fail('WEBHOOK_DNS_FAILED');
  }
  if (!Array.isArray(answers) || answers.length < 1 ||
      answers.length > WEBHOOK_DESTINATION_DRAFT_LIMITS.maxDnsAnswers) {
    fail('INVALID_WEBHOOK_DNS_ANSWERS');
  }
  const checked: Readonly<WebhookDnsAddress>[] = [];
  for (const answer of answers) {
    if (!answer || typeof answer !== 'object') fail('INVALID_WEBHOOK_DNS_ANSWERS');
    const { address, family } = answer;
    if (typeof address !== 'string' || address.length > 45 ||
        (family !== 4 && family !== 6) || isIP(address) !== family) {
      fail('INVALID_WEBHOOK_DNS_ANSWERS');
    }
    if (!(family === 4 ? publicIpv4(address) : publicIpv6(address))) fail('UNSAFE_WEBHOOK_ADDRESS');
    checked.push(Object.freeze({ address, family }));
  }
  const pinned = checked[0];
  return Object.freeze({
    origin: destination.origin,
    hostname: destination.hostname,
    hostHeader: destination.host,
    requestPath: destination.pathname,
    checkedAddresses: Object.freeze(checked),
    connection: Object.freeze({
      host: pinned.address,
      port: destination.port ? Number(destination.port) : 443,
      family: pinned.family,
      servername: destination.hostname,
      rejectUnauthorized: true as const,
    }),
    followRedirects: false as const,
    useProxy: false as const,
  });
}
