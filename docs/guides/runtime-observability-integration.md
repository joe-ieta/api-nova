---
doc-version: 2.0.0
doc-status: active
doc-updated: 2026-09-14
---
# 统一调用可观测性：远端主链路与本地增量接入

## 整合基线

以远端 origin/main 7a7fc44 的持久聚合、事件历史、Outbox、订阅/投递 API 和签名发送为唯一主链路。本地独有的根应用接入、overview/dependencies/servers/status/pipeline/status、缓存三态、内部调用 origin 隔离及 MCP 发送边界修复作为增量整合。

本地先前的重复 bucket projector/queue、dispatcher、subscription command、delivery lease、webhook sender/worker 已由远端实现替代，原始代码保存在 2b4c6c6 提交中。不能继续引用这些旧类或恢复双消费者。

## 模块与后台任务

AppModule 只导入一次 CallObservabilityModule。模块保留远端全部管理控制器和 Provider，在其上添加四类本地查询及进程内调用快照授权。不存在本地旧版 withWebhook 动态装配入口。

- API_NOVA_OBSERVABILITY_COLLECTOR_ENABLED：字符串 true 才启用采集；默认 false。采集/重算遵循远端 Store 的持久投影协议。
- API_NOVA_OBSERVABILITY_OUTBOX_ENABLED：字符串 true 才启用远端 Outbox；默认 false。入队不表示接收端收到。
- API_NOVA_OBSERVABILITY_WEBHOOK_ENABLED：字符串 true 才启用远端 DeliveryWorker；默认 false。密钥和目的地配置必须按远端实际契约完成。
- 本地旧 AGGREGATION_ENABLED 和 DISPATCH_ENABLED 不再对应消费者，不应作为部署开关使用。

管理 JWT、游标 HMAC、来源标识 HMAC、幂等 HMAC 和 Webhook 签名秘密应独立配置，不能复用业务 API Key。本文不包含真实秘密。数据库初始化结构保持远端版本；本次不执行迁移、不修改环境文件、不初始化业务库、不启用发送。

## 保留的本地查询能力

overview、dependencies、servers/status 按当前管理授权和资源范围读取。没有真实心跳证据时健康/存活保持 unknown，不用旧状态时间冒充实时健康。

pipeline/status 仍只允许显式全局 monitoring:read，读取远端 metrics.recompute 标记、Outbox 与 Webhook 持久状态，不读取已移除的本地队列字段。检查点或状态年龄不自动等于端到端延迟。

调用快照桥接只覆盖 invocation facts。快照授权绑定主体、权限、资产范围及 origin/serverType/runtimeAssetId，进程内 5 分钟、最多 1000 项；重启或淘汰后重取总览。桥接以可选增量方式加入远端事件服务，不修改远端已有类型、游标完成/过期和固定水位语义。

缓存三态计数只使用 gateway_request 的显式证据。新持久桶直接支持缓存字段；旧桶缺少完整缓存字段时沿用远端明细降级，不补造零值，也不把保留明细当完整长期历史。

## 订阅与投递的唯一数据契约

订阅状态为远端 enabled/paused/deleted，destination 使用远端对象格式，修订采用 [effectiveFromSequence,effectiveUntilSequence)。公开 PATCH、列表游标、人工重投与 attempts 均沿用远端控制器和服务。不得把本地旧 active/config.enabled/字符串 destination 或右闭区间写回共享表。

完整接收端和秘密配置说明见 runtime-observability-external-validation-handoff.md；订阅管理说明见 runtime-observability-subscription-integration.md。

## 验收边界

远端闭环结论予以保留，合并需要另立回归证据证明没有破坏远端行为。本地历史 105/105 与远端历史专项不能直接作为合并后结果，也不相加冒充新增总量。

真实 PostgreSQL/Linux、多进程、容量性能、全链路审计和实际部署需独立验收。远端已完成的订阅/投递管理不重新列为从零开发待办；Socket.IO、策略/整体保留治理和真实运行存活仍按原规划接续。没有部署证据前 AVAILABLE=0。