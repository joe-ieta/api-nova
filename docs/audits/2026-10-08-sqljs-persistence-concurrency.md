---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-08
---
# OBS-16-04 SQL.js 并发持久化放大复现与修复

本轮在有界 ingest/outbox 合并之后，真实 SQL.js 负载仍出现高内存与业务超时，因此继续沿同一 OBS-16-04 的完整吞吐出口排查；本修复不单独增加任务包，也不以局部测试代替性能验收。

## 确定性复现

本仓库使用的 TypeORM SQL.js QueryRunner.flush 在 `await driver.autoSave()` 完成后才把 isDirty 清零。SQL.js 使用同一个 runner；DataSource.query/repository 读取结束后的 release 也会调用 flush。一个写入尚在文件 I/O 等待期间，并发读取会重复看到 dirty，分别导出整个库并对同一个文件发起写入。

独立最小夹具只建一个 sample 表：阻塞一次 INSERT 引起的真实 PlatformTools.writeFile，再启动 16 次 SELECT。实际观察到 **17 次 databaseConnection.export、17 路同时在途 writeFile**，并不是 17 个新写事务。证据 `.tmp/sqljs-flush-repro-tc4ofz/evidence.json`，可执行复现也保留在[回归测试](../../packages/api-nova-api/src/database/sqljs-persistence.spec.ts)第一项。由此确认整库缓冲被并发读释放放大的机制；该夹具不把正式负载全部内存或全部耗时归因于这一处，也没有声称已独立复现磁盘旧快照覆盖新快照的数据损失。

## 真实启动暴露的共享事务问题

首次接线后的真实 SQLite 应用启动验收，在并发 Worker 与管理操作运行时，PATCH test-samples 返回 no such savepoint: typeorm_1，证据 .tmp/obs-16-04-performance-NVepcH/api.log。本轮没有忽略该错误、停用 Worker 或依赖重试掩盖。

独立夹具让事务 A 进入 callback 后启动独立事务 B，再同时放行二者 COMMIT。原版 TypeORM 和第一版单在途持久化适配均确定性复现：A 返回成功、B 报 savepoint 不存在，最终表为空。证据 .tmp/sqljs-txn-race-fx6oA5/evidence.json 和 .tmp/sqljs-txn-race-GVKH8V/evidence.json；因此共享 runner 误把独立操作视为嵌套事务是原有正确性缺陷，不能只串行事务控制 SQL 以消除报错。

最终适配增加实例级 AsyncLocalStorage 操作串行通道：EntityManager.transaction 及 save/remove/softRemove/recover 的整个操作周期持有 owner；新建 manager 与已有 manager 均接线。普通 runner.query 也进入该通道，外部语句不得加入另一个操作的事务。只有上下文 token 等于当前仍活跃 owner 才能重入，旧 detached 异步回调不能借继承 token 绕过排队。同一操作内合法的顺序嵌套事务仍使用 TypeORM savepoint，并支持该 callback 内根 repository 调用。

范围限当前项目运行时入口：检索到的生产手工 QueryRunner 事务只用于 PostgreSQL 分支，SQL.js 分支使用现有独立只读导出。未新增任意手工 QueryRunner 跨请求事务、同 owner 下并行启动多个嵌套事务、或 SQL.js 多进程写入协议；不能将本适配宣传为这些能力。

## 项目接线与持久化约束

新增 [createApplicationDataSource](../../packages/api-nova-api/src/database/sqljs-persistence.ts)，只对 `type=sqljs && autoSave=true` 的 DataSource 实例安装适配，不修改 node_modules 或全局 TypeORM 原型。覆盖[Nest DataSource 工厂](../../packages/api-nova-api/src/database/database.module.ts)及[CLI/迁移 AppDataSource](../../packages/api-nova-api/src/database/data-source.ts)，在 initialize 创建 runner 之前接线。PostgreSQL 与明确 autoSave=false 的数据源保持原实现。

- 每次成功的非 SELECT query 推进 generation，沿用驱动保守 dirty 分类；事务控制语句也纳入。
- 最多一条 save 在途。一次快照捕获自己的 generation，文件写入结束只确认该 generation 持久化。保存期间产生的新 dirty 不会被旧 flush 清掉。
- 每个 flush 等待自己的目标 generation；已覆盖的调用及时返回，不等待持续后续写入形成的无限尾流。并发只读 release 加入已有写入等待，不重复导出同一份库。
- 存在活动事务时不导出 SQL.js（导出可能结束事务）。新外层事务 BEGIN 前检查未被快照捕获的旧 committed generation，必要时先完成持久化，避免“B 已 COMMIT 等落盘，C 抢 BEGIN，B 因 active guard 提前返回”。已有嵌套事务沿用驱动协议；本适配不新增 SQL.js 多进程写入或任意并发事务隔离能力。
- 文件保存失败向受影响等待者传播，保留 dirty，后续调用可以重试；不把失败吞成成功，不关闭 autoSave，不改变同步提交等待文件写入的口径。

持久化仍采用 TypeORM 的既有导出与 writeFile，未额外声称 fsync、原子替换或断电恢复保证。本修复限制同时在途的导出/写入数量，并未取消每次实际提交所需的整库导出成本。

## 验证及签收边界

真实 SQL.js、autoSave=true、真实文件写入配合确定性 gate，**11/11 项通过**，日志 `.tmp/sqljs-persistence-tests.log`：

