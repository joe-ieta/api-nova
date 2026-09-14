---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-14
---
# Gateway路由观测、MCP可信映射与策略UI

沿用[前轮依赖](./2026-09-14-heartbeat-header-consumer-wave.md)，三路并发完成下列可验收切片，父级统一接线、构建和复核。保留原有未提交工作，无新表/初始化结构或真实环境变更。

| 任务包 | 本轮完成 | 剩余退出条件 |
| --- | --- | --- |
| OBS-TP10 | 默认关闭的真实本实例路由注册表周期观测、DB Gateway资产映射、owner fencing、授权状态字段 | 业务监听器/进程健康、依赖/在途和多进程完整覆盖 |
| SEC-E1/C4 | 可信进程内method/path映射、冻结闭包、拒绝重复/未知/缺失绑定、两个Server入口 | 数据库归属、共享Resolver实际发送授权、逐跳复验和CLI秘密移除 |
| OBS-TP14/15 | Dashboard保留策略卡片、全局能力编辑门禁、强If-Match/原因、冲突重读及账号/异步隔离 | 完整策略/配额/元数据生命周期及其余UI集成 |

路由表是实际Gateway发送所用注册表，但不证明HTTP监听器可达；因此新增专用gatewayRoutingObservation，原业务健康保持unknown。采样在Store写锁内；等待写锁时移除路由有回归，避免旧快照被当作新证据。目录200/路由10000上限超出时整个报告拒绝，不发布部分假零。

MCP可信映射是发送授权前置身份基础，未连接共享Resolver；OpenAPI扩展和Tool参数不可覆盖已注入标准HTTP handler身份。默认Axios跳转行为未改，不以首跳身份映射宣称整条跳转安全。自定义customHandlers和数据库资产归属不在本切片保证中。

策略UI仅影响新记录TTL，不启动GC。网络失败不宣称回滚、不自动重放PATCH。审查修复旧保存finally干扰新保存状态及迟到冲突提示覆盖后续成功消息，两项有回归。

## 验证

| 范围 | 结果 | 日志 |
| --- | --- | --- |
| Parser构建 | PASS | tmp/routing-policy-wave-parser-build.log |
| Server构建 | PASS | tmp/routing-policy-wave-server-build.log |
| API构建 | PASS | tmp/routing-policy-wave-api-build.log |
| UI类型检查/生产构建 | PASS | tmp/routing-policy-wave-ui-build.log |
| OBS十六脚本加路由观测 | 265/265，0失败/取消/跳过 | tmp/routing-policy-wave-observability-tests.log |
| Gateway完整Jest | 17套176/176，detectOpenHandles正常退出 | tmp/routing-policy-wave-gateway-tests.log |
| Parser全量 | 19套349/349 | tmp/routing-policy-wave-parser-tests.log |
| MCP两个转换入口专项 | 3/3，实际handler+注入axios adapter | tmp/routing-policy-wave-mcp-mapping-tests.log |
| UI策略/查询/实时流 | 26/26，实际Pinia、竞态、权限和HTTP适配 | tmp/obs-ui-policy-tests.log |

OBS集合为前轮16脚本加test-gateway-routing-observation.cjs；新增路由观测11项包含于265，不重复计数。Parser新增映射7项包含于349；现有审计故障用例的固定告警不代表全链路审计闭环。源码类型检查曾暴露PathItemObject字符串索引错误，已修正并通过最终四包构建。

路由观测经另一代理独立只读审查，父级复核MCP标准主入口透传及策略UI并发状态，未发现剩余阻断项。Windows、SQL.js、隔离合成数据/本地注入网络不替代PostgreSQL/Linux、多进程与部署验收。未启用真实环境observer/GC、未操作业务库或外部上游。

## 当前完成状态与依赖

OBS16包：DONE10、IN_PROGRESS5、BACKLOG1。安全23包：DONE1、IN_PROGRESS18、BACKLOG3、DEFERRED1。合计39包：DONE11、IN_PROGRESS23、BACKLOG4、DEFERRED1；无新增整包DONE。HTTP28/28仍限定契约VERIFIED，AVAILABLE=0。

下一顺序：可信MCP映射→共享Resolver及每跳安全发送；业务运行健康证据→TP13全局状态快照；TP14配额/其余生命周期与TP15剩余消费者可继续并行。TP16/SEC-F4必须针对最后整合版本做完整矩阵。
