---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-08
---
# OPS-01 同版本Gateway重复部署恢复

上一轮登记的重复激活冲突已在完整、可读取的二进制样例下独立复现，不再把它与缺失样本阻断混为一谈。基线为`ffaafe0`，本机Windows / PostgreSQL16新建隔离集群，真实管理API、候选HTTP回放和认证消费者。

## 复现与修复

基线证据`.tmp/prod-04c-fVqzUn/evidence.json`及`.tmp/redeploy-baseline.log`显示：首次发布正常；内容不变再次部署时，候选验证passedCount=1，但插入同一runtimeAssetId/revision快照触发唯一键`IDX_a61ea3be16d7b504d37ea68a41`，返回409、failed/retained_previous。旧版本仍在，重复部署本身失败。

[快照激活服务](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-route-snapshot.service.ts)现在复用已存在且一致的不可变快照。每次部署仍重新执行验证并生成独立run，不跳过上游调用；复用前核对持久快照的策略、条数、候选指纹及按既有行为合同重算的正文指纹。冲突或损坏返回`GATEWAY_SNAPSHOT_REVISION_CONFLICT`，不覆盖旧证据；首次版本仍在原事务中创建，未扩展为多主机CAS。

## 验证范围

- 快照专项：同revision复用不新增行、不修改原快照；已有fingerprint或payload损坏时拒绝，当前路由保持可用。
- SQL.js发布周期：重复验证/激活仍只有一条快照，随后失效、失败保旧、事务回滚和重新发布继续有效。
- [真实PG/HTTP执行器](../../scripts/verify-prod-04c.cjs)：在已通过的二进制留存流程中加入连续两次无变化部署，核对两份不同验证run、同一revision、一次持久快照和真实认证消费者响应。

最终真实PG/HTTP17/17通过（`.tmp/prod-04c-8huOJF/evidence.json`），包括新增两次无变化部署、原二进制留存及故障恢复；所有自有API/PG停止。全仓构建通过，后续API源码最终重建通过。API全量首轮175套/1845项中唯一失败是既有测试替身缺少新增findOneBy方法（174套/1844项通过）；补齐后，失败套件与最终受影响范围共29套/240项全部通过，未用跳过测试规避失败。日志分别为`.tmp/2026-10-08-api-regression.log`和`.tmp/2026-10-08-final-targeted-tests.log`。此项属于OPS-01本地交付阻断修复，不代表生产、浏览器完整流程或整个OPS-01签收完成。
