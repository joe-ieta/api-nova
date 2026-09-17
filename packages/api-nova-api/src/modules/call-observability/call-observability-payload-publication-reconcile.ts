import { RuntimePayloadQuotaLedgerEntity as Ledger, RuntimePayloadQuotaReservationEntity as Reservation } from '../../database/entities/runtime-call-observability.entity';
import { CallObservabilityStore, ObservabilityWriteTransaction } from './call-observability.store';
import { CallObservabilityPayloadStore } from './call-observability-payload.store';
import { PayloadInventoryFenceSession } from './call-observability-payload.coordinator';
import { PayloadPublicationCorrelationService } from './call-observability-payload-publication-correlation';
import { PayloadPublicationFileProofService, payloadRecoveryScanHash } from './call-observability-payload-publication-file-proof';
import { PayloadQuotaPrimitives } from './call-observability-payload-quota';
import { PayloadRecoveryHoldService } from './call-observability-payload-recovery-hold';
import { canonicalJson, ObservabilityStorageError } from './call-observability-storage';

const SHA256 = /^[a-f0-9]{64}$/;
type Limits = { maxEntriesPerBatch: number; maxBatches: number };
type Proof = Extract<Awaited<ReturnType<PayloadPublicationFileProofService['inspectWithinFence']>>,
  { status: 'file_proof_uncommitted' }>;
export type PayloadPublicationReconcileResult =
  | { status: 'settled'; reservationId: string; ownerId: string; epoch: string;
      generation: string; committedBytes: number; quotaEnforced: false }
  | { status: 'blocked' | 'busy' | 'unavailable'; reservationId: string; reason: string;
      holdStatus: 'held' | 'already_held' | 'blocked' | 'busy' | 'unavailable' | 'failed' | null;
      quotaEnforced: false };

/** Positive credit is permitted only inside the inventory session that made
 * the bounded, complete file proof. This does not enable quota enforcement. */
export class PayloadPublicationReconcileService {
  private readonly files: PayloadPublicationFileProofService;
  private readonly correlation: PayloadPublicationCorrelationService;
  private readonly quota = new PayloadQuotaPrimitives();
  private readonly hold: PayloadRecoveryHoldService;

  constructor(private readonly store: CallObservabilityStore,
    private readonly payloads: CallObservabilityPayloadStore) {
    this.files = new PayloadPublicationFileProofService(store, payloads);
    this.correlation = new PayloadPublicationCorrelationService(store, payloads);
    this.hold = new PayloadRecoveryHoldService(store, payloads);
  }

  async reconcile(reservationId: string, options: Partial<Limits> = {})
    : Promise<PayloadPublicationReconcileResult> {
    if (!SHA256.test(reservationId || '')) {
      throw new ObservabilityStorageError('INVALID_PAYLOAD_RECOVERY_RESERVATION_ID');
    }
    const limits: Limits = { maxEntriesPerBatch: options.maxEntriesPerBatch ?? 1000,
      maxBatches: options.maxBatches ?? 32 };
    if (!Number.isInteger(limits.maxEntriesPerBatch) || limits.maxEntriesPerBatch < 1 ||
      limits.maxEntriesPerBatch > 1000 || !Number.isInteger(limits.maxBatches) ||
      limits.maxBatches < 1 || limits.maxBatches > 32) {
      throw new ObservabilityStorageError('INVALID_PAYLOAD_RECOVERY_SCAN_LIMIT');
    }
    let result: PayloadPublicationReconcileResult;
    try {
      const held = await this.store.payloadCoordination.withInventoryFence(async fence => {
        const proof = await this.files.inspectWithinFence(fence, reservationId, limits);
        if (proof.status !== 'file_proof_uncommitted') {
          return { status: proof.status, reservationId, reason: proof.reason,
            holdStatus: null, quotaEnforced: false } as PayloadPublicationReconcileResult;
        }
        return this.store.transaction(tx => this.commit(fence, tx, proof, limits));
      });
      result = held.status === 'busy'
        ? { status: 'busy', reservationId, reason: held.reason,
          holdStatus: null, quotaEnforced: false }
        : held.result;
    } catch (error) {
      result = { status: error instanceof ObservabilityStorageError &&
        error.code === 'PAYLOAD_STORAGE_NOT_BOUND' ? 'unavailable' : 'blocked',
        reservationId, reason: error instanceof ObservabilityStorageError ? error.code : 'transaction_failed',
        holdStatus: null, quotaEnforced: false };
    }
    if (result.status !== 'blocked') return result;
    // This separate conservative transaction never lowers the reservation.
    let holdStatus: 'held' | 'already_held' | 'blocked' | 'busy' | 'unavailable' | 'failed' = 'failed';
    try { holdStatus = (await this.hold.hold(reservationId)).status; } catch { /* preserve bytes */ }
    return { ...result, holdStatus };
  }

