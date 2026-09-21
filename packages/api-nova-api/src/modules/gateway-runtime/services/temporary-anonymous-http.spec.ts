import { createServer } from 'node:http';
import { once } from 'node:events';
import { GatewaySecurityService } from './gateway-security.service';
import { GatewayPolicyService } from './gateway-policy.service';

describe('temporary anonymous real Gateway HTTP admission', () => {
  const original = { ...process.env };
  afterAll(()=>{ process.env = original; });
  it('checks expiry on every request and audits the same rejected request', async()=>{
    delete process.env.API_NOVA_ALLOW_TEMPORARY_ANONYMOUS_IN_PRODUCTION;
    process.env.NODE_ENV='test';
    const audit={log:jest.fn().mockResolvedValue(undefined)};
    const service=new GatewaySecurityService(audit as any, {} as any);
    const grant={reason:'Demo',actor:'trusted-user',expiresAt:new Date(Date.now()+1500).toISOString(),allowProduction:false};
    const route:any={routeBinding:{id:'route',routeVisibility:'external',authPolicyRef:'anonymous',upstreamConfig:{temporaryAnonymous:grant}},runtimeAsset:{id:'runtime'}};
    route.policies=new GatewayPolicyService().compileForRoute(route.routeBinding);
    let admitted=0;
    const server=createServer(async(req,res)=>{
      try { await service.authorize(route,req as any); admitted++;res.end('ok'); }
      catch(error:any){res.writeHead(error.getStatus?.()||500);res.end(error.message);}
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const url=`http://127.0.0.1:${(server.address() as any).port}`;
    try {
      expect((await fetch(url)).status).toBe(200);
      await new Promise(resolve=>setTimeout(resolve, Math.max(0, Date.parse(grant.expiresAt)-Date.now()+20)));
      const expired=await fetch(url,{headers:{'x-anonymous-actor':'spoof','x-anonymous-expiry':'2099'}});
      expect(expired.status).toBe(403);expect(await expired.text()).toBe('temporary_anonymous_expired');expect(admitted).toBe(1);
      expect(audit.log).toHaveBeenLastCalledWith(expect.objectContaining({status:'failed',metadata:expect.objectContaining({actor:'trusted-user',reason:'temporary_anonymous_expired'})}));
      route.policies.auth.temporaryAnonymous.expiresAt=new Date(Date.now()+60000).toISOString();
      process.env.NODE_ENV='production';
      for(const [policy,host,status] of [[false,false,403],[true,false,403],[false,true,403],[true,true,200]] as const){
        route.policies.auth.temporaryAnonymous.allowProduction=policy;
        process.env.API_NOVA_ALLOW_TEMPORARY_ANONYMOUS_IN_PRODUCTION=String(host);
        expect((await fetch(url)).status).toBe(status);
      }
    } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
  });
});
