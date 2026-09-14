import { AsyncLocalStorage } from 'node:async_hooks';
import type { ServerResponse } from 'node:http';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

const responseCompletion = new AsyncLocalStorage<Promise<void>>();

/** The SDK's Web stream enqueue is not a Node HTTP delivery acknowledgement. */
export function withMcpHttpResponse<T>(res: ServerResponse, operation: () => T): T {
  const completion = new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      res.off('finish', onFinish);
      res.off('close', onClose);
      res.off('error', onError);
    };
    const onFinish = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('MCP HTTP response interrupted')); };
    const onClose = () => { if (res.writableFinished) onFinish(); else onError(); };
    if (res.writableFinished) { resolve(); return; }
    if (res.destroyed) { reject(new Error('MCP HTTP response unavailable')); return; }
    res.once('finish', onFinish);
    res.once('close', onClose);
    res.once('error', onError);
  });
  // Notifications and validation failures need not create a Tool observer.
  void completion.catch(() => undefined);
  return responseCompletion.run(completion, operation);
}

export function getMcpHttpResponseCompletion(): Promise<void> | undefined {
  return responseCompletion.getStore();
}

/** Preserve SDK framing and write return values; wait for this send's callbacks. */
export function confirmSseWrites(transport: Transport, res: ServerResponse): void {
  const scope = new AsyncLocalStorage<Promise<void>[]>();
  const write = res.write;
  const send = transport.send.bind(transport);
  const pending = new Set<(error: Error) => void>();
  const failPending = () => {
    for (const fail of [...pending]) fail(new Error('MCP SSE output interrupted'));
  };
  const wrappedWrite = function(this: ServerResponse, ...args: any[]) {
    const writes = scope.getStore();
    if (!writes) return (write as Function).apply(this, args);
    let fail!: (error: Error) => void;
    let complete!: (error?: Error | null) => void;
    const acknowledged = new Promise<void>((resolve, reject) => {
      fail = error => { pending.delete(fail); reject(error); };
      complete = error => {
        if (error) fail(error);
        else if (pending.delete(fail)) resolve();
      };
      pending.add(fail);
    });
    void acknowledged.catch(() => undefined);
    writes.push(acknowledged);
    const originalCallback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
    args.push((error?: Error | null) => {
      complete(error);
      originalCallback?.(error);
    });
    try {
      return (write as Function).apply(this, args);
    } catch (error) {
      fail(error instanceof Error ? error : new Error('MCP SSE write failed'));
      throw error;
    }
  } as typeof res.write;
  res.write = wrappedWrite;
  res.on('error', failPending);
  res.once('close', () => {
    failPending();
    res.off('error', failPending);
    if (res.write === wrappedWrite) res.write = write;
  });
  transport.send = async (message, options) => {
    if (res.destroyed || res.writableEnded) throw new Error('MCP SSE output unavailable');
    const writes: Promise<void>[] = [];
    const result = await scope.run(writes, () => send(message, options));
    await Promise.all(writes);
    return result;
  };
}
