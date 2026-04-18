import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { getJsonColumnOptions } from '../db-compat';

@Entity('publication_profile_history')
@Index(['endpointId'])
@Index(['runtimeAssetEndpointBindingId'])
@Index(['publicationProfileId'])
export class PublicationProfileHistoryEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36 })
  endpointId: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  runtimeAssetEndpointBindingId?: string;

  @Column({ type: 'varchar', length: 36 })
  publicationProfileId: string;

  @Column({ type: 'int' })
  version: number;

  @Column(getJsonColumnOptions(process.env.DB_TYPE))
  snapshot: Record<string, unknown>;

  @Column({ type: 'varchar', length: 64 })
  action: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  actorId?: string;

  @CreateDateColumn()
  createdAt: Date;
}
