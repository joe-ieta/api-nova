import * as crypto from 'crypto';

/**
 * Generate a CSPRNG-backed token. 32 bytes of entropy encoded as base64url
 * (43 characters) is the minimum for one-time email/reset tokens.
 */
export function generateSecureToken(bytes: number = 32): string {
  return crypto.randomBytes(Math.max(bytes, 32)).toString('base64url');
}

/** Digest persisted for one-time tokens. Plaintext is never stored. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}