  private async commit(fence: PayloadInventoryFenceSession,
    tx: ObservabilityWriteTransaction, proof: Proof, limits: Limits)
    : Promise<PayloadPublicationReconcileResult> {
    const fail = (reason: string): never => { throw new ObservabilityStorageError(reason); };
    await fence.assertInTransaction(tx);
    const linked = await this.correlation.inspectInTransaction(fence, tx, proof.reservationId);
    const { status: _status, scannedEntries: _entries, scanHash: _scanHash,
      ...linkFields } = proof;
    if (linked.status !== 'linked_unverified' ||
      canonicalJson(linked) !== canonicalJson({ ...linkFields, status: 'linked_unverified' })) {
      return fail('PAYLOAD_RECOVERY_EVIDENCE_CHANGED');
    }
    const ledger = await tx.manager.getRepository(Ledger).findOneBy({ ownerId: proof.ownerId });
    const reservation = await tx.manager.getRepository(Reservation)
      .findOneBy({ id: proof.reservationId });
    if (!ledger || !reservation || ledger.version !== proof.ledgerVersion ||
      ledger.state !== proof.ledgerState || ledger.reservedBytes !== proof.ledgerReservedBytes ||
      ledger.committedBytes !== proof.ledgerCommittedBytes ||
      reservation.state !== proof.reservationState ||
      reservation.updatedAt !== proof.reservationUpdatedAt ||
      ledger.ownerId !== proof.ownerId || ledger.epoch !== proof.epoch ||
      reservation.ownerId !== proof.ownerId || reservation.epoch !== proof.epoch ||
      reservation.generation !== proof.generation ||
      reservation.reservedBytes !== String(proof.storedBytes * 2)) {
      return fail('PAYLOAD_RECOVERY_EVIDENCE_CHANGED');
    }
    const beforeVersion = ledger.version;
    const beforeReserved = BigInt(ledger.reservedBytes);
    const beforeCommitted = BigInt(ledger.committedBytes);
    const scan = await this.payloads.scanRecoveryPaths(limits.maxEntriesPerBatch,
      limits.maxBatches, () => fence.assertInTransaction(tx));
    if (scan.traversal !== 'complete' || scan.unknownOccupancy ||
      scan.paths.some(path => path.kind !== 'final') ||
      scan.scannedEntries !== proof.scannedEntries ||
      payloadRecoveryScanHash(scan) !== proof.scanHash) {
      return fail('PAYLOAD_RECOVERY_EVIDENCE_CHANGED');
    }
    await this.payloads.verifyRecoveryPublication(proof.fileKey, proof.temporaryKey,
      proof.digest, proof.storedBytes, () => fence.assertInTransaction(tx));
    await fence.assertInTransaction(tx);
    const settlement = await this.quota.settle(tx, proof.epoch, reservation.operationId,
      { reason: 'confirmed_occupancy_and_unused_absent', committedBytes: proof.storedBytes });
    if (settlement.replayed || settlement.reservationState !== 'settled') {
      return fail('PAYLOAD_RECOVERY_SETTLEMENT_INVARIANT');
    }
    const afterLedger = await tx.manager.getRepository(Ledger)
      .findOneBy({ ownerId: proof.ownerId });
    const afterReservation = await tx.manager.getRepository(Reservation)
      .findOneBy({ id: proof.reservationId });
    if (!afterLedger || !afterReservation ||
      BigInt(afterLedger.reservedBytes) !== beforeReserved - BigInt(reservation.reservedBytes) ||
      BigInt(afterLedger.committedBytes) !== beforeCommitted + BigInt(proof.storedBytes) ||
      afterLedger.version !== beforeVersion + 1 ||
      afterReservation.state !== 'settled' ||
      afterReservation.committedBytes !== String(proof.storedBytes) ||
      !SHA256.test(afterReservation.settlementHash || '')) {
      return fail('PAYLOAD_RECOVERY_SETTLEMENT_INVARIANT');
    }
    await this.payloads.verifyRecoveryPublication(proof.fileKey, proof.temporaryKey,
      proof.digest, proof.storedBytes, () => fence.assertInTransaction(tx));
    await fence.assertInTransaction(tx);
    return { status: 'settled', reservationId: proof.reservationId,
      ownerId: proof.ownerId, epoch: proof.epoch, generation: proof.generation,
      committedBytes: proof.storedBytes, quotaEnforced: false };
  }
}
