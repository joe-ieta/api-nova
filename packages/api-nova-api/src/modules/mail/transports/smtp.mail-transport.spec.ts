import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import { OutboundMail } from '../mail.types';
import { SmtpMailTransport } from './smtp.mail-transport';

interface FakeSmtpServer {
  port: number;
  received: string[];
  authSteps: string[];
  close: () => Promise<void>;
}

/** Loopback-only fake SMTP server; never resolves external hosts. */
function startFakeSmtpServer(options: { failRcpt?: boolean } = {}): Promise<FakeSmtpServer> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('220 fake.local ESMTP\r\n');

    let buffer = '';
    let inData = false;
    let dataLines: string[] = [];
    let authStage = 0;

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const lineEnd = buffer.indexOf('\r\n');
        if (lineEnd === -1) break;
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            receive(dataLines.join('\r\n'));
            dataLines = [];
            socket.write('250 message accepted\r\n');
          } else {
            dataLines.push(line);
          }
          continue;
        }

        if (line.startsWith('EHLO')) {
          socket.write('250-fake.local\r\n250 OK\r\n');
        } else if (line === 'AUTH LOGIN') {
          authSteps.push('AUTH LOGIN');
          authStage = 1;
          socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (authStage === 1) {
          authSteps.push(`user:${line}`);
          authStage = 2;
          socket.write('334 UGFzc3dvcmQ6\r\n');
        } else if (authStage === 2) {
          authSteps.push(`password:${line}`);
          authStage = 3;
          socket.write('235 authenticated\r\n');
        } else if (line.startsWith('MAIL FROM')) {
          socket.write('250 OK\r\n');
        } else if (line.startsWith('RCPT TO')) {
          socket.write(options.failRcpt ? '550 relay denied\r\n' : '250 OK\r\n');
        } else if (line === 'DATA') {
          inData = true;
          socket.write('354 start mail input\r\n');
        } else if (line === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else {
          socket.write('250 OK\r\n');
        }
      }
    });
  });

  const received: string[] = [];
  const authSteps: string[] = [];
  const receive = (message: string) => received.push(message);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Fake SMTP server did not expose a port'));
        return;
      }
      resolve({
        port: address.port,
        received,
        authSteps,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

const buildMessage = (): OutboundMail => ({
  messageId: randomUUID(),
  from: 'no-reply@example.test',
  to: 'recipient@example.test',
  subject: '[MAIL-TEST] 验证您的邮箱',
  text: '请点击链接完成验证：http://localhost:5173/verify-email?token=abc',
  html: '<p>请点击链接完成验证：<a href="http://localhost:5173/verify-email?token=abc">验证</a></p>',
  templateId: 'verify-email.v1',
  templateVersion: '1',
  toMasked: 'r***@example.test',
});

describe('SmtpMailTransport loopback (MAIL-02)', () => {
  jest.setTimeout(15000);

  it('delivers an RFC5322 multipart message over a loopback SMTP session', async () => {
    const server = await startFakeSmtpServer();
    try {
      const transport = new SmtpMailTransport({
        host: '127.0.0.1',
        port: server.port,
        secure: false,
        timeoutMs: 5000,
      });
      const message = buildMessage();

      await transport.send(message);

      expect(server.received).toHaveLength(1);
      const raw = server.received[0];
      expect(raw).toContain('From: no-reply@example.test');
      expect(raw).toContain('To: recipient@example.test');
      expect(raw).toContain('MIME-Version: 1.0');
      expect(raw).toContain('multipart/alternative');
      expect(raw).toContain(`<${message.messageId}@api-nova.local>`);
      expect(raw).toContain('Subject: =?UTF-8?B?');
      expect(raw).not.toContain('AUTH');

      const textPart = raw.match(
        /Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/,
      );
      const decodedText = Buffer.from(
        (textPart?.[1] ?? '').replace(/\r\n/g, ''),
        'base64',
      ).toString('utf8');
      expect(decodedText).toBe(message.text);
    } finally {
      await server.close();
    }
  });

  it('performs AUTH LOGIN only when SMTP credentials are configured', async () => {
    const server = await startFakeSmtpServer();
    try {
      const transport = new SmtpMailTransport({
        host: '127.0.0.1',
        port: server.port,
        secure: false,
        user: 'smtp-user',
        password: 'smtp-password',
        timeoutMs: 5000,
      });

      await transport.send(buildMessage());

      expect(server.authSteps).toEqual([
        'AUTH LOGIN',
        `user:${Buffer.from('smtp-user').toString('base64')}`,
        `password:${Buffer.from('smtp-password').toString('base64')}`,
      ]);
    } finally {
      await server.close();
    }
  });

  it('fails closed on unexpected replies without retrying inside the transport', async () => {
    const server = await startFakeSmtpServer({ failRcpt: true });
    try {
      const transport = new SmtpMailTransport({
        host: '127.0.0.1',
        port: server.port,
        secure: false,
        timeoutMs: 5000,
      });

      await expect(transport.send(buildMessage())).rejects.toThrow(
        /SMTP RCPT TO failed with code 550/,
      );
      expect(server.received).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});
