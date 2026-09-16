import { In } from 'typeorm';
import {
  RuntimeInvocationEntity, RuntimeInvocationRevisionEntity, RuntimePayloadEntity, RuntimePipelineStateEntity,
  RuntimePayloadQuotaLedgerEntity as Ledger, RuntimePayloadQuotaReservationEntity as Reservation,
} from '../../database/entities/runtime-call-observability.entity';
import { CallObservabilityStore } from './call-observability.store';
import { CallObservabilityPayloadStore, PayloadRecoveryPath, PayloadRecoveryPathScan } from './call-observability-payload.store';
import { ObservabilityStorageError } from './call-observability-storage';
import { PayloadQuotaPrimitives } from './call-observability-payload-quota';
import { PAYLOAD_OWNER_ID } from './call-observability-payload.coordinator';

const fail = (code: string): never => { throw new ObservabilityStorageError(code); };
const AMOUNT = /^(0|[1-9][0-9]{0,19})$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface RecoveryReservationEvidence {
  id: string;
  state: string;
  reservedBytes: string | null;
  scope: 'current' | 'prior_generation' | 'other_epoch' | 'invalid';
  occupancy: 'unknown' | 'settled_history';
}
export interface RecoveryFileEvidence extends PayloadRecoveryPath {
  classification: 'metadata_match_unverified' | 'metadata_orphan_candidate' | 'orphan_candidate' |
    'temporary_unknown' | 'unknown';
  referencePresent: boolean | null;
}
export interface PayloadRecoveryEvidenceReport {
  status: 'observed' | 'busy' | 'unavailable';
  ownerId: string | null;
  generation: string | null;
  epoch: string | null;
  quotaEnforced: false;
  traversal: 'complete' | 'partial' | 'unknown';
  unknownOccupancy: boolean;
  measurement: 'observed_paths_only';
  observedBytes: number | null;
  totalOccupancyBytes: null;
  scannedEntries: number;
  files: RecoveryFileEvidence[];
  reservations: RecoveryReservationEvidence[];
  reservationsHasMore: boolean;
  reservationObjectCorrelation: 'unavailable';
  reason?: 'writer_active' | 'gc_active' | 'storage_unavailable';
}

/** Internal read-only evidence only. File IDs cannot be correlated to publish
 * reservations: operationId is a one-way hash. No finding authorizes release
 * of budget, deletion, or a claim that quota enforcement is global. */
export class PayloadRecoveryEvidenceService {
  constructor(private readonly store: CallObservabilityStore,
    private readonly payloads: CallObservabilityPayloadStore) {}

