import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  getEnumColumnOptions,
  getJsonColumnOptions,
  getTimestampColumnOptions,
  getUuidColumnOptions,
} from '../db-compat';
import { SourceServiceAssetEntity } from './source-service-asset.entity';

export enum SourceServiceInstanceStatus {
  DRAFT = 'draft',
  HEALTHY = 'healthy',
  UNHEALTHY = 'unhealthy',
  OFFLINE = 'offline',
}

@Entity('source_service_instances')
@Index(['sourceServiceAssetId', 'environment', 'name'], { unique: true })
@Index(['sourceServiceAssetId', 'environment', 'enabled'])
@Index(['status', 'enabled'])
export class SourceServiceInstanceEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column(getUuidColumnOptions(process.env.DB_TYPE))
  sourceServiceAssetId: string;

  @ManyToOne(() => SourceServiceAssetEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sourceServiceAssetId' })
  sourceServiceAsset: SourceServiceAssetEntity;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 100 })
  environment: string;

  @Column({ type: 'varchar', length: 16 })
  scheme: string;

  @Column({ type: 'varchar', length: 255 })
  host: string;

  @Column({ type: 'int' })
  port: number;

  @Column({ type: 'varchar', length: 1024, default: '/' })
  basePath: string;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, SourceServiceInstanceStatus),
    default: SourceServiceInstanceStatus.DRAFT,
  })
  status: SourceServiceInstanceStatus;

  @Column({ type: 'int', default: 100 })
  priority: number;

  @Column({ type: 'int', default: 100 })
  weight: number;

  @Column({ type: 'boolean', default: false })
  isDefault: boolean;

  @Column({ type: 'varchar', length: 255, nullable: true })
  credentialRef?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  tlsPolicyRef?: string;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  metadata?: Record<string, unknown>;

  @Column({ type: 'varchar', length: 32, nullable: true })
  lastProbeStatus?: string;

  @Column(getTimestampColumnOptions(process.env.DB_TYPE, { nullable: true }))
  lastProbeAt?: Date;

  @Column({ type: 'int', nullable: true })
  lastProbeLatencyMs?: number;

  @Column({ type: 'text', nullable: true })
  lastError?: string;

  @Column(getTimestampColumnOptions(process.env.DB_TYPE, { nullable: true }))
  archivedAt?: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
