import axios from 'axios';
import { compileTrustedOperationBindings, TrustedOperationBinding } from './trusted-operation-bindings';
import { transformToMCPTools } from '../transformer';
import { withRuntimeCallContext } from '../audit/runtime-call-audit';
import { createRuntimeHttpAuditAgents } from '../audit/runtime-http-agent';

jest.mock('../audit/runtime-http-agent', () => ({ createRuntimeHttpAuditAgents: jest.fn(() => ({
  httpAgent: {}, httpsAgent: {}, destroy: jest.fn(),
})) }));
const observed = createRuntimeHttpAuditAgents as jest.Mock;
function spec(): any {
  return { openapi: '3.0.3', info: { title: 'mapping fixture', version: '1' }, servers: [{ url: 'https://fixture.invalid' }],
    paths: { '/items/{id}': { get: { operationId: 'items', responses: { '200': { description: 'ok' } },
      'x-endpoint-definition-id': 'untrusted-endpoint', 'x-source-service-asset-id': 'untrusted-asset',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] } } } };
}
function binding(overrides: Partial<TrustedOperationBinding> = {}): TrustedOperationBinding {
  return { method: 'GET', path: '/items/{id}', endpointDefinitionId: 'trusted-endpoint', sourceServiceAssetId: 'trusted-asset', ...overrides };
}
const context = { transport: 'mcp' as const, identitySource: 'anonymous' as const, requestId: 'mapping-test', endpointDefinitionId: 'caller-endpoint', sourceServiceAssetId: 'caller-asset' };
describe('trusted in-process MCP operation identity bindings', () => {
  let adapter: typeof axios.defaults.adapter;
  let sent: any[];
  beforeEach(() => {
    adapter = axios.defaults.adapter; sent = []; observed.mockClear();
    axios.defaults.adapter = async config => {
      sent.push(config);
      return { config, data: { ok: true }, status: 200, statusText: 'OK', headers: {} };
    };
  });
  afterEach(() => { axios.defaults.adapter = adapter; });

  test('compiles copied, frozen identity independent of subsequent registry/spec mutations', () => {
    const input = binding(), source = spec(), list = [input];
    const registry = compileTrustedOperationBindings(source, list);
    (input as any).sourceServiceAssetId = 'changed'; list.length = 0; source.paths = {};
    expect(registry.get('get', '/items/{id}')).toEqual(binding());
    expect(Object.isFrozen(registry)).toBe(true); expect(Object.isFrozen(registry.get('GET', '/items/{id}'))).toBe(true);
    expect(() => registry.get('POST', '/items/{id}')).toThrow('MISSING_TRUSTED_OPERATION_BINDING');
  });

  test('rejects duplicate method/path identities regardless of case, including identical duplicate entries', () => {
    for (const pair of [[binding(), binding()], [binding(), binding({ method: 'get', endpointDefinitionId: 'conflicting-endpoint' })]]) {
      expect(() => compileTrustedOperationBindings(spec(), pair)).toThrow('DUPLICATE_TRUSTED_OPERATION_BINDING');
    }
    expect(sent).toHaveLength(0);
  });

  test('rejects unknown operations, malformed identities and accessor fields without evaluating them', () => {
    for (const input of [binding({ method: 'POST' }), binding({ path: '/unknown' })]) {
      expect(() => compileTrustedOperationBindings(spec(), [input])).toThrow('UNKNOWN_TRUSTED_OPERATION');
    }
    for (const input of [binding({ method: '*' }), binding({ path: '/items?secret=private' }),
      binding({ sourceServiceAssetId: '' }), { ...binding(), url: 'https://private.invalid' }, null]) {
      expect(() => compileTrustedOperationBindings(spec(), [input as any])).toThrow('INVALID_TRUSTED_OPERATION_BINDING');
    }
    const get = jest.fn(() => 'must-not-run');
    const input = { ...binding() }; Object.defineProperty(input, 'endpointDefinitionId', { enumerable: true, get });
    expect(() => compileTrustedOperationBindings(spec(), [input])).toThrow('INVALID_TRUSTED_OPERATION_BINDING');
    expect(get).not.toHaveBeenCalled(); expect(sent).toHaveLength(0);
  });

  test('configured identity gaps reject whole transformation before any handler can send', () => {
    expect(() => transformToMCPTools(spec(), { trustedOperationBindings: [] })).toThrow('MISSING_TRUSTED_OPERATION_BINDING');
    const source = spec(); source.paths['/unmapped'] = { get: { operationId: 'unmapped', responses: {} } };
    expect(() => transformToMCPTools(source, { trustedOperationBindings: [binding()] })).toThrow('MISSING_TRUSTED_OPERATION_BINDING');
    expect(sent).toHaveLength(0);
  });

  test('handler uses the captured identity despite malicious extensions, caller params and later mutation', async () => {
    const source = spec(), input = binding();
    const [tool] = transformToMCPTools(source, { trustedOperationBindings: [input], includeFieldAnnotations: false });
    (input as any).endpointDefinitionId = 'mutated-registry';
    source.paths['/items/{id}'].get['x-endpoint-definition-id'] = 'mutated-extension';
    tool.metadata!.operationId = 'untrusted-metadata';
    const result = await withRuntimeCallContext(context, () => tool.handler({ id: '7',
      endpointDefinitionId: 'argument-endpoint', sourceServiceAssetId: 'argument-asset',
      'x-endpoint-definition-id': 'argument-extension', trustedOperationBindings: [binding({ sourceServiceAssetId: 'argument-registry' })] }));
    expect(result.isError).toBe(false); expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://fixture.invalid/items/7');
    expect(observed.mock.calls[0][0].endpointDefinitionId).toBe('trusted-endpoint');
    expect(observed.mock.calls[0][0].sourceServiceAssetId).toBe('trusted-asset');
  });

  test('method/path identity survives tool-name collision normalization and filtered operations need no binding', async () => {
    const source = spec(); source.paths['/second'] = { get: { operationId: 'items', responses: {} } };
    const tools = transformToMCPTools(source, { trustedOperationBindings: [binding(), binding({ path: '/second', endpointDefinitionId: 'second-endpoint' })] });
    expect(tools).toHaveLength(2); expect(tools[0].name).not.toBe(tools[1].name);
    for (const tool of tools) await withRuntimeCallContext(context, () => tool.handler({ id: '7' }));
    expect(observed.mock.calls.map(call => call[0].endpointDefinitionId)).toEqual(['trusted-endpoint', 'second-endpoint']);
    const selected = transformToMCPTools(source, { trustedOperationBindings: [binding()], operationFilter: { methods: { include: ['GET'] }, paths: { include: ['/items/{id}'] } } });
    expect(selected).toHaveLength(1);
  });

  test('no-context sending and legacy unmapped entrypoints retain their existing redirect and credential behavior', async () => {
    const [trusted] = transformToMCPTools(spec(), { trustedOperationBindings: [binding()] });
    expect((await trusted.handler({ id: '7', sourceServiceAssetId: 'spoofed' })).isError).toBe(false);
    expect(observed).not.toHaveBeenCalled(); expect(sent[0].maxRedirects).toBe(5);
    const [legacy] = transformToMCPTools(spec());
    await withRuntimeCallContext(context, () => legacy.handler({ id: '8' }));
    expect(observed.mock.calls[0][0].endpointDefinitionId).toBe('untrusted-endpoint');
    expect(observed.mock.calls[0][0].sourceServiceAssetId).toBe('untrusted-asset');
    expect(sent[1].maxRedirects).toBe(5);
  });
});
