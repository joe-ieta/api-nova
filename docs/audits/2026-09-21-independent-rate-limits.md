---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-21
---
# SEC-D2-01 Gateway IP与匿名独立限流验收

代码起点：`fc4893f`；最终代码版本为包含本报告的提交。平台Windows，Node24.15.0，锁文件SHA256 `9eb15cc0265e1366483cc340ee6e7e55638af3ed558eb09dc1a5bb032f3f2a54`。

## 行为

路由 `upstreamConfig.trafficControl.rateLimit` 新增正数 `ipMax`、`anonymousMax`，窗口沿用windowMs。IP按route+socket peer计数，匿名按route共享。沿用peer-only可信边界，不信任X-Forwarded-For等来访头；IPv4-mapped IPv6归一化。
真实Gateway链为鉴权→限流准入→缓存→上游。所有有效请求包含缓存命中均计数；鉴权失败不进入准入。缺peer或身份时已配置的相应限流拒绝执行。过期桶按需清理。

## 验证

- Gateway全套 `npx jest --runInBand --testPathPattern=gateway-runtime`：18套201/201，退出0（并行执行者）；最后清理改动后专项2套11/11再次通过。
- 主任务复验Gateway限流、traffic、registry provider/admin：4套42/42，退出0；API完整构建退出0。
- 新真实HTTP4项覆盖暖缓存计数、转发头伪造、匿名/凭证分桶、鉴权失败禁止缓存旁路和路由隔离；新增单测覆盖缺peer/身份拒绝、IPv4映射、窗口到期。
- 6个修改文件ESLint与diff-check通过。

本叶只关闭Gateway IP/Anonymous层。计数进程内且重启重置；完整层级组合、跨节点共享计数、MCP及生产部署不据此验收。
