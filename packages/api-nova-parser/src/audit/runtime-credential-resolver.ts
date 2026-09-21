import { request } from 'node:http';
import { RuntimeAuthError } from './runtime-auth';
import { parseRuntimeAccessCredentialEnvelope, RuntimeAccessCredentialEnvelope } from './runtime-access-credential';

/** A host-supplied, per-child capability reads current DB state for every request. */
export function resolveRuntimeCredentials(env: NodeJS.ProcessEnv = process.env): Promise<RuntimeAccessCredentialEnvelope> {
  const fail = () => new RuntimeAuthError(503, 'runtime_auth_not_configured');
  let url: URL;
  const token = env.API_NOVA_RUNTIME_CREDENTIAL_RESOLVER_TOKEN;
  const runtimeAssetId = env.API_NOVA_RUNTIME_CREDENTIAL_RUNTIME_ID;
  try {
    url = new URL(env.API_NOVA_RUNTIME_CREDENTIAL_RESOLVER_URL || '');
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/credentials' ||
        url.search || url.hash || url.username || url.password || !token || !/^[a-f0-9]{64}$/.test(token) || !runtimeAssetId)
      throw fail();
  } catch { return Promise.reject(fail()); }
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', headers: { authorization: `Bearer ${token}` }, agent: false }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(fail()); return; }
      let bytes = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) { res.destroy(); req.destroy(); reject(fail()); }
        else chunks.push(chunk);
      });
      res.on('error', () => reject(fail()));
      res.on('aborted', () => reject(fail()));
      res.on('end', () => {
        try {
          const envelope = parseRuntimeAccessCredentialEnvelope(Buffer.concat(chunks).toString('utf8'));
          if (envelope.runtimeAssetId !== runtimeAssetId) throw fail();
          resolve(envelope);
        } catch { reject(fail()); }
      });
    });
    const deadline = setTimeout(() => { req.destroy(); reject(fail()); }, 2000);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', () => reject(fail()));
    req.end();
  });
}
