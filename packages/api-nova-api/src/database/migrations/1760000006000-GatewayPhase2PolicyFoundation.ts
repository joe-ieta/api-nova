import {
  MigrationInterface,
  QueryRunner,
  TableColumn,
  TableIndex,
} from 'typeorm';

export class GatewayPhase2PolicyFoundation1760000006000 implements MigrationInterface {
  name = 'GatewayPhase2PolicyFoundation1760000006000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    const jsonType = isPostgres ? 'jsonb' : 'text';
    const table = await queryRunner.getTable('gateway_route_bindings');
    if (!table) {
      return;
    }

    const columnsToAdd: TableColumn[] = [];
    const addColumnIfMissing = (name: string, column: TableColumn) => {
      if (!table.findColumnByName(name)) {
        columnsToAdd.push(column);
      }
    };

    addColumnIfMissing(
      'matchHost',
      new TableColumn({ name: 'matchHost', type: 'varchar', length: '255', isNullable: true }),
    );
    addColumnIfMissing(
      'pathMatchMode',
      new TableColumn({
        name: 'pathMatchMode',
        type: 'varchar',
        length: '32',
        default: "'exact'",
      }),
    );
    addColumnIfMissing(
      'priority',
      new TableColumn({ name: 'priority', type: 'int', default: '0' }),
    );
    addColumnIfMissing(
      'loggingPolicyRef',
      new TableColumn({
        name: 'loggingPolicyRef',
        type: 'varchar',
        length: '100',
        isNullable: true,
      }),
    );
    addColumnIfMissing(
      'cachePolicyRef',
      new TableColumn({
        name: 'cachePolicyRef',
        type: 'varchar',
        length: '100',
        isNullable: true,
      }),
    );
    addColumnIfMissing(
      'rateLimitPolicyRef',
      new TableColumn({
        name: 'rateLimitPolicyRef',
        type: 'varchar',
        length: '100',
        isNullable: true,
      }),
    );
    addColumnIfMissing(
      'circuitBreakerPolicyRef',
      new TableColumn({
        name: 'circuitBreakerPolicyRef',
        type: 'varchar',
        length: '100',
        isNullable: true,
      }),
    );
    addColumnIfMissing(
      'upstreamConfig',
      new TableColumn({ name: 'upstreamConfig', type: jsonType, isNullable: true }),
    );
    addColumnIfMissing(
      'routeStatusReason',
      new TableColumn({ name: 'routeStatusReason', type: 'text', isNullable: true }),
    );

    if (columnsToAdd.length > 0) {
      await queryRunner.addColumns('gateway_route_bindings', columnsToAdd);
    }

    const refreshedTable = await queryRunner.getTable('gateway_route_bindings');
    if (!refreshedTable) {
      return;
    }

    const legacyUniqueIndex = refreshedTable.indices.find(
      index =>
        index.isUnique &&
        index.columnNames.length === 2 &&
        index.columnNames.includes('routePath') &&
        index.columnNames.includes('routeMethod'),
    );
    if (legacyUniqueIndex) {
      await queryRunner.dropIndex('gateway_route_bindings', legacyUniqueIndex);
    }

    const newUniqueIndexName = 'IDX_gateway_route_bindings_host_path_method_unique';
    const hasNewUniqueIndex = refreshedTable.indices.some(
      index => index.name === newUniqueIndexName,
    );
    if (!hasNewUniqueIndex) {
      await queryRunner.createIndex(
        'gateway_route_bindings',
        new TableIndex({
          name: newUniqueIndexName,
          columnNames: ['matchHost', 'routePath', 'routeMethod'],
          isUnique: true,
        }),
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('gateway_route_bindings');
    if (!table) {
      return;
    }

    const newUniqueIndex = table.indices.find(
      index => index.name === 'IDX_gateway_route_bindings_host_path_method_unique',
    );
    if (newUniqueIndex) {
      await queryRunner.dropIndex('gateway_route_bindings', newUniqueIndex);
    }

    const columnsToDrop = [
      'matchHost',
      'pathMatchMode',
      'priority',
      'loggingPolicyRef',
      'cachePolicyRef',
      'rateLimitPolicyRef',
      'circuitBreakerPolicyRef',
      'upstreamConfig',
      'routeStatusReason',
    ].filter(name => table.findColumnByName(name));

    if (columnsToDrop.length > 0) {
      await queryRunner.dropColumns('gateway_route_bindings', columnsToDrop);
    }

    const legacyIndexName = 'IDX_gateway_route_bindings_routePath_routeMethod_unique';
    const hasLegacyIndex = (await queryRunner.getTable('gateway_route_bindings'))?.indices.some(
      index => index.name === legacyIndexName,
    );
    if (!hasLegacyIndex) {
      await queryRunner.createIndex(
        'gateway_route_bindings',
        new TableIndex({
          name: legacyIndexName,
          columnNames: ['routePath', 'routeMethod'],
          isUnique: true,
        }),
      );
    }
  }
}
