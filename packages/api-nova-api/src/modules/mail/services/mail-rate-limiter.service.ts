import { Injectable } from '@nestjs/common';

const WINDOW_MS = 60 * 60 * 1000;

/**
 * In-process sliding-window limiter keyed by recipient + template. Delivery
 * attempts consume quota; policy rejections never reach this point.
 */
@Injectable()
export class MailRateLimiterService {
  private readonly attempts = new Map<string, number[]>();

  tryConsume(
    recipient: string,
    templateId: string,
    limit: number,
    now: number = Date.now(),
  ): boolean {
    const key = `${recipient.trim().toLowerCase()}|${templateId}`;
    const windowStart = now - WINDOW_MS;
    const recent = (this.attempts.get(key) ?? []).filter(
      (timestamp) => timestamp > windowStart,
    );

    if (recent.length >= Math.max(limit, 1)) {
      this.attempts.set(key, recent);
      return false;
    }

    recent.push(now);
    this.attempts.set(key, recent);
    return true;
  }

  reset(): void {
    this.attempts.clear();
  }
}
