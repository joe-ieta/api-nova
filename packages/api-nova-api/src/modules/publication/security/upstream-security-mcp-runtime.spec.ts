import { transformToMCPTools, normalizeUpstreamSecurity } from 'api-nova-parser';
import { normalizeUpstreamSecurity as apiNormalize } from './upstream-security-reconciliation';
import { transformOpenApiToMcpTools } from '../../../../../api-nova-server/src/transform/transformOpenApiToMcpTools';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
describe('API consumers share the Parser declaration gate', () => {
  it('reexports the exact shared normalizer', () => expect(apiNormalize).toBe(normalizeUpstreamSecurity));
  it.each(['parser', 'server'].flatMap(entry => ['protected', 'unresolved', 'invalid'].map(kind => [entry, kind])))('%s wrapper rejects %s declaration without Resolver or HTTP', async (entry, kind) => {
    let hits = 0; const server = http.createServer((_req, res) => { hits++; res.end('{}'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const spec: any = { openapi: '3.0.3', info: { title: 'fixture', version: '1' }, servers: [{ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }], security: [{ Key: [] }], components: { securitySchemes: { Key: { type: 'apiKey', in: 'header', name: 'X-Key' } } }, paths: { '/target': { get: { responses: { '200': { description: 'ok' } } } } } };
      if (kind === 'unresolved') spec.security = [{ Missing: [] }];
      if (kind === 'invalid') spec.security = null;
      const bindings = [{ method: 'GET', path: '/target', sourceServiceAssetId: 'asset', endpointDefinitionId: 'endpoint' }];
      const captureSnapshot = jest.fn(() => { throw Error('must-not-resolve'); }); const policy = { mode: 'single-hop' as const, captureSnapshot };
      const tools = entry === 'parser' ? transformToMCPTools(spec, { trustedOperationBindings: bindings, upstreamCredentialPolicy: policy }) : await transformOpenApiToMcpTools(undefined, undefined, spec, undefined, undefined, false, undefined, undefined, bindings, policy);
      const result = await tools[0].handler({ state: 'Verified', security: [] });
      expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain('UPSTREAM_SECURITY_UNVERIFIED'); expect(captureSnapshot).not.toHaveBeenCalled(); expect(hits).toBe(0);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
