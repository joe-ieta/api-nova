import { Table } from 'typeorm';
import { GatewayConsumerCredentials1760000006100 } from './1760000006100-GatewayConsumerCredentials';

describe('GatewayConsumerCredentials1760000006100', () => {
  const buildQueryRunner = (type: 'sqlite' | 'postgres') => {
    const createTable = jest.fn().mockResolvedValue(undefined);
    const createIndices = jest.fn().mockResolvedValue(undefined);
    const dropTable = jest.fn().mockResolvedValue(undefined);

    return {
      queryRunner: {
        connection: { options: { type } },
        createTable,
        createIndices,
        dropTable,
      } as any,
      createTable,
      createIndices,
      dropTable,
    };
  };

  it('creates sqlite-compatible consumer credential columns', async () => {
    const migration = new GatewayConsumerCredentials1760000006100();
    const { queryRunner, createTable, createIndices } = buildQueryRunner('sqlite');

    await migration.up(queryRunner);

    const table = createTable.mock.calls[0][0] as Table;
    expect(table.columns.find(column => column.name === 'id')?.type).toBe('varchar');
    expect(table.columns.find(column => column.name === 'metadata')?.type).toBe('text');
    expect(createIndices).toHaveBeenCalledWith(
      'gateway_consumer_credentials',
      expect.arrayContaining([
        expect.objectContaining({ name: 'IDX_gateway_consumer_credentials_status' }),
      ]),
    );
  });

  it('creates postgres-compatible consumer credential columns', async () => {
    const migration = new GatewayConsumerCredentials1760000006100();
    const { queryRunner, createTable } = buildQueryRunner('postgres');

    await migration.up(queryRunner);

    const table = createTable.mock.calls[0][0] as Table;
    expect(table.columns.find(column => column.name === 'id')?.type).toBe('uuid');
    expect(table.columns.find(column => column.name === 'metadata')?.type).toBe('jsonb');
  });

  it('drops the table on rollback', async () => {
    const migration = new GatewayConsumerCredentials1760000006100();
    const { queryRunner, dropTable } = buildQueryRunner('sqlite');

    await migration.down(queryRunner);

    expect(dropTable).toHaveBeenCalledWith('gateway_consumer_credentials', true);
  });
});
