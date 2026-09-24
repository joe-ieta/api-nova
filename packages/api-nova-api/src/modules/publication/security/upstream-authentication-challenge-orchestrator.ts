import { securityDigest } from './upstream-security-reconciliation';
import { randomUUID } from 'node:crypto';
import type { Repository } from 'typeorm';
import { UpstreamProductionChallengeEvidenceEntity as Evidence } from '../../../database/entities/upstream-production-challenge-evidence.entity';
import type { ChallengeTarget, ChallengeContext, UpstreamSecurityContextAuthority } from './upstream-security-context-authority';
import type { UpstreamAuthenticationChallengeTransport } from './upstream-authentication-challenge-transport';
import { createUpstreamSecurityProofAuthority, type SecurityProof } from './upstream-security-proof-authority';
/** Future C3f host capability. Request JSON cannot act as an intent authority. */
export interface TrustedChallengeIntentAuthority {
  resolve(intent: unknown): Promise<Readonly<{ intentId: string; sourceServiceAssetId: string; endpointDefinitionId: string; actorId: string }>>;
}
export type TrustedProofBindingContext = Omit<ChallengeContext, 'credentialType'> & { readonly actorId: string };
export interface OrchestratedChallengeResult { readonly evidenceId: string; readonly proof: SecurityProof; }
/** Internal orchestration only: not registered in DI, controllers or readiness. */
export function createUpstreamAuthenticationChallengeOrchestrator(options: {
  intents: TrustedChallengeIntentAuthority;
  authority: UpstreamSecurityContextAuthority;
  transport: UpstreamAuthenticationChallengeTransport;
  repository: Pick<Repository<Evidence>, 'create' | 'save' | 'findOneBy' | 'update'>;
  ttlMs?: number;
}) {
  const ttlMs = options.ttlMs ?? 60000;
  const proofs = createUpstreamSecurityProofAuthority(options.authority, options.transport, ttlMs);
  const active = new Set<string>(), usedIntents = new Set<string>();
  const results = new WeakMap<OrchestratedChallengeResult, { target: ChallengeTarget; runNonce: string; evidenceFingerprint: string; actorId: string }>();
  const proofResults = new WeakMap<SecurityProof, OrchestratedChallengeResult>();
  const evidenceFingerprint = (row: Evidence) => securityDigest({ id: row.id, kind: row.evidenceKind, version: row.challengeVersion,
    source: row.sourceServiceAssetId, endpoint: row.endpointDefinitionId, context: row.contextDigest, epoch: row.providerEpoch,
    runNonce: row.runNonce, binding: row.bindingRevision, generation: row.bindingGeneration, actor: row.actorId, result: row.result,
    statuses: [row.anonymousBeforeStatus, row.wrongCredentialStatus, row.validCredentialStatus, row.anonymousAfterStatus],
    completed: +row.completedAt, expires: +row.expiresAt });
  const unavailable = () => new Error('CHALLENGE_ORCHESTRATION_UNAVAILABLE');
  async function validate(result: OrchestratedChallengeResult): Promise<boolean> {
      const tracked = results.get(result); if (!tracked) return false;
      try {
        const row = await options.repository.findOneBy({ id: result.evidenceId });
        if (!row || row.result !== 'passed' || row.evidenceKind !== 'production_challenge_v1' || row.runNonce !== tracked.runNonce || evidenceFingerprint(row) !== tracked.evidenceFingerprint || row.revokedAt || Date.now() >= +row.expiresAt || !(await proofs.isCurrent(result.proof, tracked.target))) throw unavailable();
        return true;
      } catch { proofs.revoke(result.proof); results.delete(result); return false; }
  }
  return Object.freeze({
    async execute(intent: unknown, signal?: AbortSignal): Promise<OrchestratedChallengeResult> {
      let scope: string | undefined, target: ChallengeTarget | undefined, row: Evidence | undefined, proof: SecurityProof | undefined;
      try {
        const claim = await options.intents.resolve(intent);
        if (!claim || ![claim.intentId, claim.actorId, claim.sourceServiceAssetId, claim.endpointDefinitionId].every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value))) throw unavailable();
        const key = JSON.stringify([claim.sourceServiceAssetId, claim.endpointDefinitionId]);
        if (active.has(key) || usedIntents.has(claim.intentId) || usedIntents.size >= 4096 || signal?.aborted) throw unavailable();
        active.add(key); scope = key; usedIntents.add(claim.intentId);
        const runNonce = randomUUID();
        if (await options.repository.findOneBy({ runNonce })) throw unavailable();
        target = await options.authority.issue({ sourceServiceAssetId: claim.sourceServiceAssetId, endpointDefinitionId: claim.endpointDefinitionId });
        const context = options.authority.inspect(target);
        row = options.repository.create({ sourceServiceAssetId: context.sourceServiceAssetId, endpointDefinitionId: context.endpointDefinitionId,
          contextDigest: context.contextDigest, providerEpoch: context.providerEpoch, runNonce,
          bindingRevision: context.bindingRevision, bindingGeneration: context.generation, actorId: claim.actorId,
          evidenceKind: 'production_challenge_v1', challengeVersion: 1, result: 'failed',
          completedAt: new Date(), expiresAt: new Date(Date.now() + ttlMs) });
        const receipt = await options.transport.challenge(target, signal);
        const observation = options.transport.inspect(receipt);
        if (observation.target !== target || signal?.aborted) throw unavailable();
        await options.authority.resolveCurrent(target);
        const [anonymousBeforeStatus, wrongCredentialStatus, validCredentialStatus, anonymousAfterStatus] = observation.statuses;
        Object.assign(row, { result: 'passed', completedAt: new Date(observation.completedAt), expiresAt: new Date(observation.completedAt + ttlMs),
          anonymousBeforeStatus, wrongCredentialStatus, validCredentialStatus, anonymousAfterStatus });
        row = await options.repository.save(row);
        // A returned row is not proof of a durable commit; reread its assigned ID.
        const stored = row.id && await options.repository.findOneBy({ id: row.id });
        if (!stored || stored.result !== 'passed' || stored.evidenceKind !== 'production_challenge_v1' || stored.challengeVersion !== 1 ||
          stored.sourceServiceAssetId !== context.sourceServiceAssetId || stored.endpointDefinitionId !== context.endpointDefinitionId ||
          stored.actorId !== claim.actorId || stored.bindingRevision !== context.bindingRevision || stored.bindingGeneration !== context.generation ||
          stored.runNonce !== runNonce || stored.contextDigest !== context.contextDigest || stored.providerEpoch !== context.providerEpoch || stored.revokedAt ||
          +stored.expiresAt !== observation.completedAt + ttlMs || +stored.completedAt !== observation.completedAt ||
          stored.anonymousBeforeStatus !== anonymousBeforeStatus || stored.wrongCredentialStatus !== wrongCredentialStatus ||
          stored.validCredentialStatus !== validCredentialStatus || stored.anonymousAfterStatus !== anonymousAfterStatus || signal?.aborted) throw unavailable();
        await options.authority.resolveCurrent(target);
        if (signal?.aborted || Date.now() >= +stored.expiresAt) throw unavailable();
        proof = await proofs.issue(receipt);
        if (signal?.aborted || !(await proofs.isCurrent(proof, target))) throw unavailable();
        const result = Object.freeze({ evidenceId: stored.id, proof }); results.set(result, { target, runNonce, evidenceFingerprint: evidenceFingerprint(stored), actorId: stored.actorId }); proofResults.set(proof, result); return result;
      } catch {
        if (proof) proofs.revoke(proof);
        if (target) options.authority.revoke(target);
        if (row) {
          try {
            if (row.id) await options.repository.update(row.id, { result: 'failed', failureCode: 'CONTEXT_CHANGED', revokedAt: new Date() });
            else await options.repository.save({ ...row, result: 'failed', failureCode: 'CHALLENGE_TRANSPORT_FAILED' });
          } catch { /* Persistence failure must never produce a capability or leak details. */ }
        }
        throw unavailable();
      } finally { if (scope) active.delete(scope); }
    },
    hasProof(proof: SecurityProof): boolean { const result = proofResults.get(proof); return Boolean(result && results.has(result)); },
    async authorizeProof(proof: SecurityProof, expected: TrustedProofBindingContext): Promise<boolean> {
      const result = proofResults.get(proof), tracked = result && results.get(result);
      if (!result || !tracked) return false;
      try {
        const context = options.authority.inspect(tracked.target);
        const fields = ['sourceServiceAssetId', 'endpointDefinitionId', 'target', 'method', 'bindingId', 'bindingRevision', 'registryRevision', 'providerEpoch', 'contextDigest'] as const;
        if (!expected || expected.actorId !== tracked.actorId || !Number.isSafeInteger(expected.generation) || expected.generation < 1 || expected.generation !== context.generation ||
          fields.some(field => typeof expected[field] !== 'string' || !expected[field] || expected[field] !== context[field])) return false;
        return validate(result);
      } catch { return false; }
    },
    async isCurrent(result: OrchestratedChallengeResult): Promise<boolean> { return validate(result); },
    async revoke(result: OrchestratedChallengeResult): Promise<void> {
      if (!results.has(result)) throw unavailable();
      proofs.revoke(result.proof); results.delete(result);
      try { await options.repository.update(result.evidenceId, { revokedAt: new Date() }); } catch { throw unavailable(); }
    },
  });
}
