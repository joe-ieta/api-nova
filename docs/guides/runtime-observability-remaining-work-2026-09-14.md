---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-14
---
# 可观测性未完成清单与远端同步基线

## 本地提交前后状态

开发提交：2b4c6c6，覆盖 98 个文件。提交前最新 API 构建通过，九脚本联合 105/105 PASS；没有部署或启用外部发送。此处是拉取远端前的本地证据，不能直接作为合并后验收。

本地计划口径：DONE=8、IN_PROGRESS=3、READY=0、BACKLOG=5。HTTP 17/28 VERIFIED，11 个 PLANNED；AVAILABLE=0。TP12 的 BACKLOG 保留硬依赖含义，不代表没有内部实现。

## 未完成工作

| 优先级 | 任务 | 已有基础 | 未完成与退出条件 |
| --- | --- | --- | --- |
| P0 | TP12 管理接口 | 订阅事务、详情安全视图、投递详情和尝试查询 | 稳定列表分页；HTTP DTO/controller；事务内 partial PATCH；目的地/secretRef 授权策略装配；真实审计与权限拒绝验证 |
| P0 | TP12 重投与受控测试 | 六次总尝试、24h、TTL、租约 fencing、签名及固定 IP HTTPS | 人工 replay generation、幂等重投、修订撤销、订阅测试事件；非零 generation 当前拒绝处理 |
| P0 | TP12 运行接入 | 默认关闭 Worker、withWebhook、密钥适配 | 实际授权秘密后端、完整 DNS 解析依赖、配置失败行为和接收端联调；不能只开开关 |
| P1 | TP10 B03/B04 | 持久贡献、脏桶、有界完整重算、覆盖选择证据 | 覆盖账本、缺口/历史恢复、保留与配额、长期 HTTP 持久读取、桶更新事件 |
| P1 | TP10/11 统一状态与事件 | 调用事件 writer、持久历史、Outbox、调用快照桥接 | 桶/服务器/pipeline 等事件生产者统一；真实心跳/存活与统一状态版本；不能把旧状态时间当健康 |
| P1 | TP13 Socket.IO | 事件历史与调用 afterSequence 授权 | 同一持久源的实时推送、无缺口快照切换、撤权断开、慢消费控制与有界补拉 |
| P1 | TP14 治理与策略 | pipeline/status | 跨对象 TTL/配额、活跃投递事件引用保留、策略 HTTP/审计、安全 GC 与恢复 |
| P1 | TP06 MCP 验收 | STDIO/SSE/Streamable 发送确认，53 项历史专项 | 完整 transport/body/失败矩阵、AC02 真实重试、Windows 大响应背压限制；不能将对照复现通过当恢复成功 |
| P2 | TP15 集成收敛 | 根模块和隔离端到端装配 | 全局拒绝审计、身份映射、旧查询消费者收敛、全部报送路径与安全停机 |
| P2 | TP16 平台与交付 | SQL.js/回环与注入式网络专项 | 真实 PostgreSQL/Linux、多进程、容量/持续负载、性能目标和完整 AC 验收；实际部署另立 AVAILABLE 证据 |

## 可并行推进但不可重复建设

1. 管理 HTTP/分页与人工重投可按查询、命令写集拆分；共享实体、模块和游标契约由同一集成负责人协调。
2. 长期聚合/统一事件与 Webhook 管理可以并行；B04/Socket.IO 无缺口承诺仍依赖覆盖和统一水位。
3. MCP 平台矩阵与 PostgreSQL/容量夹具可以并行；需要外部环境时按 external-validation-handoff 文档准备，不在聊天中传密钥。
4. 拉取远端后先检查远端是否已实现这些切片，按实际代码/测试与契约重排，避免覆盖或再造。

## 远端同步记录

待获取远端提交后补充提交范围、文件交集、冲突处理与对后续计划的影响。同步使用保留双方提交历史的 merge，不改写历史，不自动推送。
## 远端获取及三方合并预检结果

已 fetch origin/main，远端头为 7a7fc44；共同基线 ee659c3。本地开发及清单提交为 2b4c6c6、cf06256，预检时本地领先 2 个、远端独有 8 个提交。使用 git merge-tree --write-tree 预检，未把结果写入工作区，也未创建实际 merge 提交。预检报告 15 个冲突文件。

