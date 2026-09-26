import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';
import { AppConfigService } from '../../../config/app-config.service';
import { AuditAction } from '../../../database/entities/audit-log.entity';
import { User } from '../../../database/entities/user.entity';
import { MailRejectedError } from '../../mail/mail-rejected.error';
import { MailService } from '../../mail/services/mail.service';
import { maskEmail } from '../../mail/utils/mail-address';
import { Alert, AlertSeverity } from './alert.service';

export const NOTIFICATION_SERVICE_OPTIONS = 'NOTIFICATION_SERVICE_OPTIONS';

export interface NotificationServiceOptions {
  /** Injectable delay for deterministic retry tests. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** Coalescing window for acknowledge/resolve email notifications. */
  emailCoalesceDelayMs?: number;
}

const DEFAULT_EMAIL_COALESCE_DELAY_MS = 250;
const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export interface NotificationChannel {
  id: string;
  name: string;
  type: NotificationChannelType;
  enabled: boolean;
  config: Record<string, any>;
  filters?: NotificationFilter[];
}

export enum NotificationChannelType {
  EMAIL = 'email',
  WEBHOOK = 'webhook',
  SLACK = 'slack',
  TEAMS = 'teams',
  DISCORD = 'discord',
  SMS = 'sms',
  WEBSOCKET = 'websocket',
}

export interface NotificationFilter {
  field: string;
  operator: 'eq' | 'ne' | 'in' | 'nin' | 'gt' | 'lt' | 'gte' | 'lte';
  value: any;
}

export interface Notification {
  id: string;
  channelId: string;
  alertId: string;
  title: string;
  message: string;
  severity: AlertSeverity;
  timestamp: Date;
  status: NotificationStatus;
  attempts: number;
  lastAttempt?: Date;
  error?: string;
  metadata?: Record<string, any>;
}

export enum NotificationStatus {
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
  RETRYING = 'retrying',
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private readonly channels = new Map<string, NotificationChannel>();
  private readonly notifications = new Map<string, Notification>();
  private readonly pendingEmails = new Map<string, {
    notification: Notification;
    channel: NotificationChannel;
    timer: NodeJS.Timeout;
  }>();
  private readonly maxRetries = 3;
  private readonly retryDelay = 5000; // 5秒

  constructor(
    private readonly configService: AppConfigService,
    private readonly eventEmitter: EventEmitter2,
    @Optional()
    @InjectRepository(User)
    private readonly userRepository?: Repository<User>,
    @Optional()
    private readonly mailService?: MailService,
    @Optional()
    @Inject(NOTIFICATION_SERVICE_OPTIONS)
    private readonly options?: NotificationServiceOptions,
  ) {
    this.initializeDefaultChannels();
  }

  /**
   * 添加通知渠道
   */
  addChannel(channel: NotificationChannel): void {
    this.channels.set(channel.id, channel);
    this.logger.log(`Notification channel added: ${channel.name} (${channel.type})`);
  }

  /**
   * 移除通知渠道
   */
  removeChannel(channelId: string): boolean {
    const removed = this.channels.delete(channelId);
    if (removed) {
      this.logger.log(`Notification channel removed: ${channelId}`);
    }
    return removed;
  }

  /**
   * 获取所有通知渠道
   */
  getChannels(): NotificationChannel[] {
    return Array.from(this.channels.values());
  }

  /**
   * 更新通知渠道
   */
  updateChannel(channelId: string, updates: Partial<NotificationChannel>): boolean {
    const channel = this.channels.get(channelId);
    if (!channel) {
      return false;
    }

    Object.assign(channel, updates);
    this.logger.log(`Notification channel updated: ${channelId}`);
    return true;
  }

