import {
  RuntimePayloadQuotaLedgerEntity as Ledger, RuntimePayloadQuotaReservationEntity as Reservation,
  RuntimePipelineStateEntity,
} from '../../database/entities/runtime-call-observability.entity';
import { CallObservabilityStore } from './call-observability.store';
import { CallObservabilityPayloadStore } from './call-observability-payload.store';
import { PAYLOAD_OWNER_ID } from './call-observability-payload.coordinator';
import { PayloadQuotaPrimitives } from './call-observability-payload-quota';
import { canonicalJson, contentHash, ObservabilityStorageError, publicSequence } from './call-observability-storage';

type HoldStatus = 'held' | 'already_held' | 'blocked' | 'busy' | 'unavailable';
type HoldReason = 'writer_active' | 'gc_active' | 'storage_unavailable' |
  'reservation_missing' | 'reservation_invalid' | 'scope_mismatch' |
  'ledger_not_ready' | 'ledger_under_reserved' | 'inconsistent_state';

export interface PayloadRecoveryHoldResult {
  status: HoldStatus;
  reservationId: string;
  ownerId: string | null;
  epoch: string | null;
  generation: string | null;
  reservedBytes: string | null;
  quotaEnforced: false;
  reason?: HoldReason;
}

const blocked = (reservationId: string, reason: HoldReason,
  ownerId: string | null = null, epoch: string | null = null,
  generation: string | null = null): PayloadRecoveryHoldResult => ({
  status: reason === 'storage_unavailable' ? 'unavailable' :
    reason === 'writer_active' || reason === 'gc_active' ? 'busy' : 'blocked',
  reservationId, ownerId, epoch, generation, reservedBytes: null,
  quotaEnforced: false, reason,
});

/** C2C2A only: conservatively hold one verified publication reservation.
 * There is no durable reservation-to-object mapping, so this never confirms
 * absence, credits a file, releases bytes, or declares global quota active. */
export class PayloadRecoveryHoldService {
  constructor(private readonly store: CallObservabilityStore,
    private readonly payloads: CallObservabilityPayloadStore) {}

  async hold(reservationId: string): Promise<PayloadRecoveryHoldResult> {
    if (typeof reservationId !== 'string' || !/^[a-f0-9]{64}$/.test(reservationId)) {
      throw new ObservabilityStorageError('INVALID_PAYLOAD_RECOVERY_RESERVATION_ID');
    }
    let ownerId: string;
    try {
      const binding = await this.store.readSnapshot(tx => tx.manager.getRepository(RuntimePipelineStateEntity)
        .findOneBy({ id: PAYLOAD_OWNER_ID }));
      const storedOwner = binding?.value?.ownerId;
      if (typeof storedOwner !== 'string') return blocked(reservationId, 'storage_unavailable');
      await this.payloads.bindExistingOwner(storedOwner);
      ownerId = storedOwner;
    } catch {
      return blocked(reservationId, 'storage_unavailable');
    }
    const held = await this.store.payloadCoordination.withInventoryFence(async fence =>
      this.store.transaction(async tx => {
        await fence.assertInTransaction(tx);
        if (fence.lease.ownerId !== ownerId) {
          return blocked(reservationId, 'scope_mismatch', ownerId);
        }
        const ledger = await tx.manager.getRepository(Ledger).findOneBy({ ownerId });
        const quota = new PayloadQuotaPrimitives();
        const state = await quota.status({ manager: tx.manager, now: tx.now,
          snapshotSeq: publicSequence(tx.currentSequence()) }); // validates ledger amounts/configuration
        if (!ledger || !state || ledger.epoch !== state.epoch || !state.configuration.enabled ||
          ledger.baselineKey === null || !['ready', 'limited', 'degraded'].includes(ledger.state)) {
          return blocked(reservationId, 'ledger_not_ready', ownerId, ledger?.epoch ?? null,
            fence.lease.generation);
        }
        const reservation = await tx.manager.getRepository(Reservation).findOneBy({ id: reservationId });
        if (!reservation) return blocked(reservationId, 'reservation_missing',
          ownerId, ledger.epoch, fence.lease.generation);
        if (reservation.ownerId !== ownerId || reservation.epoch !== ledger.epoch ||
          reservation.generation !== fence.lease.generation) {
          return blocked(reservationId, 'scope_mismatch', ownerId, ledger.epoch,
            fence.lease.generation);
        }
        const reserved = Number(reservation.reservedBytes);
        const valid = /^publish:[a-f0-9]{64}$/.test(reservation.operationId) &&
          Number.isSafeInteger(reserved) && reserved > 0 && reserved % 2 === 0 &&
          reserved <= state.configuration.maxBodyBytes * 2 &&
          reservation.id === contentHash(canonicalJson([ownerId, reservation.operationId])) &&
          reservation.requestHash === contentHash(canonicalJson([
            'reserve', ownerId, ledger.epoch, reservation.operationId, reserved,
          ])) &&
          reservation.committedBytes === null && reservation.settlementHash === null &&
          ['reserved', 'uncertain'].includes(reservation.state);
        if (!valid) return blocked(reservationId, 'reservation_invalid',
          ownerId, ledger.epoch, fence.lease.generation);
        if (BigInt(ledger.reservedBytes) < BigInt(reservation.reservedBytes)) {
          return blocked(reservationId, 'ledger_under_reserved',
            ownerId, ledger.epoch, fence.lease.generation);
        }
        if (reservation.state === 'uncertain') {
          if (ledger.state !== 'degraded') return blocked(reservationId, 'inconsistent_state',
            ownerId, ledger.epoch, fence.lease.generation);
          await fence.assertInTransaction(tx);
          return { status: 'already_held' as const, reservationId, ownerId, epoch: ledger.epoch,
            generation: fence.lease.generation, reservedBytes: reservation.reservedBytes,
            quotaEnforced: false as const };
        }
        await quota.settle(tx, ledger.epoch, reservation.operationId, { reason: 'unknown' });
        await fence.assertInTransaction(tx);
        const afterLedger = await tx.manager.getRepository(Ledger).findOneByOrFail({ ownerId });
        const afterReservation = await tx.manager.getRepository(Reservation).findOneByOrFail({ id: reservationId });
        if (afterLedger.reservedBytes !== ledger.reservedBytes || afterLedger.committedBytes !== ledger.committedBytes ||
          afterLedger.state !== 'degraded' || afterReservation.state !== 'uncertain' ||
          afterReservation.reservedBytes !== reservation.reservedBytes ||
          afterReservation.committedBytes !== null) {
          throw new ObservabilityStorageError('PAYLOAD_RECOVERY_HOLD_INVARIANT');
        }
        return { status: 'held' as const, reservationId, ownerId, epoch: ledger.epoch,
          generation: fence.lease.generation, reservedBytes: reservation.reservedBytes,
          quotaEnforced: false as const };
      }));
    if (held.status === 'busy') return blocked(reservationId, held.reason, ownerId);
    return held.result;
  }
}