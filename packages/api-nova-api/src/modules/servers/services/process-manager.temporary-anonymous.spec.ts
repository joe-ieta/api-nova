import { once } from 'node:events';
import { ProcessManagerService } from './process-manager.service';
import { ProcessConfig } from '../interfaces/process.interface';

describe('managed temporary anonymous production trust boundary',()=>{
 const original={...process.env};
 beforeEach(()=>{process.env={...original,NODE_ENV:'production'};delete process.env.API_NOVA_ALLOW_TEMPORARY_ANONYMOUS_IN_PRODUCTION;});
 afterAll(()=>{process.env=original;});
 function fixture(){
  const service:any=Object.create(ProcessManagerService.prototype);
  Object.assign(service,{logger:{log:jest.fn(),error:jest.fn(),debug:jest.fn()},config:{},appConfigService:{processTimeout:30000,processMaxRetries:0},
   processes:new Map(),processInfo:new Map(),eventEmitter:{emit:jest.fn()},logProcess:jest.fn(),updateProcessStatus:jest.fn(),
   resourceMonitor:{startMonitoring:jest.fn()},logMonitor:{startLogMonitoring:jest.fn()},setupProcessListeners:jest.fn(),setupProcessOutputMonitoring:jest.fn(),
   writePidFile:jest.fn(),saveProcessInfo:jest.fn()});return service;
 }
 function config(allowProduction:boolean):ProcessConfig{return {
  id:'temporary-production-fixture',name:'fixture',scriptPath:process.execPath,
  args:['-e',`setTimeout(()=>{const p=require('api-nova-parser');p.assertTemporaryAnonymousPolicy(JSON.parse(process.env.API_NOVA_TEMPORARY_ANONYMOUS));console.log(JSON.stringify({environment:process.env.NODE_ENV,permission:process.env.API_NOVA_ALLOW_TEMPORARY_ANONYMOUS_IN_PRODUCTION,source:process.env.API_NOVA_RUNTIME_CREDENTIAL_SOURCE}));},100)`],
  env:{API_NOVA_RUNTIME_AUTH_MODE:'anonymous',NODE_ENV:'test',API_NOVA_ALLOW_TEMPORARY_ANONYMOUS_IN_PRODUCTION:'true',API_NOVA_RUNTIME_CREDENTIAL_SOURCE:'forged-source',API_NOVA_TEMPORARY_ANONYMOUS:'forged-policy'},
  mcpConfig:{transport:'streamable',managed:true,inboundAuthMode:'anonymous',temporaryAnonymous:{reason:'Test',actor:'trusted-admin',expiresAt:new Date(Date.now()+60000).toISOString(),allowProduction}},
 };}
 it.each([false,true])('rejects saved env production bypass with policy permission %s',async allow=>{
  const service=fixture();await expect(service.startProcess(config(allow))).rejects.toThrow('temporary_anonymous_production_forbidden');
  expect(service.processes.size).toBe(0);expect(service.updateProcessStatus).not.toHaveBeenCalled();
 });
 it('rejects host permission without policy permission',async()=>{
  process.env.API_NOVA_ALLOW_TEMPORARY_ANONYMOUS_IN_PRODUCTION='true';
  await expect(fixture().startProcess(config(false))).rejects.toThrow('temporary_anonymous_production_forbidden');
 });
 it('passes both genuine approvals to an actual child and replaces forged source/environment',async()=>{
  process.env.API_NOVA_ALLOW_TEMPORARY_ANONYMOUS_IN_PRODUCTION='true';process.env.API_NOVA_RUNTIME_CREDENTIAL_SOURCE='host-source';
  const service=fixture();const info=await service.startProcess(config(true));const child=info.process;
  let output='',errors='';child.stdout.on('data',(chunk:Buffer)=>output+=chunk);child.stderr.on('data',(chunk:Buffer)=>errors+=chunk);
  try{const [code]=await once(child,'close');expect(errors).toBe('');expect(code).toBe(0);
   expect(JSON.parse(output)).toEqual({environment:'production',permission:'true',source:'host-source'});
  }finally{if(child.exitCode===null)child.kill();}
 });
});
