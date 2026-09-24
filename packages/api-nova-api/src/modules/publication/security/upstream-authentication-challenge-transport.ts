import * as http from 'node:http';
import * as https from 'node:https';
import { randomUUID } from 'node:crypto';
import type { ChallengeTarget, UpstreamSecurityContextAuthority } from './upstream-security-context-authority';
declare const challengeReceipt: unique symbol;
export type ChallengeReceipt = { readonly [challengeReceipt]: true };
/** Internal real transport. No production DI/controller registration. */
export function createUpstreamAuthenticationChallengeTransport(authority: UpstreamSecurityContextAuthority, timeoutMs = 1000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 10 || timeoutMs > 5000) throw Error('CHALLENGE_TRANSPORT_CONFIGURATION');
  const receipts = new WeakMap<ChallengeReceipt, { target: ChallengeTarget; completedAt: number; statuses: readonly [number, number, number, number] }>();
  async function probe(target: ChallengeTarget, headers: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<number> {
    const context = authority.inspect(target), url = new URL(context.target);
    return new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(url, { method: context.method, headers, agent: false }, response => {
        response.destroy();
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) finish(Error('CHALLENGE_TRANSPORT_FAILED'));
        else finish(undefined, status);
      });
      let settled = false;
      const timer = setTimeout(() => finish(Error('CHALLENGE_TRANSPORT_FAILED')), timeoutMs);
      const abort = () => finish(Error('CHALLENGE_TRANSPORT_FAILED'));
      function finish(error?: Error, status?: number) {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); request.destroy();
        if (error) reject(Error('CHALLENGE_TRANSPORT_FAILED')); else resolve(status!);
      }
      request.on('error', () => finish(Error('CHALLENGE_TRANSPORT_FAILED')));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort(); else request.end();
    });
  }
  async function current(target: ChallengeTarget, signal?: AbortSignal) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([authority.resolveCurrent(target), new Promise<never>((_, reject) => {
        abort = () => reject(Error('AUTHENTICATION_CHALLENGE_FAILED'));
        timer = setTimeout(abort, timeoutMs); signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      })]);
    } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
  }
  return Object.freeze({
    async challenge(target: ChallengeTarget, signal?: AbortSignal): Promise<ChallengeReceipt> {
      try {
        const statuses: number[] = [];
        for (const phase of ['anonymous', 'wrong', 'valid', 'anonymous']) {
          if (signal?.aborted) throw Error();
          const credential = await current(target, signal), context = authority.inspect(target);
          const headers = phase === 'anonymous' ? {} : phase === 'valid' ? credential : Object.fromEntries(Object.keys(credential).map(name => [name, name.toLowerCase() === 'authorization' ? context.credentialType === 'basic' ? 'Basic ' + Buffer.from(randomUUID() + ':' + randomUUID()).toString('base64') : 'Bearer ' + randomUUID() : randomUUID()]));
          if (signal?.aborted) throw Error();
          const status = await probe(target, headers, signal); statuses.push(status);
          if (phase === 'valid' ? status < 200 || status >= 300 : status !== 401 && status !== 403) throw Error();
        }
        if (signal?.aborted) throw Error();
        await current(target, signal);
        const receipt = Object.freeze({}) as ChallengeReceipt; receipts.set(receipt, { target, completedAt: Date.now(), statuses: Object.freeze(statuses) as readonly [number, number, number, number] }); return receipt;
      } catch { authority.revoke(target); throw Error('AUTHENTICATION_CHALLENGE_FAILED'); }
    },
    inspect(receipt: ChallengeReceipt) { const value = receipts.get(receipt); if (!value) throw Error('AUTHENTICATION_RECEIPT_INVALID'); return Object.freeze({ ...value }); },
  });
}
export type UpstreamAuthenticationChallengeTransport = ReturnType<typeof createUpstreamAuthenticationChallengeTransport>;
