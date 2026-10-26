'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const filename=path.resolve(__dirname,'../src/modules/endpoint-registry/gateway-route-auth.ts');
const loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));loaded._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,filename);
const {gatewayRegistryHeaderConfig,usesGatewayRegistryHeaders}=loaded.exports;
test('Registry mode is opt-in and preserves independent policies',()=>{
 const original={jwtPolicy:{algorithms:['RS256']},temporaryAnonymous:{reason:'review',actor:'server'},timeout:123};
 assert.deepEqual(gatewayRegistryHeaderConfig(original,false),original);assert.equal(usesGatewayRegistryHeaders(original),false);
 const saved=gatewayRegistryHeaderConfig(original,true);assert.deepEqual(saved.headerPolicyMigration,{version:1,mode:'v1',source:'registry'});assert.equal(saved.temporaryAnonymous,original.temporaryAnonymous);assert.equal(saved.jwtPolicy,original.jwtPolicy);assert.equal(saved.timeout,123);assert.equal(original.headerPolicyMigration,undefined);assert.equal(usesGatewayRegistryHeaders(saved),true);
 assert.deepEqual(gatewayRegistryHeaderConfig(saved,false),saved,'unchecking cannot silently downgrade an existing v1 policy');
});
test('refill distinguishes actual Registry v1 from unrelated modes',()=>{
 for(const headerPolicyMigration of [undefined,null,{version:1,mode:'legacy',source:'registry'},{version:1,mode:'v1',source:'inline'},{version:2,mode:'v1',source:'registry'}])assert.equal(usesGatewayRegistryHeaders({headerPolicyMigration}),false);
});
test('actual route editor renders explicit disabled saved policy control',async()=>{
 const {parse,compileTemplate}=require('@vue/compiler-sfc'),{createSSRApp,defineComponent,h}=require('vue'),{renderToString}=require('@vue/server-renderer');
 const src=fs.readFileSync(path.resolve(__dirname,'../src/modules/endpoint-registry/EndpointRegistry.vue'),'utf8');
 const ast=require('@vue/compiler-dom').parse(parse(src).descriptor.template.content);
 const visit=n=>n.tag==='el-form-item'&&n.loc.source.includes('label="请求头策略"')?n.loc.source:(n.children||[]).map(visit).find(Boolean);
 const subtree=visit(ast);assert.ok(subtree);
 const compiled=compileTemplate({source:subtree,filename:'EndpointRegistry.vue',id:'registry-control',ssr:true,ssrCssVars:[]});assert.deepEqual(compiled.errors,[]);
 const mod=new Module(filename+'.template',module);mod.paths=loaded.paths;mod._compile(ts.transpileModule(compiled.code,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,filename+'.template');
 for(const saved of [false,true]){
  const app=createSSRApp(defineComponent({setup:()=>({publicationForm:{registryHeaders:saved,upstreamConfig:gatewayRegistryHeaderConfig({},saved)},usesGatewayRegistryHeaders}),ssrRender:mod.exports.ssrRender}));
  for(const name of ['ElFormItem','ElCheckbox'])app.component(name,defineComponent({inheritAttrs:false,setup:(_, {slots,attrs})=>()=>h('section',{disabled:attrs.disabled||undefined},slots.default?.())}));
  const html=await renderToString(app);assert.match(html,/使用 Registry v1 请求头策略/);assert.match(html,/未配置或未授权时部署会拒绝/);assert.equal(html.includes('disabled'),saved);
 }
});
