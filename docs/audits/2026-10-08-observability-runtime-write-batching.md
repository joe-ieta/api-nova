---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-08
---
# OBS-16-04 跨调用指标批量持久化验收

本轮基于 `oc_dev / 1c2c58c`，继续既有任务划分中的结构性整改。OBS 与 SEC 安全补丁并行实现；固定共同候选后顺序测量两库。用户选择本机隔离环境，生产签收继续待办；本记录不新增历史子任务，也不改变父包原退出条件。

## 实现合同与边界

同一 DataSource、同一 asset 的相邻 request-result 进入共享 FIFO，每批最多16条；空闲首项最多等待2ms，已有积压继续执行。cache/control 写入作为顺序屏障，已绑定外部事务的 manager 与当前 SQL.js 写入 owner 的重入即时执行，避免等待自己持有的连接或锁。owner 检查同时比较当前 ALS token 与活动 owner，事务外调用和已过期 token 不能旁路。PG 每批仍使用既有 asset advisory transaction lock，多个 DataSource 竞争相同 asset 时也不会丢失更新。

批内引用读取、指标/状态查找复用及末尾分块写入同时减少 SQL 与事务次数；不是仅将16次旧 save 套入一个事务。逐条递推计数、均值和最后状态，每次失败仍有独立事件。使用真实 row.id 共享已读对象，保留既有 membership、NULL/undefined 查询与分钟窗口语义；未新增 natural-key 约束或修改历史 scope 归属。状态更新时间使用数据库时钟，创建时间保留。

所有同批调用等待共同事务完成后再返回。提交前读取/写入失败或 COMMIT 发出前故障时整批拒绝并回滚，后继任务继续；没有自动重试。SQL.js 内存 COMMIT 后若文件持久化失败，整批调用仍拒绝，但内存可能已经提交，此时不能承诺回滚或安全地盲重试。该边界沿用既有持久化合同，并在真实文件失败测试中单列。

16是单批事务上限，不是全局等待队列容量；本轮不改变业务丢弃或背压语义。诊断增加实际批次执行、引用预取、批 flush 阶段，执行器锁定 write-lane 源码与构建 hash；外层与 scoped 计时及嵌套阶段不能相加当作独占 CPU 时间。

## 验证记录

真实16调用fixture与逐条绑定manager即时路径对比：SQLite SQL478→26、export16→1、commit16→1；PG SQL448→24、commit16→1。均检查完整计数、递推均值、真实membership/endpoint引用、最后状态及每次失败事件；局部SQL减少不能外推整体吞吐倍数。

独立子进程禁用owner旁路时复现外层rollback错误带走外部调用数据（`.tmp/runtime-multi-batch-owner-disabled.log`，未回退或修改共享源码）；修复后真实SQL.js场景通过。最终SQLite **13/13**（`.tmp/runtime-batch-sqlite-KDGuFW/evidence.json`）、新PG **11/11**（`.tmp/runtime-batch-pg-BhE85h/evidence.json`）、既有PG **6/6**（`.tmp/legacy-runtime-pg-kKVD91/evidence.json`）通过；两个PG均已停止。验证包含两实例共享FIFO精确16/16/1分组、过期detached ALS token不能冒充新owner、cache/control屏障、跨分钟/成员、晚SQL故障、提交前故障、后继批继续、外层rollback和真实文件重开。SQL.js提交后文件失败另证实16个Promise拒绝、内存16条/磁盘0条，不作全回滚承诺。

最终API构建通过，完整回归 **184 suites / 1932 tests**（181.029秒，`.tmp/2026-10-08-runtime-batch-full-api.log`）；采集/worker/pipeline/outbox联合CJS **67/67**（`.tmp/2026-10-08-runtime-batch-pipeline.log`）。旧atomic Jest7项仍在全量中，引用夹具改为真实metadata/seed。IPC诊断检查通过，新三个批阶段存在。正式双库测量见下文。

此前基线为[只读持久化与身份投影联合验收](2026-10-08-observability-persistence-and-projector.md)：PG 完整3000调用可见/投递p95 155.5/156.4秒；SQLite截止时均517/3000，业务p95 148.0秒。原可见3秒、签名投递5秒、查询2秒门槛不变；宽等待只用于收集完整失败证据。

## 正式同候选双库测量

顺序执行，期间无其它安装、构建、测试或产品代码变化；36个执行器、源码、构建产物及锁文件hash全部相同。100req/s、30秒、默认正文采集与autoSave保持；请求/管理180秒、诊断60秒、尾随观察最多300秒、关停180秒。原可见3秒、首次签名投递5秒、查询2秒门槛未降低。

### PostgreSQL

证据`.tmp/obs-16-04-performance-v4fsJJ/evidence.json`；日志`.tmp/2026-10-08-runtime-batch-performance-postgres.log`。

