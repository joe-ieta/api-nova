import { normalizeTemporaryAnonymousPolicy, assertTemporaryAnonymousPolicy } from './temporary-anonymous-policy';
const grant = { reason: 'Short demo', actor: 'admin', expiresAt: '2030-01-01T00:00:00.000Z', allowProduction: true };
describe('temporary anonymous grants', () => {
  it('replaces a caller actor with the trusted controller identity', () => {
    expect(normalizeTemporaryAnonymousPolicy({ ...grant, actor: 'spoofed' }, 'admin-id').actor).toBe('admin-id');
  });
  it.each([null, {}, {...grant,reason:''}, {...grant,actor:''}, {...grant,expiresAt:''}, {...grant,allowProduction:'true'}])('rejects malformed grant %#', raw => {
    expect(()=>normalizeTemporaryAnonymousPolicy(raw)).toThrow('temporary_anonymous_policy_invalid');
  });
  it('rejects exactly at expiry',()=>expect(()=>assertTemporaryAnonymousPolicy(grant,{now:Date.parse(grant.expiresAt)})).toThrow('temporary_anonymous_expired'));
  it.each([[false,false],[true,false],[false,true]])('requires both production approvals %s/%s',(policy,host)=>{
    expect(()=>assertTemporaryAnonymousPolicy({...grant,allowProduction:policy},{environment:'production',hostAllowsProduction:host,now:0})).toThrow('temporary_anonymous_production_forbidden');
  });
  it('accepts dual approval',()=>expect(assertTemporaryAnonymousPolicy(grant,{environment:'production',hostAllowsProduction:true,now:0})).toEqual(grant));
});
