import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class GatewayPhase1AccessLogs1760000005000 implements MigrationInterface {
  name = 'GatewayPhase1AccessLogs1760000005000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    const uuidType = isPostgres ? 'uuid' : 'varchar';
    const jsonType = isPostgres ? 'jsonb' : 'text';
    const datetimeType = isPostgres ? 'timestamp' : 'datetime';
    const idDefault = isPostgres ? 'uuid_generate_v4()' : undefined;
    const createdDefault = isPostgres ? 'now()' : "datetime('now')";

    await queryRunner.createTable(
      new Table({
        name: 'gateway_access_logs',
        columns: [
          {
            name: 'id',
            type: uuidType,
            isPrimary: true,
            generationStrategy: 'uuid',
            default: idDefault,
          },
          { name: 'requestId', type: 'varchar', length: '120' },
          { name: 'correlationId', type: 'varchar', length: '120', isNullable: true },
          { name: 'runtimeAssetId', type: 'varchar', length: '36', isNullable: true },
          { name: 'runtimeMembershipId', type: 'varchar', length: '36', isNullable: true },
          { name: 'routeBindingId', type: 'varchar', length: '36', isNullable: true },
          { name: 'endpointDefinitionId', type: 'varchar', length: '36', isNullable: true },
          { name: 'method', type: 'varchar', length: '16' },
          { name: 'routePath', type: 'varchar', length: '255' },
          { name: 'upstreamUrl', type: 'text', isNullable: true },
          { name: 'statusCode', type: 'int', isNullable: true },
          { name: 'latencyMs', type: 'int', isNullable: true },
          { name: 'clientIp', type: 'varchar', length: '45', isNullable: true },
          { name: 'actorId', type: 'varchar', length: '36', isNullable: true },
          { name: 'requestContentType', type: 'varchar', length: '255', isNullable: true },
          { name: 'responseContentType', type: 'varchar', length: '255', isNullable: true },
          { name: 'requestBytes', type: 'bigint', isNullable: true },
          { name: 'responseBytes', type: 'bigint', isNullable: true },
          { name: 'requestHeaders', type: jsonType, isNullable: true },
          { name: 'responseHeaders', type: jsonType, isNullable: true },
          { name: 'requestQuery', type: jsonType, isNullable: true },
          { name: 'requestBodyPreview', type: 'text', isNullable: true },
          { name: 'responseBodyPreview', type: 'text', isNullable: true },
          { name: 'requestBodyHash', type: 'varchar', length: '128', isNullable: true },
          { name: 'responseBodyHash', type: 'varchar', length: '128', isNullable: true },
          { name: 'captureMode', type: 'varchar', length: '32', default: "'meta_only'" },
          { name: 'errorMessage', type: 'text', isNullable: true },
          { name: 'createdAt', type: datetimeType, default: createdDefault },
        ],
      }),
    );

    await queryRunner.createIndices('gateway_access_logs', [
      new TableIndex({
        name: 'IDX_gateway_access_logs_requestId',
        columnNames: ['requestId'],
      }),
      new TableIndex({
        name: 'IDX_gateway_access_logs_runtimeAssetId',
        columnNames: ['runtimeAssetId'],
      }),
      new TableIndex({
        name: 'IDX_gateway_access_logs_runtimeMembershipId',
        columnNames: ['runtimeMembershipId'],
      }),
      new TableIndex({
        name: 'IDX_gateway_access_logs_routeBindingId',
        columnNames: ['routeBindingId'],
      }),
      new TableIndex({
        name: 'IDX_gateway_access_logs_statusCode',
        columnNames: ['statusCode'],
      }),
      new TableIndex({
        name: 'IDX_gateway_access_logs_createdAt',
        columnNames: ['createdAt'],
      }),
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('gateway_access_logs', true);
  }
}
