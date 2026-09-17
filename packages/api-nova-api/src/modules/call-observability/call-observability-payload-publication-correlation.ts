import {
  RuntimeIngestReceiptEntity as Receipt, RuntimeInvocationEntity as Invocation,
  RuntimeInvocationRevisionEntity as Revision, RuntimePayloadEntity as Payload,
  RuntimePayloadPublicationIntentEntity as Intent, RuntimePayloadQuotaLedgerEntity as Ledger,
  RuntimePayloadQuotaReservationEntity as Reservation, RuntimePipelineStateEntity,
} from '../../database/entities/runtime-call-observability.entity';
import { CallObservabilityStore, ObservabilityReadTransaction, ObservabilityWriteTransaction } from './call-observability.store';
import { CallObservabilityPayloadStore } from './call-observability-payload.store';
import { PAYLOAD_OWNER_ID, PayloadInventoryFenceSession } from './call-observability-payload.coordinator';
import { PayloadPublicationIntentStore } from './call-observability-payload-publication-intent';
import { PayloadQuotaPrimitives } from './call-observability-payload-quota';
import { canonicalJson, contentHash, ObservabilityStorageError, publicSequence } from './call-observability-storage';

const SHA256 = /^[a-f0-9]{64}$/;
type BlockReason = 'scope_mismatch' | 'ledger_not_ready' | 'reservation_missing' |
  'intent_missing_or_invalid' | 'receipt_missing_or_invalid' | 'revision_missing_or_conflict' |
  'payload_metadata_missing_or_invalid' | 'evidence_unreadable';
export type PayloadPublicationCorrelation =
  | { status: 'linked_unverified'; reservationId: string; ownerId: string; epoch: string;
      generation: string; payloadId: string; fileKey: string; temporaryKey: string;
      digest: string; storedBytes: number; ledgerVersion: number; ledgerState: string;
      ledgerReservedBytes: string; ledgerCommittedBytes: string; reservationState: string;
      reservationUpdatedAt: string; quotaEnforced: false; }
  | { status: 'blocked' | 'busy' | 'unavailable'; reservationId: string;
      reason: BlockReason | 'writer_active' | 'gc_active' | 'storage_unavailable'; quotaEnforced: false; };

/** C1: correlate durable database evidence under the writer/GC fence.
 * No filesystem bytes are verified here. A linked result is not settlement
 * authority; C2 must revalidate everything, inspect the full managed root,
 * and commit only while the same fence is still held. */
export class PayloadPublicationCorrelationService {
  private readonly intents = new PayloadPublicationIntentStore();
  private readonly quota = new PayloadQuotaPrimitives();

  constructor(private readonly store: CallObservabilityStore,
    private readonly payloads: CallObservabilityPayloadStore) {}

