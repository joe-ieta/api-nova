/** Internal secret checks. Static errors only; callers map them to their own safe code. */
export function checkedCredentialSecret(value: unknown): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || Buffer.byteLength(value, 'utf8') > 8192 || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.from(value, 'utf8').toString('utf8') !== value) throw new Error('SECRET_RESOLUTION_FAILED');
  return value;
}
export function basicCredentialHeader(username: unknown, password: unknown): string {
  const user = checkedCredentialSecret(username), pass = checkedCredentialSecret(password);
  if (user.includes(':')) throw new Error('SECRET_RESOLUTION_FAILED');
  const result = 'Basic ' + Buffer.from(user + ':' + pass, 'utf8').toString('base64');
  if (Buffer.byteLength(result) > 8192) throw new Error('SECRET_RESOLUTION_FAILED');
  return result;
}

export function checkedSingleCredentialSecret(value: unknown, type: 'bearer' | 'apiKey' | 'customHeader'): string {
  const secret = checkedCredentialSecret(value);
  if (/[^\x20-\xff]/.test(secret) || (type === 'bearer' && (/\s/.test(secret) || Buffer.byteLength('Bearer ' + secret) > 8192))) throw new Error('SECRET_RESOLUTION_FAILED');
  return secret;
}
