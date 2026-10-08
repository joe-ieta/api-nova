---
doc-version: 1.2.0
doc-status: active
doc-updated: 2026-10-08
---
# OBS-16-04 文件续读与桶重算公平调度

本轮保持collector每周期最多128条记录、4MiB读取、32个调度项的默认总预算，以及store每批最多16条事实事务。改动减少目录重复扫描和每文件固定状态读写开销，同时让持续源积压期间的已提交桶标记获得处理机会，不以增大默认总预算代替吞吐整改。

## 文件调度与安全边界

[worker](../../packages/api-nova-api/src/modules/call-observability/call-observability.worker.ts)原来每文件调用collector最多16条，随后清空pendingFile；单大源文件每次目录扫描只能前进16条。本轮把一个文件调度量子改为64条，发现仍有积压时加入有限续读队列，在同一次目录扫描内最多再处理一个量子。目录游标保持打开，不因16条边界重开目录；源持续追加也不会让它无限占据当前扫描，其他目录项仍可前进。队列最多32个文件名，不保留多文件正文缓冲。每周期总128条和4MiB上限继续有效。

[collector](../../packages/api-nova-api/src/modules/call-observability/call-observability.collector.ts)在一个一致只读快照中取得checkpoint、边界、seal与snapshotSeq，消除单独watermark查询及取得写序号锁的需求。仍逐次核对根目录真实路径、文件类型/nlink、打开前后源身份、已提交尾边界及每行读取边界；未缓存掉rotation/truncation/seal验证。这一历史改动当时仍沿用SQL.js驱动持久语义，本身未消除export；后续[只读事务修复](2026-10-08-sqljs-readonly-transaction-persistence.md)另行处理控制语句冗余，真实写入仍持久化。

`batchFacts`仅由生产worker对已核验的callers.project显式启用；直接调用collector默认不启用，任意外部hook不得自动转入事实延后落库模式。store事务批上限保持16，已提交offset仍为重启恢复的唯一依据。中途错误保留当前文件用于重试，证据相关错误继续隔离后续文件，不删除源文件。

未完成长行仍由原单session跨有界读取逐步推进，未新增多文件大正文缓存。当前行在抵达换行或固定打开大小的EOF前会占据pendingFile；本轮不宣称对任意无限长坏源行提供固定时间的跨文件公平保证。无论是否处在这种半行续读，已提交桶仍按下述准入间隔获得维护机会。

## 重算预算与恢复前提

原worker只在完整扫描且没有源积压/半行/隔离记录/错误时调用无界recompute。初版公平调度改为每周期8桶，但正式PG候选`vaF8xS`在3000请求业务阶段约30秒完成后，观察窗内仅可见2332/3000、投递2329/3000，低于上一候选2883/2873；不能把事实批写耗时改善视为能力达标。整桶扫描随事实增长反复执行，是必须消除的调度负担。

修订后，存在源积压或扫描尚未完成时，每次只重算1桶；首次立即准入，后续准入为本次完成时间加`clamp(9 × 本次耗时, 1000ms, 10000ms)`，使用单调时钟，失败也保留退避。worker继续按原预算采集，未到重算时刻只跳过本轮派生维护。10秒上限防止极慢桶结束后派生任务被无限推迟，metric/caller及ID轮转继续有效；单个已开始的数据库事务不可中断，因此不承诺固定CPU占比或严格派生完成期限。干净完整扫描或源目录暂缺时按8桶排空，不等待积压冷却；仅抵达目录EOF但观察到积压不算空闲。

stale-progress/process-exit调用恢复仍严格保留干净完整扫描前提，不因为重算可运行而放宽未知调用推断。中间候选的单桶`loadBucketInvocations`曾无读取条数限制，kernel的5000条上限发生在读取后。后续已将查询结果限制为5001条；检测到超5000时，在加载sources和聚合前明确拒绝，不截断为成功指标。新增真实5002条回归1/1通过。这限制了实体物化量，但不为单桶SQL扫描或事务耗时提供硬上限，大桶分页聚合仍未实现。

