import { compileHeaderPolicyV1 } from 'api-nova-parser';
import { filterGatewayRequestHeadersV1 as request, filterGatewayResponseHeadersV1 as response, GatewayHeaderWireError } from './gateway-header-wire-policy';
const policy = compileHeaderPolicyV1({ policy: { version: 1, requestHeaders: ['x-business', 'prefer'], responseHeaders: ['link', 'x-result'] }, sourceId: 'test' });
const defaults = { policy, targetUrl: new URL('https://upstream.example:8443/api'), requestId: 'generated-id', peerAddress: '127.0.0.1' };
const req = (raw: string[], extra = {}) => request({ ...defaults, rawHeaders: ['Host', 'gateway.example', ...raw], ...extra });
const res = (raw: string[], extra = {}) => response({ policy, rawHeaders: raw, statusCode: 200, requestMethod: 'GET', ...extra });
function status(fn: () => unknown, expected: number) {
  try { fn(); throw new Error('expected rejection'); } catch (error) { expect(error).toBeInstanceOf(GatewayHeaderWireError); expect((error as GatewayHeaderWireError).statusCode).toBe(expected); }
}
describe('Gateway v1 raw wire policy', () => {
  it('uses business allowlist and trusted peer TLS ID target', () => {
    const result = req(['X-Business', ' yes\t', 'X-Unknown', 'no', 'Authorization', 'consumer', 'Cookie', 'session', 'Forwarded', 'bad', 'X-Forwarded-For', 'bad', 'X-Request-ID', 'bad'], { tls: true });
    expect(result.headers).toEqual({ 'x-business': 'yes', host: 'upstream.example:8443', 'x-forwarded-host': 'gateway.example', 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'https', 'x-request-id': 'generated-id' });
  });
  it('aggregates Connection aliases without suppressing trusted credential', () => {
    const result = req(['Connection', 'x-business, authorization', 'CONNECTION', 'accept', 'X-Business', 'secret', 'Accept', 'text/plain'], { credentialHeaders: { Authorization: 'Bearer synthetic' } });
    expect(result.headers.accept).toBeUndefined(); expect(result.headers['x-business']).toBeUndefined(); expect(result.headers.authorization).toBe('Bearer synthetic');
  });
  it('merges permitted list fields in original order', () => { expect(req(['Accept', 'a', 'aCCept', 'b']).headers.accept).toBe('a, b'); expect(res(['Vary', 'Accept', 'vary', 'Accept-Language']).headers.vary).toBe('Accept, Accept-Language'); });
  it.each(['Content-Type', 'X-Business', 'Authorization', 'X-Api-Key', 'Cookie', 'Host', 'Content-Length'])('rejects duplicate %s', name => status(() => req([name, '1', name.toLowerCase(), '1']), 400));
  it('fallback preserves aliases and arrays; malformed raw cannot fallback', () => {
    status(() => request({ ...defaults, headers: { Host: 'gateway', 'Content-Type': 'a', 'content-type': ['b'] } }), 400);
    expect(request({ ...defaults, headers: { Host: 'gateway', Accept: ['a', 'b'] } }).headers.accept).toBe('a, b');
    status(() => request({ ...defaults, rawHeaders: ['Host'], headers: { Host: 'valid' } }), 400);
    status(() => request({ ...defaults, rawHeaders: [], headers: { Host: 'valid' } }), 400);
  });
  it.each(['bad name', 'bad:header', 'bad\rname'])('rejects illegal name %j', name => status(() => req([name, 'x']), 400));
  it.each(['secret\r\ninject', 'secret\u0000', 'secret\u007f', 'secret\u0001'])('rejects values without reflecting them %j', value => { status(() => req(['x-unknown', value]), 400); try { req(['x-unknown', value]); } catch (error) { expect(String(error)).not.toContain('secret'); } });
  it('enforces count value aggregate byte limits', () => {
    status(() => req(Array.from({ length: 100 }, (_, n) => [`x-${n}`, 'v']).flat()), 431);
    status(() => req(['x-unknown', 'a'.repeat(8193)]), 431);
    status(() => req(['x-a', 'a'.repeat(8192), 'x-b', 'b'.repeat(8192)]), 431);
    status(() => res(['x-a', 'a'.repeat(8193)]), 502);
  });
  it.each([['Content-Length', '1', 'Transfer-Encoding', 'chunked'], ['Content-Length', '-1'], ['Content-Length', '1.0'], ['Content-Length', '9007199254740992'], ['Transfer-Encoding', 'gzip'], ['Transfer-Encoding', 'chunked, chunked']])('rejects framing %j', (...raw: string[]) => { status(() => req(raw), 400); status(() => res(raw), 502); });
  it('normalizes length and does not copy transfer encoding', () => { expect(req(['Content-Length', '00012']).headers['content-length']).toBe('12'); expect(req(['Transfer-Encoding', 'chunked'])).toMatchObject({ chunked: true }); expect(req(['Transfer-Encoding', 'chunked']).headers['transfer-encoding']).toBeUndefined(); });
  it('rejects expectation upgrades trailers', () => { status(() => req(['Expect', '100-continue']), 417); for (const name of ['Upgrade', 'Trailer', 'Trailers']) status(() => req([name, 'x']), 400); status(() => req(['Connection', 'upgrade']), 400); });
  it.each(['evil/path', 'user@evil', 'evil#fragment', 'evil:99999', 'evil,other', 'evil\\other', 'evil host', 'evil?query'])('rejects Host %s', host => status(() => request({ ...defaults, rawHeaders: ['Host', host] }), 400));
  it('allows IPv6 authority', () => expect(request({ ...defaults, rawHeaders: ['Host', '[::1]:8080'] }).headers['x-forwarded-host']).toBe('[::1]:8080'));
  it('strips managed consumer historical authentication and rejects duplicates', () => { const extra = { managedHeaderNames: ['x-managed'], consumerAuthenticationHeaderNames: ['x-consumer'], historicalAuthenticationHeaderNames: ['x-old'] }; expect(req(['x-managed', 'a', 'x-consumer', 'b', 'x-old', 'c'], extra).normalizedRequestHeaders).toEqual({}); for (const name of ['x-managed', 'x-consumer', 'x-old']) status(() => req([name, 'a', name, 'b'], extra), 400); });
  it.each(['cookie', 'set-cookie', 'host', 'content-length', 'connection', 'x-business', 'accept', 'traceparent', 'x-forwarded-for', 'x-apinova-secret'])('rejects resolver conflict %s', name => status(() => req([], { credentialHeaders: { [name]: 'synthetic' } }), 503));
  it('rejects invalid duplicate empty credentials preserving secret whitespace', () => { for (const credentialHeaders of [{ Authorization: 'a', authorization: 'b' }, { Authorization: 'a\r\nb' }, { Authorization: '' }]) status(() => req([], { credentialHeaders }), 503); expect(req([], { credentialHeaders: { 'X-Upstream-Key': ' synthetic ' } }).headers['x-upstream-key']).toBe(' synthetic '); });
  it('independently filters response retaining original no-cache signals', () => { const result = res(['Content-Type', 'text/plain', 'X-Business', 'not-response', 'X-Result', 'ok', 'Set-Cookie', 'synthetic', 'Pragma', 'no-cache', 'Server', 'bad', 'WWW-Authenticate', 'bad', 'Connection', 'x-result']); expect(result.headers).toEqual({ 'content-type': 'text/plain' }); expect(result.cacheSignals).toMatchObject({ setCookie: true, pragma: true }); });
  it('rejects response duplicates and invalid values', () => { status(() => res(['Content-Type', 'a', 'content-type', 'b']), 502); status(() => res(['X-Unknown', 'secret\r\ninjection']), 502); });
  it('rejects successful-status upgrade attempts and invalid dynamic value types', () => { status(() => res(['Upgrade', 'websocket']), 502); status(() => res(['Connection', 'upgrade']), 502); status(() => req([], { credentialHeaders: { Authorization: ['synthetic'] } }), 503); });
  it('retains HEAD 304 metadata and rejects 204 framing or nonfinal status', () => { for (const extra of [{ requestMethod: 'HEAD' }, { statusCode: 304 }]) expect(res(['Content-Length', '123'], extra)).toMatchObject({ contentLength: 123, bodyAllowed: false, headers: { 'content-length': '123' } }); expect(res([], { statusCode: 204 }).bodyAllowed).toBe(false); status(() => res(['Content-Length', '0'], { statusCode: 204 }), 502); status(() => res([], { statusCode: 101 }), 502); });
  it.each(['Range', 'If-Match', 'If-Future-Condition', 'Cache-Control', 'Pragma'])('retains bypass for %s', name => expect(req([name, 'x']).cacheBypass).toBe(true));
  it('strips repeated upstream Set-Cookie without rejecting or losing cache veto', () => {
    const result = res(['Set-Cookie', 'session=a', 'set-cookie', 'other=b']);
    expect(result.headers['set-cookie']).toBeUndefined(); expect(result.cacheSignals.setCookie).toBe(true);
    const fallback = response({ policy, statusCode: 200, requestMethod: 'GET', headers: { 'set-cookie': ['a', 'b'] } });
    expect(fallback.cacheSignals.setCookie).toBe(true); expect(fallback.headers).toEqual({});
  });
  it('does not let Connection nominations hide framing or duplicate authentication', () => {
    status(() => req(['Connection', 'content-length, transfer-encoding', 'Content-Length', '1', 'Transfer-Encoding', 'chunked']), 400);
    status(() => res(['Connection', 'content-length', 'Content-Length', '1', 'content-length', '1']), 502);
    status(() => req(['Connection', 'authorization', 'Authorization', 'a', 'authorization', 'a']), 400);
    expect(req(['Connection', 'content-length', 'Content-Length', '3']).headers['content-length']).toBe('3');
  });
  it('strips custom consumer and historical auth even when stale business policy allows names', () => {
    const custom = compileHeaderPolicyV1({ policy: { version: 1, requestHeaders: ['x-consumer', 'x-historical'], responseHeaders: ['x-consumer', 'x-historical'] }, sourceId: 'stale' });
    const metadata = { policy: custom, consumerAuthenticationHeaderNames: ['X-Consumer'], historicalAuthenticationHeaderNames: ['X-Historical'] };
    expect(req(['x-consumer', 'synthetic-a', 'x-historical', 'synthetic-b'], metadata).normalizedRequestHeaders).toEqual({});
    expect(res(['x-consumer', 'synthetic-a', 'x-historical', 'synthetic-b'], metadata).headers).toEqual({});
    status(() => req(['X-Consumer', 'a', 'x-consumer', 'a'], metadata), 400);
    status(() => res(['X-Historical', 'a', 'x-historical', 'a'], metadata), 502);
  });

});
