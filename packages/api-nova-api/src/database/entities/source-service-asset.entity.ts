import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { getJsonColumnOptions } from '../db-compat';

@Entity('source_service_assets')
@Index(['sourceKey'], { unique: true })
@Index(['scheme', 'host', 'port', 'normalizedBasePath'], { unique: true })
export class SourceServiceAssetEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  sourceKey: string;

  @Column({ type: 'varchar', length: 16 })
  scheme: string;

  @Column({ type: 'varchar', length: 255 })
  host: string;

  @Column({ type: 'int' })
  port: number;

  @Column({ type: 'varchar', length: 255, default: '/' })
  normalizedBasePath: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  displayName?: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  owner?: string;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  tags?: string[];

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  metadata?: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