| 项目 | 结果 |
| --- | --- |
| 发包 / 响应 | 3000次 / 29.990秒，100.032req/s；3000完整JSON成功、失败0、requestId唯一 |
| 全部请求完成 / 业务p95 | 30.014秒 / 69.811ms |
| 尾随观察 / 截止 | 158.140秒 / 2026-10-08T09:25:38.358Z |
| 终态可见 | 3000/3000，未见0；完整cohortp95 148157ms |
| 普通签名投递 | 3000/3000，未收0；完整cohortp95 149942ms |
| 查询容量 | 3000，partialBacklog=false |
| 明细/列表/汇总p95 | 10.343 / 46.398 / 1182.055ms |
| 源记录 / 成功终态 | 15008 / 3000 |
| 源缺口/重复/解析失败/producer丢弃/I/O失败/正文省略 | 0 / 0 / 0 / 0 / 0 / 0 |
| 队列条数/字节高水位 | 38 / 335158B |
| API RSS峰值 / 最大采样loop p95 | 713977856B / 46.629ms |
| 关停与清理 | graceful=true；全部隔离端口关闭=true；PG stopped=true |
| 结论 | measurementComplete=true，thresholdsPassed=false；exit2，原可见/投递目标未通过 |

### SQLite / SQL.js

证据`.tmp/obs-16-04-performance-1oRfa5/evidence.json`；日志`.tmp/2026-10-08-runtime-batch-performance-sqlite.log`。

| 项目 | 结果 |
| --- | --- |
| 发包 / 响应 | 3000次 / 29.994秒，100.021req/s；3000完整JSON成功、失败0、requestId唯一 |
| 全部请求完成 / 业务p95 | 57.145秒 / 28891.713ms |
| 尾随观察 / 截止 | 300.351秒 / 2026-10-08T09:33:08.315Z |
| 终态可见 | 818/3000，未见2182；已见子集p95 317343ms |
| 普通签名投递 | 671/3000，未收2329；已收子集p95 324277ms |
| 查询容量 | 1992，partialBacklog=true |
| 明细/列表/汇总p95 | 455.290 / 548.247 / 730.206ms |
| 源记录 / 成功终态 | 16846 / 3000 |
| 源缺口/重复/解析失败/producer丢弃/I/O失败/正文省略 | 0 / 0 / 0 / 0 / 0 / 0 |
| 队列条数/字节高水位 | 385 / 5088776B |
| API RSS峰值 / 最大采样loop p95 | 914825216B / 239.993ms |
| 关停与清理 | graceful=true；全部隔离端口关闭=true |
| 结论 | measurementComplete=true，thresholdsPassed=false；exit2，原可见/投递目标未通过 |

SQL.js负载前导出212次/352321536B，最终flush采样10672次/279858753536B；增加10460次/279506432000B，单次最大100192256B，同步export累计61.237秒。累计字节是重复整库镜像总量，不是数据库大小。采样时后台工作仍在进行，正常关停后的排空不回填固定截止。

## 结论、限制与下一能力步骤

1. 旧指标批量持久化按合同完成：实际3000请求在PG形成576个request批，SQLite形成200个request批；另各有1个控制事务。PG旧指标外层加scoped的6000次阶段均值从前轮16768.6ms降到39.7ms，RSS峰值从968589312B降到713977856B；6000不是额外业务调用数。SQLite全部业务完成182.3→57.1秒，业务p95 148.0→28.9秒，导出总计14079→10672次。
2. 端到端尚未闭合：PG全体可见/投递155.5/156.4→148.2/149.9秒，仍远超目标；业务p95从65.2ms小幅回退至69.8ms，如实保留。SQLite可见818、投递671，不得将317.3/324.3秒的子集p95作为全体；其查询容量1992含未完成记录，不代表3000终态容量通过。SQLite观察总时长也因业务较快完成而缩短，不能用单一数量推导吞吐倍数。
3. 已不应继续只优化旧指标或caller：PG941次ingestBatch平均163.8ms，Store写事务11104次、readSnapshot2816次；正文prepare累计43.7秒、事实flush19.3秒，writer acquire/release分别9.9/18.8秒。SQLite376个已完成ingestBatch平均794.5ms，writer acquire/release分别69.1/76.8秒，Store写事务3751次、SQL.js save10669次，表明跨入口持久化竞争仍在。阶段计时包含排队/嵌套，不可相加成为CPU归因。
4. 下一并行线A：合并采集批次的租约取得/保留视图读取及成功提交后的释放，减少重复协调事务与同事务重复租约读取；仍保留GC fencing、代际/过期检查、正文准备在DB事务外、失败释放与事实/checkpoint原子性。
5. 下一并行线B：投递批量领取与完成持久化，有限并发外发，减少逐条claim/complete事务；仍逐条记录attempt，发送前鉴权/撤销/到期检查、租约与replay generation隔离、重试/死信/停止恢复必须保持。两线实现与专项独立，合并后固定候选再顺序双库测量。
6. SQL.js整库导出仍是实质剩余问题；若上述事务减量后仍阻断，需单独验证可持久确认的有界group commit或数据库适配路径，不以关闭autoSave、提前resolve或延长尾随观察替代。原参考硬件、等价Gateway/upstream采集A/B、Linux与生产目标签收继续待办。

SEC并行完成[官方SSE补丁回移](2026-10-08-security-nest-sse-backport.md)，实际安装/打包目录合同通过，版本范围审计仍10 moderate；SEC整体保留IN_PROGRESS。OBS-16-04仍IN_PROGRESS，OPS-01仍WAIT_DEP；209条历史叶子数量不变。
