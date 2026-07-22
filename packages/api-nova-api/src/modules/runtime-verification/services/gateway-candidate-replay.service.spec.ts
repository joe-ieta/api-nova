import { GatewayCandidateReplayService } from './gateway-candidate-replay.service';

describe('GatewayCandidateReplayService', () => {
  const snapshotService = {
    getCandidateRoute: jest.fn(),
    resolveCandidate: jest.fn(),
  };
  const gatewayRuntimeService = {
    forwardResolvedRoute: jest.fn(),
  };
  const service = new GatewayCandidateReplayService(
    snapshotService as any,
    gatewayRuntimeService as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    snapshotService.getCandidateRoute.mockReturnValue({
      normalizedRoutePath: '/orders/pets/{id}',
      routeMethod: 'GET',
    });
    snapshotService.resolveCandidate.mockReturnValue({
      membership: { id: 'membership-1' },
      routeBinding: { routePath: '/pets/{id}', routeMethod: 'GET' },
    });
    gatewayRuntimeService.forwardResolvedRoute.mockImplementation(
      async (_target, _req, res) => {
        res.status(200);
        res.setHeader('content-type', 'application/json');
        res.write(Buffer.from(JSON.stringify({ ok: true })));
        res.end();
      },
    );
  });

  it('rebuilds path and query parameters and bypasses the active cache', async () => {
    const result = await service.replay({
      candidateRevision: 'revision-1',
      runtimeMembershipId: 'membership-1',
      verificationRunId: 'run-1',
      sample: {
        id: 'sample-1',
        requestPayload: { id: 123, include: 'owner' },
        requestHeaders: {
          authorization: '[REDACTED]',
          'x-client': 'verification',
        },
      } as any,
    });

    expect(snapshotService.resolveCandidate).toHaveBeenCalledWith(
      'revision-1',
      'candidate.gateway.internal',
      'GET',
      '/orders/pets/123',
    );
    const request = gatewayRuntimeService.forwardResolvedRoute.mock.calls[0][1];
    expect(request.originalUrl).toBe('/orders/pets/123?include=owner');
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers['x-client']).toBe('verification');
    expect(gatewayRuntimeService.forwardResolvedRoute.mock.calls[0][4]).toEqual({
      bypassCache: true,
    });
    expect(result).toEqual(
      expect.objectContaining({
        statusCode: 200,
        body: { ok: true },
        routePath: '/orders/pets/123',
      }),
    );
  });

  it('fails before proxying when a required path parameter is absent', async () => {
    await expect(
      service.replay({
        candidateRevision: 'revision-1',
        runtimeMembershipId: 'membership-1',
        verificationRunId: 'run-1',
        sample: { id: 'sample-1', requestPayload: {} } as any,
      }),
    ).rejects.toThrow("missing path parameter 'id'");
    expect(gatewayRuntimeService.forwardResolvedRoute).not.toHaveBeenCalled();
  });
});
