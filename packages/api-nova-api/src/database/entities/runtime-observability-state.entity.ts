import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { getEnumColumnOptions, getJsonColumnOptions } from '../db-compat';

export enum RuntimeObservabilityScopeType {
  RUNTIME_ASSET = 'runtime_asset',
  RUNTIME_MEMBERSHIP = 'runtime_membership',
  ENDPOINT_DEFINITION = 'endpoint_definition',
  SOURCE_SERVICE_ASSET = 'source_service_asset',
}

export enum RuntimeCurrentStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  DEGRADED = 'degraded',
  OFFLINE = 'offline',
}

export enum RuntimeHealthStatus {
  UNKNOWN = 'unknown',
  HEALTHY = 'healthy',
  DEGRADED = 'degraded',
  UNHEALTHY = 'unhealthy',
}

@Entity('runtime_observability_states')
@Index(['scopeType', 'runtimeAssetId', 'runtimeAssetEndpointBindingId'], { unique: true })
@Index(['runtimeAssetId'])
@Index(['runtimeAssetEndpointBindingId'])
@Index(['currentStatus'])
@Index(['healthStatus'])
export class RuntimeObservabilityStateEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, RuntimeObservabilityScopeType),
  })
  scopeType: RuntimeObservabilityScopeType;

  @Column({ type: 'varchar', length: 36, nullable: true })
  runtimeAssetId?: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  runtimeAssetEndpointBindingId?: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  endpointDefinitionId?: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  sourceServiceAssetId?: string;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, RuntimeCurrentStatus),
    default: RuntimeCurrentStatus.DRAFT,
  })
  currentStatus: RuntimeCurrentStatus;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, RuntimeHealthStatus),
    default: RuntimeHealthStatus.UNKNOWN,
  })
  healthStatus: RuntimeHealthStatus;

  @Column({ type: 'varchar', length: 16, nullable: true })
  severity?: string;

  @Column({ type: 'datetime' as any, nullable: true })
  lastEventAt?: Date;

  @Column({ type: 'datetime' as any, nullable: true })
  lastSuccessAt?: Date;

  @Column({ type: 'datetime' as any, nullable: true })
  lastFailureAt?: Date;

  @Column({ type: 'varchar', length: 64, nullable: true })
  lastErrorCode?: string;

  @Column({ type: 'text', nullable: true })
  lastErrorMessage?: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  summary?: string;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  counters?: Record<string, number>;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  gauges?: Record<string, number | string | boolean | null>;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  dimensions?: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
