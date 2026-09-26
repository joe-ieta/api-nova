import { MailTransportKind, OutboundMail } from '../mail.types';

export interface MailTransport {
  readonly name: MailTransportKind;
  send(message: OutboundMail): Promise<void>;
}
