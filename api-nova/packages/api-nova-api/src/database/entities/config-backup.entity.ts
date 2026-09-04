import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { getJsonColumnOptions } from '../db-compat';

@Entity('config_backups')
@Index(['createdAt'])
export class ConfigBackupEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description?: string;

  @Column({ type: 'int', default: 0 })
  overrideCount: number;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: false }))
  snapshot: any;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
