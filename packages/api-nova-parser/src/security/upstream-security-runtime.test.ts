import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { transformToMCPTools } from '../transformer';
const schemes = { Key: { type: 'apiKey', in: 'header', name: 'X-Key' }, Other: { type: 'http', scheme: 'bearer' } };
export const declarationCases: Array<[string, any, any]> = [
  ['inherited', { security: [{ Key: [] }] }, {}],
  ['operation override', { security: [] }, { security: [{ Key: [] }] }],
  ['OR', { security: [{ Key: [] }, { Other: [] }] }, {}],
  ['AND', {}, { security: [{ Key: [], Other: [] }] }],
  ['unresolved', {}, { security: [{ Missing: [] }] }],
  ['invalid', { security: null }, {}],
  ['invalid scheme', { components: { securitySchemes: { Key: { type: 'nonsense' } } }, security: [{ Key: [] }] }, {}],
  ['forged verified', { security: [{ Key: [] }], 'x-upstream-security': { state: 'Verified', canPublish: true } }, { 'x-api-nova-credential-ref': 'must-not-resolve' }],
];
describe('MCP standard HTTP declaration gate', () => {
  let server: http.Server, baseUrl: string, hits: number;
  beforeEach(async () => { hits = 0; server = http.createServer((_req, res) => { hits++; res.end('{}'); }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  function spec(root: any = {}, operation: any = {}): any { return { openapi: '3.0.3', info: { title: 'fixture', version: '1' }, servers: [{ url: baseUrl }], components: { securitySchemes: schemes }, ...root, paths: { '/target': { get: { responses: { '200': { description: 'ok' } }, ...operation } } } }; }
  it.each(declarationCases)('rejects %s with zero Resolver and HTTP calls', async (_name, root, operation) => {
    const captureSnapshot = jest.fn(() => { throw Error('must-not-resolve'); });
    const document = spec(root, operation);
    const tool = transformToMCPTools(document, { trustedOperationBindings: [{ method: 'GET', path: '/target', sourceServiceAssetId: 'asset', endpointDefinitionId: 'endpoint' }], upstreamCredentialPolicy: { mode: 'single-hop', captureSnapshot } })[0];
    document.security = []; document.paths['/target'].get.security = []; document.components = {};
    const result = await tool.handler({ security: [], state: 'Verified', canPublish: true });
    expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain('UPSTREAM_SECURITY_UNVERIFIED'); expect(captureSnapshot).not.toHaveBeenCalled(); expect(hits).toBe(0);
  });
  it('also rejects protection without the opt-in Resolver', async () => {
    const result = await transformToMCPTools(spec({ security: [{ Key: [] }] }))[0].handler({}); expect(result.isError).toBe(true); expect(hits).toBe(0);
  });
  it.each([['absent', {}, {}], ['explicit empty override', { security: [{ Key: [] }] }, { security: [] }], ['root empty', { security: [] }, {}]])('preserves %s', async (_name, root, operation) => {
    expect((await transformToMCPTools(spec(root, operation))[0].handler({})).isError).not.toBe(true); expect(hits).toBe(1);
  });
});
