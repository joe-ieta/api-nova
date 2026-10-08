import { Test } from '@nestjs/testing';
import { HealthCheckError, DiskHealthIndicator, HttpHealthIndicator, MemoryHealthIndicator, TerminusModule } from '@nestjs/terminus';
import { ServiceUnavailableException } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { HealthController } from './health.controller';

describe('HealthController dependency failure and recovery', () => {
  it('reports 503 for unavailable MCP even when memory/disk are healthy, then recovers', async () => {
    const http = { pingCheck: jest.fn() };
    const module = await Test.createTestingModule({
      imports: [TerminusModule.forRoot({ logger: false })],
      controllers: [HealthController],
      providers: [{ provide: AppConfigService, useValue: { mcpServerUrl: 'http://127.0.0.1:9022' } }],
    })
      .overrideProvider(HttpHealthIndicator).useValue(http)
      .overrideProvider(MemoryHealthIndicator).useValue({
        checkHeap: async () => ({ memory_heap: { status: 'up' } }),
        checkRSS: async () => ({ memory_rss: { status: 'up' } }),
      })
      .overrideProvider(DiskHealthIndicator).useValue({ checkStorage: async () => ({ disk: { status: 'up' } }) })
      .compile();
    try {
      const controller = module.get(HealthController);
      http.pingCheck.mockRejectedValueOnce(new HealthCheckError('MCP unavailable', { mcp_server: { status: 'down', message: 'ECONNREFUSED' } }));
      let failure: ServiceUnavailableException | undefined;
      try { await controller.check(); } catch (error) { failure = error as ServiceUnavailableException; }
      expect(failure).toBeInstanceOf(ServiceUnavailableException);
      expect(failure?.getStatus()).toBe(503);
      expect(failure?.getResponse()).toMatchObject({ status: 'error', error: { mcp_server: { status: 'down' } }, info: { disk: { status: 'up' } } });
      http.pingCheck.mockResolvedValueOnce({ mcp_server: { status: 'up' } });
      await expect(controller.check()).resolves.toMatchObject({ status: 'ok', error: {}, details: { mcp_server: { status: 'up' } } });
    } finally { await module.close(); }
  });
});
