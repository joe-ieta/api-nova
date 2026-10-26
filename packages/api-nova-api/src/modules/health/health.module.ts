import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { ConfigModule } from '@nestjs/config';
import { DiskFreeSpaceHealthIndicator } from './disk-free-space.health';
import { HealthController } from './health.controller';

@Module({
  imports: [
    TerminusModule,
    ConfigModule,
  ],
  controllers: [HealthController],
  providers: [DiskFreeSpaceHealthIndicator],
})
export class HealthModule {}