| 远端提交 | 内容 | 对本地后续计划的影响 |
| --- | --- | --- |
| 3dcded3 | 持久桶修订、采集状态事件及持久统计读取 | 已推进本地 B03/B04 待办，但与本地贡献/重算格式重叠，先统一写入协议 |
| 2b43d42 | Windows 文件句柄身份复核 | 本地没有对应专项修复，适合保留并重新跑平台相关回归 |
| eeb298f | 授权持久事件历史 | 与本地同名事件服务 add/add 冲突；需保留本地调用快照 afterSequence 授权桥接 |
| 9388cdd | 持久 Outbox 投递物化 | 与本地 dispatcher 的水位、事件状态和修订边界不同，不能双消费者并行 |
| f2c1308 | 创建 Webhook 订阅 | 已覆盖本地计划中的公开创建接口，不应重写一套 |
| 7b23021 | 订阅查询、修改及删除 | 已提供列表游标和部分 PATCH，本地仅完整替换内核及详情，后续以契约兼容整合为主 |
| c26de04 | 投递管理 | 已推进测试投递、列表、尝试详情和人工重投，替代本地相应从零开发待办 |
| 7a7fc44 | 签名 Webhook 发送 | 与本地 lease/sender/worker 重叠，需统一尝试代数、秘密策略和状态写入 |

### 主要语义冲突

1. 订阅与修订格式：本地 active/paused，revision.config.enabled、字符串 destination、独立 signingKeyId；远端 enabled/paused，config.state、对象 destination={type:webhook,url}，以 secretRef 输出 signingKeyId。双方读取同表，不能仅解决文本标记后共用。
2. 修订区间：本地 dispatcher 为 (effectiveFromSequence,effectiveUntilSequence]，远端 Outbox 为 [effectiveFromSequence,effectiveUntilSequence)。创建、修改、快照查询、投递选路和边界测试必须一起统一，不能让查询和投递采用不同区间。
3. 聚合投影：本地通过 hook 存储包含 revision/bucketIds/observation 的持久贡献与独立队列；远端 Store.saveProjection 直接写 contribution=plan，并以 metrics.recompute 标记重算。同表同调用可能互相覆盖；必须选一个主写入协议并迁移/适配另一方读取。
4. 自动发送：本地 WebhookWorker 和远端 DeliveryWorker 使用同一个 API_NOVA_OBSERVABILITY_WEBHOOK_ENABLED 开关。不得同时注册两套消费同一 delivery 表的 Worker；实际密钥解析与地址允许策略也需统一。
5. HTTP/模块冲突：events 和 subscriptions 服务同名但方法参数不同；远端控制器不能直接注入本地同名服务。本地 AppModule 已接入观测模块，远端尚未做根接入，合并后会改变可访问面，必须检查全部权限和默认关闭配置。
6. 文档状态漂移：远端评审前段仍称部分 Webhook 接口未完成，但后段记录 API22~25 与发送完成；远端执行台账最新段宣称 TP11/TP12 DONE。应按代码及对应测试逐条重建状态，不能直接覆盖本地台账或累加两侧通过数量。

### 推荐整合路线（待用户确认）

以远端公开订阅/投递 API、Outbox 和持久事件作为主链路，保留本地独有的根模块接入、总览/依赖/服务器状态/pipeline 查询、缓存三态、真实内部调用 origin 隔离、MCP 发送边界修复以及相关测试。将本地发送安全、密钥所有权与停机测试移植到统一实现，不同时启用两套重算或投递消费者。两个方向的原始实现均已保存在提交历史，不能通过整文件选择 ours/theirs 掩盖差异。

远端 API01、03~13、16~25 与本地 API02、14、15、26 在功能编号上形成 26/28 候选覆盖；这只是编号并集，不是合并后的 VERIFIED 数。策略 API27/28、Socket.IO、真实存活/整体保留治理、平台性能和部署仍未因此完成。

### 调整后的下一轮清单

- P0：统一订阅/修订数据格式和生效区间，选择唯一 Outbox、聚合写入及发送消费者；合并后再运行两侧测试，当前本地 105/105 不为远端背书。
- P0：用远端已有 HTTP/重投实现替换本地从零开发计划，补本地安全/授权/快照桥接等差异用例。
- P1：移植本地独有查询、缓存、origin 与 MCP 修复，吸收远端 Windows 身份修复；重建 capabilities/Swagger/Endpoint 状态。
- P1：统一数据协议后继续 TP13 Socket.IO、TP14 治理与策略，不提前启用 GC 或生产发送。
- P2：真实 PostgreSQL/Linux、多进程及 HTTPS 接收端、持续负载与发布部署验收。

当前同步状态：已提交本地成果、已获取远端、已完成差异及合并预检；正式合并尚未执行，工作区未进入冲突解决状态，未推送远端。鉴于数据与消费者方案存在非机械取舍，等待确认推荐整合路线后继续。