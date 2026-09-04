import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { getEnumColumnOptions, getJsonColumnOptions } from '../db-compat';

export enum RuntimeAssetEndpointBindingStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  OFFLINE = 'offline',
}

@Entity('runtime_asset_endpoint_bindings')
@Index(['runtimeAssetId', 'endpointDefinitionId'], { unique: true })
@Index(['status'])
export class RuntimeAssetEndpointBindingEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36 })
  runtimeAssetId: string;

  @Column({ type: 'varchar', length: 36 })
  endpointDefinitionId: string;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, RuntimeAssetEndpointBindingStatus),
    default: RuntimeAssetEndpointBindingStatus.DRAFT,
  })
  status: RuntimeAssetEndpointBindingStatus;

  @Column({ type: 'int', default: 0 })
  publicationRevision: number;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  bindingConfig?: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
