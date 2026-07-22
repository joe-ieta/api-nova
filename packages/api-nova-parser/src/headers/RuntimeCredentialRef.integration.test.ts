import axios from 'axios';
import { transformToMCPTools } from '../transformer';

jest.mock('axios');
const mockedAxios = axios as jest.MockedFunction<typeof axios>;

describe('runtime credential reference MCP execution', () => {
  it('resolves the operation credential only when its handler executes', async () => {
    const previous = process.env.UPSTREAM_ORDER_TOKEN;
    process.env.UPSTREAM_ORDER_TOKEN = 'Bearer runtime-secret';
    mockedAxios.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      data: { ok: true },
      config: {},
    } as any);
    try {
      const [tool] = transformToMCPTools({
        openapi: '3.0.3',
        info: { title: 'Orders', version: '1.0.0' },
        servers: [{ url: 'https://orders.example' }],
        paths: {
          '/orders': {
            get: {
              operationId: 'listOrders',
              responses: { '200': { description: 'ok' } },
              'x-api-nova-credential-ref': 'env-headers:Authorization=UPSTREAM_ORDER_TOKEN',
            },
          },
        },
      } as any);

      await tool.handler?.({});

      expect(mockedAxios).toHaveBeenCalledWith(expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer runtime-secret' }),
      }));
    } finally {
      if (previous === undefined) delete process.env.UPSTREAM_ORDER_TOKEN;
      else process.env.UPSTREAM_ORDER_TOKEN = previous;
    }
  });
});
