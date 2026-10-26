'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
test('actual publication member mapper retains source identity for upstream configuration on a draft',()=>{
 const src=fs.readFileSync(path.resolve(__dirname,'../src/modules/endpoint-registry/EndpointRegistry.vue'),'utf8').replace(/\r\n/g,'\n');
 const start=src.indexOf('const mapPublicationMembershipRow ='),end=src.indexOf('\nconst grouped =',start);assert.ok(start>0&&end>start);
 const ctx={publicationCandidates:{value:[{endpointDefinitionId:'endpoint',sourceServiceAssetId:'source'}]},t:key=>key,getProfileStatusLabel:s=>s};
 vm.runInNewContext(ts.transpileModule(src.slice(start,end)+'\nglobalThis.mapper=mapPublicationMembershipRow;',{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText,ctx);
 const row=ctx.mapper({membership:{id:'member',status:'draft'},runtimeAsset:{id:'runtime',name:'Gateway draft',type:'gateway_service'},endpoint:{id:'endpoint',name:'Manual'},endpointDefinition:{id:'endpoint',method:'GET',path:'/manual'},profile:null,publishBinding:null,routeBinding:null,readiness:{ready:false,reasons:['route missing']}});
 assert.equal(row.sourceServiceAssetId,'source');assert.equal(row.runtimeMembershipId,'member');assert.equal(row.publicationState,'draft');assert.equal(row.runtimeAssetId,'runtime');assert.equal(row.groupName,'Gateway draft');assert.equal(row.readinessState,'blocked');
 ctx.publicationCandidates.value=[];assert.equal(ctx.mapper({membership:{id:'m'},runtimeAsset:{id:'r',type:'gateway_service'},endpoint:{name:'x'},endpointDefinition:{id:'missing',method:'GET',path:'/x'}}).sourceServiceAssetId,undefined,'Never borrow an unrelated source identity');
});

test('actual mounted and route watcher preserve all/ready/blocked selections',async()=>{
 const {ref}=require('vue');
 const src=fs.readFileSync(path.resolve(__dirname,'../src/modules/endpoint-registry/EndpointRegistry.vue'),'utf8').replace(/\r\n/g,'\n');
 const initial=src.match(/const selectedReadinessState = ref<[^>]+>\("([^"]+)"\)/);assert.equal(initial?.[1],'all');
 const mount=src.slice(src.indexOf('onMounted(async () => {'),src.indexOf('\nwatch(selectedFilter,'));
 const routeWatch=src.slice(src.lastIndexOf('watch(\n  () => route.fullPath,'),src.indexOf('</script>'));
 assert.ok(mount&&routeWatch);
 for(const value of ['all','ready','blocked']){
  let mounted,changed,loads=0;
  const ctx={ref,route:{meta:{productSurface:'publication'},query:{},fullPath:'/publication'},selectedReadinessState:ref(value),selectedFilter:ref('all'),search:ref(''),isManualRegistrationView:ref(false),onMounted:fn=>mounted=fn,watch:(_source,fn)=>changed=fn,loadOverview:async()=>{loads++},openCreateDialog:()=>assert.fail('publication cannot open registration form')};
  vm.runInNewContext(ts.transpileModule(mount+'\n'+routeWatch,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText,ctx);
  await mounted();assert.equal(ctx.selectedReadinessState.value,value);
  ctx.route.fullPath='/publication?sourceType=gateway';ctx.route.query.sourceType='gateway';await changed();
  assert.equal(ctx.selectedReadinessState.value,value);assert.equal(ctx.selectedFilter.value,'gateway');assert.equal(loads,2);
 }
});

test('actual publication loader includes blocked drafts by default and honors explicit readiness filters',async()=>{
 const {ref}=require('vue');
 const src=fs.readFileSync(path.resolve(__dirname,'../src/modules/endpoint-registry/EndpointRegistry.vue'),'utf8').replace(/\r\n/g,'\n');
 const start=src.indexOf('const loadOverview = async () => {'),end=src.indexOf('\nconst loadPublicationAuditTrail =',start);
 const data=[{id:'draft-member',readinessState:'blocked',runtimeAssetType:'gateway_service',name:'draft'},{id:'ready-member',readinessState:'ready',runtimeAssetType:'gateway_service',name:'ready'}];
 for(const [filter,expected] of [['all',2],['ready',1],['blocked',1]]){
  const ctx={loading:ref(false),errorMessage:ref(''),currentSurface:ref('publication'),search:ref(''),publicationCandidates:ref([]),publicationRuntimeAssets:ref([]),rows:ref([]),selectedFilter:ref('all'),selectedReadinessState:ref(filter),expandedGroupKeys:ref([]),grouped:ref([]),selectedPublicationTargetRuntimeAssetId:ref(''),publicationTargetOptions:ref([]),loadPublicationAuditTrail:async()=>{},mapPublicationCandidateRow:x=>x,mapPublicationMembershipRow:x=>x,serverAPI:{listPublicationCandidates:async()=>({data:[]}),listPublicationRuntimeMemberships:async()=>({data})},runtimeAssetsAPI:{listRuntimeAssets:async()=>({data:[]})},t:key=>key};
  vm.runInNewContext(ts.transpileModule(src.slice(start,end)+'\nglobalThis.load=loadOverview;',{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText,ctx);await ctx.load();
  assert.equal(ctx.errorMessage.value,'');assert.equal(ctx.rows.value.length,expected);
  if(filter!=='all')assert.equal(ctx.rows.value[0].readinessState,filter);else assert.ok(ctx.rows.value.some(row=>row.id==='draft-member'));
 }
});