store的可选limit为1～128，显式省略时保持原全量修复入口。生产有限模式对metric/caller表按稳定ID游标轮转，两个表公平分享总配额，奇数配额交替；某表不足时剩余配额转给另一表。每表最多读取limit个候选，总执行不超过limit。固定失败行保留pending标记和诊断记录，有限模式退避1秒，内存退避表最多128项，避免坏行一直占住排序前列。游标与退避只是易失调度提示，重启或事务失败不会把它们冒充已完成的持久checkpoint。

## 验证

- 新增[worker公平调度测试](../../packages/api-nova-api/src/modules/call-observability/call-observability-worker-fairness.spec.ts)：单源128条只需两个文件访问、持续增长源不阻止扫描完成、半行保留与桶预算、源缺失时维护、失败续读重试；连同原自动调度测试共2套/18项通过，`.tmp/collector-fairness-jest.log`。
- [真实文件/数据库worker回归](../../packages/api-nova-api/scripts/test-call-observability-worker.cjs)新增160条源记录完整收齐、源未EOF前桶推进、metric/caller均分配额、坏标记退避和保留、原全量修复与参数边界；同候选统一构建后，与collector/pipeline/outbox联合CJS回归合计65/65通过，证据`.tmp/2026-10-08-bulk-pipeline-regression.log`；未重复执行或冒充独立性能结果。
- 修订调度定向Jest共9/9通过，`.tmp/collector-maintenance-cadence-jest.log`：含耗时比例准入、1秒最小间隔、10秒上限、失败退避、空闲8桶绕过和持续积压跳过；真实store单桶metric→caller交替测试已新增，待同候选统一构建回归。上述65/65是初版证据，不冒充修订后的验证。
- collector已有源身份、边界变更、轮转、重启、超长行、无效UTF-8和事务回滚回归继续作为必要验收，不能用调度单测替代。

本次属于OBS-16-04原任务的采集/投影吞吐整改。双数据库完整3000请求、签名投递、原可见性3秒/首次投递5秒门槛及采集额外开销仍以统一性能入口的同候选结果为准，生产签收仍待办。

前轮统一验收已完成：API构建、184套/1918项与联合CJS66/66通过。同候选PG3000/3000终态可见/投递，SQLite479/3000，原时延目标仍未达；详见[本轮联合测量与剩余出口](2026-10-08-observability-bulk-pipeline.md)。两库3000完整响应、源无缺口、正常关停。


## EOF调度空等修复（同一工作包后续候选）

此前自动tick仅根据本turn的processedRecords和scanComplete选择0或1000ms。单热源每次有限扫描处理两次64条后，下一turn仅读到目录EOF；虽然此前扫描已确认文件有积压，此turn的0条/scanComplete仍会触发1秒空等。对于15008条源记录，约118次有限扫描可能造成约117秒额外等待；这是代码路径估算，不能当作正式计时。

修订保留原目录和文件公平量子，仅新增私有调度提示：本scan的真实记录进展跨turn累积，EOF时生成一次性的已知积压续扫信号，并重置扫描计数。下一有限扫描仍会重新发现目录，因此新source也有机会。只有running、无隔离/错误、无半行且无本turn零进展积压时立即继续；空闲、失败、永久hasMore但未处理记录仍退避1秒。本turn半行提示在collector提前break之前记录，修复原scan.partialBytes尚未累计时可能误判可快跑的边界。新turn、新scan及停止分别重置相关状态，不扩展WorkerReport协议。

自动timer和公平性Jest共2套30/30通过，日志`.tmp/worker-eof-scheduling-jest.log`。新增真实数据库自动tick回归使用160条源：128条→目录EOF→再次扫描余32条，并在EOF后加入另一个source验证发现第161条；断言EOF下一timer为0、最终无积压timer为1000。新构建后联合CJS67/67通过（包含该161条自动tick回归），统一API全量184套/1932项通过，见[本轮联合验收](2026-10-08-observability-persistence-and-projector.md)。此前生产caller批投影候选G2MbFR与OzADP7是本EOF修复前的正式结果，必须保留，不能冒充新候选测量。
