import { Test, TestingModule } from '@nestjs/testing';
import { HealthCheckError, HttpHealthIndicator, MemoryHealthIndicator, TerminusModule } from '@nestjs/terminus';
import { ServiceUnavailableException } from '@nestjs/common';
import { promises as fs } from 'fs';
import { AppConfigService } from '../../config/app-config.service';
import { HealthController } from './health.controller';
import { DiskFreeSpaceHealthIndicator, MIN_DISK_FREE_BYTES } from './disk-free-space.health';

describe('HealthController dependency failure and recovery', () => {
  let module: TestingModule;
  let controller: HealthController;
  let diskStat: jest.SpyInstance;
  const http = { pingCheck: jest.fn() };

  beforeEach(async () => {
    diskStat = jest.spyOn(fs, 'statfs').mockResolvedValue({
      bsize: 1, bavail: 9 * 1024 ** 3, bfree: 9 * 1024 ** 3, blocks: 100 * 1024 ** 3,
    } as any);
    http.pingCheck.mockReset().mockResolvedValue({ mcp_server: { status: 'up' } });
    module = await Test.createTestingModule({
      imports: [TerminusModule.forRoot({ logger: false })],
      controllers: [HealthController],
      providers: [DiskFreeSpaceHealthIndicator,
        { provide: AppConfigService, useValue: { mcpServerUrl: 'http://127.0.0.1:9022' } }],
    })
      .overrideProvider(HttpHealthIndicator).useValue(http)
      .overrideProvider(MemoryHealthIndicator).useValue({
        checkHeap: async () => ({ memory_heap: { status: 'up' } }),
        checkRSS: async () => ({ memory_rss: { status: 'up' } }),
      })
      .compile();
    controller = module.get(HealthController);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await module?.close();
  });

  it('reports 503 for unavailable MCP even with sufficient disk space, then recovers', async () => {
    http.pingCheck.mockRejectedValueOnce(new HealthCheckError('MCP unavailable', { mcp_server: { status: 'down', message: 'ECONNREFUSED' } }));
    await expect(controller.check()).rejects.toMatchObject({
      response: { status: 'error', error: { mcp_server: { status: 'down' } }, info: { disk: { status: 'up' } } },
    });
    await expect(controller.check()).resolves.toMatchObject({ status: 'ok', error: {}, details: { mcp_server: { status: 'up' } } });
  });

  it('accepts 9 GiB available even on a disk with 91% usage', async () => {
    await expect(controller.check()).resolves.toMatchObject({
      status: 'ok', details: { disk: { status: 'up', freeBytes: 9 * 1024 ** 3, requiredFreeBytes: 5 * 1024 ** 3 } },
    });
    expect(diskStat).toHaveBeenCalledWith(process.platform === 'win32' ? 'C:\\' : '/');
  });

  it('accepts exactly 5 GiB available', async () => {
    diskStat.mockResolvedValue({ bsize: 4096, bavail: MIN_DISK_FREE_BYTES / 4096 });
    await expect(controller.check()).resolves.toMatchObject({
      status: 'ok', details: { disk: { status: 'up', freeBytes: MIN_DISK_FREE_BYTES } },
    });
  });

  it('rejects one byte below 5 GiB even if total free space is larger, then recovers', async () => {
    diskStat.mockResolvedValueOnce({ bsize: 1, bavail: MIN_DISK_FREE_BYTES - 1, bfree: 10 * 1024 ** 3 });
    try {
      await controller.check();
      throw new Error('Expected unhealthy disk');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(error.getStatus()).toBe(503);
      expect(error.getResponse()).toMatchObject({
        error: { disk: { status: 'down', freeBytes: MIN_DISK_FREE_BYTES - 1, requiredFreeBytes: MIN_DISK_FREE_BYTES } },
      });
    }
    await expect(controller.check()).resolves.toMatchObject({ status: 'ok' });
  });

  it('fails closed when the filesystem query fails', async () => {
    diskStat.mockRejectedValueOnce(new Error('EACCES'));
    await expect(controller.check()).rejects.toMatchObject({
      response: { error: { disk: { status: 'down', requiredFreeBytes: MIN_DISK_FREE_BYTES } } },
    });
  });

  it.each([NaN, -1, Infinity])('fails closed for invalid available blocks %s', async (bavail) => {
    diskStat.mockResolvedValueOnce({ bsize: 4096, bavail });
    await expect(controller.check()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
