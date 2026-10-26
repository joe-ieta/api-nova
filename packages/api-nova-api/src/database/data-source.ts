import { createApplicationDataSource } from './sqljs-persistence';
import { buildDatabaseOptions } from './database-options';

export const AppDataSource = createApplicationDataSource(buildDatabaseOptions());
