'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
// UI performs the credential mutation; API reads only verify results. Requests
// to consumerUrl are a real auxiliary consumer, not management API mutations.
module.exports = async function ({page,uiBase,apiBase,api,request,step,evidence,assetId,upstream,secrets,workDir,afterConsumption}) {
  const read = url => api('GET',url);
  const stage = (id,fn) => step(`OPS01.browser.${id}`,fn);
  const publication = evidence.browserPublication || {};
  const detailUrl = new URL(`/runtime-assets/${assetId}`,uiBase).href;
  const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
  let key,credentialId,consumerUrl,successRequestId,deniedRequestId,invocationId;
  const shot = async name => page.screenshot({path:path.join(workDir,name),fullPage:true,
    mask:[page.locator('.api-key-created'),page.locator('input[type=password]')]});
  await stage('create_consumer_credential',async()=>{
    await page.goto(detailUrl,{waitUntil:'domcontentloaded'});
    await page.getByRole('button',{name:'创建 API Key',exact:true}).click();
    const dialog=page.locator('.el-dialog:visible');
    const name=`ops-browser-consumer-${Date.now().toString(36)}`;
    await dialog.locator('.el-form-item').filter({has:page.locator('.el-form-item__label').filter({hasText:/^名称$/})}).locator('input').fill(name);
    const pending=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith(`/v1/runtime-assets/${assetId}/gateway-consumer-credentials`));
    const [response]=await Promise.all([pending,dialog.getByRole('button',{name:'创建 API Key',exact:true}).click()]);
    assert.equal(response.status(),201,'UI credential creation failed');
    const input=page.locator('.api-key-created input');
    await input.waitFor({state:'visible'});
    key=await input.inputValue(); secrets.push(key);
    assert.ok(typeof key==='string'&&key.length>16,'Missing one-time UI credential');
    const listed=await read(`/v1/runtime-assets/${assetId}/gateway-consumer-credentials`);
    const credential=listed.data?.find(c=>c.name===name);
    assert.ok(credential?.id,'UI-created credential missing in read-back');
    assert.equal(credential.status,'active'); credentialId=credential.id;
    await page.reload({waitUntil:'domcontentloaded'});
    await page.getByRole('button',{name:'创建 API Key',exact:true}).waitFor();
    assert.equal(await page.locator('.api-key-created').count(),0,'One-time key resurfaced after refresh');
    return {assetId,credentialId,mutation:'UI',oneTimeDisplay:true,plaintextPersistedByHarness:false};
  });
  await stage('real_http_consumer',async()=>{
    const detail=await read(`/v1/runtime-assets/${assetId}`);
    assert.equal(detail.asset?.type,'gateway_service');
    const urls=new Set();
    function collect(value){if(!value||typeof value!=='object')return;for(const [name,child]of Object.entries(value)){
      if(name==='accessUrls'&&Array.isArray(child)){for(const url of child)if(typeof url==='string')urls.add(url);}
      else if(child&&typeof child==='object')collect(child);
    }}
    collect(detail);
    const routePath=publication.routePath||evidence.endpoint?.path;
    assert.ok(routePath,'Published route path required');
    const candidates=[...urls].filter(url=>new URL(url,apiBase).pathname.endsWith(routePath));
    assert.equal(candidates.length,1,'Expected one actual published access URL');
    consumerUrl=new URL(candidates[0],apiBase).href;
    assert.equal(new URL(consumerUrl).origin,new URL(apiBase).origin,'Consumer URL must be isolated API');
    const before=upstream.received.length;
    const denied=await request(consumerUrl);
    assert.equal(denied.status,401,'Missing consumer key must be denied');
    assert.equal(upstream.received.length,before,'Unauthenticated request reached upstream');
    deniedRequestId=denied.headers?.['x-request-id'];
    const success=await request(consumerUrl,{headers:{'x-api-key':key}});
    assert.equal(success.status,200,'UI credential must authorize deployed Gateway');
    assert.equal(success.body?.ok,true); assert.equal(success.body?.instance,upstream.name); assert.equal(success.body?.path,routePath);
    successRequestId=success.headers?.['x-request-id'];
    assert.ok(successRequestId&&deniedRequestId&&successRequestId!==deniedRequestId,'Distinct real response request IDs required');
    const calls=upstream.received.slice(before);
    assert.equal(calls.length,1); assert.equal(calls[0].credentialPresent,false,'Consumer key leaked to upstream');
    return {assetId,consumerUrl,actor:'auxiliary real HTTP consumer',missingCredentialStatus:401,authenticatedStatus:200,
      successRequestId,deniedRequestId,upstreamCalls:1,consumerCredentialForwarded:false};
  });
  await stage('runtime_access_logs_refresh',async()=>{
    let row;const until=Date.now()+60000;
    do{const rows=await read(`/v1/runtime-assets/${assetId}/access-logs?limit=20`);row=rows.find(r=>r.requestId===successRequestId&&r.statusCode===200);if(row)break;await delay(500);}while(Date.now()<until);
    assert.ok(row,'Persisted runtime access record missing'); assert.equal(row.runtimeAssetId,assetId);
    // The detail table exposes path/status, not request ID. Exact request
    // correlation is checked in read-back and the durable monitoring UI below.
    for(let pass=0;pass<2;pass++){
      await page.reload({waitUntil:'domcontentloaded'});
      const card=page.locator('.detail-card').filter({has:page.locator('.el-card__header').getByText('访问日志',{exact:true})});
      await card.locator('.el-table__body tr').filter({hasText:row.routePath}).filter({hasText:'200'}).first().waitFor({state:'visible'});
    }
    await shot('browser-runtime-access-logs.png');
    return {assetId,requestId:successRequestId,statusCode:200,routePath:row.routePath,renderedAfterReload:true,uiColumns:['routePath','statusCode']};
  });
  await stage('monitoring_navigation_terminal_refresh',async()=>{
    await page.goto(new URL('/publication',uiBase).href,{waitUntil:'domcontentloaded'});
    const name=publication.name||(await read(`/v1/runtime-assets/${assetId}`)).asset.name;
    await page.locator('.publication-group-item').filter({hasText:name}).click();
    await page.locator('.publication-workbench-actions').getByRole('button',{name:/监控/}).click();
    await page.waitForURL(url=>url.pathname==='/monitoring'&&url.searchParams.get('runtimeAssetId')===assetId);
    const card=page.locator('.logs-card').filter({has:page.locator('.el-card__header').getByText('Gateway 访问日志',{exact:true})});
    await card.waitFor({state:'visible'});
    const query=new URLSearchParams({runtimeAssetId:assetId,requestId:successRequestId,spanKind:'gateway_request',origin:'external',limit:'20'});
    let terminal;const until=Date.now()+120000;
    do{const data=await read(`/monitoring/observability/invocations?${query}`);terminal=data.data?.items?.find(r=>r.requestId===successRequestId&&r.lifecycle==='finished');if(terminal)break;await delay(1000);}while(Date.now()<until);
    assert.ok(terminal,'Durable terminal invocation missing');assert.equal(terminal.runtimeAssetId,assetId);assert.equal(terminal.outcome,'success');assert.equal(terminal.httpStatus,200);
    invocationId=terminal.invocationId;
    const visible=async()=>{
      await card.getByPlaceholder('请求 ID',{exact:true}).fill(successRequestId);
      await card.getByPlaceholder('请求 ID',{exact:true}).press('Tab');
      await card.getByRole('button',{name:'最新一小时',exact:true}).click();
      const row=card.locator('.el-table__body tr').filter({hasText:invocationId});await row.waitFor({state:'visible'});
      const text=await row.innerText();for(const value of [assetId,successRequestId,'success','200'])assert.ok(text.includes(value),`Monitoring row missing ${value}`);
    };
    await visible();await page.reload({waitUntil:'domcontentloaded'});await card.waitFor({state:'visible'});
    assert.equal(new URL(page.url()).searchParams.get('runtimeAssetId'),assetId);await visible();await shot('browser-monitoring-terminal.png');
    return {assetId,requestId:successRequestId,invocationId,lifecycle:'finished',outcome:'success',httpStatus:200,navigation:'publication UI association',renderedAfterReload:true};
  });
  evidence.browserConsumption={assetId,credentialId,consumerUrl,successRequestId,deniedRequestId,invocationId};
  if (afterConsumption) await afterConsumption({ key, consumerUrl, assetId });
  return evidence.browserConsumption;
};
