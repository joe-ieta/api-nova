---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-11
---
# 统一调用可观测性：应用接入与运行配置

ApiNova 以 API 资产注册、测试、治理和发布为主线，同时交付 Gateway 与 MCP 运行时。统一调用可观测性连接业务入口、Tool 和上游尝试，供管理查询与后续报送消费；管理监控 Socket.IO 不属于 MCP transport。

## 应用接入

`AppModule` 导入 `CallObservabilityModule`，管理接口统一位于 `/api/v1/monitoring/observability`。各路由继续要求管理 JWT、当前账号/角色与资源范围，Gateway/MCP 业务 Key 不能用于管理查询。

模块装配与部署可用性分别验收。源码注册、隔离 HTTP 测试不能证明业务环境已经启动，也不能证明所有计划接口已经实现。以 capabilities 返回的实现与权限资格为准，它不是运行健康检查。

采集 Worker 默认关闭，只有 `API_NOVA_OBSERVABILITY_COLLECTOR_ENABLED=true` 才在应用启动后运行。查询注册本身不会开启目录扫描。停用采集不删除已入库记录，保留期限和读取授权继续生效。

## 配置

| 配置 | 用途与要求 |
| --- | --- |
| JWT_SECRET | 管理 JWT 校验密钥；观测守卫要求至少 32 字节，不使用弱默认值放行 |
| API_NOVA_OBSERVABILITY_CURSOR_SECRET | 游标 HMAC 密钥，至少 32 字符；需要分页/补拉时必须设置 |
| API_NOVA_OBSERVABILITY_CURSOR_KEY_ID | 游标密钥版本，默认 v1，1~32 位字母、数字、下划线或连字符 |
| API_NOVA_OBSERVABILITY_COLLECTOR_ENABLED | true/false 字符串，默认 false |
| API_NOVA_OBSERVABILITY_AGGREGATION_ENABLED | true 时启动有界持久桶重算，默认 false；不会替换现有 HTTP 按需统计 |
| API_NOVA_OBSERVABILITY_DISPATCH_ENABLED | true 时将已提交事件转成持久投递任务，默认 false；不执行 Webhook 网络发送 |
| API_NOVA_OBSERVABILITY_SOURCE_ID_SECRET | 来源标识 HMAC 密钥，至少 32 字符；启用采集时必需 |
| API_NOVA_OBSERVABILITY_SOURCE_ID_KEY_ID | 来源标识密钥版本，默认 v1，与游标版本相互独立 |
| API_NOVA_OBSERVABILITY_SOURCES_PER_DAY | 每资产/认证状态/日期来源容量，默认 10000，范围 1~100000 |
| API_NOVA_AUDIT_DIR | 生产者 JSONL 与采集器共用的本机目录；建议显式绝对路径，默认相对工作目录 data/runtime-audit |
| API_NOVA_OBSERVABILITY_DATA_DIR | 私有正文存储根目录；默认位于审计目录下的 observability，不得作为静态文件目录 |

使用独立高熵秘密，不将真实密钥写入源码、文档或日志。轮换来源密钥会改变来源标识，不能解释为新增真实访客；轮换游标签名密钥后客户端需要重取快照。生产者与管理进程必须使用一致审计目录，否则无数据不能解释为零流量。

数据库仍使用项目既有初始化结构；`DB_SYNCHRONIZE=false`。本次源码接入不执行生产建库、清理、迁移或历史回填，不改写业务环境文件。

## 验收边界

隔离装配脚本为 `packages/api-nova-api/scripts/test-call-observability-integration.cjs`，在 API 构建后运行。它核对根模块注册、实际观测模块依赖注入、管理认证、Swagger 与能力声明一致，以及关闭采集时不会扫描。认证账号查询在夹具内替换，不能据此声称整个业务根应用及真实认证数据库已经部署验收。

新事件历史、持久聚合准备和采集健康能力按各自专项验收。持久贡献与脏桶不是已完成长期聚合快照；事件查询不是 Webhook 或 Socket.IO 主动推送。采集状态未知、来源无文件、观测覆盖不完整和业务无流量必须分别处理。

