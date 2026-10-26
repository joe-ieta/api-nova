import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { createApplicationDataSource } from './sqljs-persistence';
import { buildDatabaseOptions } from './database-options';
import { DATABASE_ENTITIES } from './database.entities';
import { SeedService } from './seed.service';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      dataSourceFactory: async options => createApplicationDataSource(options!),
      useFactory: () => ({
        ...buildDatabaseOptions(),
        autoLoadEntities: false,
      }),
    }),
    TypeOrmModule.forFeature(DATABASE_ENTITIES),
  ],
  providers: [SeedService],
  exports: [TypeOrmModule, SeedService],
})
export class DatabaseModule {}
