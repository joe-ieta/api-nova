---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-21
---
# SEC-A1-02B3受管鉴权模式一致性

持久private_api_key经准备服务双次快照检查进入handoff。受控环境必须为api_key；child监听前再次检查，父端READY必须与捕获模式一致。缺失、未知模式和该实验通道尚不支持的private_jwt/anonymous拒绝，不降级匿名。未发布实验性v1新增必填inboundAuthMode，旧无字段包拒绝。

## 验证

- API test-managed-mcp-channel.cjs与test-managed-mcp-handoff-preparation.cjs联合46/46：真实IPC、缺模式/未知包、数据库模式变化、受控环境不符、错误READY均拒绝。
- Server test-managed-runtime.cjs真实子进程13/13：Streamable与SSE认证调用正例，错误模式/缺认证/资源故障在监听前拒绝。
- Server构建、API类型检查通过；父任务服务管理11套34/34回归通过。

## 交付边界

本机Windows、SQL.js和回环上游证据；未接生产启动/停止生命周期，未扩展managed JWT/匿名支持。CLI effectiveInboundAuthMode仍unknown。单独child READY不能代替产品RUNNING验收。

[任务划分](../guides/active-work-package-breakdown.md)与[执行状态](../guides/active-work-package-execution-status.md)登记B3 DONE，解锁B4 UI和A2-01B综合拒绝矩阵，父包状态不提升。