  async inspect(options: { maxEntriesPerBatch?: number; maxBatches?: number; maxReservations?: number } = {})
    : Promise<PayloadRecoveryEvidenceReport> {
    const maxEntries = options.maxEntriesPerBatch ?? 1000;
    const maxBatches = options.maxBatches ?? 8;
    const maxReservations = options.maxReservations ?? 100;
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 1000 ||
      !Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 32 ||
      !Number.isInteger(maxReservations) || maxReservations < 1 || maxReservations > 1000) {
      return fail('INVALID_PAYLOAD_RECOVERY_SCAN_LIMIT');
    }
    // Evidence lookup must never initialize a database owner or create a root marker.
    let boundOwner: string;
    try {
      const row = await this.store.readSnapshot(tx => tx.manager.getRepository(RuntimePipelineStateEntity)
        .findOneBy({ id: PAYLOAD_OWNER_ID }));
      const ownerId = row?.value?.ownerId;
      if (typeof ownerId !== 'string') return this.unavailable();
      await this.payloads.bindExistingOwner(ownerId);
      boundOwner = ownerId;
    } catch {
      return this.unavailable();
    }
    const held = await this.store.payloadCoordination.withInventoryFence(async fence => {
      if (boundOwner !== fence.lease.ownerId) return fail('PAYLOAD_RECOVERY_SCOPE_MISMATCH');
      await fence.check();
      let ledger: Ledger | null = null;
      let reservationRows: Reservation[] = [];
      let reservationReadFailed = false;
      try {
        const snapshot = await this.store.readSnapshot(async tx => {
          const ledger = await tx.manager.getRepository(Ledger).findOneBy({ ownerId: boundOwner });
          // Validate persisted ledger shape before any report can claim known occupancy.
          await new PayloadQuotaPrimitives().status(tx);
          const reservations = await tx.manager.getRepository(Reservation)
            .createQueryBuilder('reservation').where('reservation.ownerId = :ownerId', { ownerId: boundOwner })
            .orderBy('reservation.id', 'ASC').take(maxReservations + 1).getMany();
          return { ledger, reservations };
        });
        ledger = snapshot.ledger;
        reservationRows = snapshot.reservations;
      } catch {
        reservationReadFailed = true;
      }
      await fence.check();
      const reservationsHasMore = reservationReadFailed || reservationRows.length > maxReservations;
      const reservations: RecoveryReservationEvidence[] = reservationRows.slice(0, maxReservations).map(row => {
        const valid = row.ownerId === boundOwner && SHA256.test(row.id) && SHA256.test(row.requestHash) &&
          typeof row.operationId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(row.operationId) &&
          AMOUNT.test(row.reservedBytes) && BigInt(row.reservedBytes) <= BigInt(Number.MAX_SAFE_INTEGER) &&
          ['reserved', 'uncertain', 'settled'].includes(row.state) &&
          /^(0|[1-9][0-9]{0,19})$/.test(row.generation) &&
          /^[a-f0-9-]{36}$/.test(row.epoch) &&
          (row.state === 'settled' ? AMOUNT.test(row.committedBytes || '') &&
            BigInt(row.committedBytes!) <= BigInt(row.reservedBytes) &&
            SHA256.test(row.settlementHash || '') : row.committedBytes === null && row.settlementHash === null);
        const scope: RecoveryReservationEvidence['scope'] = !valid ? 'invalid' :
          row.epoch !== ledger?.epoch ? 'other_epoch' :
          row.generation !== fence.lease.generation ? 'prior_generation' : 'current';
        return { id: row.id, state: row.state, reservedBytes: valid ? row.reservedBytes : null, scope,
          occupancy: valid && scope === 'current' && row.state === 'settled' ? 'settled_history' : 'unknown' };
      });
      let scan: PayloadRecoveryPathScan | null = null;
      try {
        scan = await this.payloads.scanRecoveryPaths(maxEntries, maxBatches, () => fence.check());
      } catch (error) {
        if (error instanceof ObservabilityStorageError &&
          ['PAYLOAD_INVENTORY_FENCE_LOST', 'PAYLOAD_ROOT_OWNER_MISMATCH'].includes(error.code)) throw error;
        // A filesystem inspection failure is unknown evidence, never zero occupancy.
      }
      await fence.check();
      const finalIds = [...new Set((scan?.paths ?? []).filter(path => path.kind === 'final').map(path => path.id!))];
      const metadata = new Map<string, RuntimePayloadEntity>();
      const references = new Set<string>();
      let metadataReadFailed = false;
      try {
        for (let index = 0; index < finalIds.length; index += 400) {
          const ids = finalIds.slice(index, index + 400);
          const found = await this.store.readSnapshot(async tx => {
            const metadata = await tx.manager.getRepository(RuntimePayloadEntity).findBy({ id: In(ids) });
            const current = await tx.manager.getRepository(RuntimeInvocationEntity).find({
              select: { requestPayloadId: true, responsePayloadId: true },
              where: [{ requestPayloadId: In(ids) }, { responsePayloadId: In(ids) }],
              take: 401,
            });
            const historical = await tx.manager.getRepository(RuntimeInvocationRevisionEntity).find({
              select: { requestPayloadId: true, responsePayloadId: true },
              where: [{ requestPayloadId: In(ids) }, { responsePayloadId: In(ids) }],
              take: 401,
            });
            return { metadata, current, historical };
          });
          // More than 400 references in either table leaves the chunk unproven.
          if (found.current.length > 400 || found.historical.length > 400) {
            metadataReadFailed = true;
            break;
          }
          for (const row of found.metadata) metadata.set(row.id, row);
          for (const row of [...found.current, ...found.historical]) {
            if (row.requestPayloadId) references.add(row.requestPayloadId);
            if (row.responsePayloadId) references.add(row.responsePayloadId);
          }
          await fence.check();
        }
      } catch {
        metadataReadFailed = true;
      }
      const files: RecoveryFileEvidence[] = (scan?.paths ?? []).map(path => {
        if (path.kind === 'unknown') return { ...path, classification: 'unknown', referencePresent: null };
        if (path.kind === 'temporary') return { ...path, classification: 'temporary_unknown', referencePresent: null };
        if (metadataReadFailed) return { ...path, classification: 'unknown', referencePresent: null };
        const row = metadata.get(path.id!);
        const referencePresent = references.has(path.id!);
        if (!row) return { ...path, classification: referencePresent ? 'unknown' : 'orphan_candidate',
          referencePresent };
        const valid = row.fileKey === path.key && ['captured', 'incomplete'].includes(row.state) &&
          SHA256.test(row.digest || '') && row.metadata?.storedBytes === path.sizeBytes;
        return { ...path, classification: !valid ? 'unknown' :
          referencePresent ? 'metadata_match_unverified' : 'metadata_orphan_candidate', referencePresent };
      });
      const unknownOccupancy = !scan || scan.unknownOccupancy || reservationReadFailed || metadataReadFailed ||
        !ledger || reservationsHasMore || reservations.some(row => row.occupancy === 'unknown') ||
        files.some(row => row.classification !== 'metadata_match_unverified');
      return { status: 'observed' as const, ownerId: boundOwner, generation: fence.lease.generation,
        epoch: ledger?.epoch ?? null, quotaEnforced: false as const,
        traversal: !scan ? 'unknown' as const : scan.traversal === 'partial' ? 'partial' as const :
          unknownOccupancy ? 'unknown' as const : 'complete' as const,
        unknownOccupancy, measurement: 'observed_paths_only' as const,
        observedBytes: scan?.measuredBytes ?? null, totalOccupancyBytes: null,
        scannedEntries: scan?.scannedEntries ?? 0,
        files, reservations, reservationsHasMore, reservationObjectCorrelation: 'unavailable' as const };
    });
    if (held.status === 'busy') return { status: 'busy', ownerId: null, generation: null,
      epoch: null, quotaEnforced: false, traversal: 'unknown', unknownOccupancy: true,
      measurement: 'observed_paths_only', observedBytes: null, totalOccupancyBytes: null,
      scannedEntries: 0, files: [], reservations: [],
      reservationsHasMore: true, reservationObjectCorrelation: 'unavailable', reason: held.reason };
    return held.result;
  }

  private unavailable(): PayloadRecoveryEvidenceReport {
    return { status: 'unavailable', ownerId: null, generation: null, epoch: null,
      quotaEnforced: false, traversal: 'unknown', unknownOccupancy: true,
      measurement: 'observed_paths_only', observedBytes: null, totalOccupancyBytes: null,
      scannedEntries: 0, files: [], reservations: [], reservationsHasMore: true,
      reservationObjectCorrelation: 'unavailable', reason: 'storage_unavailable' };
  }
}