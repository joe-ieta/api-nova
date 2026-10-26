import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppConfigService } from '../../../config/app-config.service';
import {
  AuditAction,
  AuditLevel,
  AuditStatus,
} from '../../../database/entities/audit-log.entity';
import { AuditService } from '../../security/services/audit.service';
import {
  MailSendRequest,
  MailSendResult,
  MailTransportKind,
  OutboundMail,
  RenderedMail,
} from '../mail.types';
import { MailTransport } from '../transports/mail-transport.interface';
import { SinkMailTransport } from '../transports/sink.mail-transport';
import { SmtpMailTransport } from '../transports/smtp.mail-transport';
import { MailTemplateService } from './mail-template.service';
import { MailRateLimiterService } from './mail-rate-limiter.service';
import {
  isAllowedRecipient,
  isValidRecipient,
  maskEmail,
  normalizeRecipient,
} from '../utils/mail-address';

function sanitizeReason(reason: unknown): string {
  const value = reason instanceof Error ? reason.message : String(reason ?? '');
  const flattened = value.replace(/[\r\n\t]+/g, ' ').trim();
  return (flattened || 'unknown').slice(0, 200);
}

/**
 * Controlled mail delivery facade. Enforces the global switch, recipient
 * allowlist and per-recipient rate limit before delegating to a transport.
 * Never throws for delivery outcomes; every attempt is audited.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly auditService: AuditService,
    private readonly templateService: MailTemplateService,
    private readonly rateLimiter: MailRateLimiterService,
  ) {}

  get isEnabled(): boolean {
    return this.config.mailEnabled === true;
  }

  get transportKind(): MailTransportKind {
    return this.config.mailTransport === 'smtp' ? 'smtp' : 'sink';
  }

  buildActionUrl(path: string, params: Record<string, string> = {}): string {
    const base = this.config.mailActionBaseUrl;
    const url = new URL(path.startsWith('/') ? path : `/${path}`, `${base}/`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  async send(request: MailSendRequest): Promise<MailSendResult> {
    const templateId = request.templateId;
    const messageId = randomUUID();
    const to = normalizeRecipient(request.to);
    const toMasked = maskEmail(to);
    const transport = this.transportKind;
    const base = {
      status: 'REJECTED' as const,
      messageId,
      transport,
      toMasked,
      templateId,
      templateVersion: '1',
    };

    if (!this.isEnabled) {
      return { ...base, reason: 'mail_disabled' };
    }

    if (!to || !isValidRecipient(to)) {
      await this.writeAudit(request, 'REJECTED', 'invalid_recipient', messageId, toMasked);
      return { ...base, reason: 'invalid_recipient' };
    }

    if (!isAllowedRecipient(to, this.config.mailAllowedRecipients)) {
      await this.writeAudit(request, 'REJECTED', 'recipient_not_allowed', messageId, toMasked);
      return { ...base, reason: 'recipient_not_allowed' };
    }

    if (
      !this.rateLimiter.tryConsume(
        to,
        templateId,
        this.config.mailRateLimitPerHour,
      )
    ) {
      await this.writeAudit(request, 'REJECTED', 'rate_limit_exceeded', messageId, toMasked);
      return { ...base, reason: 'rate_limit_exceeded' };
    }

    let rendered: RenderedMail;
    try {
      rendered = this.templateService.render(
        templateId,
        request.locale,
        request.variables ?? {},
      );
    } catch (error) {
      const reason = `template_error:${sanitizeReason(error)}`;
      this.logger.warn(`Mail rendering failed: ${templateId} -> ${toMasked}: ${reason}`);
      await this.writeAudit(request, 'FAILED', reason, messageId, toMasked);
      return { ...base, status: 'FAILED' as const, reason: 'template_error' };
    }
    const subject = `${this.config.mailSubjectPrefix}${rendered.subject}`.replace(
      /[\r\n]+/g,
      ' ',
    );
    const outbound: OutboundMail = {
      messageId,
      from: this.config.mailFrom,
      to,
      subject,
      text: rendered.text,
      html: rendered.html,
      templateId,
      templateVersion: rendered.templateVersion,
      toMasked,
    };

    try {
      await this.createTransport().send(outbound);
      this.logger.log(
        `Mail sent via ${transport}: ${templateId} -> ${toMasked} (${messageId})`,
      );
      await this.writeAudit(
        request,
        'SENT',
        rendered.sanitizedReasons.length
          ? rendered.sanitizedReasons.join(',')
          : undefined,
        messageId,
        toMasked,
        rendered.templateVersion,
      );
      return {
        ...base,
        status: 'SENT',
        templateVersion: rendered.templateVersion,
      };
    } catch (error) {
      const reason = sanitizeReason(error);
      this.logger.warn(
        `Mail delivery failed via ${transport}: ${templateId} -> ${toMasked}: ${reason}`,
      );
      await this.writeAudit(
        request,
        'FAILED',
        reason,
        messageId,
        toMasked,
        rendered.templateVersion,
      );
      return {
        ...base,
        status: 'FAILED',
        templateVersion: rendered.templateVersion,
        reason: 'transport_error',
      };
    }
  }

  private createTransport(): MailTransport {
    if (this.transportKind === 'smtp') {
      return new SmtpMailTransport({
        host: this.config.mailSmtpHost,
        port: this.config.mailSmtpPort,
        secure: this.config.mailSmtpSecure,
        user: this.config.mailSmtpUser,
        password: this.config.mailSmtpPassword,
      });
    }
    return new SinkMailTransport(this.config.mailSinkDir);
  }

  private async writeAudit(
    request: MailSendRequest,
    result: 'SENT' | 'FAILED' | 'REJECTED',
    reason: string | undefined,
    messageId: string,
    toMasked: string,
    templateVersion: string = '1',
  ): Promise<void> {
    const status =
      result === 'SENT' ? AuditStatus.SUCCESS : AuditStatus.FAILED;
    const level =
      result === 'SENT'
        ? AuditLevel.INFO
        : result === 'REJECTED'
          ? AuditLevel.WARNING
          : AuditLevel.ERROR;

    try {
      await this.auditService.log({
        action: request.auditAction ?? AuditAction.API_CALLED,
        level,
        status,
        userId: request.userId,
        resource: 'mail',
        resourceId: messageId,
        ipAddress: request.ipAddress,
        details: {
          channel: 'email',
          templateId: request.templateId,
          templateVersion,
          result,
          toMasked,
          ...(reason ? { reason } : {}),
        },
        metadata: {
          tags: ['mail', 'email', request.templateId],
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to write mail audit record for ${messageId}: ${sanitizeReason(error)}`,
      );
    }
  }
}
