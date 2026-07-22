import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { getEnumColumnOptions, getTimestampColumnOptions } from '../db-compat';

export enum RuntimeUpstreamSelectionMode {
  FIXED_PRIMARY = 'fixed_primary',
  HEALTHY_PRIORITY = 'healthy_priority',
}

export enum RuntimeUpstreamBindingStatus {
  DRAFT = 'draft',
  VERIFIED = 'verified',
  ACTIVE = 'active',
  BLOCKED = 'blocked',
}

@Entity('runtime_upstream_bindings')
@Index(['runtimeAssetEndpointBindingId'], { unique: true })
@Index(['environment', 'status'])
export class RuntimeUpstreamBindingEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36, unique: true })
  runtimeAssetEndpointBindingId: string;

  @Column({ type: 'varchar', length: 36 })
  sourceServiceAssetId: string;

  @Column({ type: 'varchar', length: 100 })
  environment: string;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, RuntimeUpstreamSelectionMode),
  })
  selectionMode: RuntimeUpstreamSelectionMode;

  @Column({ type: 'varchar', length: 36, nullable: true })
  primaryInstanceId?: string;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, RuntimeUpstreamBindingStatus),
    default: RuntimeUpstreamBindingStatus.DRAFT,
  })
  status: RuntimeUpstreamBindingStatus;

  @Column({ type: 'int', default: 1 })
  revision: number;

  @Column(getTimestampColumnOptions(process.env.DB_TYPE, { nullable: true }))
  lastVerifiedAt?: Date;

  @Column({ type: 'varchar', length: 36, nullable: true })
  lastVerificationRunId?: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
