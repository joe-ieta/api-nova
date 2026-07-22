import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { getJsonColumnOptions, getTimestampTzColumnOptions } from '../db-compat';

@Entity('gateway_route_snapshots')
@Index(['runtimeAssetId', 'revision'], { unique: true })
@Index(['runtimeAssetId', 'activatedAt'])
export class GatewayRouteSnapshotEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36 })
  runtimeAssetId: string;

  @Column({ type: 'varchar', length: 64 })
  revision: string;

  @Column({ type: 'varchar', length: 64 })
  fingerprint: string;

  @Column({ type: 'int', default: 0 })
  routeCount: number;

  @Column(getJsonColumnOptions(process.env.DB_TYPE))
  payload: unknown[];

  @Column(getTimestampTzColumnOptions(process.env.DB_TYPE))
  activatedAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}
