---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-14
---
# 正文保留与调用事实消费推进

沿用上一波依赖安排，三路并发实现，父级统一接线、构建和联合验证。保留已有工作区变更，无新增表或初始化结构变更。

| 任务包 | 本轮完成切片 | 仍需完成 |
| --- | --- | --- |
| OBS-TP14 | eventDays/payloadDays部分PATCH、旧策略兼容、真实正文TTL消费、既有期限二次事务复核 | 配额、完整策略、管理审计/事件/投递/调用元数据生命周期及恢复 |
| OBS-TP14 | 默认关闭有界正文GC调度、fencing、单飞、停止等待、持久失败/恢复诊断；接入模块与pipeline/status | PostgreSQL多连接、Linux与持续容量矩阵、实际启用验收 |
| OBS-TP13/15 | Dashboard调用事实使用授权快照+独立Socket.IO事件页；成功处理后ACK、签名恢复、身份隔离、200条缓存及合并刷新 | 全局状态快照、其余旧消费者与全链路集成 |

依赖关系：持久策略先决定新正文TTL，既有对象期限优先；GC独立消费既有到期信息，不由PATCH触发；pipeline读取worker最后报告，不据此宣称当前存活。UI复用此前overview→events桥接，无新增事件源。TP10真实周期心跳仍是TP13全局状态快照的前置项；TP16/SEC-F4依赖最终整合版本。

## 验证与边界

- API构建PASS：tmp/retention-wave-api-build.log。
- 后端15脚本联合244/244，0失败/取消/跳过：tmp/retention-wave-observability-tests.log。集合为 policies、overview、capabilities、events、invocations、integration、realtime、deliveries、outbox、webhook-worker、statistics、series-groups、pipeline、payloads、retention-worker；命令 node --test 逐个传入脚本路径。
- UI协议及实际Pinia接线10/10，0失败/取消/跳过：tmp/obs-ui-consumer-tests.log；脚本 packages/api-nova-ui/scripts/test-observability-stream.cjs。覆盖超时、ACK顺序、恢复、权限范围、账号切换、有限重试及缓存/刷新竞态。
- UI类型检查及生产构建PASS：tmp/retention-wave-ui-build.log（Rollup依赖注释提示不阻断构建）。
- TTL与worker/pipeline交叉只读审查未发现阻断问题。worker部分安全错误仍归通用静态码，诊断粒度有限，不回传原始异常。

Windows、SQL.js、隔离合成文件与回环Socket.IO测试不能替代真实PostgreSQL/Linux、多进程、容量或部署证据。同DataSource多Store竞态已验证，真实数据库多连接仍待验收。未操作业务数据库、启用实际环境清理或部署。

## 当前清单

OBS：DONE10、IN_PROGRESS5、BACKLOG1。安全：DONE1、IN_PROGRESS18、BACKLOG3、DEFERRED1。合计39包：DONE11、IN_PROGRESS23、BACKLOG4、DEFERRED1；无新增整包DONE，HTTP28/28仅限定契约VERIFIED，AVAILABLE=0。

下一依赖顺序：TP10真实心跳→TP13全局状态快照；TP14配额/其余生命周期；TP15其余消费者与身份审计。安全E1可信MCP映射/共享Resolver及D1/F3网络边界延续原计划，此轮未改其完成状态。
