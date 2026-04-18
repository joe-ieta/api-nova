import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { getEnumColumnOptions, getJsonColumnOptions } from '../db-compat';

export enum EndpointDefinitionStatus {
  DRAFT = 'draft',
  VERIFIED = 'verified',
  PUBLISHED = 'published',
  DEGRADED = 'degraded',
  OFFLINE = 'offline',
  RETIRED = 'retired',
}

@Entity('endpoint_definitions')
@Index(['sourceServiceAssetId', 'method', 'path'], { unique: true })
@Index(['status'])
export class EndpointDefinitionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36 })
  sourceServiceAssetId: string;

  @Column({ type: 'varchar', length: 16 })
  method: string;

  @Column({ type: 'varchar', length: 1024 })
  path: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  operationId?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  summary?: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, EndpointDefinitionStatus),
    default: EndpointDefinitionStatus.DRAFT,
  })
  status: EndpointDefinitionStatus;

  @Column({ type: 'boolean', default: false })
  publishEnabled: boolean;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  rawOperation?: Record<string, unknown>;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  metadata?: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
