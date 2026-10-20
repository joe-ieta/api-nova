'use strict';
const assert = require('node:assert/strict');
module.exports = async ({page,uiBase,api,step}) => {
  const pattern='**/api/v1/monitoring/management/events?*';
  const viewer=page.locator('.log-viewer');
  const refresh=()=>viewer.getByRole('button',{name:'刷新',exact:true}).click();
  await step('browser.logs_real_persisted_events',async()=>{
    const expected=await api('GET','/v1/monitoring/management/events?page=1&limit=50');
    assert.ok(expected.data.total>0,'Lifecycle must produce real runtime events');
    const pending=page.waitForResponse(r=>r.url().includes('/api/v1/monitoring/management/events?'));
    await page.goto(uiBase+'/logs'); assert.equal((await pending).status(),200);
    await viewer.locator('.log-entry').first().waitFor();
    const content=await viewer.innerText();
    assert.ok(content.includes(expected.data.data[0].summary || expected.data.data[0].eventName));
    assert.ok(!content.includes('正在解析OpenAPI规范文件'));
    await viewer.getByRole('button',{name:'清空当前显示',exact:true}).click();
    assert.equal(await viewer.locator('.log-entry').count(),0);
    const after=await api('GET','/v1/monitoring/management/events?page=1&limit=50');
    assert.ok(after.data.total>=expected.data.total);
    await refresh(); await viewer.locator('.log-entry').first().waitFor();
    return {realRows:expected.data.data.length,total:expected.data.total,clearDisplayPreservesServer:true};
  });
  await step('browser.logs_failure_empty_and_recovery',async()=>{
    try {
      for(const code of [403,500]) {
        await page.route(pattern,route=>route.fulfill({status:code,contentType:'application/json',body:'{}'}));
        await refresh(); await viewer.locator('.el-alert').waitFor();
        assert.equal(await viewer.locator('.log-entry').count(),0);
        assert.ok((await viewer.locator('.el-alert').innerText()).includes(code===403?'权限':'失败'));
        await page.unroute(pattern);
      }
      await page.route(pattern,route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({status:'success',data:{data:[],total:0,page:1,limit:50,hasNext:false,hasPrev:false}})}));
      await refresh(); await viewer.getByText('暂无日志',{exact:true}).waitFor();
      assert.equal(await viewer.locator('.el-alert').count(),0);
      await page.unroute(pattern);
      const loaded=page.waitForResponse(r=>r.url().includes('/api/v1/monitoring/management/events?'));
      await page.getByTestId('page-refresh').click(); assert.equal((await loaded).status(),200);
      await viewer.locator('.log-entry').first().waitFor();
      return {injectedResponses:[403,500,'empty'],realRecovery:true,toolbarLoadsCurrentView:true};
    } finally { await page.unroute(pattern); }
  });
  await step('browser.logs_paging_filters_and_escaped_text',async()=>{
    const queries=[];
    try {
      await page.route(pattern,route=>{
        const query=new URL(route.request().url()).searchParams;
        const number=Number(query.get('page')); queries.push(Object.fromEntries(query));
        const event={id:`controlled-${number}`,occurredAt:'2026-10-20T00:00:00Z',severity:query.get('level')||'info',
          eventFamily:'controlled-test',eventName:'controlled.event',summary:`page-${number} <img src=x onerror=alert(1)>`};
        return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({status:'success',
          data:{data:[event],total:51,page:number,limit:50,hasNext:number===1,hasPrev:number===2}})});
      });
      await refresh(); await viewer.locator('.log-message').filter({hasText:'page-1'}).waitFor();
      await viewer.getByRole('button',{name:'下一页',exact:true}).click();
      await viewer.locator('.log-message').filter({hasText:'page-2'}).waitFor();
      assert.equal(queries.at(-1).page,'2');
      assert.equal(await viewer.locator('.log-message img').count(),0);
      assert.ok((await viewer.locator('.log-message').innerText()).includes('<img'));
      await viewer.locator('.el-select').first().click();
      await page.locator('.el-select-dropdown:visible').getByRole('option',{name:'警告',exact:true}).click();
      await viewer.locator('.log-message').filter({hasText:'page-1'}).waitFor();
      assert.equal(queries.at(-1).level,'warning'); assert.equal(queries.at(-1).page,'1');
      const search=viewer.getByPlaceholder('搜索日志',{exact:true});
      await search.fill('page-1'); await refresh();
      await viewer.locator('.log-message').filter({hasText:'page-1'}).waitFor();
      assert.equal(await search.inputValue(),'page-1');
      return {controlledResponse:true,pageNavigation:true,severityQuery:'warning',filterPreserved:true,htmlEscaped:true};
    } finally {
      await page.unroute(pattern);
      await page.reload({waitUntil:'domcontentloaded'});
      await viewer.locator('.log-entry').first().waitFor();
    }
  });
};
