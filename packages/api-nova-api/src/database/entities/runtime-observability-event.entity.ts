import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { getEnumColumnOptions, getJsonColumnOptions } from '../db-compat';

export enum RuntimeObservabilityEventFamily {
  RUNTIME_LIFECYCLE = 'runtime.lifecycle',
  RUNTIME_HEALTH = 'runtime.health',
  RUNTIME_POLICY = 'runtime.policy',
  RUNTIME_PUBLICATION = 'runtime.publication',
  RUNTIME_ROUTE = 'runtime.route',
  RUNTIME_REQUEST = 'runtime.request',
  RUNTIME_ERROR = 'runtime.error',
  RUNTIME_CONTROL = 'runtime.control',
}

export enum RuntimeObservabilitySeverity {
  DEBUG = 'debug',
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical',
}

export enum RuntimeObservabilityStatus {
  SUCCESS = 'success',
  FAILED = 'failed',
  PARTIAL = 'partial',
  ACTIVE = 'active',
  OFFLINE = 'offline',
  DEGRADED = 'degraded',
}

export enum RuntimeObservabilityActorType {
  SYSTEM = 'system',
  USER = 'user',
  RUNTIME = 'runtime',
  SCHEDULER = 'scheduler',
}

export enum RuntimeObservabilityRetentionClass {
  SHORT = 'short',
  STANDARD = 'standard',
  SECURITY = 'security',
  LONG = 'long',
}

@Entity('runtime_observability_events')
@Index(['runtimeAssetId', 'occurredAt'])
@Index(['runtimeAssetEndpointBindingId', 'occurredAt'])
@Index(['eventFamily', 'occurredAt'])
@Index(['severity', 'occurredAt'])
@Index(['status', 'occurredAt'])
@Index(['correlationId'])
export class RuntimeObservabilityEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  runtimeAssetId?: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  runtimeAssetEndpointBindingId?: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  endpointDefinitionId?: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  sourceServiceAssetId?: string;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, RuntimeObservabilityEventFamily),
  })
  eventFamily: RuntimeObservabilityEventFamily;

  @Column({ type: 'varchar', length: 120 })
  eventName: string;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, RuntimeObservabilitySeverity),
    default: RuntimeObservabilitySeverity.INFO,
  })
  severity: RuntimeObservabilitySeverity;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, RuntimeObservabilityStatus),
    default: RuntimeObservabilityStatus.SUCCESS,
  })
  status: RuntimeObservabilityStatus;

  @Column({ type: 'datetime' as any })
  occurredAt: Date;

  @Column({ type: 'varchar', length: 120, nullable: true })
  correlationId?: string;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, RuntimeObservabilityActorType),
    default: RuntimeObservabilityActorType.SYSTEM,
  })
  actorType: RuntimeObservabilityActorType;

  @Column({ type: 'varchar', length: 36, nullable: true })
  actorId?: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  summary?: string;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  details?: Record<string, unknown>;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  dimensions?: Record<string, unknown>;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, RuntimeObservabilityRetentionClass),
    default: RuntimeObservabilityRetentionClass.STANDARD,
  })
  retentionClass: RuntimeObservabilityRetentionClass;

  @CreateDateColumn()
  createdAt: Date;
}
