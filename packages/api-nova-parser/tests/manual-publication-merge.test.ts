import axios from 'axios';
import { OpenAPIToMCPTransformer } from '../src/transformer';

jest.mock('axios');

const spec = (paths: Record<string, unknown>) => ({
  openapi: '3.0.3', info: { title: 'Merge regressions', version: '1' },
  servers: [{ url: 'https://upstream.example/api' }], paths,
} as any);
const operation = (operationId?: string) => ({
  operationId, responses: { '200': { description: 'OK' } },
});

describe('manual publication merge regressions', () => {
  afterEach(() => jest.restoreAllMocks());

  it('produces unique legal names after sanitizing operation IDs', () => {
    const paths = { '/one': { get: operation('get_/pets') }, '/two': { get: operation('get_pets') } };
    const forward = new OpenAPIToMCPTransformer(spec(paths)).transformToMCPTools();
    const reverse = new OpenAPIToMCPTransformer(spec(Object.fromEntries(Object.entries(paths).reverse())))
      .transformToMCPTools();
    expect(new Set(forward.map(tool => tool.name)).size).toBe(2);
    for (const tool of forward) {
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(reverse.find(item => item.metadata?.path === tool.metadata?.path)?.name).toBe(tool.name);
    }
  });

  it('bounds generated and explicitly provided long tool names', () => {
    const tools = new OpenAPIToMCPTransformer(spec({
      ['/one/' + 'x'.repeat(150)]: { get: operation() },
      '/two': { get: operation('operation'.repeat(20) + 'a') },
      '/three': { get: operation('operation'.repeat(20) + 'b') },
      '/fallback': { get: operation('///') },
    })).transformToMCPTools();
    expect(new Set(tools.map(tool => tool.name)).size).toBe(4);
    for (const tool of tools) expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it('forwards path, query, business headers and JSON body to the correct locations', async () => {
    const request = axios as jest.MockedFunction<typeof axios>;
    request.mockResolvedValue({
      status: 200, statusText: 'OK', data: { accepted: true }, headers: {},
    } as any);
    const [tool] = new OpenAPIToMCPTransformer(spec({
      '/orders/{id}': { post: {
        ...operation('post_/orders'),
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'expand', in: 'query', schema: { type: 'boolean' } },
          { name: 'x-tenant', in: 'header', schema: { type: 'string' } },
        ],
        requestBody: { required: true, content: { 'application/json': {
          schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
        } } },
      } },
    })).transformToMCPTools();
    await tool.handler({ id: 'a/b', expand: false, 'x-tenant': 'tenant-1', title: 'Order' });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://upstream.example/api/orders/a%2Fb', params: { expand: false },
      headers: expect.objectContaining({ 'x-tenant': 'tenant-1' }),
      data: { title: 'Order' },
    }));
  });

  it('keeps same-named query and body fields distinguishable', async () => {
    const request = axios as jest.MockedFunction<typeof axios>;
    request.mockResolvedValue({
      status: 200, statusText: 'OK', data: {}, headers: {},
    } as any);
    const [tool] = new OpenAPIToMCPTransformer(spec({
      '/orders': { post: {
        ...operation('orders'),
        parameters: [{ name: 'id', in: 'query', schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': {
          schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        } } },
      } },
    })).transformToMCPTools();
    expect(tool.inputSchema.properties).toHaveProperty('body');
    await tool.handler({ id: 'query-id', body: { id: 7 } });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      params: { id: 'query-id' }, data: { id: 7 },
    }));
  });
});
