'use strict';

const assert = require('node:assert/strict');

/**
 * Browser-only Gateway publication mutations. API is used exclusively for GET
 * assertions; no evaluate/store injection or request interception substitutes UI.
 * Requires a Chinese UI session and one already-ready endpoint plus its smoke sample.
 */
module.exports = async function publishGatewayInBrowser({ page, uiBase, api, step, evidence, endpoint, upstream, importScenario, existingAsset, rebind, deferDeploy }) {
  assert.ok(endpoint?.id && endpoint?.source && endpoint?.path, 'Ready endpoint id/source/path required');
  assert.ok(upstream?.url, 'Upstream URL required');
  const suffix = Date.now().toString(36);
  const name = existingAsset?.name || upstream.assetName || `ops-browser-${suffix}`;
  const servicePrefix = existingAsset?.servicePrefix || upstream.servicePrefix || `ops-${suffix}`;
  const routePath = endpoint.path;
  const timeout = 30000;
  let assetId = existingAsset?.assetId, membershipId = rebind?.membershipId, routeId = rebind?.routeId;
  const read = path => api('GET', path);
  const dialog = () => page.locator('.el-dialog:visible').last();
  const field = (scope, label) => scope.locator('.el-form-item').filter({
    has: page.locator('.el-form-item__label').filter({ hasText: new RegExp(`^${label}$`) }),
  });
  const fill = (scope, label, value) => field(scope, label).locator('input,textarea').first().fill(String(value));
  async function select(scope, label, option) {
    await field(scope, label).locator('.el-select').click();
    await page.locator('.el-select-dropdown:visible').getByRole('option', { name: option, exact: true }).click();
  }
  async function checkVisibleCheckbox(scope) {
    const label = scope.locator('label.el-checkbox');
    assert.equal(await label.count(), 1, 'Expected one visible checkbox label');
    const input = label.locator('input[type="checkbox"]');
    if (!await input.isChecked()) await label.click();
    assert.equal(await input.isChecked(), true, 'Checkbox did not accept visible user click');
  }
  async function mutation(method, urlEnd, action) {
    const pending = page.waitForResponse(response => response.request().method() === method &&
      new URL(response.url()).pathname.endsWith(urlEnd), { timeout });
    const [response] = await Promise.all([pending, action()]);
    assert.ok(response.ok(), `${method} ${urlEnd} failed: HTTP ${response.status()}`);
    return response.json();
  }
  async function selectAsset() {
    await page.locator('.publication-group-item').filter({ hasText: name }).click();
    await page.locator('.publication-workbench-actions').getByRole('button',{name:'配置',exact:true}).waitFor({ state: 'visible', timeout });
  }
  const stage = (id, fn) => step(`OPS01.browser.${id}`, fn);

  if (!rebind) await stage('mark_smoke_sample', async () => {
    await page.goto(new URL(importScenario ? '/governance' : '/registration/manual', uiBase).href, { waitUntil: 'domcontentloaded' });
    const row = page.locator('.manual-group-detail-card .el-table__body tr').filter({ hasText: endpoint.path });
    await row.getByRole('button', { name: '测试', exact: true }).click();
    await dialog().getByRole('button', { name: '样本库', exact: true }).click();
    const samples = await read('/v1/endpoint-testing/endpoints/' + endpoint.id + '/test-samples');
    const active = (samples.data || []).filter(item => item.enabled && item.status === 'active');
    assert.equal(active.length, 1, 'Isolated browser fixture expects one active success sample');
    await dialog().getByRole('button', { name: '维护', exact: true }).click();
    await fill(dialog(), '标签', [...new Set([...(active[0].tags || []), 'smoke'])].join(','));
    await mutation('PATCH', '/v1/endpoint-testing/test-samples/' + active[0].id, () => dialog().getByRole('button', { name: '保存', exact: true }).click());
    const saved = await read('/v1/endpoint-testing/endpoints/' + endpoint.id + '/test-samples');
    assert.ok(saved.data.find(item => item.id === active[0].id)?.tags?.includes('smoke'));
    return { sampleId: active[0].id, tag: 'smoke', operation: 'UI' };
  });

  if (!existingAsset) await stage('create_gateway', async () => {
    await page.goto(new URL('/publication', uiBase).href, { waitUntil: 'domcontentloaded' });
    const builder = page.locator('.publication-builder-card');
    await builder.getByText('Gateway', { exact: true }).first().click();
    await builder.getByRole('button', { name: '新建发布单元', exact: true }).click();
    await dialog().waitFor({ state: 'visible' });
    await fill(dialog(), '服务名称', name);
    await fill(dialog(), '显示名称', name);
    await fill(dialog(), '服务前缀', servicePrefix);
    const created = await mutation('POST', '/v1/publication/endpoints/runtime-assets', () =>
      dialog().getByRole('button', { name: '创建', exact: true }).click());
    assetId = created.runtimeAsset?.id;
    assert.ok(assetId, 'Create response lacks runtimeAsset.id');
    await page.locator('.el-dialog:visible').waitFor({ state: 'hidden' });
    const detail = await read(`/v1/runtime-assets/${assetId}`);
    assert.equal(detail.asset?.type, 'gateway_service');
    assert.equal(detail.asset?.name, name);
    return { assetId, name, servicePrefix, operation: 'UI' };
  });

  if (existingAsset) {
    await page.goto(new URL('/publication', uiBase).href, { waitUntil: 'domcontentloaded' });
    await selectAsset();
  }
  if (!rebind) await stage('add_gateway_member', async () => {
    const builder = page.locator('.publication-builder-card');
    if (existingAsset) {
      await builder.getByText('Gateway', { exact: true }).first().click();
      await builder.locator('.publication-target-select').click();
      await page.locator('.el-select-dropdown:visible').getByRole('option', {name, exact:true}).click();
    }
    // Registration fixture has a single ready endpoint. Still match its path so
    // the runner fails rather than silently publishing a different candidate.
    const groups = builder.locator('.publication-candidate-group-item');
    if (await groups.count() > 1) await groups.filter({ hasText: new URL(upstream.url).host }).click();
    const row = builder.locator('.el-table__body tr').filter({ hasText: routePath });
    assert.equal(await row.count(), 1, 'Expected exactly one matching ready candidate');
    await checkVisibleCheckbox(row);
    const added = await mutation('POST', `/v1/publication/endpoints/runtime-assets/${assetId}/memberships`, () =>
      builder.getByRole('button', { name: '加入已选端点', exact: true }).click());
    await selectAsset();
    const detail = await read(`/v1/runtime-assets/${assetId}`);
    const members = detail.memberships || [];
    const member = members.find(item => (item.endpointDefinitionId || item.endpointDefinition?.id || item.membership?.endpointDefinitionId) === endpoint.id);
    membershipId = member?.id || member?.membership?.id || member?.binding?.id;
    if (!membershipId) {
      const values = added.memberships || added.data || [];
      const matched = values.find(item => item.endpointDefinitionId === endpoint.id);
      membershipId = matched?.id;
    }
    assert.ok(membershipId, 'Read-back cannot identify created endpoint membership');
    return { assetId, membershipId, endpointId: endpoint.id, operation: 'UI' };
  });

  // The fixed action column can overlap the center of the name cell at 1440px.
  // Click its visible left edge, without forcing through an overlay.
  await page.locator('.publication-group-detail-card .el-table__body tr').filter({ hasText: routePath })
    .locator('td').nth(1).click({position:{x:5,y:10}});
  if (!rebind) await stage('configure_gateway_profile_route', async () => {
    await page.locator('.publication-workbench-actions').getByRole('button', { name: '配置', exact: true }).click();
    await fill(dialog(), '意图名称', `ops_browser_${suffix}`);
    await fill(dialog(), '面向 LLM 的描述', 'OPS browser acceptance: isolated local endpoint');
    await select(dialog(), '画像状态', '已评审');
    await fill(dialog(), '路由路径', routePath);
    await fill(dialog(), '上游路径', routePath);
    await select(dialog(), '路由可见性', '公开');
    await fill(dialog(), '认证策略引用', 'api-key-default');
    // This is intentionally an actual visible operator control. Missing controls
    // are reported as a product gap, never replaced by a management API write.
    const registryControl = field(dialog(), '请求头策略');
    if (await registryControl.count()) await checkVisibleCheckbox(registryControl);
    const result = await mutation('PUT', `/v1/publication/endpoints/runtime-memberships/${membershipId}/gateway-route`, () =>
      dialog().getByRole('button', { name: '保存发布配置', exact: true }).click());
    routeId = result.routeBinding?.id;
    await page.locator('.el-dialog:visible').waitFor({ state: 'hidden' });
    const state = await read(`/v1/publication/endpoints/runtime-memberships/${membershipId}`);
    routeId ||= state.routeBinding?.id;
    assert.equal(state.profile?.status, 'reviewed');
    assert.equal(state.routeBinding?.authPolicyRef, 'api-key-default');
    assert.equal(state.routeBinding?.routePath, routePath);
    assert.equal(state.routeBinding?.routeVisibility, 'external');
    return { membershipId, routeId, authPolicyRef: 'api-key-default', operation: 'UI' };
  });

  await stage('bind_gateway_upstream', async () => {
    const instances = await read(`/v1/assets/source-services/${endpoint.source}/instances`);
    const instance = (instances.data || []).find(item => item.enabled && Number(item.port) === Number(upstream.port || new URL(upstream.url).port));
    assert.ok(instance, 'Registered local upstream instance missing');
    await page.locator('.publication-workbench-actions').getByRole('button', { name: '运行上游绑定', exact: true }).click();
    await select(dialog(), '运行环境', instance.environment);
    await dialog().locator('.el-table__body').waitFor({ state: 'visible' });
    await select(dialog(), '选择策略', '固定主实例');
    const row = dialog().locator('.el-table__body tr').filter({ hasText: upstream.url });
    assert.equal(await row.count(), 1, 'Expected exactly one local upstream instance row');
    const checked = dialog().locator('.el-table__body tr').filter({ has: page.locator('input[type="checkbox"]:checked') });
    for (const other of await checked.all()) if (!(await other.innerText()).includes(upstream.url)) await other.locator('label.el-checkbox').click();
    await checkVisibleCheckbox(row);
    await field(dialog(), '主实例').locator('.el-select').click();
    await page.locator('.el-select-dropdown:visible').getByRole('option').filter({ hasText: instance.name }).click();
    await select(dialog(), '绑定状态', '已激活');
    await mutation('PUT', `/v1/runtime-memberships/${membershipId}/upstream-binding`, () =>
      dialog().getByRole('button', { name: '保存绑定', exact: true }).click());
    const saved = await read(`/v1/runtime-memberships/${membershipId}/upstream-binding`);
    assert.equal(saved.binding?.primaryInstanceId, instance.id);
    assert.equal(saved.binding?.status, 'active');
    await dialog().getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('.el-dialog:visible').waitFor({ state: 'hidden' });
    return { membershipId, instanceId: instance.id, environment: instance.environment, operation: 'UI' };
  });

  if (!rebind) await stage('publish_gateway_member', async () => {
    const before = await read(`/v1/publication/endpoints/runtime-memberships/${membershipId}`);
    const migration = before.routeBinding?.upstreamConfig?.headerPolicyMigration;
    assert.deepEqual(migration, { version: 1, mode: 'v1', source: 'registry' },
      'OPS_BROWSER_HEADER_POLICY_UI_GAP: route editor must expose Registry v1 configuration; API substitution is forbidden');
    const publish = page.locator('.publication-workbench-actions').getByRole('button', { name: '发布', exact: true });
    await publish.click();
    await mutation('POST', `/v1/publication/endpoints/runtime-memberships/${membershipId}/publish`, () =>
      page.locator('.el-message-box:visible').getByRole('button', { name: /^(确定|确认|OK)$/ }).click());
    const after = await read(`/v1/publication/endpoints/runtime-memberships/${membershipId}`);
    assert.equal(after.publishBinding?.publishStatus || after.membership?.status, 'active');
    return { membershipId, operation: 'UI' };
  });

  const deployment = deferDeploy ? null : await stage('deploy_gateway', async () => {
    const result = await mutation('POST', `/v1/runtime-assets/${assetId}/deploy-gateway`, () =>
      page.locator('.publication-group-detail-card').getByRole('button', { name: '部署', exact: true }).click());
    assert.equal(result.verification?.run?.status, 'passed', 'Candidate verification must pass');
    assert.equal(result.verification?.run?.activationStatus, 'activated', 'Candidate must activate');
    return { assetId, runId: result.verification.run.id, activationStatus: 'activated', operation: 'UI' };
  });
  const result = { assetId, membershipId, routeId, name, servicePrefix, routePath, deployment };
  if (evidence) evidence.browserPublication = result;
  return result;
};
