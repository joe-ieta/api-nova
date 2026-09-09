import * as http from 'node:http';
import * as https from 'node:https';
import { randomUUID } from 'node:crypto';
import type { RuntimeCallContext } from './runtime-call-audit';
import { runRuntimeUpstreamAttempt } from './runtime-upstream-attempt';

type NativeAgent = { addRequest(request: http.ClientRequest, options: http.RequestOptions): void };
const health = { instrumentationFailures: 0 };
export function getRuntimeHttpAgentAuditHealth() { return { ...health }; }

/** Instance-local hooks retain Axios/follow-redirects semantics and never consume a response. */
export function createRuntimeHttpAuditAgents(context: RuntimeCallContext, credentialHeaderNames: string[] = []) {
  const httpAgent = new http.Agent({ keepAlive: false });
  const httpsAgent = new https.Agent({ keepAlive: false });
  const upstreamOperationId = randomUUID();
  let redirectHopIndex = 0;
  const safe = <T>(operation: () => T): T | undefined => {
    try { return operation(); } catch { health.instrumentationFailures++; return undefined; }
  };
  const wrap = (agent: http.Agent | https.Agent, protocol: string) => {
    const native = agent as unknown as NativeAgent;
    const add = native.addRequest.bind(agent);
    native.addRequest = (request, options) => {
      const hop = redirectHopIndex++;
      const host = String(options.hostname || options.host || 'localhost');
      const authority = host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host;
      const requestPath = String(options.path || '/');
      const url = /^https?:\/\//i.test(requestPath) ? requestPath
        : protocol + '//' + authority + (options.port ? ':' + options.port : '') + requestPath;
      let syncFailure: unknown;
      let didThrow = false;
      let cleanup = () => undefined;
      void runRuntimeUpstreamAttempt({
        context: { ...context, upstreamOperationId },
        method: request.method || String(options.method || 'GET'), url,
        attemptIndex: 1, redirectHopIndex: hop,
        requestHeaders: request.getHeaders(), credentialHeaderNames,
      }, observer => new Promise<void>((resolve, reject) => {
        let settled = false, timedOut = false, response: http.IncomingMessage | undefined;
        let originalResponseEmit: typeof http.IncomingMessage.prototype.emit | undefined;
        let wrappedResponseEmit: typeof http.IncomingMessage.prototype.emit | undefined;
        const write = request.write, end = request.end;
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          if (error) reject(error); else resolve();
        };
        const capture = (chunk?: unknown, encoding?: unknown) => safe(() => {
          if (typeof chunk === 'string') observer.requestChunk(Buffer.from(chunk,
            typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8'));
          else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) observer.requestChunk(Buffer.from(chunk));
        });
        const wrappedWrite = function(this: http.ClientRequest, ...args: any[]) {
          capture(args[0], args[1]); return (write as Function).apply(this, args);
        } as typeof request.write;
        const wrappedEnd = function(this: http.ClientRequest, ...args: any[]) {
          if (typeof args[0] !== 'function') capture(args[0], args[1]);
          return (end as Function).apply(this, args);
        } as typeof request.end;
        const error = (value: Error) => {
          // Axios HTTP timeouts use ECONNABORTED by default. Its original error reaches
          // the native request; scope this conversion to Axios, never arbitrary aborts.
          const axiosTimeout = safe(() => {
            const cause = value as Error & { isAxiosError?: boolean; code?: string };
            return cause?.isAxiosError === true && cause.code === 'ECONNABORTED';
          });
          finish(timedOut || axiosTimeout
            ? Object.assign(new Error('Upstream timeout'), { code: 'ETIMEDOUT' }) : value);
        };
        const closed = () => {
          if (!response && !settled) finish(Object.assign(new Error('Upstream request closed'), {
            code: timedOut ? 'ETIMEDOUT' : request.aborted ? 'ABORT_ERR' : 'ECONNRESET',
          }));
        };
        const timeout = () => { timedOut = true; };
        const sent = () => observer.requestComplete();
        const received = (incoming: http.IncomingMessage) => {
          response = incoming;
          observer.responseStarted(incoming.statusCode || 502, incoming.headers, String(incoming.headers['content-type'] || ''));
          const isRedirect = (incoming.statusCode || 0) >= 300 && (incoming.statusCode || 0) < 400 && !!incoming.headers.location;
          originalResponseEmit = incoming.emit;
          wrappedResponseEmit = function(this: http.IncomingMessage, event: string | symbol, ...args: any[]) {
            safe(() => {
              if (settled) return;
              if (event === 'data') observer.responseChunk(args[0]);
              if (event === 'end') { observer.responseComplete(); finish(); }
              if ((event === 'aborted' || event === 'close') && !settled) {
                // follow-redirects deliberately discards a redirect body; do not invent a full read.
                if (isRedirect) finish();
                else finish(Object.assign(new Error('Upstream response interrupted'), { code: 'ECONNRESET' }));
              }
              if (event === 'error' && !settled) error(args[0]);
            });
            return originalResponseEmit!.call(this, event, ...args);
          };
          incoming.emit = wrappedResponseEmit;
        };
        request.write = wrappedWrite; request.end = wrappedEnd;
        request.once('finish', sent);
        // Observe before follow-redirects destroys redirect bodies or Axios deletes encoding headers.
        request.prependOnceListener('response', received);
        request.once('error', error); request.once('close', closed); request.once('timeout', timeout);
        cleanup = () => {
          safe(() => {
            if (request.write === wrappedWrite) request.write = write;
            if (request.end === wrappedEnd) request.end = end;
            if (response && response.emit === wrappedResponseEmit && originalResponseEmit) response.emit = originalResponseEmit;
            request.removeListener('finish', sent); request.removeListener('response', received);
            request.removeListener('error', error); request.removeListener('close', closed); request.removeListener('timeout', timeout);
          });
          return undefined;
        };
        try { add(request, options); }
        catch (value) { didThrow = true; syncFailure = value; finish(value); }
      })).catch(() => undefined).finally(() => cleanup());
      if (didThrow) throw syncFailure;
    };
  };
  wrap(httpAgent, 'http:'); wrap(httpsAgent, 'https:');
  return { httpAgent, httpsAgent, destroy() { httpAgent.destroy(); httpsAgent.destroy(); } };
}
