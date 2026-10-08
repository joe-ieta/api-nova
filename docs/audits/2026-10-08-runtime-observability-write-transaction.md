---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-08
---
# OBS-16-04 旧 Runtime 指标与状态事务合并

本轮承接[SQL.js 持久化审计](2026-10-08-sqljs-persistence-concurrency.md)定位的 Gateway 热路径重复提交：一次请求结果原先分别保存 5 个指标、2 个状态，失败时再保存事件。整合目标是让这组有关联的事实一次原子提交，保留全部指标和审计，并减少整库持久化次数；本修改不等于完整性能门槛已通过。

## 实现及边界

[RuntimeObservabilityService](../../packages/api-nova-api/src/modules/runtime-observability/services/runtime-observability.service.ts) 的 request-result、cache-result、runtime-control 三个写入口统一使用事务局部 repository，单次调用是固定有界的提交单位。正常 request-result 的 7 次 repository.save 仍执行各自必要 SQL，但共享一个提交；失败事件也归属该事务。调用方继续等待事务完成，不使用后台丢弃、关闭 autoSave 或缓存未提交结果换取吞吐。

事务绑定采用独立服务实例持有当前 manager，常驻 singleton 的 repository 字段不被临时替换，避免并发请求互相使用错误事务。若服务原本由事务 manager 构造，则复用该 manager 的嵌套事务语义；SQL.js 继续使用项目已有 owner lane，未新增另一套全局队列。

同一事务内固定小集合从 Promise.all 改成顺序 await。第一处失败后不会遗留兄弟分支，在 rollback/release 后继续写入数据库。事务内所有指标、均值、状态及对应事件成功或一起回滚。

PostgreSQL 在任何引用或投影读取前取得按 runtimeAssetId 生成的事务级 advisory lock：固定命名空间的 SHA-256 前 8 字节解释为两个 signed int32。request/cache/control 共用同一个键，因此覆盖多进程/多连接上的首次建行、已有行计数及均值更新。单次操作只拿一个 asset 锁，事务结束自动释放；不同资产不互相排队。本轮没有新增跨请求微批，也没有声称回放同一个成功调用自动去重，失败回滚后的显式重试才不会重复计数。

第一次完整 PostgreSQL 候选实测（RzVn6W）出现请求 p95 约 75.17 秒的显著退化，因此不能直接交付“只在开启事务后等待 advisory lock”的版本。后续小修增加仅针对 PostgreSQL 根 manager 的本地准入：同一 DataSource/asset 在申请连接和开启事务之前串行等待，数据库 advisory lock 继续保护跨进程/跨 DataSource 写入。WeakMap 仅保留活跃或等待的资产尾 Promise，完成时按当前尾身份清理，失败仍拒绝当前调用但不毒化后继。已绑定 QueryRunner 的 manager 绕过本地准入，避免自己持有外层连接/锁时等待 root 队列形成自锁；原有嵌套事务和 PG 锁仍执行。SQLite 分支未改变。这里是同步调用背压，没有新增后台缓冲，也不声称总等待请求数有硬上限。

## 历史维度兼容

保留旧 metric 的 scope 与 membership 维度，以及已有 state 查找/建行规则。原 asset-scope metric 同时带 membership；原 asset state 的 null 查找值由 TypeORM 忽略，历史行可能附带 membership。直接改用 IsNull 并另建空 membership 行会割裂历史计数，本轮未夹带这种迁移，也未宣称资产级聚合历史已统一。新测试应包含两个 membership 与 cache/control 混合操作，防止事务优化顺带重定义统计口径；独立的维度迁移和历史合并需另行设计。

## 验证入口与当前记录

新增 [SQL.js 原子投影回归](../../packages/api-nova-api/src/modules/runtime-observability/services/runtime-observability-atomic.spec.ts)，使用真实 autoSave=true 和磁盘数据库，覆盖：

- 5 指标与 2 状态只触发一次持久化，重新打开数据库可见全部结果。
- 文件写入被 gate 阻塞期间，调用方不能提前成功。
- 第二次 state 或最终失败事件注入异常后，指标/状态/事件全部回滚；事件循环继续后也无残留写入，重试只计一次。
- 并发结果的请求、成功、失败计数、算术均值、sampleCount 及最后状态精确。
- 两个 membership 的原维度，以及 request/cache/control 混合历史保持兼容。
- 事务 manager 绑定与合法外层回滚。

新增 [PostgreSQL 独立集群验证](../../packages/api-nova-api/scripts/test-runtime-observability-atomic-postgres.cjs)，自己 initdb、随机回环端口、fsync/synchronous_commit=on，不使用继承 DB/PG 目标；两独立 DataSource 并发覆盖首次建行、计数/均值、混合入口共享锁、末尾故障回滚和重试、外层事务回滚。catalog refs 在夹具中受控提供，仅验证持久化合同，不冒充完整 Gateway 认证验收。

已执行结果：

- SQLite 专项 1 套 **7/7 通过**，日志 `.tmp/runtime-observability-atomic-tests.log`。真实 autoSave 调用确认单次正常请求的全部 5 指标与 2 状态只需 **1 次**，磁盘重开、提交等待、两个末尾故障回滚、并发统计、旧维度及合法嵌套全部通过。
- 自建 PostgreSQL 专项 **6/6 组通过**，日志 `.tmp/runtime-observability-atomic-postgres.log`，证据 `.tmp/legacy-runtime-pg-COcdXw/evidence.json`。独立随机端口 51405；两独立 DataSource 并发 20 次请求，准确保留 total=20、success=10、error=10、均值=105、sampleCount=20；cache/control 并发各计 4 次。末尾失败不增计，恢复后重试只增加 1 次，均值=110、sampleCount=21；外层回滚不增计。另以 max=2 小池 gate 首个同资产事务，同时提交 20 个调用，验证 pool.waitingCount=0、无关 SELECT 在 gate 保持时仍能及时取得连接；已有外层事务持有 asset 锁且 root 调用正在等待时，绑定 manager 仍可重入、外层回滚后独立调用只计 1 次。夹具自建集群已正常停止（stopped=true）。

上述验证不需要修改安装或构建产物，未触碰现有数据库。真实 Gateway 宽超时前后对照、完整 cohort、采集/投递及关停结果由本轮性能审计统一记录。OBS-16-04 保持 IN_PROGRESS，生产签收继续待办。
