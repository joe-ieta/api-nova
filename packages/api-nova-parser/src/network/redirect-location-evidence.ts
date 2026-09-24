import { IncomingMessage } from 'node:http';
import { ControlledDnsError } from './controlled-dns';

export type RedirectLocationEvidence = Readonly<{ kind: 'absent' }> |
  Readonly<{ kind: 'single'; value: string }> | Readonly<{ kind: 'ambiguous' }>;
const absent: RedirectLocationEvidence = Object.freeze({ kind: 'absent' });
const ambiguous: RedirectLocationEvidence = Object.freeze({ kind: 'ambiguous' });
const denied = (): never => { throw new ControlledDnsError('upstream_network_policy_denied'); };

/** Host-only transport boundary. Capture before exposing the bounded response object.
 * Never infer uniqueness from Node's merged headers. Evidence is consumed once by exact
 * response identity; a copied response or replay cannot gain Location evidence.
 * This is not redirect permission and does not change single-hop transport behavior.
 */
export function createRedirectLocationEvidenceStore() {
  const incomingSeen = new WeakSet<object>(), responseSeen = new WeakSet<object>();
  const records = new WeakMap<object, RedirectLocationEvidence>();
  const inspect = (incoming: IncomingMessage): RedirectLocationEvidence => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(incoming, 'rawHeaders');
      if (!descriptor || !('value' in descriptor) || !Array.isArray(descriptor.value)) return ambiguous;
      const raw = descriptor.value;
      const length = Object.getOwnPropertyDescriptor(raw, 'length');
      if (!length || !('value' in length) || !Number.isSafeInteger(length.value) ||
        length.value < 0 || length.value > 2048 || length.value % 2) return ambiguous;
      let location: string | undefined, count = 0, bytes = 0;
      for (let index = 0; index < length.value; index += 2) {
        const name = Object.getOwnPropertyDescriptor(raw, String(index));
        const value = Object.getOwnPropertyDescriptor(raw, String(index + 1));
        if (!name || !value || !('value' in name) || !('value' in value) ||
          typeof name.value !== 'string' || typeof value.value !== 'string' ||
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name.value) || /[\r\n\x00]/.test(value.value)) return ambiguous;
        bytes += name.value.length + value.value.length;
        if (bytes > 65536) return ambiguous;
        if (name.value.toLowerCase() === 'location') {
          count++; location = value.value;
          if (count > 1 || location.length > 4096) return ambiguous;
        }
      }
      return count === 0 ? absent : Object.freeze({ kind: 'single', value: location! });
    } catch { return ambiguous; }
  };
  return Object.freeze({
    capture(incoming: IncomingMessage, response: object): void {
      try {
        if (!(incoming instanceof IncomingMessage) || !response || typeof response !== 'object') return denied();
        if (incomingSeen.has(incoming) || responseSeen.has(response)) {
          records.delete(response); return denied();
        }
        incomingSeen.add(incoming); responseSeen.add(response);
        records.set(response, inspect(incoming));
      } catch { return denied(); }
    },
    consume(response: object): RedirectLocationEvidence {
      const evidence = response && typeof response === 'object' ? records.get(response) : undefined;
      if (!evidence) return denied();
      records.delete(response);
      return evidence;
    },
  });
}
