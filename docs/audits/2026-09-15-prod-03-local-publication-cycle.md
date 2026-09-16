---
doc-version: 0.1.0
doc-status: active
doc-updated: 2026-09-15
---
# PROD-03 本地发布状态循环验收

## 范围

本轮提供单一可重复入口 `node scripts/verify-prod-03.cjs`。新编排用独立内存SQL.js，Gateway和MCP各执行绑定→候选计划→验证→激活→绑定修改失效→旧候选拒绝→失败重验保留旧版本→成功重验及再次发布。

注册资产、源实例、membership和成功样例直接写入隔离数据库作为前置夹具，没有调用注册HTTP。绑定upsert、revision变化、治理失效、候选与结果持久化、响应断言、MCP激活及Gateway快照保存/激活/回滚使用生产服务。Gateway路由构造和回放结果是显式注入；MCP使用真实McpCandidateReplayService调用合成handler。审计发送适配为本地空实现，但失效metadata中的操作者身份由真实服务持久化并断言。

因此本页证明本地状态机整合，不证明注册/发布HTTP、真实上游、受管进程、操作者真实登录、跨平台或EXT环境已验收。已有PROD-02C真实回环传输证据也不能替代这里未执行的入口链路。

## 已复现及修复

首次有效复现中，MCP拒绝陈旧候选，Gateway却在绑定revision改变且verificationRequired=true后把旧候选标为passed。日志为`tmp/prod-03-cycle-before.log`。夹具特意使旧候选不同于已激活revision，避免快照唯一索引冲突掩盖守卫缺失。

修复仅涉及Gateway激活边界：

- 在资产仓储事务内重读当前asset，比较previousActiveRevision、verificationRequiredAt与计划时间，核对每个绑定的归属、revision及active状态。
- GatewayRouteSnapshotService的快照持久化接收同一EntityManager，使快照记录与asset激活更新共用事务。
- 前置拒绝只丢弃待激活candidate；仅本轮已经切换内存快照后才执行内存回滚，避免错误回退此前正常版本。
- SQL.js trigger在asset激活更新时强制失败，确认新快照记录回滚、旧asset revision不变、内存快照保留，删除trigger后重验再次发布成功。

该守卫没有实现跨进程CAS或全局发布锁；内存路由切换与数据库事务的整体并发可见性仍不是本轮证明范围。

## 命令与证据

从仓库根目录执行：

```powershell
node scripts/verify-prod-03.cjs
```

单一入口包含新publication-cycle与既有候选、Gateway快照、MCP陈旧激活、绑定变更、治理失效和runtime-assets七套源码测试，使用Jest/ts-jest，不依赖API dist。本轮七套76/76通过（新增完整循环2条），结果登记在工具输出与`tmp/prod-03-local-validation.log`；各套包含不同隔离层次，不将总用例数写成真实HTTP或进程场景数。

## 操作者入口核对

- `RuntimeUpstreamBindingsController.upsert`：PUT `/api/v1/runtime-memberships/:runtimeMembershipId/upstream-binding`，类级JwtAuthGuard/PermissionsGuard，方法要求`server:manage`；从request.user.id透传actorId。
- `RuntimeVerificationController`：plan和execute-gateway要求`server:manage`，列表/详情要求`server:read`；管理JWT与权限守卫沿现有控制器。
- `RuntimeAssetsController`：deploy-mcp、deploy-gateway、start、redeploy均要求`server:manage`；MCP/Gateway部署及重部署从CurrentUser向验证上下文透传actorId。

上述为本轮源码核对，不是实际认证HTTP验收；SQL.js测试中的operator-fixture是合成身份，不能证明生产角色授权或逐资产范围。注册HTTP→受权发布→实际服务调用的剩余验证需单列，不能仅凭本页关闭真实环境发布任务。

## 文件

- `packages/api-nova-api/src/modules/runtime-verification/services/publication-cycle.spec.ts`
- `packages/api-nova-api/src/modules/runtime-verification/services/runtime-verification.service.ts`
- `packages/api-nova-api/src/modules/runtime-verification/services/runtime-verification.service.spec.ts`
- `packages/api-nova-api/src/modules/gateway-runtime/services/gateway-route-snapshot.service.ts`
- `scripts/verify-prod-03.cjs`

未修改业务数据库、统一台账、VERSIONS、受管child/preparation或OBS模块，未提交、推送或部署。
