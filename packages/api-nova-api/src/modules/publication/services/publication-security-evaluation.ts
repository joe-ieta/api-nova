import { createHash, randomUUID } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import type { SecurityProof } from '../security/upstream-security-proof-authority';
import { UpstreamProductionChallengeEvidenceEntity as Evidence } from '../../../database/entities/upstream-production-challenge-evidence.entity';
import { RuntimeAssetEndpointBindingEntity as Membership } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import type { FreshPublicationCapability } from './publication-batch-candidate-executor';
import type { PublicationMemberValidationContext, PublicationMemberValidator } from './publication-member-transaction-writer';
import type {
  PublicationPreviewAuthorization,
  PublicationPreviewSelector,
  PublicationSecurityPreview,
} from './publication-security-preview-adapter';

/**
 * One frozen host-only evaluation consumed by preview, single/batch publication and
 * the activation boundary. It never issues proofs, never persists itself and never
 * converts G2's `canPublish:false` into an authorization.
 */
export interface PublicationSecurityEvaluation {
  readonly evaluationId: string;
  readonly selector: Readonly<PublicationPreviewSelector>;
  readonly preview: PublicationSecurityPreview;
  readonly proof: SecurityProof;
  readonly evidenceId: string;
  readonly contextVersion: string;
  readonly evidenceFingerprint: string;
  readonly membershipRevision: number;
}

export interface PublicationSecurityEvaluationDependencies {
  database: Pick<DataSource, 'getRepository' | 'manager'>;
  authorization: PublicationPreviewAuthorization;
  readiness: { readiness(session: unknown, selector: PublicationPreviewSelector, proof: SecurityProof): Promise<PublicationSecurityPreview> };
  /** Host resolves a current capability per member; never from a request DTO. */
  fresh(session: unknown, selector: PublicationPreviewSelector): Promise<FreshPublicationCapability>;
}

interface RegisteredEvaluation {
  readonly selector: Readonly<PublicationPreviewSelector>;
  readonly evidenceFingerprint: string;
  readonly contextVersion: string;
  readonly membershipRevision: number;
}

const evaluations = new WeakMap<object, RegisteredEvaluation>();

const isDateLike = (input: any): boolean =>
  Object.prototype.toString.call(input) === '[object Date]' || input instanceof Date
  || (input !== null && typeof input === 'object'
    && typeof input.toISOString === 'function' && typeof input.getTime === 'function');
const stable = (input: any): any => isDateLike(input) ? new Date(input).toISOString()
  : Array.isArray(input) ? input.map(stable)
    : input && typeof input === 'object'
      ? Object.fromEntries(Object.keys(input).sort().map(key => [key, stable(input[key])])) : input;

export function challengeEvidenceFingerprint(evidence: Evidence): string {
  return createHash('sha256').update(JSON.stringify(stable([
    evidence.id, evidence.evidenceKind, evidence.challengeVersion, evidence.sourceServiceAssetId,
    evidence.endpointDefinitionId, evidence.contextDigest, evidence.providerEpoch, evidence.runNonce,
    evidence.bindingRevision, evidence.bindingGeneration, evidence.actorId, evidence.result,
    evidence.failureCode, evidence.anonymousBeforeStatus, evidence.wrongCredentialStatus,
    evidence.validCredentialStatus, evidence.anonymousAfterStatus, evidence.completedAt,
    evidence.expiresAt, evidence.revokedAt,
  ]))).digest('hex');
}

export function createPublicationSecurityEvaluation(dependencies: PublicationSecurityEvaluationDependencies) {
  const selected = (input: PublicationPreviewSelector): Readonly<PublicationPreviewSelector> => {
    if (!input || Object.keys(input).sort().join(',') !== 'runtimeAssetId,runtimeMembershipId'
      || ![input.runtimeAssetId, input.runtimeMembershipId]
        .every(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id))) {
      throw Error('publication_evaluation_selection_invalid');
    }
    return Object.freeze({ ...input });
  };

  async function evaluate(session: unknown, input: PublicationPreviewSelector): Promise<PublicationSecurityEvaluation> {
    const selector = selected(input);
    const capability = await dependencies.fresh(session, selector);
    if (!capability?.proof || !capability.evidenceId || !capability.contextVersion) {
      throw Error('publication_evaluation_rejected');
    }
    if (!(await dependencies.authorization.authorize(capability.proof, session, selector))) {
      throw Error('publication_evaluation_rejected');
    }
    const preview = await dependencies.readiness.readiness(session, selector, capability.proof);
    const evidence = await dependencies.database.getRepository(Evidence).findOneBy({ id: capability.evidenceId });
    const membership = await dependencies.database.getRepository(Membership)
      .findOneBy({ id: selector.runtimeMembershipId, runtimeAssetId: selector.runtimeAssetId });
    if (!evidence || !membership) throw Error('publication_evaluation_rejected');
    const registered: RegisteredEvaluation = Object.freeze({
      selector,
      evidenceFingerprint: challengeEvidenceFingerprint(evidence),
      contextVersion: capability.contextVersion,
      membershipRevision: membership.publicationRevision,
    });
    const evaluation: PublicationSecurityEvaluation = Object.freeze({
      evaluationId: randomUUID(),
      selector,
      preview,
      proof: capability.proof,
      evidenceId: capability.evidenceId,
      contextVersion: registered.contextVersion,
      evidenceFingerprint: registered.evidenceFingerprint,
      membershipRevision: registered.membershipRevision,
    });
    evaluations.set(evaluation, registered);
    return evaluation;
  }

  /**
   * G3 validator bound to one evaluation: it pins the evidence fingerprint and
   * member identity for the whole transaction. G3's own row digest and
   * contextVersion checks reject drift between prepare and commit; the membership
   * revision pin is enforced at the activation boundary via
   * `assertTransactionCurrent` (after the writer legitimately claims revision + 1).
   */
  function toValidator(evaluation: PublicationSecurityEvaluation,
    validate?: PublicationMemberValidator): PublicationMemberValidator {
    const registered = evaluations.get(evaluation);
    if (!registered) throw Error('publication_evaluation_missing');
    return async (context: PublicationMemberValidationContext) => {
      if (context.membershipId !== registered.selector.runtimeMembershipId
        || context.runtimeAssetId !== registered.selector.runtimeAssetId
        || context.evidence.id !== evaluation.evidenceId
        || challengeEvidenceFingerprint(context.evidence) !== registered.evidenceFingerprint) {
        throw Error('publication_evaluation_context_changed');
      }
      if (validate) {
        const version = await validate(context);
        if (version !== registered.contextVersion) throw Error('publication_evaluation_context_changed');
        return version;
      }
      return registered.contextVersion;
    };
  }

  /** Activation commit-boundary recheck against the same evaluation. */
  async function assertTransactionCurrent(manager: EntityManager,
    evaluation: PublicationSecurityEvaluation): Promise<void> {
    const registered = evaluations.get(evaluation);
    if (!registered) throw Error('publication_evaluation_missing');
    const evidence = await manager.getRepository(Evidence).findOneBy({ id: evaluation.evidenceId });
    const membership = await manager.getRepository(Membership)
      .findOneBy({ id: registered.selector.runtimeMembershipId, runtimeAssetId: registered.selector.runtimeAssetId });
    if (!evidence || challengeEvidenceFingerprint(evidence) !== registered.evidenceFingerprint
      || !membership || membership.publicationRevision !== registered.membershipRevision) {
      throw Error('publication_transaction_context_changed');
    }
  }

  return Object.freeze({ evaluate, toValidator, assertTransactionCurrent });
}
