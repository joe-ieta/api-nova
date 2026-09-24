import { randomUUID } from 'node:crypto';
import type { ChallengeTarget, UpstreamSecurityContextAuthority } from './upstream-security-context-authority';
import type { ChallengeReceipt, UpstreamAuthenticationChallengeTransport } from './upstream-authentication-challenge-transport';
declare const securityProof: unique symbol;
export type SecurityProof = { readonly [securityProof]: true };
/** Process-local capability only. Never returned as production Verified/readiness. */
export function createUpstreamSecurityProofAuthority(authority: UpstreamSecurityContextAuthority, transport: UpstreamAuthenticationChallengeTransport, ttlMs = 60000, now: () => number = Date.now) {
  if (!Number.isFinite(ttlMs) || ttlMs < 1 || ttlMs > 300000) throw Error('PROOF_CONFIGURATION_INVALID');
  const runNonce = randomUUID();
  const proofs = new WeakMap<SecurityProof, { target: ChallengeTarget; expires: number; runNonce: string }>();
  const consumed = new WeakSet<ChallengeReceipt>();
  return Object.freeze({
    async issue(receipt: ChallengeReceipt): Promise<SecurityProof> {
      try {
        if (consumed.has(receipt)) throw Error();
        const observed = transport.inspect(receipt); consumed.add(receipt);
        const expires = observed.completedAt + ttlMs;
        if (now() >= expires || now() < observed.completedAt) throw Error();
        await authority.resolveCurrent(observed.target);
        if (now() >= expires) throw Error();
        const proof = Object.freeze({}) as SecurityProof; proofs.set(proof, { target: observed.target, expires, runNonce }); return proof;
      } catch { throw Error('SECURITY_PROOF_UNAVAILABLE'); }
    },
    async isCurrent(proof: SecurityProof, target: ChallengeTarget): Promise<boolean> {
      const entry = proofs.get(proof);
      if (!entry || entry.target !== target || entry.runNonce !== runNonce || now() >= entry.expires) { proofs.delete(proof); return false; }
      try { await authority.resolveCurrent(target); } catch { proofs.delete(proof); return false; }
      if (proofs.get(proof) !== entry || now() >= entry.expires) { proofs.delete(proof); return false; }
      return true;
    },
    revoke(proof: SecurityProof): void { proofs.delete(proof); },
  });
}
