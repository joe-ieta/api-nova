---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-08
---
# OBS-16-04 SQL.js 只读事务持久化减负

本轮在 `5f5e2d2` 的 SQL.js 持久化适配器上，消除只读事务及已知控制语句造成的冗余整库导出。ALS 事务独占、generation 持久提交栅栏和 single-flight 保存流程保持原结构；不关闭 autoSave、不推迟真实提交、不减少审计数据。本专项不代表 SQLite 正式吞吐门槛通过。

## 根因与实现

本机安装的 TypeORM `SqljsQueryRunner.query` 将除原有大写 SELECT 分类外的成功语句全部标为 dirty，包括 `BEGIN TRANSACTION`、`COMMIT`、savepoint 控制和隔离设置 `PRAGMA read_uncommitted = false`。此前项目适配器也按相同分类增加 generation。因此，即使事务只读，外层 commit 仍然导出整库并写入磁盘。驱动的 `autoSave` 导出时会结束活动事务，原有“活动事务中不能导出”的限制仍须严格保留。

[适配器](../../packages/api-nova-api/src/database/sqljs-persistence.ts) 增加保守的非持久语句识别：保留驱动原有 SELECT 分类，额外允许完整事务控制语句和 `read_uncommitted` 的布尔/0/1 设置。控制语句必须整句匹配，带未知尾部、注释或多语句文本的输入保守视为写；其他 PRAGMA（例如 `user_version`）、DDL、DML、WITH 及未知 SQL 仍然增加 generation。没有将全部 PRAGMA 归为只读。

每个成功 query 返回后，根据当前 generation 与在途快照 generation（若没有在途保存则使用 durableGeneration）重新计算 dirty。不能简单恢复 query 前的 dirty 标记：await 期间旧保存可能完成或失败，重入订阅者也可能写入新 generation。该计算既不让已捕获的旧 generation 因只读控制重新变脏，也不会清掉未捕获的新写入或失败待重试数据。

flush 继续让只读 release/commit 加入在途保存；调用方只要自己的 target 已持久化即可返回，不能无限等待后续流量。真实写入在原事务 commit 前后保持原有等待保证，已有第三个 BEGIN 栅栏和 ALS owner 校验没有放松。只读事务不增加 generation；包含写入的事务即使最终 rollback，仍保守保留 generation 并执行原有保存，不额外优化回滚路径。

## 真实驱动和磁盘验证

[专项测试](../../packages/api-nova-api/src/database/sqljs-persistence.spec.ts) 共 **17/17 通过**，日志 `.tmp/sqljs-readonly-persistence-tests.log`。原有 11 项 single-flight、事务隔离、嵌套 rollback、存储失败重试和旧 ALS token 防旁路回归全部保留；新增 6 项覆盖：

- 同一真实磁盘 fixture 上，16 次 SERIALIZABLE 只读事务：原生 TypeORM 驱动 **16 次 export**，优化后 **0 次 export**，重开磁盘数据一致。该结果是只读事务专项计数，不是整体负载比例。
- 只读嵌套 savepoint、nested rollback 和 outer rollback 均不导出；随后 PRAGMA user_version、CREATE INDEX 和 WITH INSERT 分别持久化，独立重开数据库可验证版本、索引和记录。
- 已捕获的真实写正在写盘时，只读事务仍等待同一 flight；完成后再读不触发第二次导出。
- 写盘失败后的只读事务在 BEGIN 前重试旧 dirty generation，等待磁盘完成后才进入并提交。
- 写盘恰好在异步 isolation 控制语句等待期间失败；控制语句恢复后不清除失败 dirty，commit 等待重试完成，磁盘包含真实写入，最大并发保存仍为 1。
- 带注释和多语句后缀的 PRAGMA 不因匹配干净前缀而被豁免，仍保守导出。

上述真实 driver/export/writeFile 路径保持 autoSave=true；门控测试验证调用方返回时机和独立磁盘重开结果。非持久 autoSave=false 数据源仍完全绕过适配器。

## 局限和后续验收

这里只消除已识别的只读控制冗余。未知只读 SQL、带注释的控制语句及多数 PRAGMA 仍可能保守导出；没有引入 SQL 解析器或尝试识别所有数据库语法。实际写后 rollback 也可能保守保存。`durableGeneration` 继续表示驱动原有 writeFile 完成，不新增 fsync 或原子重命名保证。

既有支持边界不变：生产通过 manager 事务及顺序嵌套 savepoint 使用共享 SQL.js runner；不新增手工跨调用事务所有权或同 owner 并行嵌套事务支持。连接内部原生数据库对象的直接写入不属于新增识别合同。

统一API构建及全量184套/1932项、联合CJS67/67通过；真实写入的整库导出、内存、请求与终态可见/投递结果见[本轮联合验收](2026-10-08-observability-persistence-and-projector.md)，不能用这16次只读事务的计数替代端到端签收。
