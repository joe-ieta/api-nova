import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigController } from './config.controller';
import { AppConfigService } from '../../config/app-config.service';
import { validationSchema } from '../../config/validation.schema';
import { SecurityModule } from '../security/security.module';
import { ConfigOverrideEntity } from '../../database/entities/config-override.entity';
import { AuditLog } from '../../database/entities/audit-log.entity';
import { ConfigBackupEntity } from '../../database/entities/config-backup.entity';

@Global()
@Module({
  imports: [
    SecurityModule,
    TypeOrmModule.forFeature([ConfigOverrideEntity, ConfigBackupEntity, AuditLog]),
  ],
  controllers: [ConfigController],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class ConfigModule {}
