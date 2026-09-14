export const MANAGEMENT_JWT_SECRET_ERROR =
  'JWT_SECRET must be explicitly configured with a non-placeholder secret of at least 32 characters and no whitespace or control characters';

export function requireManagementJwtSecret(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 32 ||
    value === 'default-secret-key' ||
    /[\s\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(MANAGEMENT_JWT_SECRET_ERROR);
  }

  return value;
}
