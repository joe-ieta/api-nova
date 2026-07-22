import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { getEnumColumnOptions, getJsonColumnOptions } from '../db-compat';

export enum RuntimeVerificationResultStatus {
  PENDING = 'pending',
  PASSED = 'passed',
  FAILED = 'failed',
  BLOCKED = 'blocked',
  SKIPPED = 'skipped',
}

export enum RuntimeVerificationCaseKind {
  SMOKE = 'smoke',
  REGRESSION = 'regression',
  PRECONDITION = 'precondition',
  WAIVER = 'waiver',
}

@Entity('runtime_verification_results')
@Index(['verificationRunId', 'runtimeMembershipId'])
@Index(['verificationRunId', 'status'])
@Index(['endpointTestSampleId'])
export class RuntimeVerificationResultEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36 })
  verificationRunId: string;

  @Column({ type: 'varchar', length: 36 })
  runtimeMembershipId: string;

  @Column({ type: 'varchar', length: 36 })
  endpointDefinitionId: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  endpointTestSampleId?: string;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, RuntimeVerificationCaseKind),
  })
  kind: RuntimeVerificationCaseKind;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, RuntimeVerificationResultStatus),
  })
  status: RuntimeVerificationResultStatus;

  @Column({ type: 'varchar', length: 100, nullable: true })
  blockerCode?: string;

  @Column({ type: 'text', nullable: true })
  errorMessage?: string;

  @Column({ type: 'int', nullable: true })
  expectedStatusCode?: number;

  @Column({ type: 'int', nullable: true })
  actualStatusCode?: number;

  @Column({ type: 'int', nullable: true })
  durationMs?: number;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  evidence?: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;
}
