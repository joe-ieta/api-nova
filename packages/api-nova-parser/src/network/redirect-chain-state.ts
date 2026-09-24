import { ControlledDnsError } from './controlled-dns';
import { normalizeNetworkUrl } from './network-policy';
import { pinnedRecord } from './pinned-http-connection';

export interface RedirectResponseEvidence {
  readonly statusCode: number;
  /** The transport must prove exactly one raw Location before supplying this field. */
  readonly location?: string;
}
export type RedirectChainDecision = Readonly<{ kind: 'return'; hop: number }> | Readonly<{
  kind: 'follow'; hop: number; url: string; method: 'GET' | 'HEAD';
}>;
const denied = (): never => { throw new ControlledDnsError('upstream_network_policy_denied'); };
// Conservative equivalence for loop detection only; never rewrite the URL used for authorization.
const loopKey = (url: string) => url.replace(/%[0-9a-f]{2}/gi, encoded => {
  const decoded = String.fromCharCode(parseInt(encoded.slice(1), 16));
  return /^[A-Za-z0-9._~-]$/.test(decoded) ? decoded : encoded.toUpperCase();
});

/** Pure sequencing only: a follow decision is not Site, credential or network authorization.
 * The host must authorize the target against the fixed operation snapshot before advance/send.
 * Raw duplicate Location evidence, shared deadline/signal and socket ownership belong to the transport.
 */
export function createRedirectChainState(input: {
  url: string; method: string; hasBody: boolean; mode?: 'single-hop' | 'safe-read';
}) {
  try {
    const options = pinnedRecord(input, ['url', 'method', 'hasBody', 'mode'], ['url', 'method', 'hasBody']);
    if (typeof options.method !== 'string' || !/^[A-Z]{1,32}$/.test(options.method) ||
      typeof options.hasBody !== 'boolean' || options.mode !== undefined &&
      options.mode !== 'single-hop' && options.mode !== 'safe-read') return denied();
    let current = normalizeNetworkUrl(options.url);
    decodeURI(current.url); // Reject malformed percent/UTF-8 evidence without rewriting it.
    const method = options.method;
    const eligible = options.mode === 'safe-read' && !options.hasBody && (method === 'GET' || method === 'HEAD');
    const visited = new Set([loopKey(current.url)]);
    let hop = 0, closed = false;
    let pending: Extract<RedirectChainDecision, { kind: 'follow' }> | undefined;
    const fail = (): never => { closed = true; pending = undefined; return denied(); };
    return Object.freeze({
      inspect(evidence: RedirectResponseEvidence): RedirectChainDecision {
        try {
          if (closed || pending) return fail();
          const response = pinnedRecord(evidence, ['statusCode', 'location'], ['statusCode']);
          if (!Number.isInteger(response.statusCode) || (response.statusCode as number) < 100 || (response.statusCode as number) > 599) return fail();
          if (!eligible || ![301, 302, 303, 307, 308].includes(response.statusCode as number)) {
            closed = true; return Object.freeze({ kind: 'return', hop });
          }
          const location = response.location;
          if (hop >= 5 || typeof location !== 'string' || !location || location.length > 4096 ||
            /[\s\\#]/u.test(location) || /%(?:2e|2f|5c)/iu.test(location)) return fail();
          decodeURI(location); // Invalid percent/UTF-8 encoding is not a reliable target.
          // Validate raw absolute authority before URL can rewrite non-standard IP forms.
          const target = /^[a-z][a-z0-9+.-]*:/i.test(location) ? normalizeNetworkUrl(location)
            : location.startsWith('//') ? normalizeNetworkUrl(`${current.scheme}:${location}`)
            : normalizeNetworkUrl(new URL(location, current.url).href);
          if (current.scheme === 'https' && target.scheme === 'http' || visited.has(loopKey(target.url))) return fail();
          pending = Object.freeze({ kind: 'follow', hop: hop + 1, url: target.url, method: method as 'GET' | 'HEAD' });
          return pending;
        } catch { return fail(); }
      },
      advance(decision: RedirectChainDecision): void {
        try {
          if (closed || !pending || decision !== pending) return fail();
          current = normalizeNetworkUrl(pending.url); visited.add(loopKey(current.url)); hop = pending.hop; pending = undefined;
        } catch { return fail(); }
      },
      close(): void { closed = true; pending = undefined; },
    });
  } catch { return denied(); }
}