  /**
   * 发送通知
   */
  async sendNotification(
    alert: Alert,
    channelIds?: string[],
    options?: { coalesceEmail?: boolean },
  ): Promise<void> {
    const targetChannels = channelIds 
      ? channelIds.map(id => this.channels.get(id)).filter(Boolean) as NotificationChannel[]
      : Array.from(this.channels.values()).filter(channel => channel.enabled);

    for (const channel of targetChannels) {
      // 检查过滤器
      if (!this.shouldSendToChannel(alert, channel)) {
        continue;
      }

      const notification: Notification = {
        id: this.generateNotificationId(),
        channelId: channel.id,
        alertId: alert.id,
        title: alert.title,
        message: this.formatMessage(alert, channel),
        severity: alert.severity,
        timestamp: new Date(),
        status: NotificationStatus.PENDING,
        attempts: 0,
        metadata: {
          assetName: alert.serverName || alert.source || alert.type,
        },
      };

      this.notifications.set(notification.id, notification);

      // 确认/解决邮件按告警 ID 合并，同一告警只发一封（最新状态胜出）
      if (options?.coalesceEmail && channel.type === NotificationChannelType.EMAIL) {
        this.queueCoalescedEmail(notification, channel);
        continue;
      }

      await this.sendToChannel(notification, channel);
    }
  }

  /**
   * 获取通知历史
   */
  getNotifications(filters?: {
    channelId?: string;
    alertId?: string;
    status?: NotificationStatus;
    severity?: AlertSeverity;
    limit?: number;
  }): Notification[] {
    let notifications = Array.from(this.notifications.values());

    if (filters) {
      if (filters.channelId) {
        notifications = notifications.filter(n => n.channelId === filters.channelId);
      }
      if (filters.alertId) {
        notifications = notifications.filter(n => n.alertId === filters.alertId);
      }
      if (filters.status) {
        notifications = notifications.filter(n => n.status === filters.status);
      }
      if (filters.severity) {
        notifications = notifications.filter(n => n.severity === filters.severity);
      }
    }

    // 按时间倒序排列
    notifications.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    if (filters?.limit) {
      notifications = notifications.slice(0, filters.limit);
    }

    return notifications;
  }

  /**
   * 获取通知统计
   */
  getNotificationStats(): {
    total: number;
    byStatus: Record<NotificationStatus, number>;
    byChannel: Record<string, number>;
    bySeverity: Record<AlertSeverity, number>;
    successRate: number;
  } {
    const notifications = Array.from(this.notifications.values());
    
    const stats = {
      total: notifications.length,
      byStatus: {
        [NotificationStatus.PENDING]: 0,
        [NotificationStatus.SENT]: 0,
        [NotificationStatus.FAILED]: 0,
        [NotificationStatus.RETRYING]: 0,
      },
      byChannel: {} as Record<string, number>,
      bySeverity: {
        [AlertSeverity.INFO]: 0,
        [AlertSeverity.WARNING]: 0,
        [AlertSeverity.ERROR]: 0,
        [AlertSeverity.CRITICAL]: 0,
      },
      successRate: 0,
    };

    let successCount = 0;

    notifications.forEach(notification => {
      stats.byStatus[notification.status]++;
      stats.byChannel[notification.channelId] = (stats.byChannel[notification.channelId] || 0) + 1;
      stats.bySeverity[notification.severity]++;
      
      if (notification.status === NotificationStatus.SENT) {
        successCount++;
      }
    });

    stats.successRate = notifications.length > 0 ? (successCount / notifications.length) * 100 : 0;

    return stats;
  }

  /**
   * 监听告警创建事件
   */
  @OnEvent('alert.created')
  async handleAlertCreated(alert: Alert): Promise<void> {
    await this.sendNotification(alert);
  }

  /**
   * 监听告警确认事件
   */
  @OnEvent('alert.acknowledged')
  async handleAlertAcknowledged(alert: Alert): Promise<void> {
    // 发送确认通知（可选）
    const acknowledgeChannels = Array.from(this.channels.values())
      .filter(channel => channel.enabled && channel.config.notifyOnAcknowledge);

    if (acknowledgeChannels.length > 0) {
      const acknowledgeAlert = {
        ...alert,
        title: `Alert Acknowledged: ${alert.title}`,
        message: `Alert has been acknowledged by ${alert.acknowledgedBy}`,
      };

      await this.sendNotification(
        acknowledgeAlert,
        acknowledgeChannels.map(c => c.id),
        { coalesceEmail: true },
      );
    }
  }

