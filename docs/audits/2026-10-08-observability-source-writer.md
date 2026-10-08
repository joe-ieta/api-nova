---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-08
---
# OBS-16-04 源审计合并写与失败诊断

本次关闭源 writer 的逐记录小写放大问题，并提供可区分失败原因和队列峰值的诊断。[上一轮双数据库测量](2026-10-08-observability-performance.md)存在 sourceSequence 缺口，只有统一警告，无法区分排队上限、内存预算和真实 I/O 失败。本次不宣称整个 OBS-16-04 性能验收完成；采集、事实投影、事件和投递仍须完整链路验证。

## 写入行为和边界

[源 writer](../../packages/api-nova-parser/src/audit/runtime-call-audit.ts)用一个异步 pump 处理有界队列；只合并连续写往相同日期、目录和进程文件的记录。每批目标至多128条和256KiB（包含 caller 观察数据），单条超过256KiB时独立成批，仍受共享内存预算约束。日期/目录变更不会跨文件合并，也不会重排。首批在下一事件循环开始，随后每批异步 I/O 期间自然聚合新记录，没有固定等待窗口。

入队时即把 calls 与 caller 观察序列化成UTF-8 Buffer，后续调用方修改原对象不会污染 caller 证据。每批 calls 完成后才 append 对应 caller 行；调用返回的 Promise 与 flush 都等待该批的 caller 结果。calls 失败时不写对应 caller。目录初始化和 source manifest 发布在 calls 写前执行，相同目录成功后缓存；I/O失败使缓存失效，后续批次可重新初始化。source manifest 失败仍按原 fail-open 合同保留 calls，并记录独立失败、下批重试，不将 manifest 成功伪造为前提已经满足。

**原护栏保留：**4096条待写、默认128MiB共享采集/写入预算、原正文上限。预算包含待写UTF-8 Buffer、批次拼接 Buffer 及 caller 行，按两倍UTF-8字节预留；不再长期保存待写JavaScript字符串。未增大队列或内存、关闭正文、关闭持久化或改变业务 fail-open 行为。`flushRuntimeAudit` 排空已接收写入，并处理完成回调继续入队的记录；它不是 `fsync`，本次与原 `appendFile` 保持同一持久化等级，不声称断电零损失。

## 失败可观测性

`getRuntimeAuditHealth()`保留原字段，新增：

| 字段 | 含义 |
| --- | --- |
| queueDroppedRecords / budgetDroppedRecords / serializationDroppedRecords | 入队前分别因4096上限、共享预算、序列化失败而拒绝的记录数；三者构成 droppedRecords 的分类 |
| ioFailedRecords | calls批次I/O未能确认成功的记录数；写失败可能已经落下部分前缀，所以不是精确丢失数 |
| callerWriteFailures | calls成功但caller批次I/O未能确认成功的观察数，独立于 ioFailedRecords |
| writtenBatches / appendOperations | 成功calls批次数、尝试的calls及caller append次数 |
| pendingWritesHighWater / pendingWriteBytesHighWater / captureMemoryBytesHighWater | 进程生命周期内待写条数、待写预算、采集预算各自峰值；不是三者同时峰值 |
| currentSourceSequence | producer已分配的末尾序列，可配合最终flush核对文件末尾缺口 |

原 writeFailures 以涉及记录数量累加calls和caller I/O失败；writtenRecords只累计确认成功的calls append。manifest失败仍独立记录sourceManifestFailures。警告保留原`RUNTIME_AUDIT_WRITE_FAILED`标记，并增加不含用户数据的reason和records。每次失败批只警告一次，不把警告行数冒充失败记录数。

append返回错误时，不自动重放整个批次：操作可能已写入未知前缀，盲目重试可能制造重复记录或半行拼接。健康计数保留该不确定性，后续新批可继续写；人工或collector应根据文件事实判断已落盘部分。此策略保留原fail-open行为，并未实现失败批持久重试队列。

## 验证和独立机制基准

[writer回归](../../packages/api-nova-parser/src/audit/runtime-audit-writer.test.ts)新增11项，包含真实文件3000条顺序及caller快照、manifest先于数据、128条/256KiB边界、单大记录、4096队列边界、预算/序列化原因、注入部分append后不重放及恢复、真实caller文件冲突、manifest冲突恢复、flush期间链式入队、A→B→A目录切换，以及目录消失后的失败与重新创建。

- `npm run test --workspace api-nova-parser -- --runInBand audit`：11套/210项通过，含原有HTTP审计、上游尝试、凭据和合同回归；证据`.tmp/2026-10-08-writer-audit-tests.log`。
- `npm run build --workspace api-nova-parser`：通过，证据`.tmp/2026-10-08-writer-build.log`。
- 独立新旧writer机制基准：`.tmp/writer-benchmark-20261008/before.json`、`after.json`和对应真实source文件。旧版由本轮起点HEAD源码转译；新版使用当前parser构建。同一Node v24.15.0，顺序执行，每轮突发3000条带4024B正文的已认证finished记录，并写3000条caller观察；calls文件均13,748,358字节。

| 观察项 | 旧writer | 新writer |
| --- | --- | --- |
| 完整排空时间 | 2344.10ms | 266.07ms |
| calls / caller | 3000 / 3000 | 3000 / 3000 |
| 顺序、drop、I/O失败 | 全顺序、0、0 | 全顺序、0、0 |
| 成功calls批 / append次数 | 原实现逐条；旧health未提供计数 | 54 / 108 |
| 队列高水位 / 待写预算峰值 | 旧health未提供 | 3000条 / 28,028,502字节 |

该基准在开发活动期间执行，只证明合并写机制能减少小I/O开销，不是安静窗口下的正式性能结论。它直接调用writer，不经过Gateway、采集和投递，也不分配producer序列（因此health currentSourceSequence为0）；顺序校验使用夹具显式sourceSequence。不得将266ms外推为100请求/秒完整链路、额外p95开销、SSD或参考机验收通过。

下一步由统一性能入口采样源health及API进程资源，执行最终flush并核对完整序列；联合采集事务优化重跑SQLite/PG的3000业务调用完整可见和普通签名投递门槛。原OBS-16-04保持IN_PROGRESS，生产签收仍待办。
