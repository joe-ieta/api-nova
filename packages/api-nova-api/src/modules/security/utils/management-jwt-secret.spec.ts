import * as configurationSchemas from '../../../config/validation.schema';
import {
  MANAGEMENT_JWT_SECRET_ERROR,
  requireManagementJwtSecret,
} from './management-jwt-secret';

const validSecret = 'isolated-test-management-jwt-secret-2026-09-14';
const invalidCases: Array<[string, unknown]> = [
  ['missing', undefined],
  ['null', null],
  ['number', 42],
  ['boolean', false],
  ['object', { secret: validSecret }],
  ['array', [validSecret]],
  ['empty', ''],
  ['too short', 'x'.repeat(31)],
  ['removed fallback', 'default-secret-key'],
  ['leading whitespace', ' ' + validSecret],
  ['trailing whitespace', validSecret + ' '],
  ['embedded whitespace', validSecret + ' extra'],
  ['newline', validSecret + '\n'],
  ['tab', validSecret + '\t'],
  ['null byte', validSecret + '\u0000'],
  ['control byte', validSecret + '\u0001'],
  ['delete byte', validSecret + '\u007f'],
  ['unicode whitespace', validSecret + '\u00a0'],
];

describe('management JWT secret fail-closed configuration', () => {
  it.each(invalidCases)('rejects %s with a fixed non-secret error', (_label, value) => {
    expect(() => requireManagementJwtSecret(value)).toThrow(MANAGEMENT_JWT_SECRET_ERROR);
    try {
      requireManagementJwtSecret(value);
    } catch (error) {
      expect((error as Error).message).toBe(MANAGEMENT_JWT_SECRET_ERROR);
      expect((error as Error).message).not.toContain(validSecret);
    }
  });

  it('preserves an explicitly configured valid secret without normalization', () => {
    expect(requireManagementJwtSecret(validSecret)).toBe(validSecret);
    const base64Secret = 'N'.repeat(42) + '==';
    expect(requireManagementJwtSecret(base64Secret)).toBe(base64Secret);
  });

  it('accepts the exact minimum length', () => {
    expect(requireManagementJwtSecret('x'.repeat(32))).toBe('x'.repeat(32));
  });

  it('rejects non-string values without invoking accessors', () => {
    const accessor = jest.fn(() => validSecret);
    const input = Object.defineProperty({}, 'secret', { get: accessor });
    expect(() => requireManagementJwtSecret(input)).toThrow(MANAGEMENT_JWT_SECRET_ERROR);
    expect(accessor).not.toHaveBeenCalled();
  });
});

describe('application JWT_SECRET validation', () => {
  const applicationSchema = Object.values(configurationSchemas).find(
    (value: any) => value && typeof value.extract === 'function',
  ) as { extract(path: string): { validate(value: unknown): { value: unknown; error?: Error } } } | undefined;

  it('registers the management secret field in the application schema', () => {
    expect(applicationSchema).toBeDefined();
    expect(applicationSchema!.extract('JWT_SECRET')).toBeDefined();
  });

  it.each(invalidCases)('rejects %s at startup without exposing the supplied value', (_label, value) => {
    const result = applicationSchema!.extract('JWT_SECRET').validate(value);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error!.message).toBe(MANAGEMENT_JWT_SECRET_ERROR);
    expect(result.error!.message).not.toContain(validSecret);
  });

  it('preserves a valid configured signing secret', () => {
    const result = applicationSchema!.extract('JWT_SECRET').validate(validSecret);
    expect(result.error).toBeUndefined();
    expect(result.value).toBe(validSecret);
  });
});
