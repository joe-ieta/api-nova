---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-08
---
# OBS-16-04 有界采集入库批处理

本轮承接[双数据库性能测量](2026-10-08-observability-performance.md)发现的逐记录持久化成本，改变采集提交单位，不修改正文策略、读取预算、持久化开关或批准性能门槛。性能是否达标仍以同候选真实业务链路测量为准，本实现及局部测试不构成 OBS-16-04 完成签收。

## 实现与一致性边界

[collector](../../packages/api-nova-api/src/modules/call-observability/call-observability.collector.ts) 将已校验源文件身份、边界和 UTF-8/JSON 的完整行积累为最多 16 条的批。仍遵守既有单轮读取字节预算和单行上限，半行不提交。每条 checkpoint 的 previousOffset 指向上一条完整行；只有数据库批提交成功，内存 committedOffset 才前进。繁忙、正文存储、投影或数据库错误整批回滚，下一轮从持久 checkpoint 重读。

[store](../../packages/api-nova-api/src/modules/call-observability/call-observability.store.ts) 的 ingestBatch 在一个共享 writer lease 下做一次保留策略及既有正文引用快照，正文文件仍在数据库事务外准备；随后 receipts、事实版本、投影、事件和所有 checkpoint 在同一事务提交。序列分配仍受原有数据库 counter 锁保护，单条 ingest 复用一条记录的批并保持即时桶更新语义。GC 仍不能与有效 writer 并行，提交时及各记录仍检查 lease，续期/过期代次机制保持原实现。事务失败后的正文孤儿继续走既有 GC/配额恢复流程，不把文件提前发布等同于事实提交。

同批多版本按顺序读取此前写入，终态冲突、幂等 receipt/tombstone、原始正文期限等检查仍执行。默认一条记录的返回 events 不混入同批其他记录事件。坏 JSON、坏 schema 与有效相邻记录可以一起提交各自 quarantine/事实；存储故障不被当成坏源行消费。

collector 显式启用桶 marker 合并：按 bucketId 保存事务内最新 pending marker，suppressEvent 与既有库内 marker 及批内每次更新做 AND，保留原 version 和最后 dataWatermark，提交前统一保存。当前生产 callers.project 不读取这些 pending marker；其他 ingestBatch 调用默认不启用合并，保留即时读取自己写入的行为。单版本最多涉及两个时间基准、四个间隔、两个 scope；revision 失效集合为前后版本并集，因此单批每类桶缓存上限为 16×32=512 个 ID，不建立跨批全局缓存。

## 已取得的局部验证

新增[真实落盘 SQL.js 回归](../../packages/api-nova-api/src/modules/call-observability/call-observability-ingest-batch.spec.ts)使用 autoSave=true，7 项通过：

- 16 条链式 checkpoint、关闭并重新打开数据库、重放不增加事实版本或事件。
- 第 9 条投影注入失败后，16 条事实、receipt、checkpoint、事件全部回滚，重试成功。
- 坏 JSON、坏 schema 与有效记录混合，仅坏记录进入 quarantine。
- 同 invocation 的 start/finish 同批更新、事件归属及初始正文期限保留。
- 16 条记录共享 acquire/read/commit/release：预热后真实 autoSave 调用由逐条路径的 64 次降至 4 次；持久化开关保持开启。启用正文配额时其预留/结算仍有额外独立事务，本数字不外推该路径。
- 正文准备期间 GC 报 writer_active；实际释放 writer lease 后提交拒绝，事实及 receipt 均不写入。
- 同桶 16 条记录合并与即时模式的 marker、版本、水位、抑制状态完全相同（仅忽略 queuedAt）；SQL 日志验证桶写入减少超过 75%。

连同原有 in-flight delta、生命周期保留、staged source recovery，当前本机 4 套/34 项通过，日志 `.tmp/ingest-batch-final-tests.log`。collector CJS 故障注入入口随生产调用改为 ingestBatch，保持 GC-held 不消费源文件断言；锁文件整合及统一构建后6个CJS入口合计63/63通过：collector14、worker16、restart3、bucket-projection-recovery8、payload quota/publication13、独立PostgreSQL多写者9。日志`.tmp/ingest-final-*.log`；PG使用独立随机端口、fsync/synchronous_commit开启并正常停止。联合性能与限制见[本批证据](2026-10-08-observability-throughput-closure.md)。

## 实际限制与后续出口

上述提交次数与 SQL 日志属于局部机制证据，未量化每阶段占整个业务性能的比例。批内事实和 caller 投影仍执行逐记录 SQL；合并事务会延长一次 counter 锁持有时间，但保持最多 16 条并在批间让出调度。必须用真实 PostgreSQL 与持久化 SQL.js 同候选基准检查查询可见性、投递尾延迟及业务成功率，不能把局部事务数下降直接换算成总体吞吐提升。

OBS-16-04 继续 IN_PROGRESS：源记录完整性、3000 次调用可查询与普通签名投递、原定可见性/首次投递门槛及等价业务路径采集开销 A/B 尚需统一验收。生产签收继续遵守用户的本机隔离范围，保留待办。
