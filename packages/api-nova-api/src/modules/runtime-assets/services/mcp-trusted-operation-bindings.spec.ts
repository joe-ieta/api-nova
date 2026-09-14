import { createMcpTrustedOperationBindings as generate } from './mcp-trusted-operation-bindings';

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
function fixture(): any {
  return {
    asset: { id: id(1), type: 'mcp_server' },
    rows: [{ membership: { id: id(2), runtimeAssetId: id(1), endpointDefinitionId: id(3), enabled: true, status: 'active' },
      endpoint: { id: id(3), sourceServiceAssetId: id(4), method: 'get', path: '/items', status: 'published' }, sourceAsset: { id: id(4) } }],
    spec: { openapi: '3.0.3', info: { title: 'fixture', version: '1' }, paths: { '/items': { get: {
      operationId: 'untrusted-name', 'x-endpoint-definition-id': id(90), 'x-source-service-asset-id': id(91), responses: { '200': { description: 'ok' } },
    } } } },
  };
}
describe('MCP trusted ownership snapshot mapping', () => {
  it('uses only relational IDs, ignores extensions and freezes copied output', () => {
    const f = fixture(), bindings = generate(f.asset, f.rows, f.spec);
    expect(bindings).toEqual([{ method: 'GET', path: '/items', endpointDefinitionId: id(3), sourceServiceAssetId: id(4) }]);
    f.rows[0].endpoint.id = id(77); f.rows[0].endpoint.path = '/mutated'; f.rows[0].sourceAsset.id = id(78);
    expect(bindings[0].endpointDefinitionId).toBe(id(3)); expect(bindings[0].path).toBe('/items');
    expect(Object.isFrozen(bindings)).toBe(true); expect(Object.isFrozen(bindings[0])).toBe(true);
  });
  it.each([
    ['cross runtime', (f: any) => { f.rows[0].membership.runtimeAssetId = id(99); }],
    ['cross endpoint', (f: any) => { f.rows[0].membership.endpointDefinitionId = id(99); }],
    ['cross source', (f: any) => { f.rows[0].endpoint.sourceServiceAssetId = id(99); }],
    ['disabled membership', (f: any) => { f.rows[0].membership.enabled = false; }],
    ['offline membership', (f: any) => { f.rows[0].membership.status = 'offline'; }],
    ['offline endpoint', (f: any) => { f.rows[0].endpoint.status = 'offline'; }],
    ['retired endpoint', (f: any) => { f.rows[0].endpoint.status = 'retired'; }],
    ['missing endpoint', (f: any) => { delete f.rows[0].endpoint; }],
    ['missing source', (f: any) => { delete f.rows[0].sourceAsset; }],
    ['invalid endpoint status', (f: any) => { f.rows[0].endpoint.status = 'surprise'; }],
    ['duplicate membership', (f: any) => { f.rows.push(f.rows[0]); }],
    ['ambiguous operation', (f: any) => { const row = structuredClone(f.rows[0]); row.membership.id = id(22); row.membership.endpointDefinitionId = row.endpoint.id = id(23); row.endpoint.method = 'GET'; f.rows.push(row); }],
    ['spec missing operation', (f: any) => { delete f.spec.paths['/items'].get; }],
    ['unmapped spec operation', (f: any) => { f.spec.paths['/other'] = { post: { responses: {} } }; }],
    ['wrong runtime type', (f: any) => { f.asset.type = 'gateway_service'; }],
    ['invalid identifier', (f: any) => { f.rows[0].sourceAsset.id = 'not-a-uuid'; }],
  ])('rejects %s with fixed diagnostics', (_label, mutate) => {
    const f = fixture(); (mutate as (value: any) => void)(f);
    expect(() => generate(f.asset, f.rows, f.spec)).toThrow(/^INVALID_MCP_OPERATION_OWNERSHIP$/);
  });
  it('re-evaluates a new snapshot after disable, without claiming in-flight revocation', () => {
    const f = fixture(), prior = generate(f.asset, f.rows, f.spec);
    f.rows[0].membership.enabled = false;
    expect(() => generate(f.asset, f.rows, f.spec)).toThrow('INVALID_MCP_OPERATION_OWNERSHIP');
    expect(prior[0].endpointDefinitionId).toBe(id(3));
  });
  it('does not leak a malformed row getter error', () => {
    const f = fixture(); Object.defineProperty(f.rows[0], 'endpoint', { get() { throw new Error('private-fixture'); } });
    expect(() => generate(f.asset, f.rows, f.spec)).toThrow(/^INVALID_MCP_OPERATION_OWNERSHIP$/);
  });
});