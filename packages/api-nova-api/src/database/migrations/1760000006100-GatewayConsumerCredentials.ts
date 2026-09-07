import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class GatewayConsumerCredentials1760000006100 implements MigrationInterface {
  name = 'GatewayConsumerCredentials1760000006100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    const uuidType = isPostgres ? 'uuid' : 'varchar';
    const jsonType = isPostgres ? 'jsonb' : 'text';
    const datetimeType = isPostgres ? 'timestamp' : 'datetime';
    const idDefault = isPostgres ? 'uuid_generate_v4()' : undefined;
    const createdDefault = isPostgres ? 'now()' : "datetime('now')";

    await queryRunner.createTable(
      new Table({
        name: 'gateway_consumer_credentials',
        columns: [
          {
            name: 'id',
            type: uuidType,
            isPrimary: true,
            generationStrategy: 'uuid',
            default: idDefault,
          },
          { name: 'name', type: 'varchar', length: '120' },
          { name: 'keyId', type: 'varchar', length: '120', isUnique: true },
          { name: 'secretHash', type: 'varchar', length: '128' },
          { name: 'label', type: 'varchar', length: '255', isNullable: true },
          { name: 'status', type: 'varchar', length: '32', default: "'active'" },
          { name: 'runtimeAssetId', type: 'varchar', length: '36', isNullable: true },
          { name: 'routeBindingId', type: 'varchar', length: '36', isNullable: true },
          { name: 'metadata', type: jsonType, isNullable: true },
          { name: 'lastUsedAt', type: datetimeType, isNullable: true },
          { name: 'createdAt', type: datetimeType, default: createdDefault },
          { name: 'updatedAt', type: datetimeType, default: createdDefault },
        ],
      }),
    );

    await queryRunner.createIndices('gateway_consumer_credentials', [
      new TableIndex({
        name: 'IDX_gateway_consumer_credentials_status',
        columnNames: ['status'],
      }),
      new TableIndex({
        name: 'IDX_gateway_consumer_credentials_runtimeAssetId',
        columnNames: ['runtimeAssetId'],
      }),
      new TableIndex({
        name: 'IDX_gateway_consumer_credentials_routeBindingId',
        columnNames: ['routeBindingId'],
      }),
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('gateway_consumer_credentials', true);
  }
}
