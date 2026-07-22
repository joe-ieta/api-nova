import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  getEnumColumnOptions,
  getJsonColumnOptions,
  getTimestampTzColumnOptions,
} from '../db-compat';

export enum RuntimeVerificationTrigger {
  DEPLOY = 'deploy',
  REDEPLOY = 'redeploy',
  UPSTREAM_CHANGE = 'upstream_change',
  MANUAL = 'manual',
}

export enum RuntimeVerificationRunStatus {
  PLANNED = 'planned',
  RUNNING = 'running',
  PASSED = 'passed',
  FAILED = 'failed',
  BLOCKED = 'blocked',
}

export enum RuntimeVerificationActivationStatus {
  NOT_ATTEMPTED = 'not_attempted',
  ACTIVATED = 'activated',
  RETAINED_PREVIOUS = 'retained_previous',
  BLOCKED = 'blocked',
}

@Entity('runtime_verification_runs')
@Index(['runtimeAssetId', 'createdAt'])
@Index(['status', 'createdAt'])
@Index(['candidateRevision'])
export class RuntimeVerificationRunEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36 })
  runtimeAssetId: string;

  @Column({ type: 'varchar', length: 64 })
  candidateRevision: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  previousActiveRevision?: string;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, RuntimeVerificationTrigger),
  })
  trigger: RuntimeVerificationTrigger;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, RuntimeVerificationRunStatus),
  })
  status: RuntimeVerificationRunStatus;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, RuntimeVerificationActivationStatus),
    default: RuntimeVerificationActivationStatus.NOT_ATTEMPTED,
  })
  activationStatus: RuntimeVerificationActivationStatus;

  @Column({ type: 'int', default: 0 })
  totalCount: number;

  @Column({ type: 'int', default: 0 })
  passedCount: number;

  @Column({ type: 'int', default: 0 })
  failedCount: number;

  @Column({ type: 'int', default: 0 })
  blockedCount: number;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  upstreamBindingRevisions?: Array<{
    runtimeMembershipId: string;
    bindingId: string;
    revision: number;
  }>;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  blockers?: Array<{ code: string; runtimeMembershipId?: string; message: string }>;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  metadata?: Record<string, unknown>;

  @Column(getTimestampTzColumnOptions(process.env.DB_TYPE, { nullable: true }))
  startedAt?: Date;

  @Column(getTimestampTzColumnOptions(process.env.DB_TYPE, { nullable: true }))
  completedAt?: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
