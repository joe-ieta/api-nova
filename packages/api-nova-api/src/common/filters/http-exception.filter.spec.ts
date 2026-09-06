import { UnauthorizedException } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

describe('HttpExceptionFilter audit redaction', () => {
  it('does not echo credential query values in errors or ordinary logs', () => {
    const filter = new HttpExceptionFilter();
    const logger = jest.spyOn((filter as any).logger, 'error').mockImplementation(() => {});
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const request = { url: '/api/v1/gateway/echo?api_key=private-query-value&view=full',
      method: 'GET', headers: {} };
    const host = { switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }) } as any;
    filter.catch(new UnauthorizedException(), host);
    expect(JSON.stringify(logger.mock.calls)).not.toContain('private-query-value');
    expect(JSON.stringify(response.json.mock.calls)).not.toContain('private-query-value');
    expect(response.json.mock.calls[0][0].error.path).toContain('view=full');
  });

  it('handles malformed request targets without throwing or echoing raw input', () => {
    const filter = new HttpExceptionFilter();
    const logger = jest.spyOn((filter as any).logger, 'error').mockImplementation(() => {});
    for (const url of ['//[?api_key=private-query-value', 'http://[?api_key=private-query-value']) {
      const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const request = { url, method: 'GET', headers: {} };
      const host = { switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }) } as any;
      expect(() => filter.catch(new UnauthorizedException(), host)).not.toThrow();
      expect(response.status).toHaveBeenCalledWith(401);
      expect(response.json.mock.calls[0][0].error.path).toBe('[invalid URL]');
    }
    expect(JSON.stringify(logger.mock.calls)).not.toContain('private-query-value');
  });
});