  async inspect(reservationId: string): Promise<PayloadPublicationCorrelation> {
    if (!SHA256.test(reservationId || '')) {
      throw new ObservabilityStorageError('INVALID_PAYLOAD_RECOVERY_RESERVATION_ID');
    }
    let held;
    try {
      held = await this.store.payloadCoordination.withInventoryFence(fence =>
        this.inspectWithinFence(fence, reservationId));
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

  /** Reusable only while this exact inventory session is live. Its result still
   * contains no filesystem evidence and cannot authorize settlement. */
  async inspectWithinFence(fence: PayloadInventoryFenceSession,
    reservationId: string): Promise<PayloadPublicationCorrelation> {
    if (!SHA256.test(reservationId || '')) {
      throw new ObservabilityStorageError('INVALID_PAYLOAD_RECOVERY_RESERVATION_ID');
    }
    const blocked = (reason: BlockReason): PayloadPublicationCorrelation =>
      ({ status: 'blocked', reservationId, reason, quotaEnforced: false });
    let ownerId: string;
    try {
      const binding = await this.store.readSnapshot(tx => tx.manager
        .getRepository(RuntimePipelineStateEntity).findOneBy({ id: PAYLOAD_OWNER_ID }));
      const storedOwner = binding?.value?.ownerId;
      if (typeof storedOwner !== 'string') return { status: 'unavailable', reservationId,
        reason: 'storage_unavailable', quotaEnforced: false };
      await this.payloads.bindExistingOwner(storedOwner);
      ownerId = storedOwner;
    } catch {
      return { status: 'unavailable', reservationId,
        reason: 'storage_unavailable', quotaEnforced: false };
    }
    if (ownerId !== fence.lease.ownerId) return blocked('scope_mismatch');
    await fence.check();
    try {
      const result = await this.store.readSnapshot(tx =>
        this.inspectInTransaction(fence, tx, reservationId));
      await fence.check();
      return result;
    } catch (error) {
      if (error instanceof ObservabilityStorageError &&
        error.code === 'PAYLOAD_INVENTORY_FENCE_LOST') throw error;
      return blocked('evidence_unreadable');
    }
  }

  /** Read only. The caller must already hold and assert this exact fence;
   * C2B calls it again inside the final write transaction. */
  async inspectInTransaction(fence: PayloadInventoryFenceSession,
    tx: ObservabilityReadTransaction | ObservabilityWriteTransaction,
    reservationId: string): Promise<PayloadPublicationCorrelation> {
    const ownerId = fence.lease.ownerId;
    const blocked = (reason: BlockReason): PayloadPublicationCorrelation =>
      ({ status: 'blocked', reservationId, reason, quotaEnforced: false });
    const binding = await tx.manager.getRepository(RuntimePipelineStateEntity)
      .findOneBy({ id: PAYLOAD_OWNER_ID });
    if (binding?.value?.ownerId !== ownerId) return blocked('scope_mismatch');
    const ledger = await tx.manager.getRepository(Ledger).findOneBy({ ownerId });
    const status = await this.quota.status({ manager: tx.manager, now: tx.now,
      snapshotSeq: 'snapshotSeq' in tx ? tx.snapshotSeq : publicSequence(tx.currentSequence()) });
    if (!ledger || !status || ledger.epoch !== status.epoch ||
      status.configuration.enabled !== true || ledger.baselineKey === null ||
      !['ready', 'limited', 'degraded'].includes(ledger.state)) return blocked('ledger_not_ready');
    const reservation = await tx.manager.getRepository(Reservation).findOneBy({ id: reservationId });
    if (!reservation) return blocked('reservation_missing');
    if (reservation.ownerId !== ownerId || reservation.epoch !== ledger.epoch ||
      reservation.generation !== fence.lease.generation) return blocked('scope_mismatch');
    if (!['reserved', 'uncertain'].includes(reservation.state) ||
      reservation.state === 'uncertain' && ledger.state !== 'degraded' ||
      BigInt(ledger.reservedBytes) < BigInt(reservation.reservedBytes)) return blocked('ledger_not_ready');
    const intent = await this.intents.load(tx, reservationId);
    if (!intent) return blocked('intent_missing_or_invalid');
    const receiptId = contentHash(canonicalJson([intent.sourceInstanceId, intent.sourceEventId]));
    const receipt = await tx.manager.getRepository(Receipt).findOneBy({ id: receiptId });
    if (!receipt || receipt.sourceInstanceId !== intent.sourceInstanceId ||
      receipt.eventId !== intent.sourceEventId || !SHA256.test(receipt.recordHash) ||
      typeof receipt.invocationId !== 'string' || !receipt.invocationId) {
      return blocked('receipt_missing_or_invalid');
    }
    const payload = await tx.manager.getRepository(Payload).findOneBy({ id: intent.payloadId });
    if (!this.payloadMatches(payload, intent, receipt.invocationId)) {
      return blocked('payload_metadata_missing_or_invalid');
    }
    const current = await tx.manager.getRepository(Invocation)
      .findOneBy({ invocationId: receipt.invocationId });
    const historical = await tx.manager.getRepository(Revision).find({
      where: { invocationId: receipt.invocationId, recordHash: receipt.recordHash }, take: 2,
    });
    // A current row and its historical copy may both represent the event.
    // Every row with the receipt hash must agree; a conflicting copy is
    // evidence corruption, even when another copy looks valid.
    const relevant = [current, ...historical].filter(row => row?.recordHash === receipt.recordHash);
    if (historical.length > 1 || relevant.length === 0 ||
      relevant.some(row => !this.revisionMatches(row, intent, receipt, payload!))) {
      return blocked('revision_missing_or_conflict');
    }
    return { status: 'linked_unverified' as const, reservationId, ownerId,
      epoch: ledger.epoch, generation: fence.lease.generation,
      payloadId: intent.payloadId, fileKey: intent.fileKey,
      temporaryKey: intent.temporaryKey, digest: intent.digest,
      storedBytes: Number(intent.storedBytes), ledgerVersion: ledger.version,
      ledgerState: ledger.state, ledgerReservedBytes: ledger.reservedBytes,
      ledgerCommittedBytes: ledger.committedBytes, reservationState: reservation.state,
      reservationUpdatedAt: reservation.updatedAt, quotaEnforced: false as const };
  }

  private payloadMatches(row: Payload | null, intent: Intent, invocationId: string): boolean {
    if (!row || row.invocationId !== invocationId ||
      !['request', 'response'].includes(row.side) ||
      !['captured', 'incomplete'].includes(row.state) ||
      row.fileKey !== intent.fileKey || row.digest !== intent.digest ||
      !row.metadata || typeof row.metadata !== 'object' || Array.isArray(row.metadata) ||
      'data' in row.metadata || row.metadata.storedBytes !== Number(intent.storedBytes) ||
      row.metadata.state !== row.state || row.metadata.reason !== row.reason) return false;
    const expected = contentHash(canonicalJson({
      sourceInstanceId: intent.sourceInstanceId, invocationId, side: row.side,
      storageOwnerId: intent.ownerId, storageGeneration: intent.generation,
      metadata: row.metadata, digest: intent.digest,
    }));
    return row.id === expected && row.id === intent.payloadId;
  }

  private revisionMatches(row: Invocation | Revision | null, intent: Intent,
    receipt: Receipt, payload: Payload): boolean {
    if (!row || row.invocationId !== receipt.invocationId ||
      row.sourceInstanceId !== intent.sourceInstanceId ||
      row.recordHash !== receipt.recordHash ||
      row.record?.sourceEventId !== intent.sourceEventId ||
      row.record?.sourceInstanceId !== intent.sourceInstanceId) return false;
    const sideId = payload.side === 'request' ? row.requestPayloadId : row.responsePayloadId;
    const sideBody = payload.side === 'request' ? row.record?.request : row.record?.response;
    return sideId === intent.payloadId && canonicalJson(sideBody) === canonicalJson(payload.metadata);
  }
}
