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

export enum EndpointTestSampleStatus {
  ACTIVE = 'active',
  ARCHIVED = 'archived',
}

@Entity('endpoint_test_samples')
@Index(['testRunId'], { unique: true })
@Index(['endpointDefinitionId', 'capturedAt'])
@Index(['fingerprint'])
@Index(['status', 'enabled'])
export class EndpointTestSampleEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36 })
  endpointDefinitionId: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  testCaseId?: string;

  @Column({ type: 'varchar', length: 36 })
  testRunId: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  sourceServiceInstanceId?: string;

  @Column({ type: 'varchar', length: 64 })
  fingerprint: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  title?: string;

  @Column({ type: 'text', nullable: true })
  note?: string;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, EndpointTestSampleStatus),
    default: EndpointTestSampleStatus.ACTIVE,
  })
  status: EndpointTestSampleStatus;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  requestHeaders?: Record<string, unknown>;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  requestPayload?: unknown;

  @Column({ type: 'int' })
  responseStatusCode: number;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  responseHeaders?: Record<string, unknown>;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  responsePayload?: unknown;

  @Column({ type: 'int', nullable: true })
  durationMs?: number;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  tags?: string[];

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  metadata?: Record<string, unknown>;

  @Column(getTimestampTzColumnOptions(process.env.DB_TYPE))
  capturedAt: Date;

  @Column(getTimestampTzColumnOptions(process.env.DB_TYPE, { nullable: true }))
  archivedAt?: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
