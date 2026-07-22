import { Injectable } from '@nestjs/common';
import { EndpointTestSampleEntity } from '../../../database/entities/endpoint-test-sample.entity';

export type RuntimeResponseAssertionMode = 'status' | 'schema' | 'exact';

type AssertionMismatch = {
  path: string;
  expected: string;
  actual: string;
};

@Injectable()
export class RuntimeResponseAssertionService {
  assert(sample: EndpointTestSampleEntity, actual: unknown) {
    const config = this.config(sample);
    if (config.mode === 'status') {
      return { passed: true, mode: config.mode, mismatches: [] as AssertionMismatch[] };
    }
    const mismatches: AssertionMismatch[] = [];
    this.compare(sample.responsePayload, actual, '$', config.mode, config.ignoredPaths, mismatches);
    return { passed: mismatches.length === 0, mode: config.mode, mismatches };
  }

  private config(sample: EndpointTestSampleEntity) {
    const raw = sample.metadata?.responseAssertion;
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const requested = String(value.mode || '').toLowerCase();
    const mode: RuntimeResponseAssertionMode = ['status', 'schema', 'exact'].includes(requested)
      ? requested as RuntimeResponseAssertionMode
      : sample.responsePayload === undefined ? 'status' : 'schema';
    const ignoredPaths = new Set(
      (Array.isArray(value.ignoredPaths) ? value.ignoredPaths : [])
        .map(item => String(item).trim())
        .filter(Boolean),
    );
    return { mode, ignoredPaths };
  }

  private compare(
    expected: unknown,
    actual: unknown,
    path: string,
    mode: RuntimeResponseAssertionMode,
    ignoredPaths: Set<string>,
    mismatches: AssertionMismatch[],
  ) {
    if (mismatches.length >= 50 || ignoredPaths.has(path)) return;
    const expectedType = this.valueType(expected);
    const actualType = this.valueType(actual);
    if (expectedType !== actualType) {
      mismatches.push({ path, expected: expectedType, actual: actualType });
      return;
    }
    if (expectedType === 'object') {
      const expectedObject = expected as Record<string, unknown>;
      const actualObject = actual as Record<string, unknown>;
      for (const key of Object.keys(expectedObject).sort()) {
        const childPath = `${path}.${key}`;
        if (!(key in actualObject)) {
          if (!ignoredPaths.has(childPath)) {
            mismatches.push({ path: childPath, expected: this.valueType(expectedObject[key]), actual: 'missing' });
          }
          continue;
        }
        this.compare(expectedObject[key], actualObject[key], childPath, mode, ignoredPaths, mismatches);
      }
      if (mode === 'exact') {
        for (const key of Object.keys(actualObject).sort()) {
          const childPath = `${path}.${key}`;
          if (!(key in expectedObject) && !ignoredPaths.has(childPath)) {
            mismatches.push({ path: childPath, expected: 'missing', actual: this.valueType(actualObject[key]) });
          }
        }
      }
      return;
    }
    if (expectedType === 'array') {
      const expectedArray = expected as unknown[];
      const actualArray = actual as unknown[];
      if (mode === 'exact' && expectedArray.length !== actualArray.length) {
        mismatches.push({ path: `${path}.length`, expected: String(expectedArray.length), actual: String(actualArray.length) });
      }
      if (expectedArray.length === 0) return;
      const count = mode === 'exact' ? Math.min(expectedArray.length, actualArray.length) : actualArray.length;
      for (let index = 0; index < count; index += 1) {
        this.compare(
          mode === 'exact' ? expectedArray[index] : expectedArray[0],
          actualArray[index],
          `${path}[${index}]`,
          mode,
          ignoredPaths,
          mismatches,
        );
      }
      return;
    }
    if (mode === 'exact' && !Object.is(expected, actual)) {
      mismatches.push({ path, expected: this.display(expected), actual: this.display(actual) });
    }
  }

  private valueType(value: unknown) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }

  private display(value: unknown) {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized.slice(0, 500);
  }
}
