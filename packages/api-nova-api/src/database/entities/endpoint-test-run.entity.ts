import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import {
  getEnumColumnOptions,
  getJsonColumnOptions,
  getTimestampTzColumnOptions,
} from '../db-compat';

export enum EndpointTestRunStatus {
  SUCCESS = 'success',
  FAILED = 'failed',
}

@Entity('endpoint_test_runs')
@Index(['endpointDefinitionId', 'executedAt'])
@Index(['testCaseId', 'executedAt'])
@Index(['status', 'executedAt'])
export class EndpointTestRunEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36 })
  endpointDefinitionId: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  testCaseId?: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  sourceServiceInstanceId?: string;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, EndpointTestRunStatus),
  })
  status: EndpointTestRunStatus;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  requestHeaders?: Record<string, unknown>;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  requestPayload?: unknown;

  @Column({ type: 'int', nullable: true })
  responseStatusCode?: number;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  responseHeaders?: Record<string, unknown>;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  responsePayload?: unknown;

  @Column({ type: 'int', nullable: true })
  durationMs?: number;

  @Column({ type: 'text', nullable: true })
  errorMessage?: string;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  metadata?: Record<string, unknown>;

  @Column(getTimestampTzColumnOptions(process.env.DB_TYPE))
  executedAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}
