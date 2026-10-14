'use strict';
const assert = require('node:assert/strict');
module.exports=async (ctx)=>{
 const {page,uiBase,password,username,upstream,step,evidence,managementLogin,api,reloadRegistry}=ctx;
 await step('browser.login',async()=>{
  await page.goto(uiBase+'/login');
  await page.locator('input').nth(0).fill(username);
  await page.locator('input[type=password]').fill(password);
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.waitForURL('**/registration/batch');
  return {route:new URL(page.url()).pathname};
 });
 if (ctx.importScenario) await require('./ops-browser-import.cjs')(ctx);
 else await step('browser.manual_registration',async()=>{
  await page.goto(uiBase+'/registration/manual');
  await page.getByRole('button',{name:'添加 Endpoint'}).first().click();
  const dialog=page.getByRole('dialog');
  await dialog.locator('.el-form-item').filter({hasText:'名称'}).first().locator('input').fill('OPS browser source');
  await dialog.locator('.el-form-item').filter({hasText:'基础 URL'}).locator('input').fill(upstream.url);
  await dialog.locator('.el-form-item').filter({hasText:'路径'}).locator('input').fill('/manual');
  const saved=page.waitForResponse(r=>r.url().endsWith('/v1/assets/endpoints/manual')&&r.request().method()==='POST');
  const [response]=await Promise.all([saved,dialog.getByRole('button',{name:'创建',exact:true}).click()]); assert.equal(response.status(),201); const result=await response.json();
  evidence.endpoint={id:result.id,path:result.endpoint.path,source:result.sourceServiceAsset.id};
  await dialog.waitFor({state:'hidden'});
  assert.ok((await page.locator('body').innerText()).includes('/manual'));
  return evidence.endpoint;
 });
 await managementLogin();
 await step('fixture.controlled_upstream_registry',()=>reloadRegistry([evidence.endpoint],upstream,'ops-browser-upstream'));
 await step('browser.instance_probe',async()=>{
  const scope=ctx.importScenario ? page.locator('.governance-group-detail-card .el-table__body tr').filter({hasText:evidence.endpoint.path}) : page;
  await scope.getByRole('button',{name:'运行实例',exact:true}).click();
  const dialog=page.locator('.el-dialog:visible');
  const list=await api('GET','/v1/assets/source-services/'+evidence.endpoint.source+'/instances');
  const instance=list.data.find(i=>i.port===upstream.port&&i.enabled);assert.ok(instance);
  const pending=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/instances/'+instance.id+'/probe'));
  const [response]=await Promise.all([pending,dialog.getByRole('button',{name:'探测',exact:true}).click()]);assert.equal(response.status(),201);
  const after=await api('GET','/v1/assets/source-services/'+evidence.endpoint.source+'/instances');assert.equal(after.data.find(i=>i.id===instance.id).status,'healthy');
  await dialog.locator('.el-dialog__headerbtn').first().click();await dialog.waitFor({state:'hidden'});
  return {instanceId:instance.id,healthy:true};
 });
 await step('browser.source_test',async()=>{
  await page.getByRole('button',{name:'测试',exact:true}).first().click();
  const dialog=page.getByRole('dialog');
  const result=page.waitForResponse(r=>r.url().endsWith('/'+evidence.endpoint.id+'/test')&&r.request().method()==='POST');
  const [response]=await Promise.all([result,dialog.getByRole('button',{name:'测试',exact:true}).click()]); assert.equal(response.status(),201); const body=await response.json(); assert.equal(body.test.passed,true);
  await page.locator('.test-result-pre').waitFor();
  assert.ok((await page.locator('.test-result-pre').innerText()).includes(evidence.endpoint.path));
  await dialog.getByRole('button',{name:'取消',exact:true}).click();
  return {passed:true,httpStatus:body.test.httpStatus,sourceCalls:upstream.received.length};
 });
 await step('browser.governance',async()=>{
  await page.goto(uiBase+'/governance');
  const probe=page.waitForResponse(r=>r.url().endsWith('/'+evidence.endpoint.id+'/probe')&&r.request().method()==='POST');
  const [response]=await Promise.all([probe,page.getByRole('button',{name:'探测',exact:true}).first().click()]); assert.equal(response.status(),201); const result=await response.json(); assert.equal(result.endpoint.status,'verified');
  await page.getByRole('button',{name:'准入检查',exact:true}).first().click();
  const state=await api('GET','/v1/assets/endpoints/'+evidence.endpoint.id+'/readiness'); assert.equal(state.ready,true,JSON.stringify(state));
  return {ready:true};
 });
 const published=await require('./ops-browser-publication.cjs')({...ctx,endpoint:evidence.endpoint});
 await require('./ops-browser-consumption.cjs')({...ctx,...published});
};
