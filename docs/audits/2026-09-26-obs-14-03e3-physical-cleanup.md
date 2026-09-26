---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-26
---
# OBS-14-03E2B/E3 授权物理清理证据（2026-09-26）

> Document status: Active evidence。用户已明确授权本功能物理删除；默认配置保持关闭且无物理删除。

## 1. 环境与执行

- 执行器：`npm run verify:obs-14-03e3`（`scripts/verify-obs-14-03e3.cjs`），标记 `OBS_14_03E3_OK`
- 环境：commit `3f47266`（含本批未提交改动），win32 x64，Node v24.15.0；SQL.js 单进程
- 结果：call-observability 模块 **12 suites / 102 tests 全通过**；8 个 TAP 脚本回归（E2B 1、E1 6、E2A 4、03D 9/12/12/56/14）全通过；`database-tool.cjs create sqlite` 73 表零漂移
- API 构建：`npm run build --workspace api-nova-api` 通过

## 2. E2B 实现要点

- 新增 opt-in 事件阶段（`events`），接入既有 03D 三阶段服务之前/同链：过期事件候选经 E2A 分类与授权、租约/状态/投递引用复核后，**同一 Store 事务**内完成 gap 记录 + 物理删除 + 持久游标推进 + 阶段报告。
- 开关：worker `API_NOVA_OBSERVABILITY_LIFECYCLE_RETENTION_EVENTS_ENABLED`（仅 `'true'` 生效，默认 false）；未开启时行为与现状一致。
- 保护：活动租约、未完成 attempt、有效幂等结果、投递引用、墓碑不被触碰；批大小有界；失败整体回滚、游标不前移、重试幂等；重启按持久游标续扫并尾部复位。
- 复用 03D 墓碑/回执模型，无第二套存储、无 schema/迁移变更。

## 3. E3 验收（10 项检查全过）

| 检查 | 结果 |
| --- | --- |
| default-off 无删除（worker 开关 false，2 存活/0 gap/游标与水位不变） | pass |
| enabled 仅删授权候选（2 删除/1 合并 gap） | pass |
| gap+游标+删除同事务（注入失败回滚，重试恰好一次） | pass |
| 有界批次 `[2,2,1,0]`、重启续扫、尾部复位、资产范围隔离 | pass |
| 租约/未完成 attempt/有效幂等保护后释放（4 删除） | pass |
| 幂等重跑 0 删除、gap 集合不变 | pass |

## 4. 边界

- PostgreSQL 运行时装迁移/多进程并发、长时浸泡与删除量、Linux/macOS、生产启用与回退签收仍为平台/环境项（`notCovered` 已列出）。
- 物理删除默认关闭；本证据不构成生产启用授权。
