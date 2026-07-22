const PREFIX = 'env-headers:';
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const BLOCKED_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function resolveRuntimeCredentialRefHeaders(
  credentialRef: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (credentialRef === undefined || credentialRef === null || credentialRef === '') return {};
  if (typeof credentialRef !== 'string' || !credentialRef.startsWith(PREFIX)) {
    throw new Error("Runtime credentialRef must use 'env-headers:Header=ENV_NAME' syntax");
  }
  const mappings = credentialRef.slice(PREFIX.length).split(';').map(item => item.trim()).filter(Boolean);
  if (mappings.length === 0 || mappings.length > 32) {
    throw new Error('Runtime credentialRef must define between 1 and 32 header mappings');
  }
  const headers: Record<string, string> = {};
  const names = new Set<string>();
  for (const mapping of mappings) {
    const separator = mapping.indexOf('=');
    const headerName = separator > 0 ? mapping.slice(0, separator).trim() : '';
    const environmentName = separator > 0 ? mapping.slice(separator + 1).trim() : '';
    const normalizedHeader = headerName.toLowerCase();
    if (!HEADER_NAME.test(headerName) || BLOCKED_HEADERS.has(normalizedHeader)) {
      throw new Error(`Runtime credentialRef contains forbidden header '${headerName}'`);
    }
    if (!ENV_NAME.test(environmentName)) {
      throw new Error(`Runtime credentialRef contains invalid environment variable '${environmentName}'`);
    }
    if (names.has(normalizedHeader)) {
      throw new Error(`Runtime credentialRef contains duplicate header '${headerName}'`);
    }
    const value = environment[environmentName];
    if (!value) {
      throw new Error(`Runtime credential environment variable '${environmentName}' is not configured`);
    }
    if (value.length > 8192 || /[\r\n]/.test(value)) {
      throw new Error(`Runtime credential environment variable '${environmentName}' is not a safe header value`);
    }
    names.add(normalizedHeader);
    headers[normalizedHeader] = value;
  }
  return headers;
}
