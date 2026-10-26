import 'reflect-metadata';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigService } from '../../../config/app-config.service';
import { AuditAction } from '../../../database/entities/audit-log.entity';
import { AuditService } from '../../security/services/audit.service';
import { MailService } from './mail.service';
import { MailRateLimiterService } from './mail-rate-limiter.service';
import { MailTemplateService } from './mail-template.service';

interface SinkEntry {
  messageId: string;
  timestamp: string;
  toMasked: string;
  templateId: string;
  templateVersion: string;
  subject: string;
  text: string;
  html: string;
  transport: string;
  result: string;
}

describe('MailService controlled delivery (MAIL-02)', () => {
  let sinkDir: string;
  let auditLog: jest.Mock;
  let config: Record<string, unknown>;

  const buildService = (): MailService =>
    new MailService(
      config as unknown as AppConfigService,
      { log: auditLog } as unknown as AuditService,
      new MailTemplateService(),
      new MailRateLimiterService(),
    );

  const readSink = (): SinkEntry[] => {
    const file = join(sinkDir, 'mail.jsonl');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SinkEntry);
  };

  const sendVerify = (service: MailService, to = 'allowed@example.test') =>
    service.send({
      to,
      templateId: 'verify-email.v1',
      variables: {
        appName: 'ApiNova',
        username: 'alice',
        emailMasked: 'a***@example.test',
        actionUrl: 'http://localhost:5173/verify-email?token=TOKEN-UNDER-TEST',
        expiresAt: '2026-09-27T00:00:00.000Z',
      },
      auditAction: AuditAction.USER_UPDATED,
    });

  beforeEach(() => {
    sinkDir = mkdtempSync(join(tmpdir(), 'api-nova-mail-service-'));
    auditLog = jest.fn().mockResolvedValue(undefined);
    config = {
      mailEnabled: true,
      mailTransport: 'sink',
      mailSinkDir: sinkDir,
      mailSmtpHost: undefined,
      mailSmtpPort: 587,
      mailSmtpSecure: false,
      mailSmtpUser: undefined,
      mailSmtpPassword: undefined,
      mailFrom: 'no-reply@example.test',
      mailAllowedRecipients: ['allowed@example.test'],
      mailSubjectPrefix: '[MAIL-TEST] ',
      mailRateLimitPerHour: 10,
      mailActionBaseUrl: 'http://localhost:5173',
    };
  });

  afterEach(() => {
    rmSync(sinkDir, { recursive: true, force: true });
  });

  it('defaults to no send and no sink files when mail is disabled', async () => {
    config.mailEnabled = false;
    const result = await sendVerify(buildService());

    expect(result.status).toBe('REJECTED');
    expect(result.reason).toBe('mail_disabled');
    expect(readSink()).toHaveLength(0);
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('rejects recipients outside the allowlist with a masked audit record', async () => {
    const result = await sendVerify(buildService(), 'outsider@example.test');

    expect(result.status).toBe('REJECTED');
    expect(result.reason).toBe('recipient_not_allowed');
    expect(result.toMasked).toBe('o***@example.test');
    expect(readSink()).toHaveLength(0);

    const audit = auditLog.mock.calls[0][0];
    expect(audit.resource).toBe('mail');
    expect(audit.details).toMatchObject({
      channel: 'email',
      templateId: 'verify-email.v1',
      result: 'REJECTED',
      reason: 'recipient_not_allowed',
      toMasked: 'o***@example.test',
    });
    expect(JSON.stringify(audit)).not.toContain('outsider@example.test');
  });

  it('accepts allowlisted recipients case-insensitively with trimmed spaces', async () => {
    const result = await sendVerify(buildService(), '  ALLOWED@example.test ');

    expect(result.status).toBe('SENT');
    expect(readSink()).toHaveLength(1);
  });

  it('delivers all three templates to the sink with zh-CN text and action links', async () => {
    const service = buildService();

    const verify = await sendVerify(service);
    const reset = await service.send({
      to: 'allowed@example.test',
      templateId: 'reset-password.v1',
      variables: {
        appName: 'ApiNova',
        username: 'alice',
        actionUrl: 'http://localhost:5173/reset-password?token=RESET-TOKEN',
        expiresAt: '2026-09-26T12:00:00.000Z',
      },
    });
    const alert = await service.send({
      to: 'allowed@example.test',
      templateId: 'alert-notification.v1',
      variables: {
        appName: 'ApiNova',
        alertName: 'CPU 过高',
        severity: 'critical',
        assetName: 'runtime-a',
        actionUrl: 'http://localhost:5173/alerts/alert-1',
      },
    });

    expect([verify.status, reset.status, alert.status]).toEqual([
      'SENT',
      'SENT',
      'SENT',
    ]);

    const entries = readSink();
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.transport === 'sink')).toBe(true);
    expect(entries.every((entry) => entry.result === 'sent')).toBe(true);

    expect(entries[0].subject).toBe('[MAIL-TEST] 验证您的邮箱');
    expect(entries[0].text).toContain('邮箱验证');
    expect(entries[0].text).toContain('http://localhost:5173/verify-email?token=TOKEN-UNDER-TEST');

    expect(entries[1].templateId).toBe('reset-password.v1');
    expect(entries[1].text).toContain('重置');
    expect(entries[1].text).toContain('若非本人操作请忽略此邮件');
    expect(entries[1].text).toContain('http://localhost:5173/reset-password?token=RESET-TOKEN');

    expect(entries[2].templateId).toBe('alert-notification.v1');
    expect(entries[2].text).toContain('CPU 过高');
    expect(entries[2].text).toContain('http://localhost:5173/alerts/alert-1');
  });

  it('records FAILED without throwing when the selected transport cannot deliver', async () => {
    config.mailTransport = 'smtp';
    config.mailSmtpHost = '127.0.0.1';
    config.mailSmtpPort = 1;

    const result = await sendVerify(buildService());

    expect(result.status).toBe('FAILED');
    expect(result.reason).toBe('transport_error');
    expect(readSink()).toHaveLength(0);
    expect(auditLog.mock.calls[0][0].details).toMatchObject({
      result: 'FAILED',
    });
    expect(auditLog.mock.calls[0][0].details.reason).toContain('SMTP');
    expect(auditLog.mock.calls[0][0].details.reason).not.toContain(
      'allowed@example.test',
    );
  });

  it('enforces the hourly per-recipient/per-template rate limit', async () => {
    config.mailRateLimitPerHour = 2;
    const service = buildService();

    expect((await sendVerify(service)).status).toBe('SENT');
    expect((await sendVerify(service)).status).toBe('SENT');
    const overLimit = await sendVerify(service);

    expect(overLimit.status).toBe('REJECTED');
    expect(overLimit.reason).toBe('rate_limit_exceeded');
    expect(readSink()).toHaveLength(2);
    expect(auditLog.mock.calls[2][0].details).toMatchObject({
      result: 'REJECTED',
      reason: 'rate_limit_exceeded',
    });
  });

  it('records sanitized template variable reasons in the audit record', async () => {
    const result = await buildService().send({
      to: 'allowed@example.test',
      templateId: 'verify-email.v1',
      variables: {
        appName: 'ApiNova',
        username: 'alice',
        actionUrl: 'http://localhost:5173/verify-email?token=abc',
        bogusVariable: 'nope',
      } as any,
    });

    expect(result.status).toBe('SENT');
    expect(auditLog.mock.calls[0][0].details.reason).toContain(
      'unknown_variable:bogusVariable',
    );
  });

  it('fails closed without throwing when the template identifier is unknown', async () => {
    const result = await buildService().send({
      to: 'allowed@example.test',
      templateId: 'does-not-exist.v9' as any,
      variables: {},
    });

    expect(result.status).toBe('FAILED');
    expect(result.reason).toBe('template_error');
    expect(readSink()).toHaveLength(0);
    expect(auditLog.mock.calls[0][0].details.result).toBe('FAILED');
  });

  it('never writes a plaintext token or full recipient into audit details', async () => {
    await sendVerify(buildService());

    const audit = auditLog.mock.calls[0][0];
    expect(JSON.stringify(audit)).not.toContain('TOKEN-UNDER-TEST');
    expect(JSON.stringify(audit)).not.toContain('allowed@example.test');
    expect(JSON.stringify(audit)).toContain('a***@example.test');
  });
});
