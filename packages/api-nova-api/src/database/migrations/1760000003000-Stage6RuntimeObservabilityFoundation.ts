import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class Stage6RuntimeObservabilityFoundation1760000003000
  implements MigrationInterface
{
  name = 'Stage6RuntimeObservabilityFoundation1760000003000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    const enumType = (name: string, values: string[]) =>
      isPostgres ? { type: 'enum', enumName: name, enum: values } : { type: 'varchar' };
    const jsonType = isPostgres ? 'jsonb' : 'text';
    const datetimeType = isPostgres ? 'timestamp' : 'datetime';
    const uuidType = isPostgres ? 'uuid' : 'varchar';
    const idDefault = isPostgres ? 'uuid_generate_v4()' : undefined;
    const createdDefault = isPostgres ? 'now()' : "datetime('now')";

    await queryRunner.createTable(
      new Table({
        name: 'runtime_observability_events',
        columns: [
          { name: 'id', type: uuidType, isPrimary: true, generationStrategy: 'uuid', default: idDefault },
          { name: 'runtimeAssetId', type: 'varchar', length: '36', isNullable: true },
          { name: 'runtimeAssetEndpointBindingId', type: 'varchar', length: '36', isNullable: true },
          { name: 'endpointDefinitionId', type: 'varchar', length: '36', isNullable: true },
          { name: 'sourceServiceAssetId', type: 'varchar', length: '36', isNullable: true },
          { name: 'eventFamily', ...enumType('runtime_observability_events_eventfamily_enum', ['runtime.lifecycle', 'runtime.health', 'runtime.policy', 'runtime.publication', 'runtime.route', 'runtime.request', 'runtime.error', 'runtime.control']) },
          { name: 'eventName', type: 'varchar', length: '120' },
          { name: 'severity', ...enumType('runtime_observability_events_severity_enum', ['debug', 'info', 'warning', 'error', 'critical']), default: isPostgres ? "'info'" : "'info'" },
          { name: 'status', ...enumType('runtime_observability_events_status_enum', ['success', 'failed', 'partial', 'active', 'offline', 'degraded']), default: isPostgres ? "'success'" : "'success'" },
          { name: 'occurredAt', type: datetimeType },
          { name: 'correlationId', type: 'varchar', length: '120', isNullable: true },
          { name: 'actorType', ...enumType('runtime_observability_events_actortype_enum', ['system', 'user', 'runtime', 'scheduler']), default: isPostgres ? "'system'" : "'system'" },
          { name: 'actorId', type: 'varchar', length: '36', isNullable: true },
          { name: 'summary', type: 'varchar', length: '500', isNullable: true },
          { name: 'details', type: jsonType, isNullable: true },
          { name: 'dimensions', type: jsonType, isNullable: true },
          { name: 'retentionClass', ...enumType('runtime_observability_events_retentionclass_enum', ['short', 'standard', 'security', 'long']), default: isPostgres ? "'standard'" : "'standard'" },
          { name: 'createdAt', type: datetimeType, default: createdDefault },
        ],
      }),
    );

    await queryRunner.createIndices('runtime_observability_events', [
      new TableIndex({ name: 'IDX_runtime_observability_events_runtimeAssetId_occurredAt', columnNames: ['runtimeAssetId', 'occurredAt'] }),
      new TableIndex({ name: 'IDX_runtime_observability_events_runtimeAssetEndpointBindingId_occurredAt', columnNames: ['runtimeAssetEndpointBindingId', 'occurredAt'] }),
      new TableIndex({ name: 'IDX_runtime_observability_events_eventFamily_occurredAt', columnNames: ['eventFamily', 'occurredAt'] }),
      new TableIndex({ name: 'IDX_runtime_observability_events_severity_occurredAt', columnNames: ['severity', 'occurredAt'] }),
      new TableIndex({ name: 'IDX_runtime_observability_events_status_occurredAt', columnNames: ['status', 'occurredAt'] }),
      new TableIndex({ name: 'IDX_runtime_observability_events_correlationId', columnNames: ['correlationId'] }),
    ]);

    await queryRunner.createTable(
      new Table({
        name: 'runtime_metric_series',
        columns: [
          { name: 'id', type: uuidType, isPrimary: true, generationStrategy: 'uuid', default: idDefault },
          { name: 'runtimeAssetId', type: 'varchar', length: '36', isNullable: true },
          { name: 'runtimeAssetEndpointBindingId', type: 'varchar', length: '36', isNullable: true },
          { name: 'endpointDefinitionId', type: 'varchar', length: '36', isNullable: true },
          { name: 'sourceServiceAssetId', type: 'varchar', length: '36', isNullable: true },
          { name: 'metricScope', ...enumType('runtime_metric_series_metricscope_enum', ['runtime_asset', 'runtime_membership', 'endpoint_definition', 'source_service_asset', 'system']) },
          { name: 'metricName', type: 'varchar', length: '120' },
          { name: 'aggregationWindow', ...enumType('runtime_metric_series_aggregationwindow_enum', ['minute', 'five_minutes', 'hour', 'day']) },
          { name: 'windowStartedAt', type: datetimeType },
          { name: 'windowEndedAt', type: datetimeType },
          { name: 'metricType', ...enumType('runtime_metric_series_metrictype_enum', ['counter', 'gauge', 'histogram', 'rate']), default: isPostgres ? "'counter'" : "'counter'" },
          { name: 'value', type: isPostgres ? 'double precision' : 'float', default: 0 },
          { name: 'unit', type: 'varchar', length: '32', isNullable: true },
          { name: 'sampleCount', type: 'int', default: 1 },
          { name: 'dimensions', type: jsonType, isNullable: true },
          { name: 'createdAt', type: datetimeType, default: createdDefault },
        ],
      }),
    );

    await queryRunner.createIndices('runtime_metric_series', [
      new TableIndex({ name: 'IDX_runtime_metric_series_runtimeAssetId_windowStartedAt', columnNames: ['runtimeAssetId', 'windowStartedAt'] }),
      new TableIndex({ name: 'IDX_runtime_metric_series_runtimeAssetEndpointBindingId_windowStartedAt', columnNames: ['runtimeAssetEndpointBindingId', 'windowStartedAt'] }),
      new TableIndex({ name: 'IDX_runtime_metric_series_metricName_windowStartedAt', columnNames: ['metricName', 'windowStartedAt'] }),
      new TableIndex({ name: 'IDX_runtime_metric_series_metricScope_windowStartedAt', columnNames: ['metricScope', 'windowStartedAt'] }),
    ]);

    await queryRunner.createTable(
      new Table({
        name: 'runtime_observability_states',
        columns: [
          { name: 'id', type: uuidType, isPrimary: true, generationStrategy: 'uuid', default: idDefault },
          { name: 'scopeType', ...enumType('runtime_observability_states_scopetype_enum', ['runtime_asset', 'runtime_membership', 'endpoint_definition', 'source_service_asset']) },
          { name: 'runtimeAssetId', type: 'varchar', length: '36', isNullable: true },
          { name: 'runtimeAssetEndpointBindingId', type: 'varchar', length: '36', isNullable: true },
          { name: 'endpointDefinitionId', type: 'varchar', length: '36', isNullable: true },
          { name: 'sourceServiceAssetId', type: 'varchar', length: '36', isNullable: true },
          { name: 'currentStatus', ...enumType('runtime_observability_states_currentstatus_enum', ['draft', 'active', 'degraded', 'offline']), default: isPostgres ? "'draft'" : "'draft'" },
          { name: 'healthStatus', ...enumType('runtime_observability_states_healthstatus_enum', ['unknown', 'healthy', 'degraded', 'unhealthy']), default: isPostgres ? "'unknown'" : "'unknown'" },
          { name: 'severity', type: 'varchar', length: '16', isNullable: true },
          { name: 'lastEventAt', type: datetimeType, isNullable: true },
          { name: 'lastSuccessAt', type: datetimeType, isNullable: true },
          { name: 'lastFailureAt', type: datetimeType, isNullable: true },
          { name: 'lastErrorCode', type: 'varchar', length: '64', isNullable: true },
          { name: 'lastErrorMessage', type: 'text', isNullable: true },
          { name: 'summary', type: 'varchar', length: '500', isNullable: true },
          { name: 'counters', type: jsonType, isNullable: true },
          { name: 'gauges', type: jsonType, isNullable: true },
          { name: 'dimensions', type: jsonType, isNullable: true },
          { name: 'createdAt', type: datetimeType, default: createdDefault },
          { name: 'updatedAt', type: datetimeType, default: createdDefault, onUpdate: createdDefault },
        ],
      }),
    );

    await queryRunner.createIndices('runtime_observability_states', [
      new TableIndex({ name: 'UQ_runtime_observability_states_scope_identity', columnNames: ['scopeType', 'runtimeAssetId', 'runtimeAssetEndpointBindingId'], isUnique: true }),
      new TableIndex({ name: 'IDX_runtime_observability_states_runtimeAssetId', columnNames: ['runtimeAssetId'] }),
      new TableIndex({ name: 'IDX_runtime_observability_states_runtimeAssetEndpointBindingId', columnNames: ['runtimeAssetEndpointBindingId'] }),
      new TableIndex({ name: 'IDX_runtime_observability_states_currentStatus', columnNames: ['currentStatus'] }),
      new TableIndex({ name: 'IDX_runtime_observability_states_healthStatus', columnNames: ['healthStatus'] }),
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('runtime_observability_states', true);
    await queryRunner.dropTable('runtime_metric_series', true);
    await queryRunner.dropTable('runtime_observability_events', true);
  }
}
