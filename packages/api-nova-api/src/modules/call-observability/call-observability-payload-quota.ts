import { randomUUID } from 'crypto';
import { RuntimePayloadQuotaLedgerEntity as Ledger, RuntimePayloadQuotaReservationEntity as Reservation,
  RuntimePipelineStateEntity } from '../../database/entities/runtime-call-observability.entity';
import { ObservabilityWriteTransaction, ObservabilityReadTransaction } from './call-observability.store';
import { PAYLOAD_OWNER_ID, PAYLOAD_COORDINATION_ID } from './call-observability-payload.coordinator';
import { canonicalJson, contentHash, ObservabilityStorageError, publicSequence } from './call-observability-storage';

const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const error = (code: string): never => { throw new ObservabilityStorageError(code); };
const integer = (value: unknown, minimum = 0): number => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))) return error('INVALID_QUOTA_CONFIGURATION');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) return error('INVALID_QUOTA_CONFIGURATION');
  return number;
};
const amount = (value: string): bigint => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) return error('INVALID_QUOTA_LEDGER');
  const n = BigInt(value); if (n > MAX) return error('INVALID_QUOTA_LEDGER'); return n;
};
const operation = (value: string): void => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) error('INVALID_QUOTA_OPERATION');
};
export interface PayloadQuotaConfiguration {
  enabled: boolean; quotaBytes: number | null; maxBodyBytes: number;
  highWatermarkBytes: number | null; lowWatermarkBytes: number | null;
  minimumFreeBytes: number; maxObservationAgeMs: number;
}
export function payloadQuotaConfiguration(raw: Record<string, unknown> = {}): PayloadQuotaConfiguration {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => ![
    'enabled', 'quotaBytes', 'maxBodyBytes', 'highWatermarkBytes', 'lowWatermarkBytes', 'minimumFreeBytes', 'maxObservationAgeMs',
  ].includes(key)) || (raw.enabled !== undefined && typeof raw.enabled !== 'boolean')) return error('INVALID_QUOTA_CONFIGURATION');
  const enabled = raw.enabled === true, maxBodyBytes = integer(raw.maxBodyBytes ?? 16 * 1024 * 1024, 1);
  if (maxBodyBytes > 64 * 1024 * 1024) return error('INVALID_QUOTA_CONFIGURATION');
  const quotaBytes = raw.quotaBytes == null && !enabled ? null : integer(raw.quotaBytes, maxBodyBytes * 2);
  const highWatermarkBytes = quotaBytes === null ? null : integer(raw.highWatermarkBytes ?? Number(BigInt(quotaBytes) * BigInt(90) / BigInt(100)), 1);
  const lowWatermarkBytes = quotaBytes === null ? null : integer(raw.lowWatermarkBytes ?? Number(BigInt(quotaBytes) * BigInt(80) / BigInt(100)), 1);
  if (quotaBytes !== null && !(lowWatermarkBytes! < highWatermarkBytes! && highWatermarkBytes! < quotaBytes)) return error('INVALID_QUOTA_CONFIGURATION');
  if (quotaBytes === null && (raw.highWatermarkBytes != null || raw.lowWatermarkBytes != null)) return error('INVALID_QUOTA_CONFIGURATION');
  const minimumFreeBytes = integer(raw.minimumFreeBytes ?? 256 * 1024 * 1024, 1);
  const maxObservationAgeMs = integer(raw.maxObservationAgeMs ?? 15000, 1);
  if (maxObservationAgeMs > 60000 || BigInt(minimumFreeBytes) + BigInt(maxBodyBytes * 2) > MAX) return error('INVALID_QUOTA_CONFIGURATION');
  return { enabled, quotaBytes, maxBodyBytes, highWatermarkBytes, lowWatermarkBytes, minimumFreeBytes, maxObservationAgeMs };
}
export interface PayloadQuotaStatus {
  state: string; epoch: string; version: number; configuration: PayloadQuotaConfiguration;
  committedBytes: number | null; reservedBytes: number; budgetedBytes: number | null;
  quotaEnforced: false;
}
export type QuotaSettlement = { reason: 'unknown'; } |
  { reason: 'confirmed_absent'; committedBytes: 0; } |
  { reason: 'confirmed_occupancy_and_unused_absent'; committedBytes: number; };

/** Database-only internal primitives. All mutations require Store.transaction:
 * local shared lane + PostgreSQL counter-row lock, plus an explicit ledger CAS.
 * No caller chooses an owner; it comes from the persisted storage binding.
 * 05B/05C must supply actual filesystem evidence; nothing here enables quota. */
