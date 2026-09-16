import {
  RuntimePayloadPublicationIntentEntity as Intent, RuntimePayloadQuotaReservationEntity as Reservation,
  RuntimePipelineStateEntity,
} from '../../database/entities/runtime-call-observability.entity';
import { ObservabilityReadTransaction, ObservabilityWriteTransaction } from './call-observability.store';
import { PAYLOAD_COORDINATION_ID, PAYLOAD_OWNER_ID } from './call-observability-payload.coordinator';
import { PayloadQuotaPrimitives } from './call-observability-payload-quota';
import { canonicalJson, contentHash, ObservabilityStorageError, publicSequence } from './call-observability-storage';
import { randomUUID } from 'crypto';

const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail = (code: string): never => { throw new ObservabilityStorageError(code); };

export interface PayloadPublicationIntentInput {
  sourceInstanceId: string;
  sourceEventId: string;
  payloadId: string;
  generation: string;
  fileKey: string;
  digest: string;
  storedBytes: number;
}

export interface PayloadPublicationReservation {
  reservationId: string;
  operationId: string;
  temporaryKey: string;
  replayed: boolean;
  reservationState: string;
}

/** B1 database primitive; no runtime caller is wired to it yet.
 * Insert is coupled to a genuinely new reservation in the caller's Store
 * transaction. A legacy reservation without an intent can never be backfilled. */
export class PayloadPublicationIntentStore {
  private async owner(tx: ObservabilityReadTransaction | ObservabilityWriteTransaction): Promise<string> {
    const binding = await tx.manager.getRepository(RuntimePipelineStateEntity)
      .findOneBy({ id: PAYLOAD_OWNER_ID });
    const ownerId = binding?.value?.ownerId;
    if (typeof ownerId !== 'string' || !UUID.test(ownerId)) return fail('PAYLOAD_STORAGE_NOT_BOUND');
    return ownerId;
  }

  private validate(input: PayloadPublicationIntentInput): void {
    if (!input || typeof input.sourceInstanceId !== 'string' ||
      input.sourceInstanceId.length < 1 || input.sourceInstanceId.length > 500 ||
      typeof input.sourceEventId !== 'string' || input.sourceEventId.length < 1 ||
      input.sourceEventId.length > 500 || !SHA256.test(input.payloadId) ||
      !/^(0|[1-9][0-9]{0,19})$/.test(input.generation) ||
      input.fileKey !== input.payloadId.slice(0, 2) + '/' + input.payloadId + '.body' ||
      !SHA256.test(input.digest) || !Number.isSafeInteger(input.storedBytes) ||
      input.storedBytes < 1 || input.storedBytes > Number.MAX_SAFE_INTEGER / 2) {
      fail('INVALID_PAYLOAD_PUBLICATION_INTENT');
    }
  }

  private hash(row: Intent): string {
    return contentHash(canonicalJson(['publication_intent_v1', row.reservationId,
      row.ownerId, row.epoch, row.generation, row.sourceInstanceId, row.sourceEventId,
      row.payloadId, row.fileKey, row.temporaryKey, row.digest, row.storedBytes, row.createdAt]));
  }

  /** Only use inside Store.transaction. No file may be opened before it commits. */
  async reserve(tx: ObservabilityWriteTransaction, epoch: string,
    input: PayloadPublicationIntentInput): Promise<PayloadPublicationReservation> {
    this.validate(input);
    const ownerId = await this.owner(tx);
    const coordination = await tx.manager.getRepository(RuntimePipelineStateEntity)
      .findOneBy({ id: PAYLOAD_COORDINATION_ID });
    const generation = publicSequence(coordination?.value?.generation ?? '0');
    if (generation !== input.generation) return fail('PAYLOAD_PUBLICATION_INTENT_SCOPE_MISMATCH');
    const operationId = 'publish:' + contentHash(canonicalJson([
      input.sourceInstanceId, input.sourceEventId, input.payloadId, generation,
    ]));
    const reservationId = contentHash(canonicalJson([ownerId, operationId]));
    const result = await new PayloadQuotaPrimitives().reserve(tx, epoch, operationId,
      input.storedBytes * 2);
    if (result.replayed) {
      const existing = await this.load(tx, reservationId);
      if (!existing || existing.ownerId !== ownerId || existing.epoch !== epoch ||
        existing.generation !== generation || existing.sourceInstanceId !== input.sourceInstanceId ||
        existing.sourceEventId !== input.sourceEventId || existing.payloadId !== input.payloadId ||
        existing.fileKey !== input.fileKey || existing.digest !== input.digest ||
        existing.storedBytes !== String(input.storedBytes)) {
        return fail('PAYLOAD_PUBLICATION_INTENT_MISSING_OR_CONFLICT');
      }
      // Expose the original path even while quota remains held. A later caller must
      // decide whether resuming publication is safe; replay never settles quota here.
      return { reservationId, operationId, temporaryKey: existing.temporaryKey,
        replayed: true, reservationState: result.reservationState };
    }
    const row = tx.manager.getRepository(Intent).create({
      reservationId, ownerId, epoch, generation,
      sourceInstanceId: input.sourceInstanceId, sourceEventId: input.sourceEventId,
      payloadId: input.payloadId, fileKey: input.fileKey,
      temporaryKey: input.fileKey + '.' + randomUUID() + '.tmp',
      digest: input.digest, storedBytes: String(input.storedBytes),
      createdAt: tx.now,
    });
    row.intentHash = this.hash(row);
    await tx.manager.getRepository(Intent).insert(row);
    return { reservationId, operationId, temporaryKey: row.temporaryKey,
      replayed: false, reservationState: result.reservationState };
  }

