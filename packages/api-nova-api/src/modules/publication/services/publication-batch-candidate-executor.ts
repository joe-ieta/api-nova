import type { DataSource } from 'typeorm';
import type { SecurityProof } from '../security/upstream-security-proof-authority';
import type { PublicationPreviewAuthorization, PublicationPreviewSelector } from './publication-security-preview-adapter';
import { PublicationMemberTransactionWriter, PublicationMemberAfterCommitError, type PublicationMemberCommitResult } from './publication-member-transaction-writer';
export interface FreshPublicationCapability { proof: SecurityProof; evidenceId: string; contextVersion: string }
export interface PublicationBatchDependencies {
  database: DataSource;
  /** Host resolves a current capability separately for each member, never from a request DTO. */
  fresh(session: unknown, selector: PublicationPreviewSelector): Promise<FreshPublicationCapability>;
  authorization: PublicationPreviewAuthorization;
  /** Actual G2 currently returns canPublish:false, which this executor must preserve. */
  readiness: { readiness(session: unknown, selector: PublicationPreviewSelector, proof: SecurityProof): Promise<{ readonly canPublish: boolean; readonly proofCurrent: boolean }> };
  afterCommit?(result: Readonly<PublicationMemberCommitResult>): Promise<void>;
  audit?(item: Readonly<PublicationBatchItem>): Promise<void>;
}
export interface PublicationBatchItem {
  readonly membershipId: string;
  readonly status: 'success' | 'failed' | 'committed_side_effect_failed';
  readonly committed: boolean;
  readonly code?: 'MEMBER_REJECTED' | 'AFTER_COMMIT_FAILED';
  readonly publicationRevision?: number;
  readonly auditFailed?: boolean;
}
/** Unregistered execution capability. Per-member atomicity only; audits remain outside transactions. */
export function createPublicationBatchCandidateExecutor(dependencies: PublicationBatchDependencies) {
  function selected(input: PublicationPreviewSelector): PublicationPreviewSelector {
    if (!input || Object.keys(input).sort().join(',') !== 'runtimeAssetId,runtimeMembershipId'
      || ![input.runtimeAssetId, input.runtimeMembershipId].every(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id))) throw Error('publication_batch_selection_invalid');
    return Object.freeze({ ...input });
  }
  async function current(session: unknown, selector: PublicationPreviewSelector, capability: FreshPublicationCapability) {
    if (!capability?.proof || !capability.evidenceId || !capability.contextVersion
      || !(await dependencies.authorization.authorize(capability.proof, session, selector))) throw Error('publication_member_rejected');
  }
  async function ready(session: unknown, selector: PublicationPreviewSelector, capability: FreshPublicationCapability) {
    await current(session, selector, capability);
    const state = await dependencies.readiness.readiness(session, selector, capability.proof);
    if (state.canPublish !== true || state.proofCurrent !== true) throw Error('publication_member_rejected');
    await current(session, selector, capability);
  }
  return Object.freeze({
    async executeBatch(session: unknown, selections: readonly PublicationPreviewSelector[]): Promise<Readonly<{ atomic: false; items: readonly PublicationBatchItem[] }>> {
      if (!Array.isArray(selections) || !selections.length || selections.length > 100) throw Error('publication_batch_selection_invalid');
      const items = selections.map(selected);
      if (new Set(items.map(item => item.runtimeAssetId)).size !== 1 || new Set(items.map(item => item.runtimeMembershipId)).size !== items.length) throw Error('publication_batch_selection_invalid');
      const reports: PublicationBatchItem[] = [];
      // Existing publication batches continue after an individual member failure.
      for (const selector of items) {
        let report: PublicationBatchItem;
        try {
          const raw = await dependencies.fresh(session, selector);
          const capability = Object.freeze({ proof: raw.proof, evidenceId: raw.evidenceId, contextVersion: raw.contextVersion });
          await ready(session, selector, capability);
          const writer = new PublicationMemberTransactionWriter(dependencies.database, async context => {
            if (context.membershipId !== selector.runtimeMembershipId || context.runtimeAssetId !== selector.runtimeAssetId || context.evidence.id !== capability.evidenceId) throw Error('publication_member_rejected');
            await current(session, selector, capability); return capability.contextVersion;
          });
          const ticket = await writer.prepare({ membershipId: selector.runtimeMembershipId, evidenceId: capability.evidenceId });
          await ready(session, selector, capability);
          const committed = await writer.commit(ticket, dependencies.afterCommit);
          report = Object.freeze({ membershipId: selector.runtimeMembershipId, status: 'success', committed: true, publicationRevision: committed.publicationRevision });
        } catch (error) {
          report = error instanceof PublicationMemberAfterCommitError
            ? Object.freeze({ membershipId: selector.runtimeMembershipId, status: 'committed_side_effect_failed', committed: true, code: 'AFTER_COMMIT_FAILED', publicationRevision: error.result.publicationRevision })
            : Object.freeze({ membershipId: selector.runtimeMembershipId, status: 'failed', committed: false, code: 'MEMBER_REJECTED' });
        }
        try { await dependencies.audit?.(report); }
        catch { report = Object.freeze({ ...report, auditFailed: true }); }
        reports.push(report);
      }
      return Object.freeze({ atomic: false, items: Object.freeze(reports) });
    },
    /** Narrow synchronous candidate swap only. Async preparation belongs before this call.
     * A host recheck may re-validate the shared evaluation; the epoch is compared again
     * after it so no await remains between the final check and the synchronous swap. */
    async activateCandidate(session: unknown, selection: PublicationPreviewSelector, candidate: { expectedEpoch: string; currentEpoch(): string; activate(): undefined; recheck?(): Promise<void> }): Promise<void> {
      const selector = selected(selection);
      const expectedEpoch = candidate.expectedEpoch;
      const currentEpoch = candidate.currentEpoch.bind(candidate), activate = candidate.activate.bind(candidate);
      const recheck = candidate.recheck?.bind(candidate);
      const capability = await dependencies.fresh(session, selector);
      await ready(session, selector, capability);
      await current(session, selector, capability);
      if (!expectedEpoch || currentEpoch() !== expectedEpoch) throw Error('publication_candidate_rejected');
      if (recheck) await recheck();
      if (!expectedEpoch || currentEpoch() !== expectedEpoch) throw Error('publication_candidate_rejected');
      // No await between the live epoch check and this host-owned synchronous swap.
      activate();
    },
  });
}
