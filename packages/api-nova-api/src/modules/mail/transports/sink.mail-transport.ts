import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { MailTransport } from './mail-transport.interface';
import { OutboundMail } from '../mail.types';

const SINK_FILE = 'mail.jsonl';

/**
 * Controlled acceptance transport: appends one JSONL line per message to the
 * configured directory. Never used for real delivery.
 */
export class SinkMailTransport implements MailTransport {
  readonly name = 'sink' as const;

  constructor(private readonly directory: string) {}

  async send(message: OutboundMail): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const line = JSON.stringify({
      messageId: message.messageId,
      timestamp: new Date().toISOString(),
      toMasked: message.toMasked,
      templateId: message.templateId,
      templateVersion: message.templateVersion,
      subject: message.subject,
      text: message.text,
      html: message.html,
      transport: 'sink',
      result: 'sent',
    });
    await appendFile(join(this.directory, SINK_FILE), `${line}\n`, 'utf8');
  }
}
