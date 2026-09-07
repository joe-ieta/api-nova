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
  getTimestampColumnOptions,
} from '../db-compat';

export enum PublicationReviewStatus {
  PENDING = 'pending',
  REVIEWED = 'reviewed',
  REJECTED = 'rejected',
}

export enum PublicationBindingStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  OFFLINE = 'offline',
}

@Entity('endpoint_publish_bindings')
@Index(['endpointDefinitionId'])
@Index(['runtimeAssetEndpointBindingId'], { unique: true })
@Index(['publishStatus'])
export class EndpointPublishBindingEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36 })
  endpointDefinitionId: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  runtimeAssetEndpointBindingId?: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  publicationProfileId?: string;

  @Column({ type: 'int', default: 0 })
  publicationRevision: number;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, PublicationReviewStatus),
    default: PublicationReviewStatus.PENDING,
  })
  reviewStatus: PublicationReviewStatus;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, PublicationBindingStatus),
    default: PublicationBindingStatus.DRAFT,
  })
  publishStatus: PublicationBindingStatus;

  @Column({ type: 'boolean', default: false })
  publishedToMcp: boolean;

  @Column({ type: 'boolean', default: false })
  publishedToHttp: boolean;

  @Column(getTimestampColumnOptions(process.env.DB_TYPE, { nullable: true }))
  publishedAt?: Date;

  @Column({ type: 'varchar', length: 36, nullable: true })
  publishedBy?: string;

  @Column(getTimestampColumnOptions(process.env.DB_TYPE, { nullable: true }))
  offlineAt?: Date;

  @Column({ type: 'varchar', length: 36, nullable: true })
  offlineBy?: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  lastSnapshotId?: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
