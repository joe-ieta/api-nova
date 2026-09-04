import { Table } from 'typeorm';
import { GatewayPhase1AccessLogs1760000005000 } from './1760000005000-GatewayPhase1AccessLogs';

describe('GatewayPhase1AccessLogs1760000005000', () => {
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

  it('creates sqlite-compatible column types', async () => {
    const migration = new GatewayPhase1AccessLogs1760000005000();
    const { queryRunner, createTable, createIndices } = buildQueryRunner('sqlite');

    await migration.up(queryRunner);

    const table = createTable.mock.calls[0][0] as Table;
    const requestHeaders = table.columns.find(column => column.name === 'requestHeaders');
    const id = table.columns.find(column => column.name === 'id');
    const createdAt = table.columns.find(column => column.name === 'createdAt');

    expect(id?.type).toBe('varchar');
    expect(requestHeaders?.type).toBe('text');
    expect(createdAt?.type).toBe('datetime');
    expect(createIndices).toHaveBeenCalledWith(
      'gateway_access_logs',
      expect.arrayContaining([
        expect.objectContaining({ name: 'IDX_gateway_access_logs_requestId' }),
        expect.objectContaining({ name: 'IDX_gateway_access_logs_createdAt' }),
      ]),
    );
  });

  it('creates postgres-compatible column types', async () => {
    const migration = new GatewayPhase1AccessLogs1760000005000();
    const { queryRunner, createTable } = buildQueryRunner('postgres');

    await migration.up(queryRunner);

    const table = createTable.mock.calls[0][0] as Table;
    const requestHeaders = table.columns.find(column => column.name === 'requestHeaders');
    const id = table.columns.find(column => column.name === 'id');
    const createdAt = table.columns.find(column => column.name === 'createdAt');

    expect(id?.type).toBe('uuid');
    expect(id?.default).toBe('uuid_generate_v4()');
    expect(requestHeaders?.type).toBe('jsonb');
    expect(createdAt?.type).toBe('timestamp');
  });

  it('drops the table on rollback', async () => {
    const migration = new GatewayPhase1AccessLogs1760000005000();
    const { queryRunner, dropTable } = buildQueryRunner('sqlite');

    await migration.down(queryRunner);

    expect(dropTable).toHaveBeenCalledWith('gateway_access_logs', true);
  });
});
