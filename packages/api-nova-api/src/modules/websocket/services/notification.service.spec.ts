import 'reflect-metadata';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';
import { AppConfigService } from '../../../config/app-config.service';
import { User } from '../../../database/entities/user.entity';
import { MailRejectedError } from '../../mail/mail-rejected.error';
import { MailService } from '../../mail/services/mail.service';
import { Alert, AlertSeverity } from './alert.service';
import {
  NotificationService,
  NotificationStatus,
} from './notification.service';

describe('NotificationService email delivery (MAIL-02)', () => {
  let service: NotificationService;
  let eventEmitter: EventEmitter2;
  let mailSend: jest.Mock;
  let sleep: jest.Mock;
  let userFind: jest.Mock;

  const optedIn = {
    id: 'user-1',
    username: 'opted',
    email: 'opted@example.test',
    preferences: { notifications: { email: true }, language: 'zh-CN' },
  } as unknown as User;
  const optedOut = {
    id: 'user-2',
    username: 'quiet',
    email: 'quiet@example.test',
    preferences: { notifications: { email: false } },
  } as unknown as User;
  const adminWithoutPreference = {
    id: 'user-3',
    username: 'admin',
    email: 'admin@example.test',
    preferences: {},
    roles: [{ name: 'SUPER_ADMIN' }],
  } as unknown as User;

  const buildAlert = (): Alert =>
    ({
      id: 'alert-1',
      type: 'system-error',
      severity: AlertSeverity.ERROR,
      title: 'Database down',
      message: 'Database is not reachable',
      serverName: 'runtime-a',
      timestamp: new Date(),
      acknowledged: false,
      resolved: false,
    }) as Alert;

  beforeEach(() => {
    eventEmitter = new EventEmitter2();
    mailSend = jest.fn();
    sleep = jest.fn(async () => undefined);
    userFind = jest.fn(async () => [optedIn, optedOut, adminWithoutPreference]);

    const config = {
      mailEnabled: true,
      mailActionBaseUrl: 'http://localhost:5173',
      get: (_key: string, defaultValue?: unknown) => defaultValue,
    } as unknown as AppConfigService;
    const mailService = {
      isEnabled: true,
      send: mailSend,
      buildActionUrl: (path: string) => `http://localhost:5173${path}`,
    } as unknown as MailService;
    const userRepository = { find: userFind } as unknown as Repository<User>;

    service = new NotificationService(
      config,
      eventEmitter,
      userRepository,
      mailService,
      {
        sleep,
        emailCoalesceDelayMs: 0,
      },
    );
  });

  it('sends alert.created email only to users who opted in, never admins implicitly', async () => {
    mailSend.mockResolvedValue({ status: 'SENT', reason: undefined });
    const wsEvents: unknown[] = [];
    eventEmitter.on('websocket.notification', (event) => wsEvents.push(event));

    await service.handleAlertCreated(buildAlert());

    expect(mailSend).toHaveBeenCalledTimes(1);
    const request = mailSend.mock.calls[0][0];
    expect(request.to).toBe('opted@example.test');
    expect(request.templateId).toBe('alert-notification.v1');
    expect(request.variables.alertName).toBe('Database down');
    expect(request.variables.assetName).toBe('runtime-a');
    expect(request.variables.actionUrl).toBe('http://localhost:5173/alerts/alert-1');
    expect(request.variables.emailMasked).toBe('o***@example.test');

    // WebSocket behavior is unchanged.
    expect(wsEvents).toHaveLength(1);
  });

  it('coalesces acknowledge and resolve email for the same alert, latest wins', async () => {
    mailSend.mockResolvedValue({ status: 'SENT', reason: undefined });
    const alert = buildAlert();

    await service.handleAlertAcknowledged(alert);
    await service.handleAlertResolved(alert);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mailSend).toHaveBeenCalledTimes(1);
    expect(mailSend.mock.calls[0][0].variables.alertName).toBe(
      'Alert Resolved: Database down',
    );

    const notifications = service.getNotifications({ alertId: alert.id });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].status).toBe(NotificationStatus.SENT);
  });

  it('treats allowlist/config rejections as non-retryable', async () => {
    mailSend.mockResolvedValue({
      status: 'REJECTED',
      reason: 'recipient_not_allowed',
    });

    await service.handleAlertCreated(buildAlert());

    expect(mailSend).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    const emailNotification = service
      .getNotifications()
      .find((notification) => notification.channelId === 'email-default');
    expect(emailNotification?.status).toBe(NotificationStatus.FAILED);
  });

  it('retries transport failures three times with exponential backoff from 5s', async () => {
    mailSend.mockResolvedValue({ status: 'FAILED', reason: 'transport_error' });

    await service.handleAlertCreated(buildAlert());

    for (let attempt = 0; attempt < 100 && mailSend.mock.calls.length < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(mailSend).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([5000, 10000]);
    const emailNotification = service
      .getNotifications()
      .find((notification) => notification.channelId === 'email-default');
    expect(emailNotification?.status).toBe(NotificationStatus.FAILED);
    expect(emailNotification?.attempts).toBe(3);
  });

  it('does not send when no user opted in and does not fail the alert pipeline', async () => {
    userFind.mockResolvedValue([optedOut, adminWithoutPreference]);
    mailSend.mockResolvedValue({ status: 'SENT' });

    await expect(service.handleAlertCreated(buildAlert())).resolves.toBeUndefined();

    expect(mailSend).not.toHaveBeenCalled();
  });

  it('exposes a non-retryable mail rejection error type', () => {
    const error = new MailRejectedError('mail_disabled');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('mail_disabled');
  });
});
