import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { getEnumColumnOptions, getJsonColumnOptions } from '../db-compat';

export enum RuntimeMetricScope {
  RUNTIME_ASSET = 'runtime_asset',
  RUNTIME_MEMBERSHIP = 'runtime_membership',
  ENDPOINT_DEFINITION = 'endpoint_definition',
  SOURCE_SERVICE_ASSET = 'source_service_asset',
  SYSTEM = 'system',
}

export enum RuntimeMetricAggregationWindow {
  MINUTE = 'minute',
  FIVE_MINUTES = 'five_minutes',
  HOUR = 'hour',
  DAY = 'day',
}

export enum RuntimeMetricType {
  COUNTER = 'counter',
  GAUGE = 'gauge',
  HISTOGRAM = 'histogram',
  RATE = 'rate',
}

@Entity('runtime_metric_series')
@Index(['runtimeAssetId', 'windowStartedAt'])
@Index(['runtimeAssetEndpointBindingId', 'windowStartedAt'])
@Index(['metricName', 'windowStartedAt'])
@Index(['metricScope', 'windowStartedAt'])
export class RuntimeMetricSeriesEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  runtimeAssetId?: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  runtimeAssetEndpointBindingId?: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  endpointDefinitionId?: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  sourceServiceAssetId?: string;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, RuntimeMetricScope),
  })
  metricScope: RuntimeMetricScope;

  @Column({ type: 'varchar', length: 120 })
  metricName: string;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, RuntimeMetricAggregationWindow),
  })
  aggregationWindow: RuntimeMetricAggregationWindow;

  @Column({ type: 'datetime' as any })
  windowStartedAt: Date;

  @Column({ type: 'datetime' as any })
  windowEndedAt: Date;

  @Column({
    ...getEnumColumnOptions(process.env.DB_TYPE, RuntimeMetricType),
    default: RuntimeMetricType.COUNTER,
  })
  metricType: RuntimeMetricType;

  @Column({ type: 'double precision' as any, default: 0 })
  value: number;

  @Column({ type: 'varchar', length: 32, nullable: true })
  unit?: string;

  @Column({ type: 'int', default: 1 })
  sampleCount: number;

  @Column(getJsonColumnOptions(process.env.DB_TYPE, { nullable: true }))
  dimensions?: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;
}
