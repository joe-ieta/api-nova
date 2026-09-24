import type { SecurityProof } from './upstream-security-proof-authority';
import type { TrustedProofBindingContext } from './upstream-authentication-challenge-orchestrator';
import { securityDigest } from './upstream-security-reconciliation';
export interface TrustedProofConsumptionContextReader {
  /** Host authenticates the session and reads the current membership ownership,
   * exact Binding identity and target. Never derive actor/epoch from request JSON. */
  read(session: unknown, selector: Readonly<{ runtimeAssetId: string; runtimeMembershipId: string }>): Promise<TrustedProofBindingContext | undefined>;
}
/** Host-only asynchronous consumer. No persistent Verified result or production registration. */
export function createUpstreamSecurityAuthorizationAdapter(
  authority: { hasProof(proof: SecurityProof): boolean; authorizeProof(proof: SecurityProof, context: TrustedProofBindingContext): Promise<boolean> },
  contexts: TrustedProofConsumptionContextReader,
) {
  return Object.freeze({
    async authorize(proof: SecurityProof, session: unknown, selector: { runtimeAssetId: string; runtimeMembershipId: string }): Promise<boolean> {
      try {
        // Missing/forged proof cannot trigger Provider resolution or context I/O.
        if (!authority.hasProof(proof) || !selector || Object.keys(selector).sort().join(',') !== 'runtimeAssetId,runtimeMembershipId' ||
          ![selector.runtimeAssetId, selector.runtimeMembershipId].every(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id))) return false;
        const selection = Object.freeze({ runtimeAssetId: selector.runtimeAssetId, runtimeMembershipId: selector.runtimeMembershipId });
        const first = await contexts.read(session, selection);
        if (!first) return false;
        const captured = structuredClone(first);
        if (!(await authority.authorizeProof(proof, captured))) return false;
        const second = await contexts.read(session, selection);
        if (!second || securityDigest(captured) !== securityDigest(second)) return false;
        // Do not reuse a previous boolean after asynchronous host ownership reads.
        return await authority.authorizeProof(proof, structuredClone(second));
      } catch { return false; }
    },
  });
}
