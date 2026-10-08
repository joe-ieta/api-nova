---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-08
---
# OBS-16-04 caller/source 事务内批投影

基线`5f5e2d2`的PG已能在延长观察窗中收齐3000个终态，但可见性p95约267秒，不能视为原3秒目标完成。本轮针对生产`callers.project`在每条外部调用上重复查询与保存同一source、caller、credential和observation的开销；不修改业务认证、不扩大采集批预算，也不调整原性能门槛。端到端结果由主任务统一测量，本文件先记录能力改动与独立数据库证据。

## 实现及一致性

[生产投影](../../packages/api-nova-api/src/modules/call-observability/call-observability-callers.projector.ts)保留原`project`即时执行入口，新增可选`createBatch()`。只有[store](../../packages/api-nova-api/src/modules/call-observability/call-observability.store.ts)显式`batchFacts`入口才创建批对象，且在准备记录闭包之前选定实际hook。默认调用和没有该factory的任意自定义hook仍逐条立即写入，读取前序写入的行为保持有效。

每个批对象只服务一个写事务、最多16条投影调用。首次遇到身份时读取数据库，后续相同主键从该批缓存读取；每个source cap维度只执行首次count，逐条将新source计入批内数量。四类投影实体按主键合并最终firstSeenAt/lastSeenAt，在同一个事实事务结束前批量upsert；overflow诊断也在该事务合并累加。`after.sourceId`及`after.record`在每条hook调用时立即赋值，因此中间revision、桶计划和最终事件保留各自的身份结果。任何SQL或后续checkpoint失败都会回滚整个事务；store在成功、准备失败或事务失败后统一dispose，清空缓存并拒绝跨事务复用。

源身份HMAC、可信代理判定、匿名/认证失败处理、origin/span过滤和key rotation配置读取保持原算法。source cap继续按asset/authState/day计数，不因source ID包含serverType就偷偷增加该维度；overflow行同样计入总数。相同invocation试图更换或删除caller仍由原身份冲突门拒绝，批hook不会使隔离记录生成新的来源或凭证。

caller人工displayName、note、labels、version的管理入口本来就进入同一store序号锁事务。批量冲突更新额外只允许identitySource、firstSeenAt和lastSeenAt，避免把预读的人工字段写回旧值；新caller仍按原字段初始化。PG多实例仍以数据库counter行锁串行处理source cap与时间边界，没有新增进程外缓存或后台补写。

## 验证证据

专属[真实数据库脚本](../../packages/api-nova-api/scripts/test-call-observability-caller-batch.cjs)直接加载当前源码：

- SQLite：`node packages/api-nova-api/scripts/test-call-observability-caller-batch.cjs`，7组通过，证据`.tmp/caller-batch-sqlite-zWPpK4/evidence.json`，日志`.tmp/caller-batch-sqlite.log`。
- 隔离PostgreSQL：同命令加`--postgres`，8组通过，证据`.tmp/caller-batch-pg-gnvJev/evidence.json`，日志`.tmp/caller-batch-postgres.log`。夹具创建独立回环地址集群，启用fsync与同步提交，不继承应用数据库目标；测试完成后集群已停止。
- 原有bulk事实Jest专项7/7通过，`.tmp/caller-batch-existing-bulk-jest.log`，包含实际生产hook在所有核心及caller/source表上的即时/批模式等价、revision链、孤立payload期限、失败回滚和默认自定义hook行为。

16条同身份记录的投影SQL语句数：

| 数据库 | 即时模式 | 批模式 |
| --- | ---: | ---: |
| SQLite / SQL.js | 194 | 11 |
| PostgreSQL | 193 | 9 |

上述只统计涉及四类投影表的语句，不计成HTTP或完整采集吞吐提升。两个模式的实体内容及逐条sourceId/record结果完全比对；还覆盖跨serverType上限、overflow新调用与已有revision计数、空asset及跨日、可信/不可信代理、匿名及认证失败、内部与upstream排除、同调用多revision/重复/过时/冲突/重放、晚投影flush及晚事实flush失败后的全回滚与新批重试、人工字段在flush前变动不被覆盖，以及批对象16条/单事务边界。PG另用两个独立DataSource并发投影，验证source普通名额与overflow计数、caller时间范围及人工资料无丢失。

## 本轮范围与待验收

批缓存有界且仅存在于事务生命周期；全不同身份时仍需要每个新主键的首次查询，并未宣称一次全量预取消除全部读取。事实序号锁、payload协调、桶重算及outbox尚有各自成本，不能根据局部SQL数量推导端到端3秒/5秒目标已达。本轮保留既有文件公平轮转和忙时单桶/1～10秒冷却、空闲8桶策略。主任务已完成全量API 184套/1932项和联合CJS 66/66回归，同候选PG/SQLite正式负载仍待主任务补录；生产签收继续待办。
