import { generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { McpInboundAuthMode } from '../../../database/entities/mcp-server.entity';
import { ProcessManagerService } from './process-manager.service';
import { mcpInboundSpawnEnv, persistedMcpInboundMode } from './mcp-inbound-process-env';

const publicJwk = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ format: 'jwk' });
const policy = { algorithms: ['ES384'], requiredClaims: ['sub', 'exp', 'iat', 'tenant'], clockToleranceSeconds: 30 };
const original = { ...process.env };
function environment() { return { ...original, API_NOVA_RUNTIME_ISSUER: 'https://issuer.example',
 API_NOVA_MCP_RESOURCE: 'https://runtime.example/mcp', API_NOVA_RUNTIME_JWKS_JSON: JSON.stringify({ keys: [{ ...publicJwk, alg: 'ES384' }] }) }; }
function config(jwtPolicy: unknown = policy) { return { id:'jwt-fixture', env: { API_NOVA_RUNTIME_AUTH_MODE:'jwt',
 API_NOVA_RUNTIME_JWT_POLICY: JSON.stringify({ ...policy, clockToleranceSeconds:300 }) },
 mcpConfig: { managed:true,inboundAuthMode:'jwt',jwtPolicy } }; }

describe('persisted JWT policy lifecycle agreement',()=>{
 beforeEach(()=>{process.env=environment();delete process.env.API_NOVA_RUNTIME_JWKS_URI;delete process.env.API_NOVA_RUNTIME_JWT_POLICY;});
 afterAll(()=>{process.env=original;});
 it('preflights an allowed non-default algorithm from persisted server config',()=>{
  expect(persistedMcpInboundMode({inboundAuthMode:McpInboundAuthMode.PRIVATE_JWT,config:{jwtPolicy:policy}} as any)).toBe('jwt');
  expect(()=>persistedMcpInboundMode({inboundAuthMode:McpInboundAuthMode.PRIVATE_JWT,config:{jwtPolicy:{...policy,algorithms:['RS256']}}} as any)).toThrow('JWK set');
 });
 it('rejects malformed persisted policy before any process side effect',async()=>{
  const service:any=Object.create(ProcessManagerService.prototype);
  service.updateProcessStatus=jest.fn();
  await expect(service.startProcess(config({...policy,clockToleranceSeconds:-1}))).rejects.toThrow();
  expect(service.updateProcessStatus).not.toHaveBeenCalled();
 });
 it('passes persisted policy to a real child without accepting saved env override',async()=>{
  const service:any=Object.create(ProcessManagerService.prototype);
  const env=await service.preflightProcessEnvironment(config());
  expect(JSON.parse(env.API_NOVA_RUNTIME_JWT_POLICY)).toEqual(policy);
  const child=spawn(process.execPath,['-e',"console.log(JSON.stringify(require('api-nova-parser').readRuntimeJwtPolicy()))"],{env,windowsHide:true});
  let output='',error='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>error+=chunk);
  try { const [code]=await once(child,'close');expect(code).toBe(0);expect(error).toBe('');expect(JSON.parse(output)).toEqual(policy); }
  finally {if(child.exitCode===null)child.kill();}
 });
 it('clears JWT configuration from anonymous and API key process environments',()=>{
  const env={...process.env,API_NOVA_RUNTIME_JWT_POLICY:JSON.stringify(policy)};
  expect(mcpInboundSpawnEnv('anonymous',env).API_NOVA_RUNTIME_JWT_POLICY).toBeUndefined();
 });
});
