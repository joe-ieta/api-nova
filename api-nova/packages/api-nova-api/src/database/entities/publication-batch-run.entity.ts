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
  getTimestampColumnOptions,
} from '../db-compat';

export enum PublicationBatchAction {
  PUBLISH = 'publish',
  OFFLINE = 'offline',
}

export enum PublicationBatchStatus {
  PENDING = 'pending',
  SUCCESS = 'success',
  PARTIAL = 'partial',
  FAILED = 'failed',
}

@Entity('publication_batch_runs')
@Index(['runtimeAssetId'])
@Index(['operatorId'])
@Index(['status'])
@Index(['createdAt'])
export class PublicationBatchRunEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, PublicationBatchAction),
  })
  action: PublicationBatchAction;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, PublicationBatchStatus),
    default: PublicationBatchStatus.PENDING,
  })
  status: PublicationBatchStatus;

  @Column({ type: 'varchar', length: 36, nullable: true })
  runtimeAssetId?: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  runtimeAssetType?: string;

  @Column({ type: 'int', default: 0 })
  totalCount: number;

  @Column({ type: 'int', default: 0 })
  successCount: number;

  @Column({ type: 'int', default: 0 })
  failedCount: number;

  @Column({ type: 'varchar', length: 36, nullable: true })
  operatorId?: string;

  @Column({ type: 'varchar', length: 32, default: 'publication-ui' })
  triggerSource: string;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  requestPayload?: Record<string, unknown>;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  resultSummary?: Record<string, unknown>;

  @Column(getTimestampColumnOptions(process.env.DB_TYPE))
  startedAt: Date;

  @Column(getTimestampColumnOptions(process.env.DB_TYPE, { nullable: true }))
  finishedAt?: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
