'use strict';
const assert = require('node:assert/strict');

module.exports = async ({page, step}) => {
  const badge = page.getByTestId('system-health');
  const refresh = page.getByTestId('page-refresh');
  const healthRoute = '**/health';
  const healthy = {status:'ok',details:{disk:{status:'up'},mcp_server:{status:'up'}}};
  const unhealthy = {status:'error',details:{disk:{status:'up'},mcp_server:{status:'down'}}};
  const clickRefresh = async () => {
    await refresh.click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="page-refresh"]')?.classList.contains('is-loading'));
  };
  const status = expected => page.waitForFunction(value =>
    document.querySelector('[data-testid="system-health"]')?.getAttribute('data-status') === value, expected);
  try {
    await step('browser.toolbar_real_health', async () => {
      const search = page.locator('.search-container input');
      await search.fill('keep-this-filter');
      const pending = page.waitForResponse(r => new URL(r.url()).pathname === '/health');
      const documents = page.waitForResponse(r => new URL(r.url()).pathname === '/api/documents' && r.request().method() === 'GET');
      await clickRefresh();
      const response = await pending;
      const body = await response.json();
      assert.ok([200,503].includes(response.status()));
      await status(response.status() === 200 && body.status === 'ok' ? 'healthy' : 'error');
      assert.equal((await documents).status(),200);
      assert.equal(await search.inputValue(), 'keep-this-filter');
      await search.fill('');
      return {http:response.status(),backendStatus:body.status || body.error?.details?.status,currentPageReloaded:true,filterPreserved:true};
    });
    await step('browser.toolbar_health_failure_and_recovery', async () => {
      await page.route(healthRoute, route => route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(healthy)}));
      await clickRefresh(); await status('healthy');
      await page.unroute(healthRoute);
      await page.route(healthRoute, route => route.fulfill({status:503,contentType:'application/json',body:JSON.stringify(unhealthy)}));
      await clickRefresh(); await status('error');
      await page.unroute(healthRoute);
      await page.route(healthRoute, route => route.abort('failed'));
      await clickRefresh(); await status('unknown');
      await page.unroute(healthRoute);
      await page.route(healthRoute, route => route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(healthy)}));
      await clickRefresh(); await status('healthy');
      return {injectedBrowserResponses:[200,503,'network failure',200],immediateBadgeUpdates:true};
    });
    await step('browser.toolbar_page_failure', async () => {
      await page.route('**/api/documents', route => route.fulfill({status:500,contentType:'application/json',body:'{"message":"controlled list failure"}'}));
      // Wait for earlier transient messages to disappear before checking this action.
      await page.locator('.el-message').first().waitFor({state:'hidden'}).catch(()=>{});
      await clickRefresh();
      await page.getByText('刷新失败',{exact:true}).waitFor();
      assert.equal(await page.getByText('刷新成功',{exact:true}).count(),0);
      await page.unroute('**/api/documents');
      await clickRefresh();
      return {failedListDoesNotReportSuccess:true,recovery:true};
    });
  } finally {
    await page.unroute(healthRoute);
    await page.unroute('**/api/documents');
  }
  assert.ok(await badge.isVisible());
};
