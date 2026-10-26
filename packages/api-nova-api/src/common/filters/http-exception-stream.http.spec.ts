import 'reflect-metadata';
import { BadGatewayException, Controller, Get, Module, Res, UnauthorizedException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { get } from 'node:http';
import type { Response } from 'express';
import { HttpExceptionFilter } from './http-exception.filter';

@Controller()
class StreamFailureController {
  @Get('partial')
  async partial(@Res() response: Response) {
    response.setHeader('Content-Type', 'text/plain');
    response.write('started');
    await new Promise(resolve => setTimeout(resolve, 20));
    throw new BadGatewayException('upstream failed after streaming began');
  }
  @Get('ended')
  ended(@Res() response: Response) {
    response.end('complete');
    throw new BadGatewayException('late failure after end');
  }
  @Get('denied') denied() { throw new UnauthorizedException('denied'); }
  @Get('alive') alive() { return { alive: true }; }
}
@Module({ controllers: [StreamFailureController] })
class StreamFailureModule {}

describe('HTTP exceptions after a streaming response starts', () => {
  it('aborts an incomplete stream without a second response and keeps serving requests', async () => {
    const app = await NestFactory.create(StreamFailureModule, { logger: false });
    const filter = new HttpExceptionFilter();
    jest.spyOn((filter as any).logger, 'error').mockImplementation(() => {});
    app.useGlobalFilters(filter);
    try {
      await app.listen(0, '127.0.0.1');
      const base = await app.getUrl();
      const streamed = await new Promise<{ aborted: boolean; body: string }>((resolve, reject) => {
        const req = get(base + '/partial', response => {
          const chunks: Buffer[] = [];
          response.on('data', chunk => chunks.push(chunk));
          response.once('aborted', () => resolve({ aborted: true, body: Buffer.concat(chunks).toString() }));
          response.once('end', () => resolve({ aborted: false, body: Buffer.concat(chunks).toString() }));
          response.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error); });
        });
        req.setTimeout(3000, () => { req.destroy(); reject(new Error('stream did not close')); });
        req.on('error', reject);
      });
      expect(streamed).toEqual({ aborted: true, body: 'started' });
      expect(await (await fetch(base + '/ended')).text()).toBe('complete');
      const denied = await fetch(base + '/denied');
      expect(denied.status).toBe(401);
      expect(await denied.json()).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
      expect(await (await fetch(base + '/alive')).json()).toEqual({ alive: true });
    } finally { await app.close(); }
  });

  it.each(['aborted', 'destroyed', 'writableEnded'])('does not write to an already %s connection', state => {
    const filter = new HttpExceptionFilter();
    jest.spyOn((filter as any).logger, 'error').mockImplementation(() => {});
    const request = { url: '/stream', method: 'GET', headers: {}, aborted: state === 'aborted' };
    const response = { headersSent: true, destroyed: state === 'destroyed', writableEnded: state === 'writableEnded',
      destroy: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
    filter.catch(new BadGatewayException('disconnected'), {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    } as any);
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
    expect(response.destroy).not.toHaveBeenCalled();
  });
});