1. 原版 1 写 + 16 读产生 17 路导出/文件写入。
2. 修复后相同并发只产生 1 路；写入和读释放都等待该次文件写入，重开数据库可读到记录。
3. 旧快照保存期间产生新事务提交，新提交等待第二次快照落盘；第一调用在第二次仍阻塞时即可返回。
4. 旧保存期间打开的活动事务不被导出提前结束；随后 COMMIT 才保存其结果。
5. 文件写入失败传播给全部当前等待者；保留 dirty，重试成功后重开可见完整数据。
6. autoSave=false 的数据源没有安装此适配，也不产生文件写入。
7. 第三事务不能越过尚未捕获的第二次提交；第二次提交返回时独立重开文件已含该记录，第三次事务随后 rollback 不被隐式提交。

8. 独立事务 A 成功、B 失败回滚，A 的持久结果保留且 B 不提前进入 A 的事务。
9. 同一 owner 顺序嵌套事务回滚只撤销内层记录，外层及 callback 内根 repository 操作保持有效。
10. 外部 repository.save 及普通查询等待另一个事务完成，不读取或持久化其未提交结果。
11. 已结束事务创建的 detached 异步回调，在另一个 owner 活跃时必须重新排队。

第一版 7 项测试没有覆盖独立事务争用，因此真实启动失败后增加上述 4 项，不能把此前单测通过等同于真实应用通过。接线后的应用构建、相关数据层回归及真实双数据库同候选负载由整合阶段记录。OBS-16-04 仍需满足原可见性、签名投递、完整 cohort 与采集额外开销指标；生产签收保持待办。
## 最终 SQLite 负载失败及下一主线

最终真实负载证据 `.tmp/obs-16-04-performance-xD5q4A/evidence.json` 仍不通过：3000 次请求仅 1255 次成功，查询超时，gracefulShutdown=false。源记录 16502/16502、零序列缺口、零 drop，API RSS 峰值约 667 MB（此前问题轮峰值约 11.42 GB），说明已取得的源完整性和内存改善不能替代业务、采集、投递吞吐签收。

静态核对及现有时间曲线更支持持续排队饱和，当前没有证据将其判为 owner lane 死锁：源记录停止增长后，约第 100、121、142、183 秒，store.transaction 已完成数仍由 116 增至 117、118、119；同时 event-loop utilization 约 0.87～0.95。该现象不能完全排除未覆盖的排队问题，但不应将单条事务长等待直接称为锁死。现有阶段计时包含排队时间，不能把 transaction 的 110 秒最大值解释为该事务 SQL 本身执行 110 秒；该轮实际投影阶段均值约 2.68 ms，正文 prepare 均值约 1.15 ms。

更需处理的是同一 Gateway 调用仍有旧 runtime 路径与新 OBS 路径重复持久化：

- [RuntimeObservabilityService.recordGatewayRequestResult](../../packages/api-nova-api/src/modules/runtime-observability/services/runtime-observability.service.ts) 第 54 行入口，第 73 行组执行 5 个指标 find/save，第 132 行组执行 2 个状态 find/save；具体实现位于第 664、696、748 行，状态保存位于第 823 行。
- [GatewaySecurityService](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-security.service.ts) 第 133 行每次认证等待 lastUsedAt UPDATE，第 134 行异步启动 API_KEY_USED 审计，审计最终由 [AuditService](../../packages/api-nova-api/src/modules/security/services/audit.service.ts) 第 49 行 repository.save 持久化。
- 普通转发完成后 [GatewayRuntimeService](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-runtime.service.ts) 第 150、161 行继续等待旧指标及访问日志；[GatewayAccessLogService](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-access-log.service.ts) 第 75 行另做一次 save。

因此静态完整路径包含至少 10 个独立数据库写入动作/调用，尚未计入新 call-observability 事实、事件、投递。3000 次完整执行对应约 30000 个写入动作量级；这不是本轮实际 SQL/writeFile 计数，不能直接等同于 30000 次 export，也没有独立量化各动作在总耗时中的占比。该轮数据库文件约 6 MiB，SQL.js 持久化整库导出的成本与这些重复写入叠加，值得先于继续调整 collector 的 16 条批上限解决。

下一首要能力步骤是在原 OBS-16-04 内合并旧 runtime 指标/状态/访问日志与新 OBS 的重复持久化责任，采用有界批量或从持久事实投影的兼容读取；保留认证实时校验、撤销语义及审计完整性，不以停止采集或关闭持久化换吞吐。同时补 SQL lane 队列深度、等待/持有时间、实际 export/write 次数与耗时，确认真正的瓶颈。指标原有 find→修改→save 分离，也应在该步骤用原子聚合或同事务投影避免并发覆盖计数。

可以交付本批通过确定性正确性验证的修复，但必须连同上述真实负载失败及明确吞吐阻断一起交付；OBS-16-04 继续 IN_PROGRESS，不能标记 SQLite 或生产性能签收通过。

最终候选验证：API重新构建通过；正式负载结束后全量API **180套/1894项全部通过**（157.544s），日志`.tmp/2026-10-08-final-owner-api-tests.log`；实际消费者依赖门禁通过，日志`.tmp/2026-10-08-final-parser-gate.log`。两条最终负载证据中的全部26个源码/构建/lock/诊断hash一致；回归通过不改变SQLite正式查询/关停失败及PG观测吞吐未达结论。
