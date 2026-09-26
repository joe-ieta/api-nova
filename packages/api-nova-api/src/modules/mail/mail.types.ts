import { AuditAction } from '../../database/entities/audit-log.entity';

export type MailTransportKind = 'sink' | 'smtp';

export type MailTemplateId =
  | 'verify-email.v1'
  | 'reset-password.v1'
  | 'alert-notification.v1';

export type MailTemplateVariable =
  | 'appName'
  | 'username'
  | 'emailMasked'
  | 'actionUrl'
  | 'expiresAt'
  | 'alertName'
  | 'severity'
  | 'assetName';

export type MailResultStatus = 'SENT' | 'FAILED' | 'REJECTED';

export interface MailSendRequest {
  to: string;
  templateId: MailTemplateId;
  variables?: Partial<Record<MailTemplateVariable, unknown>>;
  locale?: string;
  userId?: string;
  ipAddress?: string;
  auditAction?: AuditAction;
}

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
  templateVersion: string;
  sanitizedReasons: string[];
}

export interface OutboundMail {
  messageId: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  templateId: MailTemplateId;
  templateVersion: string;
  toMasked: string;
}

export interface MailSendResult {
  status: MailResultStatus;
  messageId: string;
  transport: MailTransportKind;
  toMasked: string;
  templateId: MailTemplateId;
  templateVersion: string;
  reason?: string;
}
