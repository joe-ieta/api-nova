import { Table, TableColumn, TableIndex } from 'typeorm';
import { GatewayAccessLogAuthContext1760000006200 } from './1760000006200-GatewayAccessLogAuthContext';

describe('GatewayAccessLogAuthContext1760000006200', () => {
  const buildQueryRunner = () => {
    const table = new Table({
      name: 'gateway_access_logs',
      columns: [
        new TableColumn({ name: 'id', type: 'varchar', isPrimary: true }),
      ],
      indices: [],
    });
    const getTable = jest.fn().mockResolvedValue(table);
    const addColumns = jest.fn().mockImplementation(async (_name, columns) => {
      table.columns.push(...columns);
    });
    const createIndex = jest.fn().mockImplementation(async (_name, index) => {
      table.indices.push(index);
    });
    const dropIndex = jest.fn().mockResolvedValue(undefined);
    const dropColumns = jest.fn().mockResolvedValue(undefined);

    return {
      queryRunner: {
        getTable,
        addColumns,
        createIndex,
        dropIndex,
        dropColumns,
      } as any,
      table,
      addColumns,
      createIndex,
      dropIndex,
      dropColumns,
    };
  };

  it('adds auth context columns and consumer index', async () => {
    const migration = new GatewayAccessLogAuthContext1760000006200();
    const { queryRunner, table, addColumns, createIndex } = buildQueryRunner();

    await migration.up(queryRunner);

    expect(addColumns).toHaveBeenCalledWith(
      'gateway_access_logs',
      expect.arrayContaining([
        expect.objectContaining({ name: 'authMode' }),
        expect.objectContaining({ name: 'consumerId' }),
        expect.objectContaining({ name: 'credentialKeyId' }),
      ]),
    );
    expect(table.columns.map(column => column.name)).toEqual(
      expect.arrayContaining(['authMode', 'consumerId', 'credentialKeyId']),
    );
    expect(createIndex).toHaveBeenCalledWith(
      'gateway_access_logs',
      expect.objectContaining({ name: 'IDX_gateway_access_logs_consumerId' }),
    );
  });

  it('drops auth context columns and index on rollback', async () => {
    const migration = new GatewayAccessLogAuthContext1760000006200();
    const { queryRunner, table, dropIndex, dropColumns } = buildQueryRunner();
    table.columns.push(
      new TableColumn({ name: 'authMode', type: 'varchar' }),
      new TableColumn({ name: 'consumerId', type: 'varchar' }),
      new TableColumn({ name: 'credentialKeyId', type: 'varchar' }),
    );
    table.indices.push(
      new TableIndex({
        name: 'IDX_gateway_access_logs_consumerId',
        columnNames: ['consumerId'],
      }),
    );

    await migration.down(queryRunner);

    expect(dropIndex).toHaveBeenCalledWith(
      'gateway_access_logs',
      expect.objectContaining({ name: 'IDX_gateway_access_logs_consumerId' }),
    );
    expect(dropColumns).toHaveBeenCalledWith(
      'gateway_access_logs',
      expect.arrayContaining(['authMode', 'consumerId', 'credentialKeyId']),
    );
  });
});
