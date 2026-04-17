type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergeLocaleMessages<T extends PlainObject>(
  base: T,
  ...overrides: PlainObject[]
): T {
  const result: PlainObject = { ...base };

  for (const override of overrides) {
    for (const [key, value] of Object.entries(override)) {
      const currentValue = result[key];

      if (isPlainObject(currentValue) && isPlainObject(value)) {
        result[key] = mergeLocaleMessages(currentValue, value);
        continue;
      }

      result[key] = value;
    }
  }

  return result as T;
}
