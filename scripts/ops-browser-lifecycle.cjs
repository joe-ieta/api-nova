'use strict';
const assert = require('node:assert/strict');
module.exports = async ctx => {
  const { page, uiBase, api, request, step, evidence, upstream: a, replacement: b, reloadRegistry } = ctx;
  const publish = require('./ops-browser-publication.cjs');
  const dialog = () => page.locator('.el-dialog:visible').last();
  const field = label => dialog().locator('.el-form-item').filter({
    has: page.locator('.el-form-item__label').filter({ hasText: new RegExp(`^${label}$`) }),
  });
  const fill = (label, value) => field(label).locator('input').first().fill(String(value));
  async function mutation(method, suffix, action) {
    const pending = page.waitForResponse(r => r.request().method() === method && new URL(r.url()).pathname.endsWith(suffix));
    const [response] = await Promise.all([pending, action()]);
    assert.ok(response.ok(), `${method} ${suffix}: ${response.status()}`);
    return response.json();
  }
  await require('./ops-browser-import.cjs')(ctx);
  const records = evidence.endpoints;
  assert.equal(records.length, 2);
  const source = records[0].source;
  const row = record => page.locator('.governance-group-detail-card .el-table__body tr').filter({hasText:record.path});
  async function openInstances() {
    await page.goto(uiBase + '/governance');
    await row(records[0]).getByRole('button', {name:'运行实例',exact:true}).click();
    await dialog().getByRole('button', {name:'新增实例',exact:true}).waitFor();
  }
  async function attach(host) {
    await openInstances();
    await dialog().getByRole('button', {name:'新增实例',exact:true}).click();
    await fill('实例名称', `browser-${host.name}`); await fill('环境','production');
    await field('协议').locator('.el-select').click();
    await page.locator('.el-select-dropdown:visible').getByRole('option',{name:'HTTP',exact:true}).click();
    await fill('主机','127.0.0.1'); await fill('端口',host.port); await fill('基础路径','/');
    await field('设为默认').locator('.el-switch').click();
    await mutation('POST',`/v1/assets/source-services/${source}/instances`, () => dialog().getByRole('button',{name:'保存',exact:true}).click());
    await page.getByRole('dialog',{name:'新增运行实例',exact:true}).waitFor({state:'hidden'});
    const instance = (await api('GET',`/v1/assets/source-services/${source}/instances`)).data.find(i=>i.port===host.port && i.enabled);
    assert.ok(instance);
    const instanceRow=dialog().locator('.el-table__body tr').filter({hasText:`browser-${host.name}`});
    await mutation('POST',`/instances/${instance.id}/probe`,()=>instanceRow.getByRole('button',{name:'探测',exact:true}).click());
    await dialog().locator('.el-dialog__headerbtn').first().click();
    return instance;
  }
  async function qualify(record, host) {
    await page.goto(uiBase+'/governance');
    await mutation('POST',`/${record.id}/probe`,()=>row(record).getByRole('button',{name:'探测',exact:true}).click());
    await row(record).getByRole('button',{name:'测试',exact:true}).click();
    const tested=await mutation('POST',`/${record.id}/test`,()=>dialog().getByRole('button',{name:'测试',exact:true}).click());
    assert.equal(tested.test.passed,true);
    await page.locator('.test-result-pre').waitFor();
    assert.ok((await page.locator('.test-result-pre').innerText()).includes(host.url + record.path));
    await dialog().getByRole('button',{name:'取消',exact:true}).click();
    assert.equal((await api('GET',`/v1/assets/endpoints/${record.id}/readiness`)).ready,true);
  }
  let instanceA;
  await step('browser.unbound_attach_without_reimport',async()=>{
    instanceA=await attach(a);
    for(const r of records) assert.equal((await api('GET',`/v1/assets/endpoints/${r.id}`)).sourceServiceAsset.id,source);
    return {instanceId:instanceA.id,source,endpointIds:records.map(r=>r.id),operation:'UI'};
  });
  await step('fixture.registry_A',()=>reloadRegistry(records,a,'browser-multi-A'));
  const publications=[];
  for(const record of records) {
    await step(`browser.qualify_A.${record.path}`,()=>qualify(record,a));
    publications.push(await publish({...ctx,endpoint:record,existingAsset:publications[0],deferDeploy:publications.length===0}));
  }
  const asset=publications[1];
  assert.equal(publications[0].assetId,asset.assetId);
  async function consumeAll(key,host) {
    const urls=[];
    const detail=await api('GET',`/v1/runtime-assets/${asset.assetId}`);
    function collect(value) { if(!value || typeof value!=='object')return;
      for(const [name,child] of Object.entries(value)) {
        if(name==='accessUrls'&&Array.isArray(child)) urls.push(...child);
        else collect(child);
      }
    }
    collect(detail);
    const unique=[...new Set(urls)]; assert.equal(unique.length,2);
    for(const url of unique) {
      assert.ok(new URL(url).pathname.startsWith(`/api/v1/gateway/${asset.servicePrefix}/`));
      const before=host.received.length;
      assert.equal((await request(url)).status,401); assert.equal(host.received.length,before);
      const result=await request(url,{headers:{'x-api-key':key}});
      assert.equal(result.status,200); assert.equal(result.body.instance,host.name);
      assert.equal(host.received.at(-1).credentialPresent,false);
    }
    return {assetId:asset.assetId,urls:unique,instance:host.name,authenticated:2,denied:2};
  }
  await require('./ops-browser-consumption.cjs')({...ctx,...asset,afterConsumption:async({key})=>{
    await step('browser.multi_endpoint_consumer_A',()=>consumeAll(key,a));
    let instanceB;
    await step('browser.archive_A_attach_B',async()=>{
      await openInstances();
      await dialog().locator('.el-table__body tr').filter({hasText:'browser-A'}).getByRole('button',{name:'归档',exact:true}).click();
      await mutation('POST',`/instances/${instanceA.id}/archive`,()=>page.locator('.el-message-box:visible').getByRole('button',{name:/^(确定|确认|OK)$/}).click());
      await dialog().locator('.el-dialog__headerbtn').first().click();
      a.server.closeAllConnections(); await new Promise(resolve=>a.server.close(resolve));
      instanceB=await attach(b);
      return {archivedInstance:instanceA.id,replacementInstance:instanceB.id,oldServerStopped:true,operation:'UI'};
    });
    await step('fixture.registry_B',()=>reloadRegistry(records,b,'browser-multi-B'));
    for(let i=0;i<records.length;i++) {
      await step(`browser.qualify_B.${records[i].path}`,()=>qualify(records[i],b));
      await publish({...ctx,upstream:b,endpoint:records[i],existingAsset:asset,rebind:publications[i],deferDeploy:i<records.length-1});
    }
    await step('browser.migration_identity_and_persisted_verification',async()=>{
      const deployed=evidence.browserPublication.deployment;
      const verification=await api('GET',`/v1/runtime-assets/${asset.assetId}/verification-runs/${deployed.runId}`);
      for(let i=0;i<records.length;i++) {
        const current=await api('GET',`/v1/assets/endpoints/${records[i].id}`);
        assert.equal(current.sourceServiceAsset.id,source);
        assert.equal(current.endpoint.metadata.documentId,records[i].documentId);
        assert.equal(current.endpoint.metadata.lastProbeInstanceId,instanceB.id);
        const binding=await api('GET',`/v1/runtime-memberships/${publications[i].membershipId}/upstream-binding`);
        assert.equal(binding.binding.primaryInstanceId,instanceB.id);
        assert.equal(verification.run.upstreamBindingRevisions.find(r=>r.runtimeMembershipId===publications[i].membershipId)?.resolvedSourceServiceInstanceId,instanceB.id);
        const smoke=verification.results.filter(r=>r.runtimeMembershipId===publications[i].membershipId&&r.kind==='smoke');
        assert.ok(smoke.length); for(const result of smoke) {
          assert.equal(result.status,'passed'); assert.equal(result.evidence?.responsePayload?.instance,'B');
        }
      }
      return {source,endpointIds:records.map(r=>r.id),membershipIds:publications.map(p=>p.membershipId),runId:deployed.runId,instanceId:instanceB.id};
    });
    await step('browser.multi_endpoint_consumer_B',()=>consumeAll(key,b));
  }});
  if(process.argv.includes('--logs')) await require('./ops-browser-logs.cjs')(ctx);
};
