import { Check, Column, Entity, PrimaryColumn } from 'typeorm';

/** Names only. This registry-owned ledger never contains credential values. */
@Entity('gateway_header_history_ledger')
@Check('CHK_gateway_header_history_source', `"sourceKind" = 'registry'`)
@Check('CHK_gateway_header_history_version', '"version" = 1')
@Check('CHK_gateway_header_history_revision', '"revision" > 0')
export class GatewayHeaderHistoryLedgerEntity {
  @PrimaryColumn({ type: 'varchar', length: 200 }) namespace: string;
  @Column({ type: 'varchar', length: 16 }) sourceKind: 'registry';
  @Column({ type: 'varchar', length: 64 }) provenanceDigest: string;
  @Column({ type: 'int' }) version: number;
  @Column({ type: 'int' }) revision: number;
  @Column({ type: 'text' }) headerNames: string;
}
