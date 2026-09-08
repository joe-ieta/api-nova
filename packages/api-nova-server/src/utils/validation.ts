import type { CustomHeaders, OperationFilter } from 'api-nova-parser';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const fields: Record<string, readonly string[]> = {
  methods: ['include', 'exclude'],
  paths: ['include', 'exclude'],
  operationIds: ['include', 'exclude'],
  tags: ['include', 'exclude'],
  statusCodes: ['include', 'exclude'],
  parameters: ['required', 'forbidden'],
};
const methods = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE']);

export function validateOperationFilter(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: ['Operation filter must be an object'], warnings: [] };
  }
  for (const [field, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (field === 'customFilter') {
      if (typeof value !== 'function') errors.push('customFilter must be a function');
      continue;
    }
    const keys = fields[field];
    if (!keys || !value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${field} must use the current structured filter format`);
      continue;
    }
    for (const [key, entries] of Object.entries(value)) {
      if (entries === undefined) continue;
      if (!keys.includes(key) || !Array.isArray(entries)) {
        errors.push(`Invalid filter field: ${field}.${key}`);
        continue;
      }
      if (entries.some((entry) => field === 'statusCodes'
        ? typeof entry !== 'number' || !Number.isInteger(entry) || entry < 100 || entry > 599
        : typeof entry !== 'string' || !entry.trim() ||
          (field === 'methods' && !methods.has(entry.trim().toUpperCase())))) {
        errors.push(`Invalid filter values: ${field}.${key}`);
      }
    }
  }
  return { valid: errors.length === 0, errors, warnings: [] };
}

export function normalizeOperationFilter(input: unknown): OperationFilter {
  const result = validateOperationFilter(input);
  if (!result.valid) throw new Error(result.errors.join('; '));
  const normalized: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (field === 'customFilter') {
      normalized[field] = value;
      continue;
    }
    normalized[field] = Object.fromEntries(
      Object.entries(value as Record<string, unknown[]>)
        .filter(([, entries]) => entries !== undefined)
        .map(([key, entries]) => [key, entries.map((entry) =>
          typeof entry === 'string'
            ? field === 'methods' ? entry.trim().toUpperCase() : entry.trim()
            : entry)]),
    );
  }
  return normalized as OperationFilter;
}

export function assertStructuredHeaders(value: unknown): asserts value is CustomHeaders {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['static', 'env', 'dynamic', 'conditional'].includes(key))) {
    throw new Error('Custom headers must use the current structured format');
  }
  for (const key of ['static', 'env'] as const) {
    const headers = (value as CustomHeaders)[key];
    if (headers !== undefined && (!headers || typeof headers !== 'object' || Array.isArray(headers) ||
        Object.entries(headers).some(([name, content]) => !name.trim() || typeof content !== 'string'))) {
      throw new Error('Invalid custom headers ' + key);
    }
  }
  const headers = value as CustomHeaders;
  if (headers.conditional !== undefined && !Array.isArray(headers.conditional)) {
    throw new Error('Conditional headers must be an array');
  }
}
