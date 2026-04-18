import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { getEnumColumnOptions, getJsonColumnOptions } from '../db-compat';

export enum RuntimeAssetType {
  MCP_SERVER = 'mcp_server',
  GATEWAY_SERVICE = 'gateway_service',
}

export enum RuntimeAssetStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  DEGRADED = 'degraded',
  OFFLINE = 'offline',
}

@Entity('runtime_assets')
@Index(['name'], { unique: true })
@Index(['type', 'status'])
export class RuntimeAssetEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  name: string;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, RuntimeAssetType),
  })
  type: RuntimeAssetType;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, RuntimeAssetStatus),
    default: RuntimeAssetStatus.DRAFT,
  })
  status: RuntimeAssetStatus;

  @Column({ type: 'varchar', length: 255, nullable: true })
  displayName?: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  policyBindingRef?: string;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  metadata?: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
