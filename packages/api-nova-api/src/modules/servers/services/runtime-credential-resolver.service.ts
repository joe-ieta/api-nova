import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createServer, Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { parseRuntimeAccessCredentialEnvelope } from 'api-nova-parser';
import { GatewayConsumerCredentialEntity } from '../../../database/entities/gateway-consumer-credential.entity';
import { RuntimeAssetEntity, RuntimeAssetType } from '../../../database/entities/runtime-asset.entity';
import { toRuntimeAccessCredential } from '../../runtime-assets/services/runtime-access-credential';

@Injectable()
export class RuntimeCredentialResolverService implements OnModuleDestroy {
  private server?: Server;
  private starting?: Promise<void>;
  private readonly capabilities = new Map<string, { serverId: string; runtimeAssetId: string }>();
  constructor(private readonly db: DataSource) {}

  private async envelope(runtimeAssetId: string) {
    const asset = await this.db.getRepository(RuntimeAssetEntity).findOneBy({ id: runtimeAssetId });
    if (!asset || asset.type !== RuntimeAssetType.MCP_SERVER) throw new Error('Invalid credential runtime');
    const rows = await this.db.getRepository(GatewayConsumerCredentialEntity).find({ where: { runtimeAssetId } });
    return parseRuntimeAccessCredentialEnvelope(JSON.stringify({ version: 1, runtimeAssetId,
      credentials: rows.filter(row => row.accessPolicy != null).map(toRuntimeAccessCredential) }));
  }
  async validateForRuntime(runtimeAssetId: string): Promise<void> {
    const envelope = await this.envelope(runtimeAssetId);
    const now = Date.now() / 1000;
    const required = (process.env.API_NOVA_RUNTIME_REQUIRED_SCOPES || '').split(/\s+/).filter(Boolean);
    if (!envelope.credentials.some(item => item.status === 'active' && item.expiresAt > now &&
        (item.validUntil === undefined || item.validUntil > now) && item.protocols.includes('mcp') &&
        !item.routeBindingId && required.every(scope => item.scopes.includes(scope))))
      throw new Error('No usable database MCP runtime credential');
  }
  private async listen() {
    if (this.server?.listening) return;
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      const server = createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
        const capability = token ? this.capabilities.get(token) : undefined;
        if (req.method !== 'GET' || req.url !== '/credentials' || !capability) { res.writeHead(401).end(); return; }
        try {
          const result = await this.envelope(capability.runtimeAssetId);
          // A release during the asynchronous DB read invalidates this response as well.
          if (this.capabilities.get(token!) !== capability) { res.writeHead(401).end(); return; }
          const body = JSON.stringify(result);
          if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('Credential set too large');
          res.setHeader('Content-Type', 'application/json'); res.end(body);
        } catch { res.writeHead(503).end(); }
      });
      server.headersTimeout = 3000; server.requestTimeout = 3000;
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { this.server = server; resolve(); });
    }).finally(() => { this.starting = undefined; });
    return this.starting;
  }
  async createSpawnEnv(serverId: string, runtimeAssetId: string): Promise<NodeJS.ProcessEnv> {
    await this.validateForRuntime(runtimeAssetId);
    await this.listen();
    this.releaseServer(serverId);
    const token = randomBytes(32).toString('hex');
    this.capabilities.set(token, { serverId, runtimeAssetId });
    return { API_NOVA_RUNTIME_CREDENTIAL_RESOLVER_URL: `http://127.0.0.1:${(this.server!.address() as any).port}/credentials`,
      API_NOVA_RUNTIME_CREDENTIAL_RESOLVER_TOKEN: token, API_NOVA_RUNTIME_CREDENTIAL_RUNTIME_ID: runtimeAssetId };
  }
  releaseServer(serverId: string): void {
    for (const [token, entry] of this.capabilities) if (entry.serverId === serverId) this.capabilities.delete(token);
  }
  async onModuleDestroy(): Promise<void> {
    await this.starting;
    this.capabilities.clear();
    const server = this.server; this.server = undefined;
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
}
