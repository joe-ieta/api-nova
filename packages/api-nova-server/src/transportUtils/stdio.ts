import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { flushRuntimeAudit } from 'api-nova-parser';
import { instrumentMcpTransport } from './audit';

/** Write callbacks establish local delivery, not peer application acknowledgement. */
class AuditedStdioTransport extends StdioServerTransport {
  private stopped = false;
  private closing?: Promise<void>;
  private writes = new Set<(error: Error) => void>();
  private readonly endInput = () => { void this.close(); };
  private readonly streamError = (error: Error) => {
    for (const reject of this.writes) reject(error);
    void this.close();
  };
  private readonly endOutput = () => this.streamError(new Error('STDIO output closed'));

  override async start(): Promise<void> {
    // connect() installs callbacks before start(); instrument before reading stdin.
    instrumentMcpTransport(this, { localProcess: true });
    process.stdin.once('end', this.endInput);
    process.stdin.once('close', this.endInput);
    process.stdin.on('error', this.streamError);
    process.stdout.on('error', this.streamError);
    process.stdout.once('close', this.endOutput);
    await super.start();
  }

  override send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.stopped || process.stdout.destroyed || process.stdout.writableEnded) {
        reject(new Error('STDIO output unavailable'));
        return;
      }
      const fail = (error: Error) => { this.writes.delete(fail); reject(error); };
      this.writes.add(fail);
      try {
        process.stdout.write(serializeMessage(message), error => {
          if (error) { fail(error); return; }
          if (this.writes.delete(fail)) resolve();
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error('STDIO write failed'));
      }
    });
  }

  override close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.closing = (async () => {
      for (const reject of this.writes) reject(new Error('STDIO session closed during write'));
      // Let failed sends record incomplete evidence before cancelling other calls.
      await Promise.resolve();
      await super.close();
      process.stdin.off('end', this.endInput);
      process.stdin.off('close', this.endInput);
      process.stdin.off('error', this.streamError);
      process.stdout.off('close', this.endOutput);
      // Node emits stream errors after the failed write callback.
      setImmediate(() => process.stdout.off('error', this.streamError));
      await flushRuntimeAudit();
    })();
    return this.closing;
  }
}

export async function startStdioMcpServer(server: McpServer): Promise<void> {
  await server.connect(new AuditedStdioTransport());
}