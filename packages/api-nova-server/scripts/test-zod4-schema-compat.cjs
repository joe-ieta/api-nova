'use strict';
// Direct `node this-file.cjs` also executes all node:test assertions. It avoids
// Node20.0's child TAP lexer failing on the product's Unicode diagnostic output.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const http = require('node:http');
const { once } = require('node:events');
const { transformToMCPTools } = require('api-nova-parser');
const { registerManagedMcpTools } = require('../dist/tools/initTools.js');
const { MCPRegistry } = require('../dist/core/MCPRegistry.js');

async function connect(t, server) {
  const client = new Client({ name: 'zod-schema-regression', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test('SDK request schemas and live tool validation use patched v4 even when v3 compatibility parsing is disabled', async t => {
  assert.ok(CallToolRequestSchema._zod, 'SDK tools/call envelope must use Zod 4');
  assert.ok(ListToolsRequestSchema._zod, 'SDK tools/list envelope must use Zod 4');
  // The SDK imports v3 for backwards compatibility. Loading that code alone
  // is not consumption: prove that no v3 parser handles this live exchange.
  const v3 = require('zod/v3');
  const methods = ['parse', 'safeParse', 'parseAsync', 'safeParseAsync', '_parseSync', '_parseAsync'];
  const originals = methods.map(name => Object.getOwnPropertyDescriptor(v3.ZodType.prototype, name));
  try {
    for (const name of methods) Object.defineProperty(v3.ZodType.prototype, name, {
      configurable: true, writable: true, value() { throw new Error('UNPATCHED_V3_PARSE_MUST_NOT_RUN'); },
    });
    assert.throws(() => v3.string().parse('control'), /UNPATCHED_V3_PARSE_MUST_NOT_RUN/);
    let elementReads = 0, handlerCalls = 0;
    const server = new McpServer({ name: 'patched-consumer', version: '1' });
    server.registerTool('bounded', { inputSchema: {
      rows: z.array(z.object({ value: z.string() })).max(2),
    } }, async () => {
      handlerCalls++;
      return { content: [{ type: 'text', text: 'accepted' }] };
    });
    const client = await connect(t, server);
    const schema = (await client.listTools()).tools[0].inputSchema;
    assert.equal(schema.properties.rows.maxItems, 2);
    const rows = Array.from({ length: 32 }, () => ({ get value() { elementReads++; return 0; } }));
    const rejected = await client.callTool({ name: 'bounded', arguments: { rows } });
    assert.equal(rejected.isError, true);
    assert.equal(elementReads, 0, 'the actual SDK consumer must reject before element parsing');
    assert.equal(handlerCalls, 0);
    assert.notEqual((await client.callTool({ name: 'bounded', arguments: { rows: [{ value: 'valid' }] } })).isError, true);
    assert.equal(handlerCalls, 1);
    // Also consume the application JSON-Schema converter, not just SDK-owned schemas.
    const dynamic = await managed(t, { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] });
    assert.equal((await dynamic.client.listTools()).tools.length, 1);
    assert.notEqual((await dynamic.client.callTool({ name: 'schema_fixture', arguments: { value: 'valid' } })).isError, true);
    assert.equal((await dynamic.client.callTool({ name: 'schema_fixture', arguments: { value: 1 } })).isError, true);
    assert.equal(dynamic.received.length, 1);
    const empty = await managed(t, { type: 'object', properties: {} });
    assert.equal((await empty.client.listTools()).tools.length, 1);
    assert.notEqual((await empty.client.callTool({ name: 'schema_fixture', arguments: {} })).isError, true);
    assert.deepEqual(empty.received, [{}]);
  } finally {
    methods.forEach((name, index) => Object.defineProperty(v3.ZodType.prototype, name, originals[index]));
  }
});

function managed(t, inputSchema) {
  const server = new McpServer({ name: 'dynamic-schema', version: '1' });
  const received = [];
  registerManagedMcpTools(server, [{ name: 'schema_fixture', description: 'Dynamic schema fixture',
    inputSchema, handler: async args => {
      received.push(args);
      return { content: [{ type: 'text', text: JSON.stringify(args) }] };
    } }]);
  return connect(t, server).then(client => ({ client, received }));
}

test('Zod 4 native conversion retains input defaults, effects, required fields and object policies through the real SDK', async t => {
  assert.equal(typeof z.toJSONSchema, 'function', 'the application must use Zod 4');
  const server = new McpServer({ name: 'native-schema', version: '1' });
  const received = [];
  server.registerTool('native', { inputSchema: z.object({
    name: z.string().min(1).describe('Public input name').transform(value => value.trim().toUpperCase()),
    count: z.number().default(3),
    optionalDefault: z.string().default('retained').optional(),
    closed: z.object({ enabled: z.boolean() }).strict(),
    open: z.object({ known: z.string() }).passthrough(),
  }) }, async args => {
    received.push(args);
    return { content: [{ type: 'text', text: 'accepted' }] };
  });
  const client = await connect(t, server);
  const schema = (await client.listTools()).tools[0].inputSchema;
  assert.deepEqual([...schema.required].sort(), ['closed', 'name', 'open']);
  assert.equal(schema.properties.name.type, 'string');
  assert.equal(schema.properties.name.minLength, 1);
  assert.equal(schema.properties.name.description, 'Public input name');
  assert.equal(schema.properties.count.default, 3);
  assert.equal(schema.properties.optionalDefault.default, 'retained');
  assert.equal(schema.properties.closed.additionalProperties, false);
  assert.notEqual(schema.properties.open.additionalProperties, false);
  const result = await client.callTool({ name: 'native', arguments: {
    name: ' fixture ', closed: { enabled: true }, open: { known: 'x', extra: 9 }, extraRoot: 'stripped',
  } });
  assert.notEqual(result.isError, true);
  // Zod 3's optional(default) did not synthesize an absent property. The
  // migration does not introduce this shape in application-generated schemas;
  // callers explicitly using Zod 4 get its documented default materialization.
  assert.deepEqual(received, [{ name: 'FIXTURE', count: 3, optionalDefault: 'retained',
    closed: { enabled: true }, open: { known: 'x', extra: 9 } }]);
  const rejected = await client.callTool({ name: 'native', arguments: {
    name: 'valid', closed: { enabled: true, forbidden: true }, open: { known: 'x' },
  } });
  assert.equal(rejected.isError, true);
  assert.equal(received.length, 1, 'invalid input must never reach the handler');
});

test('dynamic JSON Schema retains required/optional, arrays, enums, descriptions and nested additionalProperties', async t => {
  const { client, received } = await managed(t, { type: 'object', required: ['body'], properties: {
    body: { type: 'object', additionalProperties: false, required: ['tags', 'open'], properties: {
      tags: { type: 'array', description: 'Selected tags', items: { type: 'string', enum: ['a', 'b'] } },
      open: { type: 'object', properties: { known: { type: 'boolean' } }, additionalProperties: true },
      optional: { type: 'string' },
    } },
    query: { type: 'string', description: 'Optional query' },
  } });
  const schema = (await client.listTools()).tools[0].inputSchema;
  assert.deepEqual(schema.required, ['body']);
  assert.deepEqual([...schema.properties.body.required].sort(), ['open', 'tags']);
  assert.equal(schema.properties.body.additionalProperties, false);
  assert.equal(schema.properties.body.properties.tags.description, 'Selected tags');
  assert.deepEqual(schema.properties.body.properties.tags.items.enum, ['a', 'b']);
  const valid = { body: { tags: ['a', 'b'], open: { known: true, extra: 'preserved' } } };
  assert.notEqual((await client.callTool({ name: 'schema_fixture', arguments: valid })).isError, true);
  assert.deepEqual(received, [valid]);
  for (const invalid of [{}, { body: { open: {} } }, { body: { tags: ['c'], open: {} } },
    { body: { tags: ['a'], open: {}, extra: true } }, { body: { tags: [7], open: {} } }]) {
    assert.equal((await client.callTool({ name: 'schema_fixture', arguments: invalid })).isError, true);
  }
  assert.equal(received.length, 1);
});

test('public Parser OpenAPI conversion through managed SDK registration validates before a real upstream request', async t => {
  const requests = [];
  const upstream = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, body: JSON.parse(body) });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ accepted: true }));
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const spec = { openapi: '3.0.3', info: { title: 'Public Parser schema fixture', version: '1' },
    servers: [{ url: `http://127.0.0.1:${upstream.address().port}` }], paths: { '/orders': { post: {
      operationId: 'create_order', requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', required: ['id', 'tags'], properties: {
          id: { type: 'integer', description: 'Order number' },
          tags: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
      } } } }, responses: { 200: { description: 'Accepted' } },
    } } } };
  const tools = transformToMCPTools(spec);
  assert.equal(tools.length, 1);
  const before = JSON.stringify(tools[0].inputSchema);
  const server = new McpServer({ name: 'parser-schema', version: '1' });
  registerManagedMcpTools(server, tools);
  const client = await connect(t, server);
  const listed = (await client.listTools()).tools[0].inputSchema;
  assert.equal(listed.properties.id.type, 'integer');
  assert.equal(listed.properties.id.description, 'Order number');
  assert.equal(listed.properties.tags.items.type, 'string');
  assert.deepEqual([...listed.required].sort(), ['id', 'tags']);
  const valid = { id: Number.MAX_SAFE_INTEGER + 1, tags: ['a'] };
  const result = await client.callTool({ name: tools[0].name, arguments: valid });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(requests, [{ method: 'POST', url: '/orders', body: valid }]);
  for (const invalid of [{ id: 1 }, { id: 1.5, tags: ['a'] }, { id: 1, tags: [7] }]) {
    assert.equal((await client.callTool({ name: tools[0].name, arguments: invalid })).isError, true);
  }
  assert.equal(requests.length, 1, 'invalid tools/call must be rejected before HTTP dispatch');
  assert.equal(JSON.stringify(tools[0].inputSchema), before, 'registration must not mutate the public Parser schema');
});

