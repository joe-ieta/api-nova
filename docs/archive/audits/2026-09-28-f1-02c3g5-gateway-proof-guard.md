---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-28
---
# SEC-F1-02C3G5 Gateway 执行 Proof Guard 补全与注册证据（2026-09-28）

> Document status: Active evidence。同进程 authority lifecycle + request-bound capability，默认关闭注册；Verified 保持关闭。

## 1. 环境与执行

- 执行器：`npm run verify:f1-02c3g5 --workspace api-nova-api`，标记 `F1_02C3G5_VERIFY_OK`，exit 0（**5/5 套件 / 58 测试**，含真实 Nest HTTP）
- 回归：gateway-runtime **55 suites / 784 tests**；API type-check 与构建通过；verify:e1-04、verify:f3-03 保持绿

## 2. 实现

- 同进程 host challenge/session/proof issuer lifecycle（复用 C3 原语与既有证据存储，无 schema 变更）：创建、TTL、单次消费、撤销、epoch/context 复核、`active()/close()`。
- request-bound capability provider：绑定 scope/method/target/contextDigest/providerEpoch/generation/actorId + TTL，WeakMap 持有 proof/session，消费一次，消费时重验 context；仅 `{kind}` 可序列化。
- Guard 绑定补全并在 `GatewayRuntimeService` 的 Resolver 与 cache **之前**执行；`GatewayRuntimeModule` 以 **null 默认**注册（default-off），host 需显式注入。
- 不开放 Verified（`canPublish` 保持 false，E1 继续拒绝）；Publication 入口未改。

## 3. 边界

- PostgreSQL 未覆盖（lifecycle/evidence 路径用 SQL.js）；无生产 host 安装（无环境/配置文件铸造路径）、无管理 HTTP proof 请求端点或真实 session/事件源；跨进程与 MCP/child 实时撤销归 G6。
