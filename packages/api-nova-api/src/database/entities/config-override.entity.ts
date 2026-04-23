import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { getJsonColumnOptions } from '../db-compat';

export type ConfigOverrideValueType = 'string' | 'number' | 'boolean';

@Entity('config_overrides')
@Index(['envKey'], { unique: true })
@Index(['section'])
export class ConfigOverrideEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 128 })
  envKey: string;

  @Column({ type: 'varchar', length: 64 })
  section: string;

  @Column({ type: 'varchar', length: 64 })
  field: string;

  @Column({ type: 'varchar', length: 16 })
  valueType: ConfigOverrideValueType;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: false }))
  value: string | number | boolean;

  @Column({ type: 'boolean', default: false })
  restartRequired: boolean;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description?: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