  /** A missing row is legacy/unknown, never an invitation to infer or insert it. */
  async load(tx: ObservabilityReadTransaction | ObservabilityWriteTransaction,
    reservationId: string): Promise<Intent | null> {
    if (typeof reservationId !== 'string' || !SHA256.test(reservationId)) {
      return fail('INVALID_PAYLOAD_PUBLICATION_INTENT');
    }
    const row = await tx.manager.getRepository(Intent).findOneBy({ reservationId });
    if (!row) return null;
    const reservation = await tx.manager.getRepository(Reservation).findOneBy({ id: reservationId });
    const storedBytes = Number(row.storedBytes);
    const tempPrefix = row.fileKey + '.';
    const tempUuid = typeof row.temporaryKey === 'string' &&
      row.temporaryKey.startsWith(tempPrefix) && row.temporaryKey.endsWith('.tmp')
      ? row.temporaryKey.slice(tempPrefix.length, -4) : '';
    const settled = reservation?.state === 'settled';
    const settlementValid = settled
      ? /^(0|[1-9][0-9]{0,19})$/.test(reservation.committedBytes || '') &&
        Number(reservation.committedBytes) <= Number(reservation.reservedBytes) &&
        SHA256.test(reservation.settlementHash || '')
      : reservation?.committedBytes === null && reservation?.settlementHash === null;
    if (!reservation || row.ownerId !== await this.owner(tx) ||
      row.ownerId !== reservation.ownerId || row.epoch !== reservation.epoch ||
      row.generation !== reservation.generation ||
      reservation.operationId !== 'publish:' + contentHash(canonicalJson([
        row.sourceInstanceId, row.sourceEventId, row.payloadId, row.generation,
      ])) ||
      row.reservationId !== contentHash(canonicalJson([row.ownerId, reservation.operationId])) ||
      reservation.requestHash !== contentHash(canonicalJson([
        'reserve', row.ownerId, row.epoch, reservation.operationId, storedBytes * 2,
      ])) ||
      !UUID.test(row.ownerId) || !UUID.test(row.epoch) ||
      !/^(0|[1-9][0-9]{0,19})$/.test(row.generation) ||
      typeof row.sourceInstanceId !== 'string' || row.sourceInstanceId.length < 1 ||
      row.sourceInstanceId.length > 500 || typeof row.sourceEventId !== 'string' ||
      row.sourceEventId.length < 1 || row.sourceEventId.length > 500 ||
      !SHA256.test(row.payloadId) || !SHA256.test(row.digest) ||
      !Number.isSafeInteger(storedBytes) || storedBytes < 1 ||
      storedBytes > Number.MAX_SAFE_INTEGER / 2 ||
      reservation.reservedBytes !== String(storedBytes * 2) ||
      !['reserved', 'uncertain', 'settled'].includes(reservation.state) || !settlementValid ||
      row.fileKey !== row.payloadId.slice(0, 2) + '/' + row.payloadId + '.body' ||
      !UUID.test(tempUuid) || row.intentHash !== this.hash(row)) {
      return fail('INVALID_PAYLOAD_PUBLICATION_INTENT');
    }
    return row;
  }
}