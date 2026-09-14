import { randomUUID } from 'node:crypto';
import { createRuntimeHttpAuditAgents, RuntimeCallContext, withRuntimeCallContext } from 'api-nova-parser';

/** A fresh context must never inherit an administrator's external trace. */
export function endpointDependencyContext(
  origin: 'test' | 'probe' | 'internal',
  assets: Pick<RuntimeCallContext, 'endpointDefinitionId' | 'sourceServiceAssetId' |
    'sourceServiceInstanceId' | 'runtimeAssetId' | 'runtimeAssetEndpointBindingId' |
    'toolName' | 'transport'>,
): RuntimeCallContext {
  return { ...assets, origin, requestId: randomUUID(), traceId: randomUUID(),
    identitySource: 'anonymous', authState: 'unknown' };
}

/** Observe the existing HTTP operation without inventing an ingress or retry. */
export async function observeEndpointDependency<T>(
  context: RuntimeCallContext,
  execute: (agents: Partial<Pick<ReturnType<typeof createRuntimeHttpAuditAgents>,
    'httpAgent' | 'httpsAgent'>>) => Promise<T>,
): Promise<T> {
  return withRuntimeCallContext(context, async () => {
    let agents: ReturnType<typeof createRuntimeHttpAuditAgents> | undefined;
    try { agents = createRuntimeHttpAuditAgents(context); } catch { /* Fail open. */ }
    try {
      return await execute(agents ? { httpAgent: agents.httpAgent, httpsAgent: agents.httpsAgent } : {});
    } finally {
      try { agents?.destroy(); } catch { /* Never replace a business result. */ }
    }
  });
}
