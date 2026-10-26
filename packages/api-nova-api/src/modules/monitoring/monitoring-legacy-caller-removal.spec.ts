import 'reflect-metadata';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import * as parser from 'api-nova-parser';
import { MonitoringController } from './monitoring.controller';

describe('legacy external-caller query retirement (OBS-15-01)', () => {
  test('does not expose the legacy route and keeps no parser file-scan fallback', () => {
    expect((parser as any).listObservedRuntimeCallers).toBeUndefined();
    const prototype = MonitoringController.prototype as any;
    const routes = Reflect.ownKeys(prototype)
      .filter((key): key is string => typeof key === 'string' && key !== 'constructor')
      .map(key => ({
        key,
        path: Reflect.getMetadata(PATH_METADATA, prototype[key]),
        method: Reflect.getMetadata(METHOD_METADATA, prototype[key]),
      }));
    expect(routes.some(entry => entry.path === 'management/external-callers')).toBe(false);
    expect(prototype.getExternalCallers).toBeUndefined();
  });
});