export class PayloadQuotaPrimitives {
  private async owner(tx: ObservabilityReadTransaction | ObservabilityWriteTransaction): Promise<string> {
    const row = await tx.manager.getRepository(RuntimePipelineStateEntity).findOneBy({ id: PAYLOAD_OWNER_ID });
    const owner = row?.value?.ownerId;
    if (typeof owner !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(owner)) return error('PAYLOAD_STORAGE_NOT_BOUND');
    return owner;
  }
  private validate(row: Ledger): PayloadQuotaConfiguration {
    const config = payloadQuotaConfiguration(row.configuration);
    if (!Number.isSafeInteger(row.version) || row.version < 0 || row.version >= 2147483647 ||
      !/^[a-f0-9-]{36}$/.test(row.epoch) || !['disabled', 'initializing', 'ready', 'limited', 'degraded'].includes(row.state) ||
      amount(row.committedBytes) + amount(row.reservedBytes) > MAX) return error('INVALID_QUOTA_LEDGER');
    return config;
  }
  private view(row: Ledger): PayloadQuotaStatus {
    const configuration = this.validate(row), known = row.baselineKey !== null;
    return { state: row.state, epoch: row.epoch, version: row.version, configuration,
      committedBytes: known ? Number(row.committedBytes) : null, reservedBytes: Number(row.reservedBytes),
      budgetedBytes: known ? Number(amount(row.committedBytes) + amount(row.reservedBytes)) : null, quotaEnforced: false };
  }
  private async load(tx: ObservabilityWriteTransaction, epoch: string): Promise<Ledger> {
    const row = await tx.manager.getRepository(Ledger).findOneBy({ ownerId: await this.owner(tx) });
    if (!row) return error('QUOTA_NOT_INITIALIZED');
    this.validate(row); if (row.epoch !== epoch) return error('QUOTA_EPOCH_MISMATCH'); return row;
  }
  private async save(tx: ObservabilityWriteTransaction, row: Ledger): Promise<void> {
    this.validate(row);
    const version = row.version;
    const result = await tx.manager.getRepository(Ledger).update({ ownerId: row.ownerId, version },
      { ...row, version: version + 1, updatedAt: tx.now });
    if (result.affected !== 1) error('QUOTA_VERSION_CONFLICT');
    row.version++; row.updatedAt = tx.now;
  }
  private state(row: Ledger): void {
    const c = this.validate(row), total = amount(row.committedBytes) + amount(row.reservedBytes);
    if (!c.enabled) row.state = 'disabled';
    else if (!row.baselineKey) row.state = 'initializing';
    else if (row.state === 'degraded') return;
    else if (total >= BigInt(c.highWatermarkBytes!) || (row.state === 'limited' && total > BigInt(c.lowWatermarkBytes!))) row.state = 'limited';
    else row.state = 'ready';
  }
  async initialize(tx: ObservabilityWriteTransaction, raw: Record<string, unknown> = {}): Promise<PayloadQuotaStatus> {
    const configuration = payloadQuotaConfiguration(raw), ownerId = await this.owner(tx);
    const repository = tx.manager.getRepository(Ledger), previous = await repository.findOneBy({ ownerId });
    if (previous) {
      if (canonicalJson(previous.configuration) !== canonicalJson(configuration)) return error('QUOTA_CONFIGURATION_CONFLICT');
      return this.view(previous);
    }
    const row = repository.create({ ownerId, epoch: randomUUID(), version: 0, configuration,
      state: configuration.enabled ? 'initializing' : 'disabled', committedBytes: '0', reservedBytes: '0', baselineKey: null, updatedAt: tx.now });
    await repository.insert(row); return this.view(row);
  }
  /** 05C-only completion seam. Calling code must have proved inventory completeness.
   * It is intentionally not exposed by any controller or lifecycle hook. */
  async confirmBaseline(tx: ObservabilityWriteTransaction, epoch: string,
    evidence: { kind: 'complete_inventory'; evidenceId: string; committedBytes: number }): Promise<PayloadQuotaStatus> {
    if (!evidence || evidence.kind !== 'complete_inventory') return error('INVALID_QUOTA_BASELINE');
    operation(evidence.evidenceId); if (typeof evidence.committedBytes !== 'number') return error('INVALID_QUOTA_BASELINE');
    const bytes = integer(evidence.committedBytes);
    const baselineKey = contentHash(canonicalJson(['inventory', epoch, evidence.evidenceId, bytes]));
    const row = await this.load(tx, epoch);
    if (row.baselineKey !== null) {
      if (row.baselineKey !== baselineKey) return error('QUOTA_BASELINE_CONFLICT');
      return this.view(row);
    }
    if (amount(row.reservedBytes) !== BigInt(0)) return error('QUOTA_BASELINE_CONFLICT');
    row.baselineKey = baselineKey; row.committedBytes = String(bytes); this.state(row);
    await this.save(tx, row); return this.view(row);
  }
  async reserve(tx: ObservabilityWriteTransaction, epoch: string, operationId: string, bytes: number): Promise<{ status: PayloadQuotaStatus; replayed: boolean; reservationState: string }> {
    operation(operationId); if (typeof bytes !== 'number') return error('INVALID_QUOTA_RESERVATION'); integer(bytes);
    const row = await this.load(tx, epoch), configuration = this.validate(row);
    if (bytes > configuration.maxBodyBytes * 2) return error('INVALID_QUOTA_RESERVATION');
    const repository = tx.manager.getRepository(Reservation), id = contentHash(canonicalJson([row.ownerId, operationId]));
    const hash = contentHash(canonicalJson(['reserve', row.ownerId, epoch, operationId, bytes]));
    const previous = await repository.findOneBy({ id });
    if (previous) {
      if (previous.requestHash !== hash || previous.epoch !== epoch || previous.ownerId !== row.ownerId || previous.operationId !== operationId) return error('QUOTA_OPERATION_CONFLICT');
      if (!['reserved', 'uncertain', 'settled'].includes(previous.state) || amount(previous.reservedBytes) !== BigInt(bytes)) return error('INVALID_QUOTA_LEDGER');
      return { status: this.view(row), replayed: true, reservationState: previous.state };
    }
    if (!configuration.enabled || row.state !== 'ready' || !row.baselineKey ||
      amount(row.committedBytes) + amount(row.reservedBytes) >= BigInt(configuration.highWatermarkBytes!)) return error('QUOTA_NOT_READY');
    const total = amount(row.committedBytes) + amount(row.reservedBytes) + BigInt(bytes);
    if (total > MAX || total > BigInt(configuration.quotaBytes!)) return error('QUOTA_EXHAUSTED');
    const coordination = await tx.manager.getRepository(RuntimePipelineStateEntity).findOneBy({ id: PAYLOAD_COORDINATION_ID });
    const generation = publicSequence(coordination?.value?.generation ?? '0');
    row.reservedBytes = (amount(row.reservedBytes) + BigInt(bytes)).toString(); this.state(row);
    await this.save(tx, row);
    await repository.insert({ id, ownerId: row.ownerId, operationId, epoch, generation, requestHash: hash,
      reservedBytes: String(bytes), committedBytes: null, state: 'reserved', settlementHash: null, updatedAt: tx.now });
    return { status: this.view(row), replayed: false, reservationState: 'reserved' };
  }
  async settle(tx: ObservabilityWriteTransaction, epoch: string, operationId: string,
    outcome: QuotaSettlement): Promise<{ status: PayloadQuotaStatus; replayed: boolean; reservationState: string }> {
    operation(operationId);
    if (!outcome || !['unknown', 'confirmed_absent', 'confirmed_occupancy_and_unused_absent'].includes(outcome.reason)) return error('INVALID_QUOTA_SETTLEMENT');
    const fields = Object.keys(outcome);
    if (fields.some(key => !['reason', 'committedBytes'].includes(key)) ||
      (outcome.reason === 'unknown' && fields.includes('committedBytes'))) return error('INVALID_QUOTA_SETTLEMENT');
    const row = await this.load(tx, epoch), repository = tx.manager.getRepository(Reservation);
    const reservation = await repository.findOneBy({ id: contentHash(canonicalJson([row.ownerId, operationId])) });
    if (!reservation || reservation.epoch !== epoch) return error('QUOTA_OPERATION_CONFLICT');
    const hash = contentHash(canonicalJson(['settle', row.ownerId, epoch, operationId, outcome]));
    if (reservation.state === 'settled') {
      if (reservation.settlementHash !== hash) return error('QUOTA_OPERATION_CONFLICT');
      return { status: this.view(row), replayed: true, reservationState: reservation.state };
    }
    if (!['reserved', 'uncertain'].includes(reservation.state)) return error('INVALID_QUOTA_LEDGER');
    if (outcome.reason === 'unknown') {
      if (reservation.state === 'uncertain') return { status: this.view(row), replayed: true, reservationState: reservation.state };
      reservation.state = 'uncertain'; row.state = 'degraded';
    } else {
      if (typeof outcome.committedBytes !== 'number') return error('INVALID_QUOTA_SETTLEMENT');
      const committed = integer(outcome.committedBytes);
      if ((outcome.reason === 'confirmed_absent' && committed !== 0) || BigInt(committed) > amount(reservation.reservedBytes) ||
        amount(row.reservedBytes) < amount(reservation.reservedBytes)) return error('INVALID_QUOTA_SETTLEMENT');
      row.reservedBytes = (amount(row.reservedBytes) - amount(reservation.reservedBytes)).toString();
      row.committedBytes = (amount(row.committedBytes) + BigInt(committed)).toString();
      reservation.state = 'settled'; reservation.committedBytes = String(committed); reservation.settlementHash = hash;
      // A confirmed result resolves this operation only. Other uncertain operations
      // keep the ledger degraded and their conservative reservations held.
      const otherUnknown = await repository.createQueryBuilder('reservation')
        .where('reservation.ownerId = :owner AND reservation.state = :state AND reservation.id != :id',
          { owner: row.ownerId, state: 'uncertain', id: reservation.id }).getExists();
      if (row.state === 'degraded' && !otherUnknown) row.state = 'limited';
      this.state(row);
    }
    await this.save(tx, row); reservation.updatedAt = tx.now; await repository.save(reservation);
    return { status: this.view(row), replayed: false, reservationState: reservation.state };
  }
  async status(tx: ObservabilityReadTransaction): Promise<PayloadQuotaStatus | null> {
    const row = await tx.manager.getRepository(Ledger).findOneBy({ ownerId: await this.owner(tx) });
    return row ? this.view(row) : null;
  }
}
