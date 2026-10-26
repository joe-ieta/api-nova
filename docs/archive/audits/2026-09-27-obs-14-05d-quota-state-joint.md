---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-27
---
# OBS-14-05D 配额状态机与本地故障联调证据（2026-09-27）

> Document status: Active evidence。Windows SQL.js 单进程 + 真实本地文件系统；生产启用/长时压力/多进程/Linux-PG 联合为环境项。

## 1. 环境与执行

- 执行器：`npm run verify:obs-14-05d`（`scripts/verify-obs-14-05d.cjs`），标记 `OBS_14_05D_OK`
- 环境：commit `2929ad2`（含本批未提交改动），win32 x64，Node v24.15.0
- 结果：call-observability 模块 **13 suites / 105 tests**；聚合 **19 个 TAP 脚本 / 179 项**全通过；**17/17 验收检查**通过

## 2. 覆盖（新增联调场景 + 既有回归）

| 场景 | 要点 |
| --- | --- |
| 水位状态机 | H=90% 到达即限定并拒绝（`quota_exhausted`，0 临时写入）；L=80% 精确恢复；迟滞边界与硬上限 Q 精确 |
| 物理余量 | 新默认关闭守卫 `API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_PHYSICAL_ENABLED`：读取负载根真实 `fs.statfs`；低/过期/缺失证据分别 `quota_physical_low`/`quota_physical_unknown`，不放行 |
| 版本/禁用状态 | 配置冲突、epoch/操作/版本冲突、非法 ledger 均拒绝且不改状态；禁用时 `quota_unavailable` 且 baseline 不变 |
| 权限与旁路 | 伪造减负被拒；跨资产读取 `NOT_FOUND`；受权读取正常；业务结果为声明式成功而非静默丢弃 |
| 压力+故障 | 峰值保持、证明完成后一次性结算、重放 delta 0、不多计不超卖；业务降级状态显式声明 |
| 回归 | 05A/05B/05C1–C3 共 18 脚本（quota、publication、capacity、inventory、baseline、recovery、publication-intent/correlation/file-proof/reconcile/restart、recovery-acceptance、payload HTTP 鉴权等）全部通过 |

另修复 `test-call-observability-payload-publication-intent.cjs` 的迁移夹具清单（补 8000/10000/12000，7/9→9/9），断言未放宽。

## 3. 边界

- 未覆盖：长时浸泡/持续压力、Linux/PostgreSQL 联合状态机场景（05C3 双平台证据独立存在）、新场景的真实多进程、生产启用/回退签收；`quotaEnforced` 保持 false。
- 不新增 schema/迁移、无第二套存储；既有可选配额仍默认关闭。
