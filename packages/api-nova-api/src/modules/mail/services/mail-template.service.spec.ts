import { MailTemplateService } from './mail-template.service';

describe('MailTemplateService (MAIL-02)', () => {
  const service = new MailTemplateService();

  it('renders zh-CN by default with the action link and expiry', () => {
    const rendered = service.render('verify-email.v1', undefined, {
      appName: 'ApiNova',
      username: '测试用户',
      emailMasked: 'u***@example.test',
      actionUrl: 'http://localhost:5173/verify-email?token=abc',
      expiresAt: '2026-09-27T00:00:00.000Z',
    });

    expect(rendered.subject).toBe('验证您的邮箱');
    expect(rendered.text).toContain('邮箱验证');
    expect(rendered.text).toContain('http://localhost:5173/verify-email?token=abc');
    expect(rendered.text).toContain('2026-09-27T00:00:00.000Z');
    expect(rendered.html).toContain('href="http://localhost:5173/verify-email?token=abc"');
    expect(rendered.sanitizedReasons).toEqual([]);
  });

  it('renders en-US when the locale is English', () => {
    const rendered = service.render('reset-password.v1', 'en-US', {
      appName: 'ApiNova',
      username: 'alice',
      actionUrl: 'http://localhost:5173/reset-password?token=abc',
      expiresAt: '2026-09-27T00:00:00.000Z',
    });

    expect(rendered.subject).toBe('Reset your password');
    expect(rendered.text).toContain('ignore this email');
  });

  it('leaves unknown variables empty and records a sanitized reason', () => {
    const rendered = service.render('verify-email.v1', 'zh-CN', {
      username: 'alice',
      actionUrl: '<script>alert(1)</script>',
      expiresAt: undefined,
      bogusVariable: 'should-not-render',
    } as any);

    expect(rendered.text).not.toContain('bogusVariable');
    expect(rendered.text).not.toContain('should-not-render');
    expect(rendered.sanitizedReasons).toContain('unknown_variable:bogusVariable');
    expect(rendered.sanitizedReasons).toContain('empty_variable:expiresAt');
  });

  it('escapes html variables and keeps templates free of scripts and remote images', () => {
    const rendered = service.render('alert-notification.v1', 'zh-CN', {
      appName: 'ApiNova',
      alertName: '<img src="http://evil.test/x.png">',
      severity: 'error',
      assetName: 'runtime-a',
      actionUrl: 'http://localhost:5173/alerts/1',
    });

    expect(rendered.html).not.toMatch(/<img[\s>]/i);
    expect(rendered.html).toContain('&lt;img');
    expect(rendered.html).not.toMatch(/<script[\s>]/i);
  });

  it('rejects unknown template identifiers', () => {
    expect(service.hasTemplate('verify-email.v1')).toBe(true);
    expect(service.hasTemplate('made-up.v9')).toBe(false);
  });
});
