import { Injectable } from '@nestjs/common';
import {
  MailTemplateId,
  MailTemplateVariable,
  RenderedMail,
} from '../mail.types';

export const MAIL_TEMPLATE_VARIABLES: readonly MailTemplateVariable[] = [
  'appName',
  'username',
  'emailMasked',
  'actionUrl',
  'expiresAt',
  'alertName',
  'severity',
  'assetName',
] as const;

type SupportedLocale = 'zh-CN' | 'en-US';

interface MailTemplateDefinition {
  subject: string;
  text: string;
  html: string;
}

const TEMPLATE_VERSION = '1';

const TEMPLATES: Record<MailTemplateId, Record<SupportedLocale, MailTemplateDefinition>> = {
  'verify-email.v1': {
    'zh-CN': {
      subject: '验证您的邮箱',
      text: [
        '您好 {{username}}：',
        '',
        '请点击下面的链接完成 {{appName}} 邮箱验证（24 小时内有效）：',
        '{{actionUrl}}',
        '',
        '链接到期时间：{{expiresAt}}',
        '',
        '如果这不是您本人的操作，请忽略此邮件。',
      ].join('\n'),
      html: [
        '<p>您好 {{username}}：</p>',
        '<p>请点击下面的链接完成 {{appName}} 邮箱验证（24 小时内有效）：</p>',
        '<p><a href="{{actionUrl}}">{{actionUrl}}</a></p>',
        '<p>链接到期时间：{{expiresAt}}</p>',
        '<p>如果这不是您本人的操作，请忽略此邮件。</p>',
      ].join('\n'),
    },
    'en-US': {
      subject: 'Verify your email',
      text: [
        'Hello {{username}},',
        '',
        'Click the link below to verify your {{appName}} email address (valid for 24 hours):',
        '{{actionUrl}}',
        '',
        'Link expires at: {{expiresAt}}',
        '',
        'If you did not request this, you can ignore this email.',
      ].join('\n'),
      html: [
        '<p>Hello {{username}},</p>',
        '<p>Click the link below to verify your {{appName}} email address (valid for 24 hours):</p>',
        '<p><a href="{{actionUrl}}">{{actionUrl}}</a></p>',
        '<p>Link expires at: {{expiresAt}}</p>',
        '<p>If you did not request this, you can ignore this email.</p>',
      ].join('\n'),
    },
  },
  'reset-password.v1': {
    'zh-CN': {
      subject: '重置您的密码',
      text: [
        '您好 {{username}}：',
        '',
        '我们收到了重置 {{appName}} 账户密码的请求，请在 1 小时内点击下面的链接完成重置：',
        '{{actionUrl}}',
        '',
        '链接到期时间：{{expiresAt}}',
        '',
        '若非本人操作请忽略此邮件，您的密码不会被更改。',
      ].join('\n'),
      html: [
        '<p>您好 {{username}}：</p>',
        '<p>我们收到了重置 {{appName}} 账户密码的请求，请在 1 小时内点击下面的链接完成重置：</p>',
        '<p><a href="{{actionUrl}}">{{actionUrl}}</a></p>',
        '<p>链接到期时间：{{expiresAt}}</p>',
        '<p>若非本人操作请忽略此邮件，您的密码不会被更改。</p>',
      ].join('\n'),
    },
    'en-US': {
      subject: 'Reset your password',
      text: [
        'Hello {{username}},',
        '',
        'We received a request to reset your {{appName}} password. Click the link below within 1 hour to continue:',
        '{{actionUrl}}',
        '',
        'Link expires at: {{expiresAt}}',
        '',
        'If you did not request this, ignore this email and your password will stay unchanged.',
      ].join('\n'),
      html: [
        '<p>Hello {{username}},</p>',
        '<p>We received a request to reset your {{appName}} password. Click the link below within 1 hour to continue:</p>',
        '<p><a href="{{actionUrl}}">{{actionUrl}}</a></p>',
        '<p>Link expires at: {{expiresAt}}</p>',
        '<p>If you did not request this, ignore this email and your password will stay unchanged.</p>',
      ].join('\n'),
    },
  },
  'alert-notification.v1': {
    'zh-CN': {
      subject: '告警通知：{{alertName}}',
      text: [
        '{{appName}} 告警通知',
        '',
        '告警名称：{{alertName}}',
        '严重级别：{{severity}}',
        '相关资产：{{assetName}}',
        '',
        '查看详情：{{actionUrl}}',
      ].join('\n'),
      html: [
        '<p>{{appName}} 告警通知</p>',
        '<p>告警名称：{{alertName}}</p>',
        '<p>严重级别：{{severity}}</p>',
        '<p>相关资产：{{assetName}}</p>',
        '<p><a href="{{actionUrl}}">查看详情</a></p>',
      ].join('\n'),
    },
    'en-US': {
      subject: 'Alert notification: {{alertName}}',
      text: [
        '{{appName}} alert notification',
        '',
        'Alert: {{alertName}}',
        'Severity: {{severity}}',
        'Asset: {{assetName}}',
        '',
        'Details: {{actionUrl}}',
      ].join('\n'),
      html: [
        '<p>{{appName}} alert notification</p>',
        '<p>Alert: {{alertName}}</p>',
        '<p>Severity: {{severity}}</p>',
        '<p>Asset: {{assetName}}</p>',
        '<p><a href="{{actionUrl}}">Details</a></p>',
      ].join('\n'),
    },
  },
};

const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const WHITELIST = new Set<string>(MAIL_TEMPLATE_VARIABLES);

export function normalizeLocale(locale?: string): SupportedLocale {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('en')
    ? 'en-US'
    : 'zh-CN';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stringifyVariable(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function sanitizeReasonFragment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40);
  return sanitized || 'unknown';
}

@Injectable()
export class MailTemplateService {
  hasTemplate(templateId: string): templateId is MailTemplateId {
    return Object.prototype.hasOwnProperty.call(TEMPLATES, templateId);
  }

  render(
    templateId: MailTemplateId,
    locale: string | undefined,
    variables: Partial<Record<MailTemplateVariable, unknown>>,
  ): RenderedMail {
    const definition = TEMPLATES[templateId][normalizeLocale(locale)];
    const sanitizedReasons: string[] = [];

    for (const key of Object.keys(variables ?? {})) {
      if (!WHITELIST.has(key)) {
        sanitizedReasons.push(`unknown_variable:${sanitizeReasonFragment(key)}`);
      }
    }

    const resolveText = (template: string, escape: boolean): string =>
      template.replace(PLACEHOLDER_PATTERN, (_match, name: string) => {
        if (!WHITELIST.has(name)) {
          sanitizedReasons.push(`unknown_variable:${sanitizeReasonFragment(name)}`);
          return '';
        }
        const value = (variables ?? {})[name as MailTemplateVariable];
        const text = stringifyVariable(value);
        if (!text) {
          sanitizedReasons.push(`empty_variable:${name}`);
          return '';
        }
        return escape ? escapeHtml(text) : text;
      });

    return {
      subject: resolveText(definition.subject, false),
      text: resolveText(definition.text, false),
      html: resolveText(definition.html, true),
      templateVersion: TEMPLATE_VERSION,
      sanitizedReasons: [...new Set(sanitizedReasons)],
    };
  }
}
