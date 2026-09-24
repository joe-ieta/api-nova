import { Column, CreateDateColumn, Entity, Check, Index, PrimaryGeneratedColumn } from 'typeorm';
import { getTimestampColumnOptions } from '../database-dialect';

/** Durable challenge observations only; a passed row is never publication authorization. */
@Entity('upstream_authentication_evidence')
@Check('CHK_upstream_auth_evidence_kind', `"evidenceKind" IN ('challenge_prototype')` )
@Check('CHK_upstream_auth_evidence_result', `"result" IN ('passed', 'failed')` )
@Index('IDX_upstream_auth_evidence_endpoint_created', ['endpointDefinitionId', 'createdAt'])
export class UpstreamAuthenticationEvidenceEntity {
  @Column({ type: 'varchar', length: 32, default: 'challenge_prototype' }) evidenceKind: 'challenge_prototype';
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
