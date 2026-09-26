import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from '../../database/entities/audit-log.entity';
import { User } from '../../database/entities/user.entity';
import { AuditService } from '../security/services/audit.service';
import { MailRateLimiterService } from './services/mail-rate-limiter.service';
import { MailTemplateService } from './services/mail-template.service';
import { MailService } from './services/mail.service';

@Module({
  imports: [TypeOrmModule.forFeature([AuditLog, User])],
  providers: [
    AuditService,
    MailTemplateService,
    MailRateLimiterService,
    MailService,
  ],
  exports: [MailService],
})
export class MailModule {}
