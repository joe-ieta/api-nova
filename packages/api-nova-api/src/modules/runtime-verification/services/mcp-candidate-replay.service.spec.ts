import { McpCandidateReplayService } from './mcp-candidate-replay.service';

describe('McpCandidateReplayService', () => {
  const service = new McpCandidateReplayService();

  it('executes the in-memory candidate handler and captures HTTP evidence', async () => {
    const handler = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok', _meta: { httpStatus: 201 } }],
      structuredContent: { type: 'json', data: { id: 'created' } },
      isError: false,
    });

    const result = await service.replay({
      tool: { name: 'createOrder', handler },
      sample: { requestPayload: { sku: 'A-1' } } as any,
    });

    expect(handler).toHaveBeenCalledWith({ sku: 'A-1' });
    expect(result).toEqual(expect.objectContaining({
      statusCode: 201,
      isError: false,
      body: { id: 'created' },
      toolName: 'createOrder',
    }));
  });

  it('rejects responses without transport-level HTTP evidence', async () => {
    await expect(service.replay({
      tool: {
        name: 'brokenTool',
        handler: async () => ({ content: [{ type: 'text', text: 'unknown' }] }),
      },
      sample: { requestPayload: {} } as any,
    })).rejects.toThrow('did not report an HTTP status');
  });
});
