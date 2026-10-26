---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-28
---
# SEC-E2-01 当前产物安全联合矩阵证据（2026-09-28）

> Document status: Active evidence。聚合 12 套既有权威套件 + 新增 5 场景/19 检查；本地回环合成数据。

## 1. 环境与执行

- 执行器：`npm run verify:e2-01`（仓库根 `scripts/verify-e2-01.cjs`），**exit 0**，标记 `E2_01_VERIFY_OK`
- 环境：win32 x64，Node v24.15.0；dist 新鲜度校验（陈旧则拒绝并提示构建）
- 结果：聚合 **12 套件 / 153/153 测试** + 新增 **5 场景 / 19 检查**

## 2. 族×传输覆盖

| 族 | Streamable HTTP | SSE | stdio child | managed IPC |
| --- | --- | --- | --- | --- |
| 取消 | 既有 http-delivery/observability + N1（单次取消、无重试/迟到成功、activeCalls 0） | 既有 + N2（断开单次取消） | 既有 stdio/transport observability | 归 shutdown（stop/断开），e1-02c2 |
| 超时 | 既有 auth 截止 + N3（固定失败、单 attempt、无回退） | 既有 + N3 | 不适用（无握手/请求计时；上游超时由 N3 覆盖） | N4（真实 child 触发 30s 计时，`MANAGED_HANDSHAKE_TIMEOUT`，exit 1，清理干净） |
| 重放 | 既有 e0-01/b3-02/b3-01 + N1（cursor 重发不重执行、跨主体 403、已删会话 404） | 既有 + N2（退役会话 404、零上游） | 不适用（每客户端独立管道） | 既有 channel（重复包/ACK fail-closed）、e1-02c2（陈旧包不重放） |
| 关闭 | 既有 + N1（端口释放、同端口重启） | 既有 + N2（同端口重启） | 既有（EOF/关闭取消+flush） | 既有 channel/c1/c2 + N5（stop→端口释放→新 child 同端口 READY） |

聚合套件：adapter-contract 37、sdk-session 11、transport-observability 15、http-observability 17、http-delivery 11、stdio-observability 12、session-revocation 2、managed-channel 15、managed-runtime 14、e1-02c1 6、e1-02c2 10、publication-endpoints 3。

## 3. 未覆盖（`notCovered`）

- 专用每连接 idle 超时（当前产物不存在）；在途上游请求主动 abort（归 E1-04/F3）；SSE 事件游标重放（不适用）；父端对真实静默 child 的 30s 计时（子端已真实执行）；stdio 握手/请求计时与会话重放（不适用）；managed-IPC 入站取消（由 HTTP 传输覆盖）。
