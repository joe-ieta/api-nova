import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { getJsonColumnOptions } from '../db-compat';

@Entity('endpoint_test_cases')
@Index(['endpointDefinitionId', 'enabled'])
export class EndpointTestCaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36 })
  endpointDefinitionId: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  requestTemplate?: Record<string, unknown>;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  assertions?: Record<string, unknown>;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  tags?: string[];

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  metadata?: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
