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
} from '../db-compat';

export enum PublicationAuditAction {
  RUNTIME_ASSET_CREATED = 'runtime_asset.created',
  MEMBERSHIPS_ADDED = 'memberships.added',
  PROFILE_UPDATED = 'profile.updated',
  GATEWAY_ROUTE_UPDATED = 'gateway_route.updated',
  MEMBERSHIP_PUBLISHED = 'membership.published',
  MEMBERSHIP_OFFLINED = 'membership.offlined',
  BATCH_PUBLISH = 'batch.publish',
  BATCH_OFFLINE = 'batch.offline',
}

export enum PublicationAuditStatus {
  SUCCESS = 'success',
  PARTIAL = 'partial',
  FAILED = 'failed',
  INFO = 'info',
}

@Entity('publication_audit_events')
@Index(['publicationBatchRunId'])
@Index(['runtimeAssetId'])
@Index(['runtimeAssetEndpointBindingId'])
@Index(['endpointDefinitionId'])
@Index(['operatorId'])
@Index(['createdAt'])
export class PublicationAuditEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, PublicationAuditAction),
  })
  action: PublicationAuditAction;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, PublicationAuditStatus),
    default: PublicationAuditStatus.INFO,
  })
  status: PublicationAuditStatus;

  @Column({ type: 'varchar', length: 255 })
  summary: string;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  details?: Record<string, unknown>;

  @Column({ type: 'varchar', length: 36, nullable: true })
  publicationBatchRunId?: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  runtimeAssetId?: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  runtimeAssetEndpointBindingId?: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  endpointDefinitionId?: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  sourceServiceAssetId?: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  operatorId?: string;

  @CreateDateColumn()
  createdAt: Date;
}
