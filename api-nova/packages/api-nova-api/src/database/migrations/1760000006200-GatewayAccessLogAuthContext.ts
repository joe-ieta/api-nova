import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

export class GatewayAccessLogAuthContext1760000006200 implements MigrationInterface {
  name = 'GatewayAccessLogAuthContext1760000006200';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('gateway_access_logs');
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
      'authMode',
      new TableColumn({
        name: 'authMode',
        type: 'varchar',
        length: '32',
        isNullable: true,
      }),
    );
    addColumnIfMissing(
      'consumerId',
      new TableColumn({
        name: 'consumerId',
        type: 'varchar',
        length: '36',
        isNullable: true,
      }),
    );
    addColumnIfMissing(
      'credentialKeyId',
      new TableColumn({
        name: 'credentialKeyId',
        type: 'varchar',
        length: '120',
        isNullable: true,
      }),
    );

    if (columnsToAdd.length > 0) {
      await queryRunner.addColumns('gateway_access_logs', columnsToAdd);
    }

    const refreshedTable = await queryRunner.getTable('gateway_access_logs');
    if (!refreshedTable) {
      return;
    }

    const consumerIndexName = 'IDX_gateway_access_logs_consumerId';
    if (!refreshedTable.indices.some(index => index.name === consumerIndexName)) {
      await queryRunner.createIndex(
        'gateway_access_logs',
        new TableIndex({
          name: consumerIndexName,
          columnNames: ['consumerId'],
        }),
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('gateway_access_logs');
    if (!table) {
      return;
    }

    const consumerIndex = table.indices.find(
      index => index.name === 'IDX_gateway_access_logs_consumerId',
    );
    if (consumerIndex) {
      await queryRunner.dropIndex('gateway_access_logs', consumerIndex);
    }

    const columnsToDrop = ['authMode', 'consumerId', 'credentialKeyId'].filter(name =>
      table.findColumnByName(name),
    );
    if (columnsToDrop.length > 0) {
      await queryRunner.dropColumns('gateway_access_logs', columnsToDrop);
    }
  }
}
