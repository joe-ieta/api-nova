import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { MCPServerEntity, McpInboundAuthMode, TransportType } from '../../../database/entities/mcp-server.entity';
import { ServerLifecycleService } from './server-lifecycle.service';
import { previewMcpEndpoint } from '../../runtime-assets/services/mcp-endpoint-config';

describe('saved publication endpoint to lifecycle CLI and process configuration', () => {
  let db: DataSource;
  beforeEach(async () => { db = new DataSource({type:'sqljs',synchronize:true,entities:[MCPServerEntity]}); await db.initialize(); });
  afterEach(async () => { await db.destroy(); });
  function fixture(fail = false) {
    const service: any = Object.create(ServerLifecycleService.prototype);
    service.logger = {log:jest.fn(),error:jest.fn()}; service.validateOpenApiData=jest.fn().mockResolvedValue(undefined);
    service.resolveManagedCliPath=jest.fn().mockReturnValue('synthetic-cli.js');
    service.configService={get:jest.fn((_key, fallback)=>fallback)};
    service.appConfigService={port:3000,apiBaseUrl:'http://127.0.0.1:3000'};
    service.processManager={startProcess:jest.fn(async () => { if(fail) throw Object.assign(new Error('EADDRINUSE'),{code:'EADDRINUSE'}); return {pid:123}; })};
    service.processHealth={startHealthCheck:jest.fn().mockResolvedValue(undefined)};
    service.eventEmitter={emit:jest.fn()}; service.recordRuntimeLifecycleEvent=jest.fn().mockResolvedValue(undefined);
    return service;
  }
  it.each([TransportType.STREAMABLE,TransportType.SSE])('persisted %s endpoint reaches every lifecycle argument', async transport => {
    const saved=await db.getRepository(MCPServerEntity).save({name:'fixture',port:9044,transport,inboundAuthMode:McpInboundAuthMode.ANONYMOUS,openApiData:{openapi:'3.0.3',info:{title:'fixture',version:'1'},paths:{}},config:{runtimeAssetId:'fixture',endpoint:'/team/custom'}});
    const server=await db.getRepository(MCPServerEntity).findOneByOrFail({id:saved.id});
    const service=fixture(), result=await service.startServer(server), config=service.processManager.startProcess.mock.calls[0][0];
    const value=(flag:string)=>config.args[config.args.indexOf(flag)+1];
    expect(value('--endpoint')).toBe('/team/custom'); expect(value('--transport')).toBe(transport); expect(value('--port')).toBe('9044');
    expect(config.mcpConfig).toMatchObject({endpoint:'/team/custom',port:9044,transport});
    expect(config.mcpConfig.inboundAuthMode).toBe('anonymous');
    expect(config.env.API_NOVA_RUNTIME_AUTH_MODE).toBe('anonymous');
    expect(config.env.API_NOVA_RUNTIME_API_KEYS).toBeUndefined();
    expect(result.endpoint).toBe(previewMcpEndpoint({},server).consumerUrl);
    expect(config.healthCheck.endpoint).toBe('http://127.0.0.1:9044/health');
  });
  it('process start failure does not alter saved endpoint or emit a successful lifecycle result', async () => {
    const server=await db.getRepository(MCPServerEntity).save({name:'fixture',port:9044,transport:TransportType.SSE,inboundAuthMode:McpInboundAuthMode.ANONYMOUS,openApiData:{},config:{runtimeAssetId:'fixture',endpoint:'/old'}});
    const service=fixture(true), before=previewMcpEndpoint({},server);
    await expect(service.startServer(server)).rejects.toThrow('EADDRINUSE');
    expect(service.processManager.startProcess).toHaveBeenCalledTimes(1);
    expect(service.eventEmitter.emit.mock.calls.some(([name])=>name==='server.lifecycle.started')).toBe(false);
    expect(service.processHealth.startHealthCheck).not.toHaveBeenCalled();
    expect(previewMcpEndpoint({},await db.getRepository(MCPServerEntity).findOneByOrFail({id:server.id}))).toEqual(before);
  });
});
