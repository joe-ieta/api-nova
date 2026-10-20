'use strict';
const assert = require('node:assert/strict');

// Import through visible controls; management reads assert persisted identity.
module.exports = async function ({page, uiBase, upstream, step, api, evidence, managementLogin}) {
  const name = 'OPS browser imported source';
  const routePath = '/imported';
  const documentPath = '/ops-browser-openapi.json';
  upstream.documents[documentPath] = {
    openapi: '3.0.3', info: {title: name, version: '1.0.0'},
    servers: [{url: upstream.url}],
    paths: {[routePath]: {get: {operationId: 'opsImported', summary: name,
      responses: {'200': {description: 'Success', content: {'application/json': {schema: {type: 'object'}}}}}}}},
  };
  await managementLogin();
  const fileImport = process.argv.includes('--import-file');
  await step(fileImport ? 'browser.openapi_file_import' : 'browser.openapi_url_import', async () => {
    await page.getByRole('button', {name: fileImport ? '上传文件' : '从 URL 导入', exact: true}).first().click();
    const dialog = page.getByRole('dialog');
    if (fileImport) {
      await dialog.locator('input[type=file]').setInputFiles({
        name:'ops-browser-file.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(upstream.documents[documentPath])),
      });
    } else {
      await dialog.getByPlaceholder('请输入文档 URL', {exact: true}).fill(upstream.url + documentPath);
    }
    await dialog.getByPlaceholder('请输入文档名称', {exact: true}).fill(name);
    const pending = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/documents'));
    const [response] = await Promise.all([pending, dialog.getByRole('button', {name: fileImport ? '确认上传' : '开始导入', exact: true}).click()]);
    assert.equal(response.status(), 201);
    const document = await response.json();
    assert.ok(document.id);
    await dialog.waitFor({state: 'hidden'});
    await page.locator('.document-item').filter({hasText: name}).waitFor();
    const catalog = await api('GET', '/v1/assets/endpoints');
    const endpoints = catalog.data.filter(e => e.metadata?.documentId === document.id);
    assert.equal(endpoints.length, 1);
    const endpoint = endpoints[0];
    assert.equal(endpoint.path, routePath);
    const detail = await api('GET', '/v1/assets/endpoints/' + endpoint.id);
    evidence.endpoint = {id: endpoint.id, path: routePath, source: detail.sourceServiceAsset.id, documentId: document.id};
    const instances = (await api('GET', '/v1/assets/source-services/' + evidence.endpoint.source + '/instances')).data;
    assert.equal(instances.length, 1);
    assert.equal(instances[0].port, upstream.port);
    assert.equal(instances[0].enabled, true);
    if (!fileImport) assert.ok(upstream.received.some(r => r.path === documentPath), 'Import must fetch the real upstream document');
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.locator('.document-item').filter({hasText: name}).waitFor();
    return {...evidence.endpoint, provisionalInstanceId: instances[0].id, persistedAfterRefresh: true, operation: 'UI'};
  });
  await page.goto(uiBase + '/governance');
  await page.locator('.governance-group-detail-card .el-table__body tr').filter({hasText: routePath}).waitFor();
};
