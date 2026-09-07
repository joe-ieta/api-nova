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
  getJsonColumnOptions,
  getTimestampColumnOptions,
} from '../db-compat';

export enum GatewayConsumerCredentialStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  REVOKED = 'revoked',
}

@Entity('gateway_consumer_credentials')
@Index(['keyId'], { unique: true })
@Index(['status'])
@Index(['runtimeAssetId'])
@Index(['routeBindingId'])
export class GatewayConsumerCredentialEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 120, unique: true })
  keyId: string;

  @Column({ type: 'varchar', length: 128 })
  secretHash: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  label?: string;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, GatewayConsumerCredentialStatus),
    default: GatewayConsumerCredentialStatus.ACTIVE,
  })
  status: GatewayConsumerCredentialStatus;

  @Column({ type: 'varchar', length: 36, nullable: true })
  runtimeAssetId?: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  routeBindingId?: string;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  metadata?: Record<string, unknown>;

  @Column(getTimestampColumnOptions(process.env.DB_TYPE, { nullable: true }))
  lastUsedAt?: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
