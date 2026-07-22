import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('runtime_upstream_binding_instances')
@Index(['runtimeUpstreamBindingId', 'sourceServiceInstanceId'], { unique: true })
@Index(['runtimeUpstreamBindingId', 'enabled', 'priority', 'orderIndex'])
export class RuntimeUpstreamBindingInstanceEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36 })
  runtimeUpstreamBindingId: string;

  @Column({ type: 'varchar', length: 36 })
  sourceServiceInstanceId: string;

  @Column({ type: 'int', default: 0 })
  priority: number;

  @Column({ type: 'int', default: 0 })
  orderIndex: number;

  @Column({ type: 'int', default: 1 })
  weight: number;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
