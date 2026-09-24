import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { resolveUpstreamCredential, type UpstreamCredentialRegistrySnapshot, type UpstreamCredentialResolveInput } from 'api-nova-parser';
import { Repository } from 'typeorm';
import { createUpstreamSecurityBindingEvaluator } from './upstream-security-binding-evaluator';
import { reconcileUpstreamSecurity, securityDigest, type SecurityDeclaration } from './upstream-security-reconciliation';
import { UpstreamAuthenticationEvidencePrototype } from './upstream-authentication-evidence-prototype.entity';

/** Host-owned transport capability. No production implementation or HTTP controller
 * is registered. Implementations must enforce their network/redirect policy, never
 * merge cookies/consumer headers, and return the first response status only. */
export interface AuthenticationChallengeTransport {
  request(input: { url: string; method: 'GET' | 'HEAD'; headers: Readonly<Record<string, string>>; signal: AbortSignal }): Promise<number>;
}
export interface AuthenticationChallengeInput {
  sourceServiceAssetId: string; endpointDefinitionId: string; url: string;
  method: 'GET' | 'HEAD'; actorId: string; declaration: SecurityDeclaration; selectedBranch?: number;
}
/** Durable research slice only: does not return Verified or participate in publication. */
export function createAuthenticationChallengePrototype(options: {
  repository: Pick<Repository<UpstreamAuthenticationEvidencePrototype>, 'create' | 'save' | 'findOneBy'>;
  captureSnapshot: () => UpstreamCredentialRegistrySnapshot;
  transport: AuthenticationChallengeTransport;
  timeoutMs?: number;
}) {
  const runNonce = randomUUID();
  const evaluate = createUpstreamSecurityBindingEvaluator(options.captureSnapshot);
  const privateKey = randomBytes(32);
  const timeoutMs = Math.min(5000, Math.max(10, options.timeoutMs ?? 1000));
  const digest = (headers: Readonly<Record<string, string>>) => createHmac('sha256', privateKey)
    .update(JSON.stringify(Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
  const requestInput = (input: AuthenticationChallengeInput): UpstreamCredentialResolveInput => ({
    sourceServiceAssetId: input.sourceServiceAssetId, endpointDefinitionId: input.endpointDefinitionId,
    url: input.url, requestMethod: input.method,
  });
  const checkInput = (input: AuthenticationChallengeInput) => {
    try {
      const url = new URL(input.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash ||
        !['GET', 'HEAD'].includes(input.method) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.actorId)) throw new Error();
    } catch { throw new Error('CHALLENGE_INPUT_INVALID'); }
  };
  const context = (input: AuthenticationChallengeInput, snapshot: UpstreamCredentialRegistrySnapshot) => ({
    sourceServiceAssetId: input.sourceServiceAssetId, endpointDefinitionId: input.endpointDefinitionId,
    target: new URL(input.url).href, method: input.method, environment: snapshot.candidate.metadata.environment,
  });
  const probe = async (input: AuthenticationChallengeInput, headers: Readonly<Record<string, string>>) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    try {
      const status = await Promise.race([
        options.transport.request({url:input.url,method:input.method,headers,signal:controller.signal}),
        new Promise<never>((_, reject) => {timer=setTimeout(()=>{controller.abort();reject(new Error('timeout'));},timeoutMs);}),
      ]);
      if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error('status');
      return status;
    } finally { clearTimeout(timer!); controller.abort(); }
  };
  return Object.freeze({
    async challenge(input: AuthenticationChallengeInput): Promise<UpstreamAuthenticationEvidencePrototype> {
      input=structuredClone(input);
      checkInput(input);
      const snapshot = options.captureSnapshot();
      const binding = await evaluate.evaluate(requestInput(input));
      const decision = reconcileUpstreamSecurity({declaration:input.declaration, selectedBranch:input.selectedBranch,
        context:context(input,snapshot),binding});
      const row = options.repository.create({sourceServiceAssetId:input.sourceServiceAssetId,
        endpointDefinitionId:input.endpointDefinitionId,contextDigest:decision.contextDigest || securityDigest(context(input,snapshot)),
        providerEpoch:binding.providerEpoch,runNonce,bindingRevision:binding.revision,bindingGeneration:binding.generation,
        actorId:input.actorId,result:'failed'});
      if (binding.mode !== 'reference' || binding.reason || decision.state !== 'Configured') {
        row.failureCode='BINDING_UNAVAILABLE'; return options.repository.save(row);
      }
      try {
        const resolution=await resolveUpstreamCredential(snapshot,requestInput(input));
        if (options.captureSnapshot()!==snapshot || resolution.mode!=='reference') throw new Error('CONTEXT_CHANGED');
        const injectedDigest=digest(resolution.headers);
        const wrong=Object.fromEntries(Object.keys(resolution.headers).map(name=>[name,
          name.toLowerCase()==='authorization' ? (binding.credential?.type==='basic'
            ? 'Basic '+Buffer.from('wrong-'+randomUUID()+':wrong-'+randomUUID()).toString('base64')
            : 'Bearer '+randomUUID()) : randomUUID()]));
        const denied=(status:number)=>status===401 || status===403;
        row.anonymousBeforeStatus=await probe(input,{});
        if(!denied(row.anonymousBeforeStatus)) throw new Error('CHALLENGE_STATUS_REJECTED');
        row.wrongCredentialStatus=await probe(input,wrong);
        if(!denied(row.wrongCredentialStatus)) throw new Error('CHALLENGE_STATUS_REJECTED');
        row.validCredentialStatus=await probe(input,resolution.headers);
        if(row.validCredentialStatus<200 || row.validCredentialStatus>=300) throw new Error('CHALLENGE_STATUS_REJECTED');
        row.anonymousAfterStatus=await probe(input,{});
        if(!denied(row.anonymousAfterStatus)) throw new Error('CHALLENGE_STATUS_REJECTED');
        const currentResolution=await resolveUpstreamCredential(snapshot,requestInput(input));
        const currentBinding=await evaluate.evaluate(requestInput(input));
        if(options.captureSnapshot()!==snapshot || currentBinding.reason || currentBinding.providerEpoch!==binding.providerEpoch ||
          currentBinding.generation!==binding.generation || digest(currentResolution.headers)!==injectedDigest) throw new Error('CONTEXT_CHANGED');
        row.result='passed';
      } catch(error) {
        const message=error instanceof Error?error.message:'';
        row.failureCode=['CONTEXT_CHANGED','CHALLENGE_STATUS_REJECTED'].includes(message)?message:'CHALLENGE_TRANSPORT_FAILED';
      }
      return options.repository.save(row);
    },
    /** Process restart must never turn persisted successful status into current proof. */
    async isCurrentPrototypeEvidence(row: UpstreamAuthenticationEvidencePrototype, input: AuthenticationChallengeInput): Promise<boolean> {
      const stored=await options.repository.findOneBy({id:row.id});
      if(!stored) return false;
      row=stored;
      if(row.runNonce!==runNonce || row.result!=='passed') return false;
      try {
        checkInput(input); const snapshot=options.captureSnapshot();
        const binding=await evaluate.evaluate(requestInput(input));
        const decision=reconcileUpstreamSecurity({declaration:input.declaration,selectedBranch:input.selectedBranch,context:context(input,snapshot),binding});
        return decision.state==='Configured' && decision.contextDigest===row.contextDigest && binding.providerEpoch===row.providerEpoch &&
          options.captureSnapshot()===snapshot && row.bindingRevision===binding.revision && row.bindingGeneration===binding.generation;
      } catch { return false; }
    },
  });
}
