import * as net from 'node:net';
import * as tls from 'node:tls';
import { MailTransport } from './mail-transport.interface';
import { OutboundMail } from '../mail.types';

export interface SmtpTransportOptions {
  host?: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  timeoutMs?: number;
  clientName?: string;
}

const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Minimal RFC5321 client over node:net / node:tls. Fail-closed on any
 * unexpected reply, timeout or socket error. No third-party transport.
 */
export class SmtpMailTransport implements MailTransport {
  readonly name = 'smtp' as const;

  constructor(private readonly options: SmtpTransportOptions) {}

  async send(message: OutboundMail): Promise<void> {
    const { host, port, secure, user, password } = this.options;
    if (!host) {
      throw new Error('SMTP host is not configured');
    }
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const socket: net.Socket = secure
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });
    const session = new SmtpSession(socket, timeoutMs);

    try {
      await session.expect([220], 'greeting');
      await session.command(
        `EHLO ${this.options.clientName ?? 'api-nova'}`,
        [250],
        'EHLO',
      );

      if (user) {
        await session.command('AUTH LOGIN', [334], 'AUTH LOGIN');
        await session.command(
          Buffer.from(user, 'utf8').toString('base64'),
          [334],
          'AUTH username',
        );
        await session.command(
          Buffer.from(password ?? '', 'utf8').toString('base64'),
          [235],
          'AUTH password',
        );
      }

      await session.command(`MAIL FROM:<${message.from}>`, [250], 'MAIL FROM');
      await session.command(`RCPT TO:<${message.to}>`, [250, 251], 'RCPT TO');
      await session.command('DATA', [354], 'DATA');
      await session.data(buildRfc5322Message(message), [250]);
      await session.command('QUIT', [221], 'QUIT').catch(() => undefined);
    } finally {
      session.close();
    }
  }
}

class SmtpSession {
  private buffer = '';
  private pending: {
    resolve: (reply: string) => void;
    reject: (error: Error) => void;
  } | null = null;
  private failure: Error | null = null;

  constructor(
    private readonly socket: net.Socket,
    timeoutMs: number,
  ) {
    this.socket.setTimeout(timeoutMs);
    this.socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      this.pump();
    });
    this.socket.on('error', (error: Error) =>
      this.fail(new Error(`SMTP socket error: ${error.message}`)),
    );
    this.socket.on('timeout', () =>
      this.fail(new Error('SMTP connection timed out')),
    );
    this.socket.on('close', () =>
      this.fail(new Error('SMTP connection closed before completion')),
    );
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      pending.reject(error);
    }
  }

  private pump(): void {
    if (!this.pending) return;
    try {
      const reply = extractReply(this.buffer);
      if (!reply) return;
      this.buffer = this.buffer.slice(reply.consumed);
      const pending = this.pending;
      this.pending = null;
      pending.resolve(reply.text);
    } catch (error) {
      this.fail(error as Error);
    }
  }

  private readReply(): Promise<string> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) {
      return Promise.reject(new Error('SMTP session already awaiting a reply'));
    }
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.pump();
    });
  }

  async expect(expected: number[], label: string): Promise<string> {
    const reply = await this.readReply();
    const code = Number(reply.slice(0, 3));
    if (!expected.includes(code)) {
      throw new Error(`SMTP ${label} failed with code ${code}`);
    }
    return reply;
  }

  async command(payload: string, expected: number[], label: string): Promise<string> {
    this.write(`${payload}\r\n`);
    return this.expect(expected, label);
  }

  async data(payload: string, expected: number[]): Promise<string> {
    this.write(`${dotStuff(payload)}\r\n.\r\n`);
    return this.expect(expected, 'DATA body');
  }

  private write(chunk: string): void {
    if (this.failure) throw this.failure;
    this.socket.write(chunk, 'utf8');
  }

  close(): void {
    try {
      this.socket.destroy();
    } catch {
      // Socket already closed.
    }
  }
}

function extractReply(buffer: string): { text: string; consumed: number } | null {
  let index = 0;
  const lines: string[] = [];
  while (true) {
    const lineEnd = buffer.indexOf('\r\n', index);
    if (lineEnd === -1) return null;
    const line = buffer.slice(index, lineEnd);
    index = lineEnd + 2;
    if (!/^\d{3}[ -]/.test(line) || line.length < 4) {
      throw new Error('SMTP malformed server reply');
    }
    lines.push(line);
    if (line[3] === ' ') {
      return { text: lines.join('\n'), consumed: index };
    }
  }
}

function dotStuff(payload: string): string {
  return payload
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
}

function encodeHeader(value: string): string {
  const flattened = value.replace(/[\r\n]+/g, ' ').trim();
  if (/^[\x20-\x7E]*$/.test(flattened)) return flattened;
  return `=?UTF-8?B?${Buffer.from(flattened, 'utf8').toString('base64')}?=`;
}

function wrapBase64(value: string): string {
  return value.replace(/(.{76})/g, '$1\r\n').replace(/\r\n$/, '');
}

export function buildRfc5322Message(message: OutboundMail): string {
  const boundary = `api-nova-${message.messageId}`;
  const headers = [
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${message.messageId}@api-nova.local>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(Buffer.from(message.text, 'utf8').toString('base64')),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(Buffer.from(message.html, 'utf8').toString('base64')),
    `--${boundary}--`,
  ];
  return [...headers, '', ...body].join('\r\n');
}
