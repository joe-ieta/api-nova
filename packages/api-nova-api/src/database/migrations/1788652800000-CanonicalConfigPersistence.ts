import { MigrationInterface, QueryRunner, Table, TableColumnOptions } from 'typeorm';

/** Tables used by AppConfigService must exist with synchronization disabled. */
export class CanonicalConfigPersistence1788652800000 implements MigrationInterface {
  name = 'CanonicalConfigPersistence1788652800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const postgres = queryRunner.connection.options.type === 'postgres';
    const id = (): TableColumnOptions => ({ name: 'id', type: postgres ? 'uuid' : 'varchar',
      isPrimary: true, isGenerated: true, generationStrategy: 'uuid',
      ...(postgres ? { default: 'uuid_generate_v4()' } : {}) });
    const timestamps = (): TableColumnOptions[] => ['createdAt', 'updatedAt'].map(name => ({
      name, type: postgres ? 'timestamp' : 'datetime', default: postgres ? 'now()' : "datetime('now')" }));
    await queryRunner.createTable(new Table({ name: 'config_overrides', columns: [id(),
      { name: 'envKey', type: 'varchar', length: '128' },
      { name: 'section', type: 'varchar', length: '64' },
      { name: 'field', type: 'varchar', length: '64' },
      { name: 'valueType', type: 'varchar', length: '16' },
      { name: 'value', type: postgres ? 'jsonb' : 'text' },
      { name: 'restartRequired', type: 'boolean', default: postgres ? 'false' : '0' },
      { name: 'description', type: 'varchar', length: '255', isNullable: true }, ...timestamps()],
      indices: [{ columnNames: ['envKey'], isUnique: true },
        { columnNames: ['section'] }] }), true);
    await queryRunner.createTable(new Table({ name: 'config_backups', columns: [id(),
      { name: 'name', type: 'varchar', length: '120' },
      { name: 'description', type: 'varchar', length: '255', isNullable: true },
      { name: 'overrideCount', type: 'integer', default: '0' },
      { name: 'snapshot', type: postgres ? 'jsonb' : 'text' }, ...timestamps()],
      indices: [{ columnNames: ['createdAt'] }] }), true);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('config_backups', true);
    await queryRunner.dropTable('config_overrides', true);
  }
}
