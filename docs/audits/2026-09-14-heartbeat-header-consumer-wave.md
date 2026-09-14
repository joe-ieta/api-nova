---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-14
---
# 管理心跳、请求头与Gateway消费者并发推进

沿用[上一轮](./2026-09-14-retention-consumer-wave.md)依赖，三路并发实现，父级负责模块/pipeline接线、独立审查、整合验证及当前任务状态文档。原有未提交修改保留；无新表/初始化结构调整。

| 包 | 本轮完成切片 | 剩余退出条件 |
| --- | --- | --- |
| OBS-TP10 | 默认关闭管理进程周期心跳，单owner租约、超时接管、旧owner停机保护；状态/事件同事务；server状态与pipeline全局授权视图 | 业务Gateway/MCP真实心跳、在途、全进程覆盖、依赖健康和完整历史维度 |
| SEC-D1 | Connection所有大小写键与数组联合提名；代理生成四字段去别名；被提名XFF不重新引入 | 业务allowlist、完整重复/framing/响应边界及可信代理/网络策略 |
| OBS-TP15 | Dashboard Gateway日志改用统一invocations；最近一小时、签名下一页、元数据展示、会话隔离与失败清空 | 其余消费者、旧端点退役、完整身份/拒绝审计及部署切换 |

## 关键依赖和语义

管理心跳复用Store和pipeline.state_changed。它只证明单租约持有者定时循环及存储往返，不证明业务服务存活或采集成功，不虚构资产行；业务heartbeat/health仍未知。默认15秒、45秒stale，stale不等于offline；正常停机报告stopped。

D1复用既有凭据Resolver发送路径，保留普通XFF客户端前缀+peer行为而不称其可信身份。没有更改业务allowlist、Forwarded普通透传、DNS/SSRF、重定向或部署代理政策。

UI首屏使用新API实际支持过滤；后续只传签名cursor与limit以保留快照，历史页不受轮询覆盖。新接口不支持的method/path/status筛选不做本地单页伪过滤。旧后端暂保留，未加兼容回退或读取正文。

## 验证

| 范围 | 本轮结果 | 证据 |
| --- | --- | --- |
| API统一构建 | PASS | tmp/heartbeat-gateway-wave-api-build.log |
| OBS十六脚本联合 | 254/254，0失败/取消/跳过 | tmp/heartbeat-gateway-wave-observability-tests.log |
| Gateway完整Jest | 17套176/176，detectOpenHandles正常退出 | tmp/heartbeat-gateway-wave-gateway-tests.log |
| 新请求头真实发送 | 6/6，回环socket、二进制正文、None剥离及Resolver拒绝零连接 | tmp/heartbeat-gateway-wave-header-tests.log |
| UI新查询+既有实时流 | 16/16，实际Pinia接线、固定快照、会话变化及竞态 | tmp/obs-ui-query-migration-tests.log |
| UI类型检查/生产构建 | PASS | tmp/heartbeat-gateway-wave-ui-build.log |

OBS集合为policies、overview、capabilities、events、invocations、integration、realtime、deliveries、outbox、webhook-worker、statistics、series-groups、pipeline、payloads、retention-worker、heartbeat；使用node --test逐个传入脚本。心跳9项及pipeline15项已包含在254项中，不重复相加。Gateway使用npm run test --workspace api-nova-api -- --runInBand --detectOpenHandles gateway-runtime。

心跳owner/事务/授权由另一代理只读交叉审查，父级独立审查D1发送逻辑与UI实际接口契约，未发现阻断问题。测试环境为Windows、SQL.js、隔离合成文件、回环/注入网络。真实PostgreSQL多连接、多进程/Linux/容量与部署仍待验收。本轮未操作业务数据库、实际环境启用配置、真实上游或发布部署。

## 当前任务状态

OBS16包：DONE10、IN_PROGRESS5、BACKLOG1。安全23包：DONE1、IN_PROGRESS18、BACKLOG3、DEFERRED1。合计39包：DONE11、IN_PROGRESS23、BACKLOG4、DEFERRED1；无新增整包DONE。HTTP28/28仍仅限定契约VERIFIED，AVAILABLE=0。

下一并发方向：TP10业务心跳与资产映射→TP13全局状态快照；TP14配额/其余生命周期；TP15剩余调用方查询。安全E1/C4可信MCP资产映射与发送前共享Resolver、D1业务allowlist及F3网络边界延续原依赖。最终TP16/SEC-F4针对完整整合版本验证，局部绿色回归不替代整包退出条件。
