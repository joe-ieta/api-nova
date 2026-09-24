import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { getTimestampColumnOptions } from '../../../database/database-dialect';

/** Isolated evidence prototype. Not registered in DATABASE_ENTITIES or production migrations. */
@Entity('upstream_authentication_evidence_prototype')
@Index(['endpointDefinitionId', 'createdAt'])
export class UpstreamAuthenticationEvidencePrototype {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar', length: 36 }) sourceServiceAssetId: string;
  @Column({ type: 'varchar', length: 36 }) endpointDefinitionId: string;
  @Column({ type: 'varchar', length: 64 }) contextDigest: string;
  @Column({ type: 'varchar', length: 36 }) providerEpoch: string;
  @Column({ type: 'varchar', length: 36 }) runNonce: string;
  @Column({ type: 'varchar', length: 128 }) bindingRevision: string;
  @Column({ type: 'int' }) bindingGeneration: number;
  @Column({ type: 'varchar', length: 128 }) actorId: string;
  @Column({ type: 'varchar', length: 16 }) result: 'passed' | 'failed';
  @Column({ type: 'varchar', length: 64, nullable: true }) failureCode?: string;
  @Column({ type: 'int', nullable: true }) anonymousBeforeStatus?: number;
  @Column({ type: 'int', nullable: true }) wrongCredentialStatus?: number;
  @Column({ type: 'int', nullable: true }) validCredentialStatus?: number;
  @Column({ type: 'int', nullable: true }) anonymousAfterStatus?: number;
  @CreateDateColumn(getTimestampColumnOptions(process.env.DB_TYPE)) createdAt: Date;
}
