import { firstValueFrom, of } from 'rxjs';
import { LoggingInterceptor } from './logging.interceptor';

describe('LoggingInterceptor Gateway streaming boundary', () => {
  it('does not serialize streamed Express responses or duplicate Gateway audit', async () => {
    const interceptor = new LoggingInterceptor({ debugMode: true, isProduction: false } as any);
    const response: any = {}; response.self = response;
    const logger = jest.spyOn((interceptor as any).logger, 'log');
    const context = { switchToHttp: () => ({ getRequest: () => ({ path: '/api/v1/gateway/service/echo' }),
      getResponse: () => response }) } as any;
    expect(await firstValueFrom(interceptor.intercept(context, { handle: () => of(response) }))).toBe(response);
    expect(logger).not.toHaveBeenCalled();
  });
});