  /**
   * 监听告警解决事件
   */
  @OnEvent('alert.resolved')
  async handleAlertResolved(alert: Alert): Promise<void> {
    // 发送解决通知（可选）
    const resolveChannels = Array.from(this.channels.values())
      .filter(channel => channel.enabled && channel.config.notifyOnResolve);

    if (resolveChannels.length > 0) {
      const resolveAlert = {
        ...alert,
        title: `Alert Resolved: ${alert.title}`,
        message: `Alert has been resolved`,
      };

      await this.sendNotification(
        resolveAlert,
        resolveChannels.map(c => c.id),
        { coalesceEmail: true },
      );
    }
  }

  /**
   * 重试失败的通知
   */
  async retryFailedNotifications(): Promise<void> {
    const failedNotifications = Array.from(this.notifications.values())
      .filter(n => n.status === NotificationStatus.FAILED && n.attempts < this.maxRetries);

    for (const notification of failedNotifications) {
      const channel = this.channels.get(notification.channelId);
      if (channel) {
        notification.status = NotificationStatus.RETRYING;
        await this.sendToChannel(notification, channel);
      }
    }
  }

  /**
   * 清理过期通知
   */
  cleanupExpiredNotifications(maxAge: number = 30 * 24 * 60 * 60 * 1000): number { // 默认30天
    const cutoffTime = new Date(Date.now() - maxAge);
    let cleanedCount = 0;

    for (const [id, notification] of this.notifications.entries()) {
      if (notification.timestamp < cutoffTime) {
        this.notifications.delete(id);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.log(`Cleaned up ${cleanedCount} expired notifications`);
    }

    return cleanedCount;
  }

  /**
   * 发送到指定渠道
   */
  private async sendToChannel(notification: Notification, channel: NotificationChannel): Promise<void> {
    notification.attempts++;
    notification.lastAttempt = new Date();

    try {
      switch (channel.type) {
        case NotificationChannelType.WEBSOCKET:
          await this.sendWebSocketNotification(notification, channel);
          break;
        case NotificationChannelType.WEBHOOK:
          await this.sendWebhookNotification(notification, channel);
          break;
        case NotificationChannelType.EMAIL:
          await this.sendEmailNotification(notification, channel);
          break;
        case NotificationChannelType.SLACK:
          await this.sendSlackNotification(notification, channel);
          break;
        default:
          throw new Error(`Unsupported notification channel type: ${channel.type}`);
      }

      notification.status = NotificationStatus.SENT;
      this.logger.log(`Notification sent successfully: ${notification.id} via ${channel.type}`);
      
      // 发送成功事件
      this.eventEmitter.emit('notification.sent', notification);

    } catch (error) {
      notification.error = error.message;
      const isNonRetryable = this.isNonRetryableChannelError(channel, error);
      notification.status = isNonRetryable || notification.attempts >= this.maxRetries
        ? NotificationStatus.FAILED 
        : NotificationStatus.RETRYING;

      this.logger.error(`Failed to send notification ${notification.id} via ${channel.type}:`, error);
      
      // 发送失败事件
      this.eventEmitter.emit('notification.failed', notification);

      // 如果还有重试机会，安排重试（不阻塞告警主流程）
      if (!isNonRetryable && notification.attempts < this.maxRetries) {
        const delay = this.retryDelay * notification.attempts;
        void this.scheduleRetry(delay, notification, channel);
      }
    }
  }

  private async scheduleRetry(
    delay: number,
    notification: Notification,
    channel: NotificationChannel,
  ): Promise<void> {
    const sleep = this.options?.sleep ?? defaultSleep;
    await sleep(delay);
    await this.sendToChannel(notification, channel);
  }

  /**
   * 发送WebSocket通知
   */
  private async sendWebSocketNotification(notification: Notification, channel: NotificationChannel): Promise<void> {
    // 通过事件发送WebSocket通知
    this.eventEmitter.emit('websocket.notification', {
      type: 'alert',
      data: {
        id: notification.id,
        alertId: notification.alertId,
        title: notification.title,
        message: notification.message,
        severity: notification.severity,
        timestamp: notification.timestamp,
      },
    });
  }

  /**
   * 发送Webhook通知
   */
  private async sendWebhookNotification(notification: Notification, channel: NotificationChannel): Promise<void> {
    const { url, method = 'POST', headers = {} } = channel.config;
    
    if (!url) {
      throw new Error('Webhook URL is required');
    }

    const payload = {
      id: notification.id,
      alertId: notification.alertId,
      title: notification.title,
      message: notification.message,
      severity: notification.severity,
      timestamp: notification.timestamp,
    };

    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Webhook request failed: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * 发送邮件通知：收件人必须显式开启邮件偏好，不默认通知管理员。
   */
  private async sendEmailNotification(notification: Notification, channel: NotificationChannel): Promise<void> {
    const mailService = this.mailService;
    if (!mailService?.isEnabled) {
      throw new MailRejectedError('mail_disabled');
    }

    const recipients = await this.resolveEmailRecipients();
    if (recipients.length === 0) {
      this.logger.debug(
        `No email recipients opted in for alert notification ${notification.alertId}`,
      );
      return;
    }

    const actionUrl = mailService.buildActionUrl(
      `/alerts/${encodeURIComponent(notification.alertId)}`,
    );
    const baseVariables = {
      appName: 'ApiNova',
      alertName: notification.title,
      severity: String(notification.severity),
      assetName: String(notification.metadata?.assetName || 'unknown'),
      actionUrl,
    };

    let sent = 0;
    let rejectedReason: string | undefined;
    let failedReason: string | undefined;

    for (const user of recipients) {
      const result = await mailService.send({
        to: user.email,
        templateId: 'alert-notification.v1',
        variables: {
          ...baseVariables,
          username: user.username,
          emailMasked: maskEmail(user.email),
        },
        locale: user.preferences?.language,
        userId: user.id,
        auditAction: AuditAction.API_CALLED,
      });

      if (result.status === 'SENT') {
        sent++;
      } else if (result.status === 'REJECTED') {
        rejectedReason = result.reason;
      } else {
        failedReason = result.reason;
      }
    }

    if (sent > 0) {
      return;
    }
    if (rejectedReason) {
      throw new MailRejectedError(rejectedReason);
    }
    if (failedReason) {
      throw new Error(`Email delivery failed: ${failedReason}`);
    }
  }

  /** 只有策略拒绝不可重试；传输失败仍走 3 次指数退避。 */
  private isNonRetryableChannelError(_channel: NotificationChannel, error: Error): boolean {
    return error instanceof MailRejectedError;
  }

  /**
   * 解析邮件收件人：仅 preferences.notifications.email === true 的用户。
   */
  private async resolveEmailRecipients(): Promise<User[]> {
    if (!this.userRepository) {
      return [];
    }

    const users = await this.userRepository.find();
    return users.filter(
      (user) =>
        !!user.email && user.preferences?.notifications?.email === true,
    );
  }

  /**
   * 同一告警的 acknowledge/resolve 邮件合并为一封，最新状态胜出。
   */
  private queueCoalescedEmail(
    notification: Notification,
    channel: NotificationChannel,
  ): void {
    const existing = this.pendingEmails.get(notification.alertId);
    if (existing) {
      clearTimeout(existing.timer);
      this.notifications.delete(existing.notification.id);
    }

    const delay =
      this.options?.emailCoalesceDelayMs ?? DEFAULT_EMAIL_COALESCE_DELAY_MS;
    const timer = setTimeout(() => {
      void this.flushCoalescedEmail(notification.alertId);
    }, delay);
    timer.unref?.();

    this.pendingEmails.set(notification.alertId, {
      notification,
      channel,
      timer,
    });
  }

  private async flushCoalescedEmail(alertId: string): Promise<void> {
    const pending = this.pendingEmails.get(alertId);
    if (!pending) {
      return;
    }
    this.pendingEmails.delete(alertId);
    await this.sendToChannel(pending.notification, pending.channel);
  }
  /**
   * 发送Slack通知
   */
  private async sendSlackNotification(notification: Notification, channel: NotificationChannel): Promise<void> {
    const { webhookUrl } = channel.config;
    
    if (!webhookUrl) {
      throw new Error('Slack webhook URL is required');
    }

    const color = this.getSeverityColor(notification.severity);
    const payload = {
      attachments: [{
        color,
        title: notification.title,
        text: notification.message,
        fields: [
          {
            title: 'Severity',
            value: notification.severity.toUpperCase(),
            short: true,
          },
          {
            title: 'Time',
            value: notification.timestamp.toISOString(),
            short: true,
          },
        ],
        footer: 'ApiNova Monitor',
        ts: Math.floor(notification.timestamp.getTime() / 1000),
      }],
    };

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Slack webhook request failed: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * 检查是否应该发送到指定渠道
   */
  private shouldSendToChannel(alert: Alert, channel: NotificationChannel): boolean {
    if (!channel.enabled) {
      return false;
    }

    if (!channel.filters || channel.filters.length === 0) {
      return true;
    }

    return channel.filters.every(filter => this.evaluateFilter(alert, filter));
  }

  /**
   * 评估过滤器
   */
  private evaluateFilter(alert: Alert, filter: NotificationFilter): boolean {
    const fieldValue = this.getFieldValue(alert, filter.field);
    
    switch (filter.operator) {
      case 'eq': return fieldValue === filter.value;
      case 'ne': return fieldValue !== filter.value;
      case 'in': return Array.isArray(filter.value) && filter.value.includes(fieldValue);
      case 'nin': return Array.isArray(filter.value) && !filter.value.includes(fieldValue);
      case 'gt': return fieldValue > filter.value;
      case 'lt': return fieldValue < filter.value;
      case 'gte': return fieldValue >= filter.value;
      case 'lte': return fieldValue <= filter.value;
      default: return true;
    }
  }

  /**
   * 获取字段值
   */
  private getFieldValue(alert: Alert, field: string): any {
    const fields = field.split('.');
    let value: any = alert;
    
    for (const f of fields) {
      value = value?.[f];
    }
    
    return value;
  }

  /**
   * 格式化消息
   */
  private formatMessage(alert: Alert, channel: NotificationChannel): string {
    const template = channel.config.messageTemplate || '{message}';
    
    return template
      .replace('{title}', alert.title)
      .replace('{message}', alert.message)
      .replace('{severity}', alert.severity)
      .replace('{type}', alert.type)
      .replace('{serverName}', alert.serverName || 'Unknown')
      .replace('{timestamp}', alert.timestamp.toISOString());
  }

  /**
   * 获取严重程度颜色
   */
  private getSeverityColor(severity: AlertSeverity): string {
    switch (severity) {
      case AlertSeverity.INFO: return 'good';
      case AlertSeverity.WARNING: return 'warning';
      case AlertSeverity.ERROR: return 'danger';
      case AlertSeverity.CRITICAL: return '#ff0000';
      default: return '#cccccc';
    }
  }

  /**
   * 生成通知ID
   */
  private generateNotificationId(): string {
    return `notification-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 初始化默认通知渠道
   */
  private initializeDefaultChannels(): void {
    // WebSocket 渠道（默认启用）
    this.addChannel({
      id: 'websocket-default',
      name: 'WebSocket Notifications',
      type: NotificationChannelType.WEBSOCKET,
      enabled: true,
      config: {
        messageTemplate: '[{severity}] {title}: {message}',
      },
    });

    // 邮件渠道仅在邮件功能启用时注册，收件人由用户偏好和允许清单决定
    if (this.mailService?.isEnabled) {
      this.addChannel({
        id: 'email-default',
        name: 'Email Notifications',
        type: NotificationChannelType.EMAIL,
        enabled: true,
        config: {
          notifyOnAcknowledge: true,
          notifyOnResolve: true,
        },
      });
    }

    // 从配置中加载其他渠道
    const webhookUrl = this.configService.get<string>('WEBHOOK_NOTIFICATION_URL');
    if (webhookUrl) {
      this.addChannel({
        id: 'webhook-default',
        name: 'Default Webhook',
        type: NotificationChannelType.WEBHOOK,
        enabled: true,
        config: {
          url: webhookUrl,
          method: 'POST',
        },
      });
    }

    const slackWebhookUrl = this.configService.get<string>('SLACK_WEBHOOK_URL');
    if (slackWebhookUrl) {
      this.addChannel({
        id: 'slack-default',
        name: 'Default Slack',
        type: NotificationChannelType.SLACK,
        enabled: true,
        config: {
          webhookUrl: slackWebhookUrl,
        },
        filters: [
          {
            field: 'severity',
            operator: 'in',
            value: [AlertSeverity.ERROR, AlertSeverity.CRITICAL],
          },
        ],
      });
    }

    this.logger.log('Default notification channels initialized');
  }
}
