import { Column, CreateDateColumn, Entity, Check, Index, PrimaryGeneratedColumn } from 'typeorm';
import { getTimestampColumnOptions } from '../database-dialect';
/** Production-format observations only. Loading a row never creates a proof or Verified. */
@Entity('upstream_production_challenge_evidence')
@Check('CHK_upstream_production_kind', `"evidenceKind" = 'production_challenge_v1'`)
@Check('CHK_upstream_production_version', `"challengeVersion" = 1`)
@Check('CHK_upstream_production_result', `"result" IN ('passed', 'failed')`)
@Check('CHK_upstream_production_expiry', `"expiresAt" > "completedAt"`)
@Check('CHK_upstream_production_revoked', `"revokedAt" IS NULL OR "revokedAt" >= "completedAt"`)
@Check('CHK_upstream_production_failure', `"failureCode" IS NULL OR "failureCode" IN ('BINDING_UNAVAILABLE', 'CONTEXT_CHANGED', 'CHALLENGE_STATUS_REJECTED', 'CHALLENGE_TRANSPORT_FAILED', 'CHALLENGE_CANCELLED', 'CHALLENGE_TIMEOUT')`)
@Check('CHK_upstream_production_generation', `"bindingGeneration" >= 1`)
@Check('CHK_upstream_production_statuses', `("anonymousBeforeStatus" IS NULL OR "anonymousBeforeStatus" BETWEEN 100 AND 599) AND ("wrongCredentialStatus" IS NULL OR "wrongCredentialStatus" BETWEEN 100 AND 599) AND ("validCredentialStatus" IS NULL OR "validCredentialStatus" BETWEEN 100 AND 599) AND ("anonymousAfterStatus" IS NULL OR "anonymousAfterStatus" BETWEEN 100 AND 599)`)
@Check('CHK_upstream_production_passed', `"result" <> 'passed' OR ("anonymousBeforeStatus" IS NOT NULL AND "anonymousBeforeStatus" IN (401, 403) AND "wrongCredentialStatus" IS NOT NULL AND "wrongCredentialStatus" IN (401, 403) AND "validCredentialStatus" IS NOT NULL AND "validCredentialStatus" BETWEEN 200 AND 299 AND "anonymousAfterStatus" IS NOT NULL AND "anonymousAfterStatus" IN (401, 403))`)
@Index('IDX_upstream_production_endpoint_created', ['endpointDefinitionId', 'createdAt'])
export class UpstreamProductionChallengeEvidenceEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar', length: 32, default: 'production_challenge_v1' }) evidenceKind: 'production_challenge_v1';
  @Column({ type: 'int', default: 1 }) challengeVersion: 1;
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
  @Column(getTimestampColumnOptions(process.env.DB_TYPE)) completedAt: Date;
  @Column(getTimestampColumnOptions(process.env.DB_TYPE)) expiresAt: Date;
  @Column({ ...getTimestampColumnOptions(process.env.DB_TYPE), nullable: true }) revokedAt?: Date;
  @CreateDateColumn(getTimestampColumnOptions(process.env.DB_TYPE)) createdAt: Date;
}
