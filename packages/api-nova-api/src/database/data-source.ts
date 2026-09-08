import { DataSource } from 'typeorm';
import { buildDatabaseOptions } from './database-options';

export const AppDataSource = new DataSource(buildDatabaseOptions());
