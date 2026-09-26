const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeRecipient(address: string | undefined | null): string {
  return (address ?? '').trim();
}

export function isValidRecipient(address: string): boolean {
  return EMAIL_PATTERN.test(address.trim());
}

export function isAllowedRecipient(
  address: string,
  allowedRecipients: string[],
): boolean {
  const normalized = address.trim().toLowerCase();
  return allowedRecipients.some(
    (candidate) => candidate.trim().toLowerCase() === normalized,
  );
}

/** Mask a recipient as a***@domain; never emits the full local part. */
export function maskEmail(address: string | undefined | null): string {
  const value = (address ?? '').trim();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) {
    return '***';
  }
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  return `${local.slice(0, 1)}***@${domain}`;
}
