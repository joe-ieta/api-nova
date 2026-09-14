import type { OpenAPISpec } from '../types';

/** Supplied only by trusted application code, never inferred from tool arguments or OpenAPI extensions. */
export interface TrustedOperationBinding {
  readonly method: string;
  readonly path: string;
  readonly endpointDefinitionId: string;
  readonly sourceServiceAssetId: string;
}
export class TrustedOperationBindingError extends Error {
  constructor(readonly code: 'INVALID_TRUSTED_OPERATION_BINDING' | 'DUPLICATE_TRUSTED_OPERATION_BINDING' |
    'UNKNOWN_TRUSTED_OPERATION' | 'MISSING_TRUSTED_OPERATION_BINDING') {
    super(code);
    this.name = 'TrustedOperationBindingError';
  }
}
export interface CompiledTrustedOperationBindings {
  get(method: string, path: string): Readonly<TrustedOperationBinding>;
}
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE']);
const FIELDS = ['method', 'path', 'endpointDefinitionId', 'sourceServiceAssetId'];
function invalid(): never { throw new TrustedOperationBindingError('INVALID_TRUSTED_OPERATION_BINDING'); }
function key(method: string, path: string): string { return JSON.stringify([method.toUpperCase(), path]); }

/** Immutable routing-identity snapshot, not a database ownership check or destination authorization. */
export function compileTrustedOperationBindings(spec: OpenAPISpec,
  bindings: readonly TrustedOperationBinding[]): CompiledTrustedOperationBindings {
  if (!Array.isArray(bindings)) invalid();
  const entries = new Map<string, Readonly<TrustedOperationBinding>>();
  for (const input of bindings) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
    const fields = Reflect.ownKeys(input);
    if (fields.length !== FIELDS.length || fields.some(field => typeof field !== 'string' || !FIELDS.includes(field))) invalid();
    const values: Record<string, unknown> = Object.create(null);
    for (const field of FIELDS) {
      const property = Object.getOwnPropertyDescriptor(input, field);
      if (!property || !('value' in property) || typeof property.value !== 'string') invalid();
      values[field] = property.value;
    }
    const method = (values.method as string).toUpperCase(), path = values.path as string;
    if (!METHODS.has(method) || !path.startsWith('/') || /[\u0000-\u001f\u007f?#\\]/.test(path)) invalid();
    for (const field of ['endpointDefinitionId', 'sourceServiceAssetId']) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(values[field] as string)) invalid();
    }
    if (!Object.hasOwnProperty.call(spec.paths, path) ||
      !Object.hasOwnProperty.call(spec.paths[path], method.toLowerCase()) ||
      !Object.getOwnPropertyDescriptor(spec.paths[path], method.toLowerCase())?.value) throw new TrustedOperationBindingError('UNKNOWN_TRUSTED_OPERATION');
    const identity = key(method, path);
    if (entries.has(identity)) throw new TrustedOperationBindingError('DUPLICATE_TRUSTED_OPERATION_BINDING');
    entries.set(identity, Object.freeze({ method, path,
      endpointDefinitionId: values.endpointDefinitionId as string, sourceServiceAssetId: values.sourceServiceAssetId as string }));
  }
  return Object.freeze({ get(method: string, path: string) {
    const binding = entries.get(key(method, path));
    if (!binding) throw new TrustedOperationBindingError('MISSING_TRUSTED_OPERATION_BINDING');
    return binding;
  } });
}
