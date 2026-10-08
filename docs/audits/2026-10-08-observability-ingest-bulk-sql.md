---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-08
---
# OBS-16-04 采集事实批量 SQL

本轮承接 `5a9f227` 的性能缺口：业务请求完成后，源记录进入终态投影仍然落后。改动把原有 16 条事务批次中的重复查询及逐实体保存改为有界预取、内存逐版本推进和批量 SQL；不减少源事实、版本、事件或持久化要求。该专项通过不代表 3,000 请求端到端可见及投递门槛已通过，正式双库结果由主验收记录维护。

## 实现和兼容合同

[store](../../packages/api-nova-api/src/modules/call-observability/call-observability.store.ts) 的 `ingestBatch` 增加显式 `batchFacts` 选项。生产 worker 经 collector 为已核验的 `CallObservabilityCallersProjector.project` 开启；普通调用和任意自定义投影 hook 默认仍走原来的即时数据库读写路径。

启用批模式的 hook 只能根据传入的 before/after 操作 caller/source 表，不能依赖尚未 flush 的核心 receipt、invocation、revision、payload、checkpoint、event 数据库行。实际生产 hook 的全表结果已有新旧路径等价测试，不能据此把其他 hook 自动归为安全。

在原有全局 counter 锁及事务内，按最多 16 条有效源记录预取 receipt、receipt tombstone、当前 invocation、已有 payload 和 checkpoint/boundary。PostgreSQL 仍锁当前 invocation 行。payload 预取包含当前引用和本批准备出的全部 ID，防止数据库已有孤立对象的原期限被新的 PreparedPayload 覆盖。

事务内逐条保留原有 source conflict、identity conflict、terminal mutation、duplicate/stale、quarantine、source sequence gap 和 checkpoint 链式校验。当前投影、receipt、payload 和 checkpoint 的事务局部映射反映此前本批记录；没有跨批常驻事实缓存。

flush 时批量插入 receipt、payload、全部 invocation revision 及事件，对最终 current invocation、contribution、boundary、checkpoint 和合并后的 bucket marker 做分块 upsert。SQL 每块至多 16 行，避免宽表参数数目突破 SQLite 限制。同批中间 revision 单独保留，并写入精确的 `validUntilSequence`；只有批前已存在的 revision 需要单独关闭历史区间。checkpoint 最后写入，事实、事件、桶 marker 和 counter 仍在同一个原有事务内，任何后续失败均回滚。

每批最多暂存 16 个 receipt/current/revision/contribution/checkpoint、32 个新 payload、32 个内置事件；已有 payload 预取最多 64 个 ID，桶 marker 沿用最多 512 个/类型的上限。调用方继续等待原事务持久提交，autoSave 保持开启；租约取得、每条写入 fence 检查和释放流程没有省略。

同文件中的有界 bucket 重算选择由 worker 子任务提供：显式 budget 时两种桶共享总预算并轮流分配余数，游标轮转和最多 128 项短期失败退避仅为调度提示，持久 pending marker 仍是工作依据。默认无参调用保持原全量行为；该部分验证由 worker 调度专项记录负责。

## 专项验证

[SQL.js 专项](../../packages/api-nova-api/src/modules/call-observability/call-observability-ingest-bulk.spec.ts) 7/7 通过，日志 `.tmp/ingest-bulk-tests.log`：

- 16 个独立终态、链式 checkpoint 和桶 marker：实际数据库 SQL 由 1,475 次降至 163 次，约减少 89%。这是固定 fixture 的查询计数，不是生产吞吐承诺，也不含真实 caller hook 的成本。
- autoSave 仍为原有 4 次持久化，重新打开数据库可读取全部已提交 revision。
- 已有历史加同批多个新版本，保留每个版本、精确关闭历史区间及原 payload 期限。
- 同批 duplicate、stale、source conflict、坏 schema 邻居不破坏有效记录及 checkpoint 推进。
- 最终 checkpoint SQL 注入失败后，已批量写入事实及即时 hook 写入一起回滚，重试恰好应用一次。
- 已存在孤立 payload 的原期限在后续版本中保持。
- 实际生产 callers.project 新旧路径全部相关表等价；任意 hook 默认路径仍可查询此前已写事实。

既有 `call-observability-ingest-batch.spec.ts` 7/7 通过，覆盖原有 lease 丢失、GC 排斥、恢复、隔离和 bucket suppression 语义。

[独立 PostgreSQL 专项](../../packages/api-nova-api/scripts/test-call-observability-ingest-bulk-postgres.cjs) 3/3 通过，证据 `.tmp/ingest-bulk-pg-XiDu1q/evidence.json`，日志 `.tmp/ingest-bulk-pg.log`。自建随机端口 59658 的临时集群，fsync/synchronous_commit 开启，两个独立 DataSource：

- 同时导入同一批 16 条记录，恰好 16 个 receipt/revision，另一实例收到 duplicate；历史区间连续。
- 跨实例更新已有历史，再在同批提交多个版本，区间边界正确。
- 完整事实 flush 后注入失败，事务回滚；另一实例重试没有重复事实。

集群已正常停止，`stopped: true`。本脚本不访问现有开发数据库，不继承默认 PostgreSQL 目标。

## 尚待整体验收

主任务统一构建和完整回归后，顺序执行 PostgreSQL、SQL.js 的 3,000 请求正式负载，检查全体成功终态的可见/投递延迟、源记录零缺口、内存及优雅关停。本轮没有提高验收预算，也不根据专项 SQL 减少比例推断整体达标。

## 派生桶读取资源上限补充

首次集成 PostgreSQL 正式测量 `vaF8xS` 暴露派生桶重算造成调度退化，不能依据上述 SQL 专项就宣告整体完成。worker 子任务调整持续积压时的重算预算及冷却；本补充仅限制单个桶的读取资源。

`loadBucketInvocations` 与现有 `MAX_METRIC_OBSERVATIONS=5000` 对齐，SQL 最多读取 5,001 个 revision 作为超限哨兵。超过 5,000 后在 `loadSources` 前抛出与计算内核相同的 `QUERY_TOO_LARGE/observations`，沿用既有 pending marker、失败计数和退避；没有把截断样本发布成完整统计。它限制结果集分配及来源扩展，不承诺数据库扫描成本恒定，也没有解决超大桶的完整聚合能力。

新增 `call-observability-bucket-resource-limit.spec.ts` 1/1 通过（`.tmp/bucket-resource-limit-tests.log`）：直接在真实 SQL.js 事务中批插 5,002 个 revision，两类桶读取 SQL 均含 `LIMIT 5001`，未调用来源扩展、两个 marker 保持 pending、失败计数为 2、无统计事件；删除至 5,000 条后边界读取成功。正式双库验收仍由主任务复验。

最终统一验收已完成：API构建、184套/1918项与联合CJS66/66通过。同候选PG3000/3000终态可见/投递，SQLite479/3000，原时延目标仍未达；详见[本轮联合测量与剩余出口](2026-10-08-observability-bulk-pipeline.md)。两库3000完整响应、源无缺口、正常关停。
