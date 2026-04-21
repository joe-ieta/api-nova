import { Table } from 'typeorm';
import { GatewayPhase2PolicyFoundation1760000006000 } from './1760000006000-GatewayPhase2PolicyFoundation';

describe('GatewayPhase2PolicyFoundation1760000006000', () => {
  const buildTable = () =>
    new Table({
      name: 'gateway_route_bindings',
      columns: [
        { name: 'id', type: 'varchar', isPrimary: true },
        { name: 'routePath', type: 'varchar' },
        { name: 'routeMethod', type: 'varchar' },
      ],
      indices: [
        {
          name: 'IDX_gateway_route_bindings_routePath_routeMethod_legacy',
          columnNames: ['routePath', 'routeMethod'],
          isUnique: true,
        } as any,
      ],
    });

  const buildQueryRunner = (type: 'sqlite' | 'postgres') => {
    const createIndex = jest.fn().mockResolvedValue(undefined);
    const dropIndex = jest.fn().mockResolvedValue(undefined);
    const addColumns = jest.fn().mockResolvedValue(undefined);
    const dropColumns = jest.fn().mockResolvedValue(undefined);
    const table = buildTable();
    const getTable = jest.fn().mockResolvedValue(table);

    return {
      queryRunner: {
        connection: { options: { type } },
        getTable,
        addColumns,
        createIndex,
        dropIndex,
        dropColumns,
      } as any,
      addColumns,
      createIndex,
      dropIndex,
      dropColumns,
    };
  };

  it('adds phase-two policy columns and unique host/path/method index for sqlite', async () => {
    const migration = new GatewayPhase2PolicyFoundation1760000006000();
    const { queryRunner, addColumns, dropIndex, createIndex } = buildQueryRunner('sqlite');

    await migration.up(queryRunner);

    const columns = addColumns.mock.calls[0][1];
    expect(columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'matchHost', type: 'varchar' }),
        expect.objectContaining({ name: 'pathMatchMode', default: "'exact'" }),
        expect.objectContaining({ name: 'upstreamConfig', type: 'text' }),
      ]),
    );
    expect(dropIndex).toHaveBeenCalled();
    expect(createIndex).toHaveBeenCalledWith(
      'gateway_route_bindings',
      expect.objectContaining({
        name: 'IDX_gateway_route_bindings_host_path_method_unique',
        isUnique: true,
      }),
    );
  });

  it('uses postgres jsonb for upstreamConfig', async () => {
    const migration = new GatewayPhase2PolicyFoundation1760000006000();
    const { queryRunner, addColumns } = buildQueryRunner('postgres');

    await migration.up(queryRunner);

    const columns = addColumns.mock.calls[0][1];
    expect(columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'upstreamConfig', type: 'jsonb' }),
      ]),
    );
  });
});
