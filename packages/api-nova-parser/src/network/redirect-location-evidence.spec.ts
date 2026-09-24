import * as http from 'node:http';
import { Socket } from 'node:net';
import { createRedirectLocationEvidenceStore } from './redirect-location-evidence';
const denied = 'upstream_network_policy_denied';
async function realResponse(headers: string[]) {
  const server = http.createServer((_request, response) => { response.writeHead(302, headers); response.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = http.get({ hostname: '127.0.0.1', port: (server.address() as any).port }, response => {
        response.resume(); response.once('end', () => resolve(response)); response.once('error', reject);
      }); request.once('error', reject);
    });
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
const incoming = (raw: string[]) => { const message = new http.IncomingMessage(new Socket()); message.rawHeaders = raw; return message; };

describe('raw Location evidence (real HTTP and hostile descriptor fixtures)', () => {
  it.each(['Location', 'location', 'lOcAtIoN'])('captures unique real %s without exposing raw headers', async name => {
    const message = await realResponse([name, '/next', 'X-Private', 'private-value']);
    const store = createRedirectLocationEvidenceStore(), response = Object.freeze({ statusCode: 302 });
    store.capture(message, response);
    const evidence = store.consume(response);
    expect(evidence).toEqual({ kind: 'single', value: '/next' }); expect(Object.isFrozen(evidence)).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain('private-value');
  });
  it('distinguishes real absent Location', async () => {
    const store = createRedirectLocationEvidenceStore(), response = {};
    store.capture(await realResponse(['X-Test', 'value']), response);
    expect(store.consume(response)).toEqual({ kind: 'absent' });
  });
  it.each([['Location', '/one', 'Location', '/two'], ['Location', '/one', 'lOcAtIoN', '/one']].map(headers => ({ headers })))(
    'rejects raw duplicates even when Node presents one merged value %#', async ({ headers }) => {
      const message = await realResponse(headers);
      expect(typeof message.headers.location).toBe('string');
      const store = createRedirectLocationEvidenceStore(), response = {};
      store.capture(message, response); expect(store.consume(response)).toEqual({ kind: 'ambiguous' });
    });
  it('preserves a single comma-containing Location as one raw field (no comma split)', async () => {
    const store = createRedirectLocationEvidenceStore(), response = {};
    store.capture(await realResponse(['Location', '/next?a=1,2']), response);
    expect(store.consume(response)).toEqual({ kind: 'single', value: '/next?a=1,2' });
  });
  it('ignores forged merged headers and binds the original response identity', async () => {
    const message = await realResponse(['Location', '/original']);
    message.headers.location = '/forged';
    const store = createRedirectLocationEvidenceStore(), response = { statusCode: 302 };
    store.capture(message, response);
    expect(() => store.consume({ ...response })).toThrow(denied);
    expect(store.consume(response)).toEqual({ kind: 'single', value: '/original' });
    expect(() => store.consume(response)).toThrow(denied);
  });
  it('rejects replay of incoming identity onto another response', () => {
    const store = createRedirectLocationEvidenceStore(), first = {}, second = {}, message = incoming(['Location', '/one']);
    store.capture(message, first);
    expect(() => store.capture(message, second)).toThrow(denied);
    expect(() => store.consume(second)).toThrow(denied);
  });
  it('rejects overwriting a response identity and invalidates the existing record', () => {
    const store = createRedirectLocationEvidenceStore(), response = {};
    store.capture(incoming(['Location', '/one']), response);
    expect(() => store.capture(incoming(['Location', '/two']), response)).toThrow(denied);
    expect(() => store.consume(response)).toThrow(denied);
  });
  it('freezes captured evidence against later raw array mutation', () => {
    const store = createRedirectLocationEvidenceStore(), response = {}, message = incoming(['Location', '/one']);
    store.capture(message, response); message.rawHeaders[1] = '/two';
    expect(store.consume(response)).toEqual({ kind: 'single', value: '/one' });
  });
  it.each(['rawHeaders', 'name', 'value'])('never invokes a %s getter', field => {
    const message = incoming(['Location', '/one']), getter = jest.fn(() => { throw new Error('private-error'); });
    if (field === 'rawHeaders') Object.defineProperty(message, 'rawHeaders', { get: getter });
    else Object.defineProperty(message.rawHeaders, field === 'name' ? '0' : '1', { get: getter });
    const store = createRedirectLocationEvidenceStore(), response = {};
    store.capture(message, response); expect(store.consume(response)).toEqual({ kind: 'ambiguous' });
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([['Location'], ['Location', '/one\r\ninjected'], ['Bad Name', 'value'], ['Location', 'x'.repeat(4097)]].map(raw => ({ raw })))(
    'bounds and rejects malformed raw evidence %#', ({ raw }) => {
      const store = createRedirectLocationEvidenceStore(), response = {};
      store.capture(incoming(raw), response); expect(store.consume(response)).toEqual({ kind: 'ambiguous' });
    });
  it('does not read a prototype-supplied raw array slot', () => {
    const raw: string[] = []; raw.length = 2;
    Object.setPrototypeOf(raw, { 0: 'Location', 1: '/inherited' });
    const store = createRedirectLocationEvidenceStore(), response = {};
    store.capture(incoming(raw), response); expect(store.consume(response)).toEqual({ kind: 'ambiguous' });
  });
  it('does not invoke toJSON/message/header getters on response identity', () => {
    const getter = jest.fn(() => { throw new Error('private'); });
    const response = Object.defineProperties({}, { toJSON: { get: getter }, headers: { get: getter }, message: { get: getter } });
    const store = createRedirectLocationEvidenceStore(); store.capture(incoming([]), response);
    expect(store.consume(response)).toEqual({ kind: 'absent' }); expect(getter).not.toHaveBeenCalled();
  });
  it('cannot consume a different store or a nonresponse value', () => {
    const response = {}, store = createRedirectLocationEvidenceStore(); store.capture(incoming([]), response);
    expect(() => createRedirectLocationEvidenceStore().consume(response)).toThrow(denied);
    expect(() => store.consume(null as any)).toThrow(denied);
    expect(() => store.capture({ rawHeaders: [] } as any, {})).toThrow(denied);
  });
});