完整验收还包括实际管理进程的源目录一致性、持久库重开、账号撤权、全局前置拒绝审计、真实 PostgreSQL/Linux、持续负载与故障恢复。未取得独立证据前不登记 AVAILABLE。
## 快照与后台任务的当前边界

总览同时返回调用统计与持久化资产状态。`invocationSnapshotSeq` 只覆盖调用事实，`invocationSnapshotScope=invocation_facts_only`；旧状态表没有统一事件版本，不能把该序号作为服务器状态的完整增量快照。

成功读取总览后，服务端按当前主体、权限、资产范围及 origin/serverType/runtimeAssetId 登记一个进程内授权。有效期 5 分钟，最多 1000 个，淘汰最早签发项；重启、过期或淘汰后需重取总览。仅知道序号不能取得补拉权限。

首次补拉使用 `afterSequence` 和显式匹配的 `origin` 及其他已绑定筛选；后续使用响应的 `nextCursor` 作为 `after`。事件游标签名绑定权限与筛选。事件读取未指定 origin 时覆盖全部可见来源，因此不能省略总览授权中的 origin 来扩大补拉范围。

持久重算只发布完整计算的版本；新修订标脏时保留上一已完成快照，并用 stale 标识。单桶贡献超过 5000 时拒绝发布部分结果并保留重试状态。默认桶过期时间为 90 天，但物理清理、全局配额、完整覆盖账本和长期 HTTP 读取尚未闭环；当前 summary/time-series/groups 仍从保留明细读取。

Outbox 在同一事务内读取订阅所有者的当前角色与 `monitoring:read`、`monitoring:subscription:manage` 交集，创建投递任务并推进检查点。当前内核最多处理 200 个活动订阅，超限回滚；订阅管理 API、签名、网络发送、重试/死信及人工重投仍待后续任务交付。队列已创建不等于接收端已收到。

`pipeline/status` 仅限显式全局 read 范围，资产局部主体返回 403。聚合积压来自桶队列，分发进度来自持久检查点；无证据返回 unknown，不将检查点年龄解释为端到端 lag。
## 当前规划续推：内部基础增量（2026-09-11）

本轮仅延续 B03、TP11、TP12，不增加公开接口或部署开关，不改变现有任务包的完成判定。

TP11 将调用事件的事务内持久写入提取为 `writeDurableObservabilityEvent`，继续复用调用存储事务及统一序号。默认保留 14 天，历史 suppressed 事件仍落库但不进入事务事件通知集合。函数返回不代表外层事务已经提交；消费者只能处理已提交数据。桶更新和状态事件生产者仍需后续接入，不能据此声明统一事件链路已完成。

TP12 新增 `planWebhookRetry` 纯函数，失败尝试数包含首次发送，在当前 replay generation 内最多六次总尝试（首次发送加五次重试）；基础间隔为 5 秒、30 秒、2 分钟、10 分钟、30 分钟。内部抖动策略为额外增加 0~20%，活动窗口从该代持久起点起最长 24 小时，并与投递 TTL 取较早截止。Retry-After 支持秒数和标准 HTTP-date，作为不得提前重试的下界；超出截止时不再安排重试。超过次数或到达投递保留截止时不再安排重试，计划时间触及过期时也不延长 TTL。该函数只计算下一次时间，不判断 HTTP 错误是否可重试，也不执行网络请求、数据库更新或人工重放。配套 isRetryableWebhookFailure 将网络错误、408、429、5xx 分类为可重试，其他 HTTP 状态不重试，3xx 不跟随。后续 sender 必须在持有有效租约并持久记录失败后调用，同时重新执行当前授权、暂停和修订撤销检查。

这些内部基础不使 Webhook 自动可用。订阅管理、secretRef 授权解析、出站地址安全、网络发送、租约恢复、尝试审计和人工重投仍需按既有依赖完成。未增加 VERIFIED/AVAILABLE 接口数量；本轮未构建、运行或修改测试，前一轮验证结果仅覆盖前一轮实现。