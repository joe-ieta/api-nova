/**
 * Thrown for policy rejections (mail disabled, recipient not allowed, rate
 * limited). These are configuration decisions and must not be retried.
 */
export class MailRejectedError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? `Mail rejected: ${code}`);
    this.name = 'MailRejectedError';
  }
}
