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

export enum GatewayRouteBindingStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  OFFLINE = 'offline',
}

export enum GatewayRoutePathMatchMode {
  EXACT = 'exact',
  PREFIX = 'prefix',
  PARAMETER = 'parameter',
}

@Entity('gateway_route_bindings')
@Index(['matchHost', 'routePath', 'routeMethod'], { unique: true })
@Index(['endpointDefinitionId'])
@Index(['runtimeAssetEndpointBindingId'])
@Index(['status'])
export class GatewayRouteBindingEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36 })
  endpointDefinitionId: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  runtimeAssetEndpointBindingId?: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  publishBindingId?: string;

  @Column({ type: 'varchar', length: 255 })
  routePath: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  matchHost?: string;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, GatewayRoutePathMatchMode),
    default: GatewayRoutePathMatchMode.EXACT,
  })
  pathMatchMode: GatewayRoutePathMatchMode;

  @Column({ type: 'int', default: 0 })
  priority: number;

  @Column({ type: 'varchar', length: 255 })
  upstreamPath: string;

  @Column({ type: 'varchar', length: 16 })
  routeMethod: string;

  @Column({ type: 'varchar', length: 16 })
  upstreamMethod: string;

  @Column({ type: 'varchar', length: 32, default: 'internal' })
  routeVisibility: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  authPolicyRef?: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  trafficPolicyRef?: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  loggingPolicyRef?: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  cachePolicyRef?: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  rateLimitPolicyRef?: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  circuitBreakerPolicyRef?: string;

  @Column({ type: 'int', nullable: true })
  timeoutMs?: number;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  retryPolicy?: Record<string, unknown>;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  upstreamConfig?: Record<string, unknown>;

  @Column({ type: 'text', nullable: true })
  routeStatusReason?: string;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, GatewayRouteBindingStatus),
    default: GatewayRouteBindingStatus.DRAFT,
  })
  status: GatewayRouteBindingStatus;

  @Column(getTimestampColumnOptions(process.env.DB_TYPE, { nullable: true }))
  lastPublishedAt?: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