for (const entry of ['managed', 'registry']) {
  test(`${entry}: migration preserves declared integer domain beyond safe integers and rejects fractions`, async t => {
    const inputSchema = { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } };
    let client, received;
    if (entry === 'managed') ({ client, received } = await managed(t, inputSchema));
    else {
      const signals = process.listeners('SIGINT');
      const registry = new MCPRegistry();
      const id = await registry.createServer({ name: 'registry-integer', version: '1' });
      t.after(async () => {
        await registry.destroyServer(id);
        for (const listener of process.listeners('SIGINT')) if (!signals.includes(listener)) process.off('SIGINT', listener);
      });
      received = [];
      await registry.bindToolsToServer(id, [{ id: 'integer', name: 'schema_fixture', description: 'Integer input', inputSchema,
        handler: async args => { received.push(args); return { content: [{ type: 'text', text: 'accepted' }] }; } }]);
      client = await connect(t, registry.getServer(id));
    }
    const schema = (await client.listTools()).tools[0].inputSchema.properties.id;
    assert.equal(schema.type, 'integer');
    assert.equal(schema.minimum, undefined);
    assert.equal(schema.maximum, undefined);
    for (const value of [0, -12, Number.MAX_SAFE_INTEGER + 1, 1e20]) {
      assert.notEqual((await client.callTool({ name: 'schema_fixture', arguments: { id: value } })).isError, true);
    }
    assert.equal(received.length, 4);
    for (const value of [1.5, '12']) {
      assert.equal((await client.callTool({ name: 'schema_fixture', arguments: { id: value } })).isError, true);
    }
    assert.equal(received.length, 4);
  });
}

