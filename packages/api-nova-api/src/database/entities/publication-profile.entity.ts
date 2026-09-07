import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { getEnumColumnOptions, getJsonColumnOptions } from '../db-compat';

export enum PublicationProfileStatus {
  DRAFT = 'draft',
  REVIEWED = 'reviewed',
  PUBLISHED = 'published',
  OFFLINE = 'offline',
}

@Entity('publication_profiles')
@Index(['endpointDefinitionId', 'version'])
@Index(['endpointDefinitionId'])
@Index(['runtimeAssetEndpointBindingId', 'version'], { unique: true })
@Index(['runtimeAssetEndpointBindingId'])
@Index(['status'])
export class PublicationProfileEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36 })
  endpointDefinitionId: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  runtimeAssetEndpointBindingId?: string;

  @Column({ type: 'int', default: 1 })
  version: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  intentName?: string;

  @Column({ type: 'text', nullable: true })
  descriptionForLlm?: string;

  @Column({ type: 'text', nullable: true })
  operatorNotes?: string;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  inputAliases?: Record<string, string>;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  constraints?: Record<string, unknown>;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  examples?: Array<Record<string, unknown>>;

  @Column({ type: 'varchar', length: 32, default: 'internal' })
  visibility: string;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, PublicationProfileStatus),
    default: PublicationProfileStatus.DRAFT,
  })
  status: PublicationProfileStatus;

  @Column({ type: 'varchar', length: 32, nullable: true })
  draftSource?: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  createdBy?: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  updatedBy?: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
