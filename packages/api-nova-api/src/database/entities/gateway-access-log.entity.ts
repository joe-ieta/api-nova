import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { getJsonColumnOptions, getUuidColumnOptions } from '../db-compat';

@Entity('gateway_access_logs')
@Index(['requestId'])
@Index(['runtimeAssetId'])
@Index(['runtimeMembershipId'])
@Index(['routeBindingId'])
@Index(['statusCode'])
@Index(['createdAt'])
export class GatewayAccessLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 120 })
  requestId: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  correlationId?: string;

  @Column(getUuidColumnOptions(process.env.DB_TYPE, { nullable: true }))
  runtimeAssetId?: string;

  @Column(getUuidColumnOptions(process.env.DB_TYPE, { nullable: true }))
  runtimeMembershipId?: string;

  @Column(getUuidColumnOptions(process.env.DB_TYPE, { nullable: true }))
  routeBindingId?: string;

  @Column(getUuidColumnOptions(process.env.DB_TYPE, { nullable: true }))
  endpointDefinitionId?: string;

  @Column({ type: 'varchar', length: 16 })
  method: string;

  @Column({ type: 'varchar', length: 255 })
  routePath: string;

  @Column({ type: 'text', nullable: true })
  upstreamUrl?: string;

  @Column({ type: 'int', nullable: true })
  statusCode?: number;

  @Column({ type: 'int', nullable: true })
  latencyMs?: number;

  @Column({ type: 'varchar', length: 45, nullable: true })
  clientIp?: string;

  @Column(getUuidColumnOptions(process.env.DB_TYPE, { nullable: true }))
  actorId?: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  authMode?: string;

  @Column(getUuidColumnOptions(process.env.DB_TYPE, { nullable: true }))
  consumerId?: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  credentialKeyId?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  requestContentType?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  responseContentType?: string;

  @Column({ type: 'bigint', nullable: true })
  requestBytes?: number;

  @Column({ type: 'bigint', nullable: true })
  responseBytes?: number;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  requestHeaders?: Record<string, string | string[]>;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  responseHeaders?: Record<string, string | string[]>;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  requestQuery?: Record<string, unknown>;

  @Column({ type: 'text', nullable: true })
  requestBodyPreview?: string;

  @Column({ type: 'text', nullable: true })
  responseBodyPreview?: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  requestBodyHash?: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  responseBodyHash?: string;

  @Column({ type: 'varchar', length: 32, default: 'meta_only' })
  captureMode: string;

  @Column({ type: 'text', nullable: true })
  errorMessage?: string;

  @CreateDateColumn()
  createdAt: Date;
}