// GHSA-mrhx-c7xc-m3w5 / upstream PR #6652: a constrained collection must
// reject by size before touching elements, not accumulate one issue per item.
// Bounded fixtures use property getters to prove the actual early boundary;
// they neither allocate a huge payload nor rely on a timing threshold.
for (const collection of ['array', 'set', 'map']) {
  for (const mode of ['sync', 'async']) {
    test(`GHSA-mrhx-c7xc-m3w5 ${collection}/${mode}: oversized constrained input skips all element validation`, async () => {
      let visits = 0;
      const element = z.object({ value: z.string() });
      const schema = collection === 'array' ? z.array(element).max(2)
        : collection === 'set' ? z.set(element).max(2) : z.map(z.string(), element).max(2);
      const values = Array.from({ length: 32 }, () => ({ get value() { visits++; return 0; } }));
      const input = collection === 'array' ? values : collection === 'set' ? new Set(values)
        : new Map(values.map((value, index) => [String(index), value]));
      const result = mode === 'sync' ? schema.safeParse(input) : await schema.safeParseAsync(input);
      assert.equal(result.success, false);
      assert.equal(visits, 0);
      assert.equal(result.error.issues.length, 1);
      assert.equal(result.error.issues[0].code, 'too_big');
      const validValues = [{ value: 'a' }, { value: 'b' }];
      const valid = collection === 'array' ? validValues : collection === 'set' ? new Set(validValues)
        : new Map(validValues.map((value, index) => [String(index), value]));
      assert.equal((mode === 'sync' ? schema.safeParse(valid) : await schema.safeParseAsync(valid)).success, true);
    });
  }
}
