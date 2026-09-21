'use strict';
process.env.DB_TYPE = 'sqlite';
const path = require('node:path'), fs = require('node:fs'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const Module = require('node:module');
const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apinova-handoff-preparation-'));
const serverRoot = path.resolve(__dirname, '../../api-nova-server');
const build = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'),
  path.join(serverRoot, 'src/managed/entry.ts'), path.join(serverRoot, 'src/managed/handoff.ts'),
  '--outDir', directory, '--module', 'commonjs', '--target', 'ES2020', '--types', 'node', '--skipLibCheck'], { encoding: 'utf8' });
assert.equal(build.status, 0, build.stdout + build.stderr);
require('ts-node').register({ transpileOnly: true, project: path.resolve(__dirname, '../tsconfig.json') });
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (name, ...rest) {
  if (name === 'api-nova-server') return path.join(directory, 'handoff.js');
  if (name === 'api-nova-server/dist/managed/entry.js') return path.join(directory, 'entry.js');
  if (name === 'api-nova-parser') return path.resolve(__dirname, '../../api-nova-parser/src/index.ts');
  return originalResolve.call(this, name, ...rest);
};
require('reflect-metadata');
const { DataSource } = require('typeorm');
const { ManagedMcpHandoffPreparationService, MANAGED_MCP_PREPARATION_REJECTED: code } = require('../src/modules/servers/services/managed-mcp-handoff-preparation.service.ts');
const load = (file, name) => require('../src/database/entities/' + file + '.entity.ts')[name];
const Asset = load('runtime-asset','RuntimeAssetEntity'), Member = load('runtime-asset-endpoint-binding','RuntimeAssetEndpointBindingEntity');
const Endpoint = load('endpoint-definition','EndpointDefinitionEntity'), Source = load('source-service-asset','SourceServiceAssetEntity');
const Profile = load('publication-profile','PublicationProfileEntity'), Publish = load('endpoint-publish-binding','EndpointPublishBindingEntity');
const Server = load('mcp-server','MCPServerEntity'), Run = load('runtime-verification-run','RuntimeVerificationRunEntity');
const Upstream = load('runtime-upstream-binding','RuntimeUpstreamBindingEntity');
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])) : value;
const hash = text => createHash('sha256').update(text).digest('hex');
let db, service, config, registry, registryPath;
async function saveRegistry() {
  const text = JSON.stringify(registry);
  fs.writeFileSync(registryPath, text);
  config.sources[id(1)].registrySource.expectedContentDigest = hash(text);
}
beforeEach(async () => {
  db = new DataSource({ type:'sqljs', synchronize:true, entities:[Asset,Member,Endpoint,Source,Profile,Publish,Server,Run,Upstream] });
  await db.initialize();
  const spec = { openapi:'3.0.3', info:{title:'fixture',version:'1'}, paths:{'/items':{get:{operationId:'items',responses:{'200':{description:'OK'}}}}}};
  const fingerprint = hash(JSON.stringify(canonical(spec)));
  await db.getRepository(Asset).save({id:id(1),name:'fixture',type:'mcp_server',metadata:{managedServerId:id(5),activeRevision:'candidate1',lastVerificationRunId:id(6),activeMcpBehaviorFingerprint:fingerprint,verificationRequired:false}});
  await db.getRepository(Source).save({id:id(4),sourceKey:'fixture'});
  await db.getRepository(Endpoint).save({id:id(3),sourceServiceAssetId:id(4),method:'GET',path:'/items',rawOperation:spec.paths['/items'].get});
  await db.getRepository(Member).save({id:id(2),runtimeAssetId:id(1),endpointDefinitionId:id(3),enabled:true});
  await db.getRepository(Publish).save({id:id(8),endpointDefinitionId:id(3),runtimeAssetEndpointBindingId:id(2),publishedToMcp:true});
  await db.getRepository(Upstream).save({id:id(7),runtimeAssetEndpointBindingId:id(2),sourceServiceAssetId:id(4),environment:'test',selectionMode:'fixed_primary',status:'active',revision:1});
  await db.getRepository(Server).save({id:id(5),name:'fixture',inboundAuthMode:'private_api_key',openApiData:spec,port:9022,transport:'streamable',config:{endpoint:'/mcp',runtimeAssetId:id(1),managedByRuntimeAsset:true,verifiedCandidateRevision:'candidate1',verificationRunId:id(6),behaviorFingerprint:fingerprint}});
  await db.getRepository(Run).save({id:id(6),runtimeAssetId:id(1),candidateRevision:'candidate1',trigger:'deploy',status:'passed',activationStatus:'activated',metadata:{behaviorFingerprint:fingerprint,mcpEndpointConfig:{transport:'streamable',port:9022,endpointPath:'/mcp'}},upstreamBindingRevisions:[{runtimeMembershipId:id(2),bindingId:id(7),revision:1}]});
  registryPath=path.join(directory,'registry.json');
  registry={apiVersion:'security.apinova.io/v1',kind:'UpstreamCredentialBindings',metadata:{revision:'r1',environment:'test'},reload:{mode:'manual',debounceMs:0,rejectPlaintextSecrets:true},secretProviders:{env:{type:'env'}},credentials:{token:{type:'bearer',secretRef:'env:FIXTURE_TOKEN'}},sites:[{id:'fixture',sourceServiceAssetId:id(4),match:{scheme:'https',host:'fixture.invalid',port:443,basePath:'/'},credential:'none',allowedHosts:['fixture.invalid'],endpoints:[]}]};
  config={sources:{[id(1)]:{registrySource:{configId:'fixture',path:registryPath,format:'json',environment:'test',expectedRevision:'r1',expectedContentDigest:'a'.repeat(64)},approvedEnvironmentNames:['FIXTURE_TOKEN','API_NOVA_RUNTIME_AUTH_MODE']}}, get(key){return key==='managedMcp.handoffSources'?this.sources:key==='FIXTURE_TOKEN'?'synthetic-private-marker':key==='API_NOVA_RUNTIME_AUTH_MODE'?'api_key':undefined;}};
  await saveRegistry();
  service = new ManagedMcpHandoffPreparationService(db,config);
});
afterEach(async()=>{await db.destroy();});
after(()=>{Module._resolveFilename=originalResolve;fs.rmSync(directory,{recursive:true,force:true});});
const reject = () => assert.rejects(service.prepare(id(1),id(5)), error=>error.message===code && !String(error).includes('synthetic-private-marker'));
test('real SQL.js produces frozen ownership envelope without environment values',async()=>{
 const payload=await service.prepare(id(1),id(5));
 assert.equal(payload.inboundAuthMode,'private_api_key');
 assert.equal(payload.trustedOperationBindings[0].sourceServiceAssetId,id(4));
 assert.equal(payload.trustedOperationBindings[0].endpointDefinitionId,id(3));
 assert.equal(payload.registrySource.expectedContentDigest,config.sources[id(1)].registrySource.expectedContentDigest);
 assert.ok(Object.isFrozen(payload));assert.ok(!JSON.stringify(payload).includes('synthetic-private-marker'));
});
test('prepared actual dedicated child ACK still closes as runtime dependencies unavailable',async()=>{
 const handle=await service.startInternal(id(1),id(5));assert.equal(handle.state,'handoffAccepted');
 assert.deepEqual(await handle.closed,{code:'MANAGED_RUNTIME_FAILED'});await handle.close();assert.throws(()=>process.kill(handle.pid,0));
});
for(const [name,entity,identifier,patch] of [
 ['wrong managed ownership',Server,5,{config:{runtimeAssetId:id(99)}}],
 ['membership disabled',Member,2,{enabled:false}],
 ['source reassigned',Endpoint,3,{sourceServiceAssetId:id(99)}],
 ['upstream revision drift',Upstream,7,{revision:2}],
 ['upstream source drift',Upstream,7,{sourceServiceAssetId:id(99)}],
 ['verification not passed',Run,6,{status:'failed'}],
 ['verification revision drift',Run,6,{candidateRevision:'other'}],
 ['endpoint port drift',Server,5,{port:9023}],
 ['missing revision evidence',Run,6,{upstreamBindingRevisions:null}],
 ['body fingerprint drift',Server,5,{openApiData:{paths:{}}}],
]) test(name,async()=>{await db.getRepository(entity).update(id(identifier),patch);await reject();});
test('missing source is rejected rather than dropped',async()=>{await db.getRepository(Source).delete(id(4));await reject();});
test('Registry digest revision environment and source must agree',async()=>{
 for(const key of ['expectedContentDigest','expectedRevision','environment']){const s=config.sources[id(1)].registrySource,old=s[key];s[key]=key==='expectedContentDigest'?'0'.repeat(64):'other';await reject();s[key]=old;}
 registry.sites[0].sourceServiceAssetId=id(99);await saveRegistry();await reject();
});
test('fixed ConfigService sources reject relative path unknown fields getters and forbidden environment names',async()=>{
 const s=config.sources[id(1)],p=s.registrySource.path;s.registrySource.path='relative.json';await reject();s.registrySource.path=p;
 s.extra='untrusted';await reject();delete s.extra;
 let calls=0;Object.defineProperty(s,'bad',{get(){calls++;return 'private';},configurable:true});await reject();assert.equal(calls,0);delete s.bad;
 s.approvedEnvironmentNames=['NODE_OPTIONS'];await reject();
});
test('Registry env secretRef requires explicit approved business key',async()=>{config.sources[id(1)].approvedEnvironmentNames=[];await reject();});
test('directory Registry path and content replacement are rejected',async()=>{
 config.sources[id(1)].registrySource.path=directory;await reject();config.sources[id(1)].registrySource.path=registryPath;
 fs.writeFileSync(registryPath,'replaced-private-marker');await reject();
});
test('second short DB snapshot rejects mutation during stable file read',async()=>{
 const original=service.snapshot.bind(service);let reads=0;
 service.snapshot=async(...args)=>{const count=++reads;const result=await original(...args);if(count===1)await db.getRepository(Member).update(id(2),{status:'offline'});return result;};
 await reject();assert.equal(reads,2);
});
test('valid row mutation without revision change still rejects and no transaction spans file IO',async()=>{
 const original=service.snapshot.bind(service);let reads=0;
 service.snapshot=async(...args)=>{const result=await original(...args);assert.equal(db.createQueryRunner().isTransactionActive,false);if(++reads===1)await db.getRepository(Endpoint).update(id(3),{rawOperation:{operationId:'items',description:'new value'}});return result;};
 await reject();assert.equal(reads,2);
});
test('protected source changing after capture is rejected',async()=>{
 const original=service.snapshot.bind(service);let reads=0;
 service.snapshot=async(...args)=>{const result=await original(...args);if(++reads===2)config.sources[id(1)].registrySource.configId='changed';return result;};
 await reject();
});
test('hardlinked Registry is rejected by stable file source',async()=>{
 const link=path.join(directory,'registry-hardlink.json');fs.linkSync(registryPath,link);
 try{await reject();}finally{fs.unlinkSync(link);}
});
test('explicit source size bound and inherited configuration reject before any child',async()=>{
 config.sources[id(1)].registrySource.configId='x'.repeat(65537);await reject();
 config.sources=Object.create({[id(1)]:{}});await reject();
});
test('duplicate revision membership and binding IDs are not treated as coverage',async()=>{
 const run=await db.getRepository(Run).findOneByOrFail({id:id(6)});
 await db.getRepository(Run).update(id(6),{upstreamBindingRevisions:[...run.upstreamBindingRevisions,...run.upstreamBindingRevisions]});await reject();
});

for(const mode of [null,'private_jwt','anonymous']) test('persisted mode '+mode+' is rejected before preparing managed child',async()=>{
 await db.getRepository(Server).update(id(5),{inboundAuthMode:mode});await reject();
});
test('persisted mode drift during Registry read fails closed',async()=>{
 const original=service.snapshot.bind(service);let reads=0;
 service.snapshot=async(...args)=>{const result=await original(...args);if(++reads===1)await db.getRepository(Server).update(id(5),{inboundAuthMode:'anonymous'});return result;};
 await reject();
});

for(const mode of [undefined,'jwt','anonymous','unknown']) test('approved runtime mode '+mode+' cannot disagree with persisted mode',async()=>{
 const original=config.get.bind(config);config.get=key=>key==='API_NOVA_RUNTIME_AUTH_MODE'?mode:original(key);await reject();
});
