---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-26
---
# OBS-13-02 长期传输与慢客户端验收（Windows 本地）

> Document status: Active evidence。仅本地回环、Windows x64、SQL.js/真实 Socket.IO；不含长时 soak/持续负载、Linux/多实例与真实外部接收端。

## 1. 环境与命令

- 提交：`8acc955`（以实际提交为准）
- 命令：`npm run verify:obs-13-02`
- 执行器：[scripts/verify-obs-13-02.cjs](../../scripts/verify-obs-13-02.cjs)
- 标记：`OBS_13_02_OK`

## 2. 本次结果

| 流 | 套件 | 结果 |
| --- | --- | --- |
| 调用事实流 | `test-call-observability-realtime.cjs` | 12/12（新增慢客户端 1 项） |
| 状态流（server_state_v1） | `call-observability-server-state-realtime.spec.ts` | 10/10（新增慢客户端 1 项） |

## 3. 慢客户端与恢复语义

- 每订阅同一时刻只有一个在途页面；ACK 未决期间不会继续拉取或缓存后续页面。
- 调用事实流：ACK 挂起时仅收到第 1 页；释放后从已确认游标继续，且事件序号无重复、无缺口（51→52→53）。
- 状态流：慢 ACK 订阅被限制为 1 页，另一并发订阅不受影响；ACK 超时/错误游标 → `SLOW_CONSUMER` 断开；未确认页在重连后重放，已确认游标从下一页继续。

## 4. 非声明

- 不含长时 soak、持续负载与内存曲线测量；不含 Linux/多实例/跨部署恢复与真实外部接收端。
- 本地通过不替代平台/生产验收。
