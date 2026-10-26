import 'reflect-metadata';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { AppConfigService } from '../../../config/app-config.service';
import {
  AuditLog,
  AuditLevel,
  AuditStatus,
} from '../../../database/entities/audit-log.entity';
import { Permission } from '../../../database/entities/permission.entity';
import { Role } from '../../../database/entities/role.entity';
import { User, UserStatus } from '../../../database/entities/user.entity';
import { hashToken } from '../../../utils/secure-token';
import { MailRateLimiterService } from '../../mail/services/mail-rate-limiter.service';
import { MailService } from '../../mail/services/mail.service';
import { MailTemplateService } from '../../mail/services/mail-template.service';
import { AuditService } from './audit.service';
import { AuthService } from './auth.service';
import { RoleService } from './role.service';
import { UserService } from './user.service';

interface SinkEntry {
  messageId: string;
  toMasked: string;
  templateId: string;
  subject: string;
  text: string;
  html: string;
}

interface Harness {
  db: DataSource;
  authService: AuthService;
  userService: UserService;
  config: Record<string, unknown>;
  sinkDir: string;
  readSink: () => SinkEntry[];
  logMessages: string[];
}

const IP = '127.0.0.1';
const UA = 'jest-mail-02';

describe('Auth mail delivery end-to-end (MAIL-02)', () => {
  jest.setTimeout(60000);

  let harness: Harness;
  let createdSinkDir: string | null;

  const extractToken = (entry: SinkEntry): string => {
    const match = entry.text.match(/https?:\/\/\S+/);
    if (!match) throw new Error('Sink entry does not contain an action link');
    return new URL(match[0]).searchParams.get('token') as string;
  };

  beforeEach(async () => {
    const savedSinkDir = process.env.MAIL_SINK_DIR;
    createdSinkDir = savedSinkDir ? null : mkdtempSync(join(tmpdir(), 'api-nova-auth-mail-'));
    const sinkDir = savedSinkDir ?? (createdSinkDir as string);
    rmSync(join(sinkDir, 'mail.jsonl'), { force: true });

    process.env.JWT_SECRET = 'mail-02-jest-secret';
    process.env.JWT_REFRESH_SECRET = 'mail-02-jest-refresh-secret';
    process.env.JWT_EXPIRES_IN = '15m';

    const db = await new DataSource({
      type: 'sqljs',
      synchronize: true,
      entities: [User, Role, Permission, AuditLog],
    }).initialize();

    const userRepository = db.getRepository(User);
    const auditService = new AuditService(db.getRepository(AuditLog), userRepository);
    const config: Record<string, unknown> = {
      mailEnabled: true,
      mailTransport: 'sink',
      mailSinkDir: sinkDir,
      mailSmtpHost: undefined,
      mailSmtpPort: 587,
      mailSmtpSecure: false,
      mailSmtpUser: undefined,
      mailSmtpPassword: undefined,
      mailFrom: 'no-reply@example.test',
      mailAllowedRecipients: ['user@example.test', 'bob@example.test', 'carol@example.test', 'dave@example.test'],
      mailSubjectPrefix: '[MAIL-TEST] ',
      mailRateLimitPerHour: 10,
      mailActionBaseUrl: 'http://localhost:5173',
    };
    const mailService = new MailService(
      config as unknown as AppConfigService,
      auditService,
      new MailTemplateService(),
      new MailRateLimiterService(),
    );
    const userService = new UserService(
      userRepository,
      db.getRepository(Role),
      auditService,
    );
    const roleService = new RoleService(
      db.getRepository(Role),
      db.getRepository(Permission),
      userRepository,
      auditService,
    );
    const authService = new AuthService(
      userRepository,
      new JwtService({}),
      userService,
      auditService,
      roleService,
      mailService,
    );

    const logMessages: string[] = [];
    for (const method of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, method).mockImplementation((message: any) => {
        logMessages.push(String(message));
        return undefined as never;
      });
    }

    harness = {
      db,
      authService,
      userService,
      config,
      sinkDir,
      logMessages,
      readSink: () => {
        const file = join(sinkDir, 'mail.jsonl');
        if (!existsSync(file)) return [];
        return readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as SinkEntry);
      },
    };
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (harness?.db?.isInitialized) {
      await harness.db.destroy();
    }
    if (createdSinkDir) {
      const target = resolve(createdSinkDir);
      if (
        dirname(target) !== resolve(tmpdir()) ||
        !basename(target).startsWith('api-nova-auth-mail-')
      ) {
        throw new Error('Unsafe sink directory cleanup');
      }
      rmSync(target, { recursive: true, force: true });
      createdSinkDir = null;
    }
  });

  it('registers, stores only a SHA-256 digest, and delivers zh-CN verification mail', async () => {
    const response = await harness.authService.register(
      {
        username: 'alice',
        email: 'user@example.test',
        password: 'StrongPass1!',
      },
      IP,
      UA,
    );

    expect(response.status).toBe(UserStatus.PENDING);
    expect(response).not.toHaveProperty('emailVerificationToken');
    expect(response).not.toHaveProperty('emailVerificationExpiresAt');

    const stored = await harness.db
      .getRepository(User)
      .findOneByOrFail({ username: 'alice' });
    expect(stored.emailVerificationToken).toMatch(/^[0-9a-f]{64}$/);
    const remainingMs =
      (stored.emailVerificationExpiresAt as Date).getTime() - Date.now();
    expect(remainingMs).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(remainingMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);

    const entries = harness.readSink();
    expect(entries).toHaveLength(1);
    expect(entries[0].templateId).toBe('verify-email.v1');
    expect(entries[0].toMasked).toBe('u***@example.test');
    expect(entries[0].subject).toBe('[MAIL-TEST] 验证您的邮箱');
    expect(entries[0].text).toContain('邮箱验证');
    expect(entries[0].text).toContain('24 小时');

    const token = extractToken(entries[0]);
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(stored.emailVerificationToken).toBe(hashToken(token));
    expect(readFileSync(join(harness.sinkDir, 'mail.jsonl'), 'utf8')).toContain(token);

    const auditDump = JSON.stringify(await harness.db.getRepository(AuditLog).find());
    expect(auditDump).not.toContain(token);
    expect(harness.logMessages.join('\n')).not.toContain(token);
  });

  it('verifies once, rejects wrong, reused and expired tokens generically', async () => {
    await harness.authService.register(
      { username: 'alice', email: 'user@example.test', password: 'StrongPass1!' },
      IP,
      UA,
    );
    const token = extractToken(harness.readSink()[0]);

    await expect(
      harness.authService.verifyEmail('not-a-real-token', IP),
    ).rejects.toThrow('验证令牌无效或已过期');

    await harness.authService.verifyEmail(token, IP);
    const verified = await harness.db
      .getRepository(User)
      .findOneByOrFail({ username: 'alice' });
    expect(verified.emailVerified).toBe(true);
    expect(verified.status).toBe(UserStatus.ACTIVE);
    expect(verified.emailVerificationToken).toBeNull();
    expect(verified.emailVerificationExpiresAt).toBeNull();

    await expect(harness.authService.verifyEmail(token, IP)).rejects.toThrow(
      '验证令牌无效或已过期',
    );

    await harness.authService.register(
      { username: 'expired', email: 'bob@example.test', password: 'StrongPass1!' },
      IP,
      UA,
    );
    const expiredToken = extractToken(harness.readSink()[1]);
    const expiredUser = await harness.db
      .getRepository(User)
      .findOneByOrFail({ username: 'expired' });
    expiredUser.emailVerificationExpiresAt = new Date(Date.now() - 1000);
    await harness.db.getRepository(User).save(expiredUser);

    await expect(
      harness.authService.verifyEmail(expiredToken, IP),
    ).rejects.toThrow('验证令牌无效或已过期');

    const audits = await harness.db.getRepository(AuditLog).find({ where: { resource: 'auth' } });
    expect(audits.some((entry) => entry.status === AuditStatus.FAILED)).toBe(true);
    expect(JSON.stringify(audits)).not.toContain(token);
    expect(harness.logMessages.join('\n')).not.toContain(token);
  });

  it('resets the password with a one-time link and revokes existing sessions', async () => {
    await harness.authService.register(
      { username: 'bob', email: 'bob@example.test', password: 'StrongPass1!' },
      IP,
      UA,
    );
    const verifyToken = extractToken(harness.readSink()[0]);
    await harness.authService.verifyEmail(verifyToken, IP);

    const login = await harness.authService.login(
      { username: 'bob', password: 'StrongPass1!' },
      IP,
      UA,
    );
    expect(login.refreshToken).toBeTruthy();

    await harness.authService.forgotPassword({ email: 'bob@example.test' }, IP);
    const resetEntry = harness.readSink().find(
      (entry) => entry.templateId === 'reset-password.v1',
    ) as SinkEntry;
    expect(resetEntry).toBeTruthy();
    expect(resetEntry.text).toContain('重置');
    expect(resetEntry.text).toContain('若非本人操作请忽略此邮件');
    const resetToken = extractToken(resetEntry);

    const resetUser = await harness.db
      .getRepository(User)
      .findOneByOrFail({ username: 'bob' });
    expect(resetUser.passwordResetToken).toBe(hashToken(resetToken));
    expect(resetUser.passwordResetToken).not.toBe(resetToken);

    await harness.authService.resetPassword(
      { token: resetToken, newPassword: 'NewStrong2!' },
      IP,
      UA,
    );

    await expect(
      harness.authService.refreshToken(login.refreshToken, IP, UA),
    ).rejects.toThrow();

    await expect(
      harness.authService.resetPassword(
        { token: resetToken, newPassword: 'Another3!' },
        IP,
        UA,
      ),
    ).rejects.toThrow('重置令牌无效或已过期');

    await expect(
      harness.authService.login(
        { username: 'bob', password: 'StrongPass1!' },
        IP,
        UA,
      ),
    ).rejects.toThrow();

    const relogin = await harness.authService.login(
      { username: 'bob', password: 'NewStrong2!' },
      IP,
      UA,
    );
    expect(relogin.accessToken).toBeTruthy();

    const auditDump = JSON.stringify(await harness.db.getRepository(AuditLog).find());
    expect(auditDump).not.toContain(resetToken);
    expect(auditDump).not.toContain(verifyToken);
    expect(harness.logMessages.join('\n')).not.toContain(resetToken);
  });

  it('keeps the registration response unchanged when the transport fails', async () => {
    harness.config.mailTransport = 'smtp';
    harness.config.mailSmtpHost = '127.0.0.1';
    harness.config.mailSmtpPort = 1;

    const response = await harness.authService.register(
      { username: 'carol', email: 'carol@example.test', password: 'StrongPass1!' },
      IP,
      UA,
    );

    expect(response.username).toBe('carol');
    expect(response.status).toBe(UserStatus.PENDING);
    expect(harness.readSink()).toHaveLength(0);

    const stored = await harness.db
      .getRepository(User)
      .findOneByOrFail({ username: 'carol' });
    expect(stored.emailVerificationToken).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.emailVerified).toBe(false);

    const failedMail = await harness.db.getRepository(AuditLog).find({
      where: { resource: 'mail', status: AuditStatus.FAILED },
    });
    expect(failedMail).toHaveLength(1);
    expect(failedMail[0].details).toMatchObject({
      channel: 'email',
      templateId: 'verify-email.v1',
      result: 'FAILED',
      toMasked: 'c***@example.test',
    });
    expect(failedMail[0].level).toBe(AuditLevel.ERROR);
  });

  it('resends verification generically and only when the account is eligible', async () => {
    await harness.authService.register(
      { username: 'dave', email: 'dave@example.test', password: 'StrongPass1!' },
      IP,
      UA,
    );
    const firstDigest = (
      await harness.db.getRepository(User).findOneByOrFail({ username: 'dave' })
    ).emailVerificationToken as string;

    await harness.authService.resendVerification('nobody@example.test', IP);
    expect(harness.readSink()).toHaveLength(1);

    await harness.authService.resendVerification('dave@example.test', IP);
    expect(harness.readSink()).toHaveLength(2);
    const secondDigest = (
      await harness.db.getRepository(User).findOneByOrFail({ username: 'dave' })
    ).emailVerificationToken as string;
    expect(secondDigest).not.toBe(firstDigest);

    const verified = await harness.db
      .getRepository(User)
      .findOneByOrFail({ username: 'dave' });
    verified.emailVerified = true;
    await harness.db.getRepository(User).save(verified);

    await harness.authService.resendVerification('dave@example.test', IP);
    expect(harness.readSink()).toHaveLength(2);
  });
});
