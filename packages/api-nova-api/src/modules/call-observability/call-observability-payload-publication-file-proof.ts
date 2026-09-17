import { CallObservabilityStore } from './call-observability.store';
import { CallObservabilityPayloadStore, PayloadRecoveryPathScan } from './call-observability-payload.store';
import { PayloadInventoryFenceSession } from './call-observability-payload.coordinator';
import { PayloadPublicationCorrelation, PayloadPublicationCorrelationService } from './call-observability-payload-publication-correlation';
import { canonicalJson, contentHash, ObservabilityStorageError } from './call-observability-storage';

type CorrelationBlocked = Exclude<PayloadPublicationCorrelation, { status: 'linked_unverified' }>;
type FileBlockReason = 'scan_partial' | 'scan_unknown' | 'temporary_present' |
  'file_missing_or_invalid' | 'file_unverified' | 'evidence_changed';
export type PayloadPublicationFileProof = CorrelationBlocked |
  { status: 'blocked'; reservationId: string; reason: FileBlockReason; quotaEnforced: false } |
  { status: 'file_proof_uncommitted'; reservationId: string; ownerId: string;
    epoch: string; generation: string; payloadId: string; fileKey: string;
    temporaryKey: string; digest: string; storedBytes: number;
    ledgerVersion: number; ledgerState: string; ledgerReservedBytes: string;
    ledgerCommittedBytes: string; reservationState: string; reservationUpdatedAt: string;
    scannedEntries: number; scanHash: string; quotaEnforced: false };

/** Stable fingerprint for a complete path scan. It is session-local evidence,
 * never a durable permission to release quota after the fence ends. */
export function payloadRecoveryScanHash(scan: PayloadRecoveryPathScan): string {
  return contentHash(canonicalJson([scan.traversal, scan.unknownOccupancy,
    scan.scannedEntries, scan.measuredBytes,
    scan.paths.map(path => [path.kind, path.key, path.shard, path.sizeBytes, path.reason])
      .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)))]));
}

/** C2A: a complete, bounded, read-only scan and exact target-file proof while
 * the same persistent inventory fence excludes managed writers and GC.
 * No result is settlement authority after this fence has been released. */
export class PayloadPublicationFileProofService {
  private readonly correlation: PayloadPublicationCorrelationService;

  constructor(private readonly store: CallObservabilityStore,
    private readonly payloads: CallObservabilityPayloadStore) {
    this.correlation = new PayloadPublicationCorrelationService(store, payloads);
  }

  async inspect(reservationId: string,
    options: { maxEntriesPerBatch?: number; maxBatches?: number } = {})
    : Promise<PayloadPublicationFileProof> {
    const limits = this.limits(options);
    let held;
    try {
      held = await this.store.payloadCoordination.withInventoryFence(fence =>
        this.inspectWithinFence(fence, reservationId, limits));
    } catch (error) {
      if (error instanceof ObservabilityStorageError && error.code === 'PAYLOAD_STORAGE_NOT_BOUND') {
        return { status: 'unavailable', reservationId,
          reason: 'storage_unavailable', quotaEnforced: false };
      }
      throw error;
    }
    if (held.status === 'busy') return { status: 'busy', reservationId,
      reason: held.reason, quotaEnforced: false };
    return held.result;
  }

  /** C2B may call this only with its own live fence and must repeat the proof
   * in its final transaction; the returned object is never a reusable token. */
  async inspectWithinFence(fence: PayloadInventoryFenceSession, reservationId: string,
    options: { maxEntriesPerBatch?: number; maxBatches?: number } = {})
    : Promise<PayloadPublicationFileProof> {
    const limits = this.limits(options);
    const blocked = (reason: FileBlockReason): PayloadPublicationFileProof =>
      ({ status: 'blocked', reservationId, reason, quotaEnforced: false });
    const linked = await this.correlation.inspectWithinFence(fence, reservationId);
    if (linked.status !== 'linked_unverified') return linked;
    let scan;
    try {
      scan = await this.payloads.scanRecoveryPaths(limits.maxEntriesPerBatch,
        limits.maxBatches, () => fence.check());
    } catch (error) {
      if (error instanceof ObservabilityStorageError &&
        error.code === 'PAYLOAD_INVENTORY_FENCE_LOST') throw error;
      return blocked('scan_unknown');
    }
    if (scan.traversal !== 'complete') return blocked('scan_partial');
    if (scan.paths.some(path => path.key === linked.temporaryKey)) return blocked('temporary_present');
    if (scan.unknownOccupancy || scan.paths.some(path => path.kind !== 'final')) {
      return blocked('scan_unknown');
    }
    const final = scan.paths.filter(path => path.kind === 'final' && path.key === linked.fileKey);
    if (final.length !== 1 || final[0].sizeBytes !== linked.storedBytes) {
      return blocked('file_missing_or_invalid');
    }
    try {
      await this.payloads.verifyRecoveryPublication(linked.fileKey, linked.temporaryKey,
        linked.digest, linked.storedBytes, () => fence.check());
    } catch (error) {
      if (error instanceof ObservabilityStorageError &&
        error.code === 'PAYLOAD_INVENTORY_FENCE_LOST') throw error;
      if (error instanceof ObservabilityStorageError &&
        error.code === 'PAYLOAD_RECOVERY_TEMP_PRESENT') return blocked('temporary_present');
      return blocked('file_unverified');
    }
    const after = await this.correlation.inspectWithinFence(fence, reservationId);
    if (after.status !== 'linked_unverified' || canonicalJson(after) !== canonicalJson(linked)) {
      return blocked('evidence_changed');
    }
    await fence.check();
    return { ...linked, status: 'file_proof_uncommitted',
      scannedEntries: scan.scannedEntries, scanHash: payloadRecoveryScanHash(scan) };
  }

  private limits(options: { maxEntriesPerBatch?: number; maxBatches?: number })
    : { maxEntriesPerBatch: number; maxBatches: number } {
    const maxEntriesPerBatch = options.maxEntriesPerBatch ?? 1000;
    const maxBatches = options.maxBatches ?? 32;
    if (!Number.isInteger(maxEntriesPerBatch) || maxEntriesPerBatch < 1 ||
      maxEntriesPerBatch > 1000 || !Number.isInteger(maxBatches) ||
      maxBatches < 1 || maxBatches > 32) {
      throw new ObservabilityStorageError('INVALID_PAYLOAD_RECOVERY_SCAN_LIMIT');
    }
    return { maxEntriesPerBatch, maxBatches };
  }
}
