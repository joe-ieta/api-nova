---
doc-version: 1.0.1
doc-status: active
doc-updated: 2026-10-08
---
# OBS-16-04 只读持久化与生产身份投影联合验收

> 历史候选结果保留；最新跨调用批处理和双库测量见[后续验收](2026-10-08-observability-runtime-write-batching.md)，当前剩余按任务状态页执行。

本轮基于 oc_dev / 5f5e2d2，按现有任务划分并行处理数据库持久化、生产调用方投影以及安全依赖。沿用用户确认的本机隔离环境；生产签收仍待办，SEC-F4-02、OBS-16-04 和 OPS-01 的原退出条件不变。

## 实际改动与依赖

- [SQLite 只读事务持久化](2026-10-08-sqljs-readonly-transaction-persistence.md)：完整事务控制与已知隔离设置不再增加持久化 generation；真实写入、未知 SQL、失败重试及调用方等待原保证保留。真实只读事务 fixture 导出16→0，17项磁盘/驱动回归通过，不将局部计数当作整条链路改善比例。
- [生产 caller/source projector](2026-10-08-observability-caller-batch-projection.md)：仅在既有 batchFacts 内为每批最多16条创建独立缓存，来源、调用方、凭据、观察与overflow诊断同事务批量落库。来源上限跨serverType的原计数口径不变，人工名称/备注/标签/版本不被冲突更新覆盖；每条记录仍即时获得sourceId和规范化身份，所有历史版本保留。普通自定义hook仍即时读写，失败后释放缓存并回滚所有事实/checkpoint。
- 安全依赖迁移与上述两条工程线独立；统一安装/构建完成后再固定测量候选，正式测量期间暂停其它测试、构建和安装。签收依赖仍为SEC与OBS并行、OPS最终汇总等待两者，不新增历史细叶。

## 验证口径

生产投影使用真实SQLite和新建随机回环端口PG验证；固定16条同身份fixture投影SQL在SQLite为194→11、PG为193→9，检查表数据和逐记录结果等价、来源cap/overflow、代理信任、认证身份、同调用多版本、duplicate/stale/replay、晚flush/晚facts失败回滚及重试、人工资料保护和通用hook兼容。PG额外覆盖两独立DataSource竞争上限。SQL减少仅限该fixture，不能外推总体吞吐倍数。

测量继续100req/s、30秒、默认正文采集和持久化。沿用已授权宽等待：业务/管理请求180秒，诊断60秒，尾随观察最多300秒，关停180秒。原终态可见3秒、签名投递5秒、查询2秒门槛不变；截止之后的后台排空不回填窗口。新增projector、事实flush和payload租约阶段诊断，计时包含嵌套/排队，不能相加当作独占CPU成本；runner增加projector与coordinator源码/产物hash。

第一候选API构建通过，完整回归 **184 suites / 1924 tests通过**，日志分别为 .tmp/2026-10-08-persistence-projector-build.log 和 .tmp/2026-10-08-persistence-projector-full-api.log。采集/worker/pipeline/outbox联合CJS **66/66**，日志 .tmp/2026-10-08-persistence-projector-pipeline.log。生产投影专项SQLite7组、隔离PG8组全部通过，PG已停止；原批事实等价Jest7/7也通过。持久化17项包含在全量1924项内，不重复相加。

[安全依赖迁移](2026-10-08-security-residual-dependency-migration.md)完成file-type与UUID兼容升级，新4项消费者合同、npm10隔离clean ci、既有解析门禁及server完整回归通过。生产审计剩余10 moderate，均为同一Nest SSE公告的传递节点，0 high/critical；当前无Nest SSE生产入口不表示漏洞已修复。生产签收仍待办。

此前证据保留在[上一候选联合验收](2026-10-08-observability-bulk-pipeline.md)。

## 第一候选：持久化与身份批投影

两次顺序执行、期间无其它测试/构建/安装；34个源码、构建和执行器hash全部相同。均保持默认正文采集和原门槛。下表可见/投递只按固定截止记录；未观察数量不是源丢失数量。

### PostgreSQL

证据`.tmp/obs-16-04-performance-G2MbFR/evidence.json`，日志`.tmp/2026-10-08-persistence-projector-performance-postgres.log`。

| 项目 | 结果 |
| --- | --- |
| 发包 / 响应 | 3000次 / 29.990秒，100.033req/s；3000完整JSON成功，失败0，requestId唯一 |
| 全部请求完成 / 业务p95 | 30.302秒 / 338.088ms |
| 尾随观察 / 截止 | 258.048秒 / 2026-10-08T08:22:51.251Z |
| 终态可见 | 3000/3000，未见0；完整cohortp95 241808ms |
| 普通签名投递 | 3000/3000，未收0；完整cohortp95 242963ms |
| 查询容量 | 3000，partialBacklog=false |
| 明细/列表/汇总p95 | 8.355 / 39.796 / 1474.258ms |
| 源记录 / 序列 / 成功终态 | 15008 / 15008 / 3000 |
| 源缺口/重复/解析失败/producer丢弃/I/O失败/正文省略 | 0 / 0 / 0 / 0 / 0 / 0 |
| 队列条数/字节高水位 | 64 / 664992B |
| API RSS峰值 / 最大采样loop p95 | 1036296192B / 51.839ms |
| 关停与清理 | graceful=true；所有隔离端口关闭=true；PG stopped=true |
| 结论 | measurementComplete=true，thresholdsPassed=false；exit2，原可见/投递目标未通过 |

### SQLite / SQL.js

证据`.tmp/obs-16-04-performance-OzADP7/evidence.json`，日志`.tmp/2026-10-08-persistence-projector-performance-sqlite.log`。

| 项目 | 结果 |
| --- | --- |
| 发包 / 响应 | 3000次 / 30.003秒，99.990req/s；3000完整JSON成功，失败0，requestId唯一 |
| 全部请求完成 / 业务p95 | 194.477秒 / 160964.864ms |
| 尾随观察 / 截止 | 300.611秒 / 2026-10-08T08:33:14.957Z |
| 终态可见 | 407/3000，未见2593；已见子集p95 449596ms |
| 普通签名投递 | 407/3000，未收2593；已收子集p95 445308ms |
| 查询容量 | 2711，partialBacklog=true |
| 明细/列表/汇总p95 | 374.257 / 538.598 / 756.142ms |
| 源记录 / 序列 / 成功终态 | 29364 / 29364 / 3000 |
| 源缺口/重复/解析失败/producer丢弃/I/O失败/正文省略 | 0 / 0 / 0 / 0 / 0 / 0 |
| 队列条数/字节高水位 | 90 / 1187800B |
| API RSS峰值 / 最大采样loop p95 | 880939008B / 297.796ms |
| 关停与清理 | graceful=true；所有隔离端口关闭=true |
| 结论 | measurementComplete=true，thresholdsPassed=false；exit2，原可见/投递目标未通过 |

SQL.js实际导出：负载前199次/323080192B，最终flush采样13798次/292485275648B；本段增加13599次/292162195456B。单次最大94289920B，同步export累计70.438秒。累计字节是重复整库镜像的总量，不是数据库大小或磁盘新增量；采样在正常关停之前。


## 第一候选判断与扫描空等修复

第一候选没有关闭原性能出口。PG相对上一候选S2sskz，可见/投递全体p95从267018/267996ms降至241808/242963ms，但业务p95从49.451升至338.088ms、RSS从755609600升至1036296192B，均保留为本次观察到的回退，不能只列改善项。单次前后比较不隔离依赖、调度及主机波动，不能据此归因于caller批投影。SQLite第一候选完整响应仍成功，但终态/投递479→407，业务p95约142→161秒；虽然导出计数和累计字节减少，仍不能声称整体提速。

新阶段计时把PG caller逐条投影与批flush合计约5.05秒，与采集138.4秒、整批业务加尾随约288秒相比，继续优化caller局部不是主要方向。payload prepare约41.35秒、事实flush约17.48秒、940次writer acquire/release约7.88/16.67秒；这些区间有嵌套和排队，不能相加作独占成本。legacy阶段记录6000次是3000外层+3000绑定事务内层，累计包含大量队列等待，不是6000次业务或独占CPU。高峰仍有大量legacy请求未完成，后续需要跨调用批量持久化。

只读核查还发现明确调度阻断：单热源每有限scan最多两次64条量子；下一turn只读到目录EOF时，本turn processedRecords为0，旧tick即使scan已确认积压也固定睡1秒。15008条约118次scan，静态估算可能多出约117秒空等；该数字不是实测独占耗时。

本轮继续修复[worker](../../packages/api-nova-api/src/modules/call-observability/call-observability.worker.ts)：私有scan进展与EOF一次性hint允许确认积压的下一有限scan立即运行；每轮仍让出事件循环、总128条和文件公平量子保持。半行flag在提前break之前记录，零进展hasMore、半行、错误、隔离或degraded仍退避1秒，避免忙转；不扩大报告协议或提前reconcile。定向Jest2套30/30通过，真实数据库自动timer测试验证128→EOF→32条续读并发现新源，共161条，及最终idle退避。最终统一回归和双库测量记录如下。

EOF修复后再次完成统一API构建及全量 **184 suites / 1932 tests**，联合CJS **67/67**，日志分别为`.tmp/2026-10-08-persistence-projector-eof-build.log`、`.tmp/2026-10-08-persistence-projector-eof-full-api.log`、`.tmp/2026-10-08-persistence-projector-eof-pipeline.log`。最终正式测量以下述冻结候选为准，首候选测量不覆盖成成功。

## 最终候选：确认积压跨EOF立即续扫

两次顺序执行、期间无其它测试/构建/安装；34个源码、构建和执行器hash全部相同。均保持默认正文采集和原门槛。下表可见/投递只按固定截止记录；未观察数量不是源丢失数量。

### PostgreSQL

证据`.tmp/obs-16-04-performance-7qKxYf/evidence.json`，日志`.tmp/2026-10-08-persistence-projector-eof-performance-postgres.log`。

| 项目 | 结果 |
| --- | --- |
| 发包 / 响应 | 3000次 / 29.990秒，100.034req/s；3000完整JSON成功，失败0，requestId唯一 |
| 全部请求完成 / 业务p95 | 30.011秒 / 65.167ms |
| 尾随观察 / 截止 | 166.511秒 / 2026-10-08T08:43:18.407Z |
| 终态可见 | 3000/3000，未见0；完整cohortp95 155517ms |
| 普通签名投递 | 3000/3000，未收0；完整cohortp95 156383ms |
| 查询容量 | 3000，partialBacklog=false |
| 明细/列表/汇总p95 | 10.357 / 43.138 / 1439.299ms |
| 源记录 / 序列 / 成功终态 | 15008 / 15008 / 3000 |
| 源缺口/重复/解析失败/producer丢弃/I/O失败/正文省略 | 0 / 0 / 0 / 0 / 0 / 0 |
| 队列条数/字节高水位 | 53 / 455978B |
| API RSS峰值 / 最大采样loop p95 | 968589312B / 52.593ms |
| 关停与清理 | graceful=true；所有隔离端口关闭=true；PG stopped=true |
| 结论 | measurementComplete=true，thresholdsPassed=false；exit2，原可见/投递目标未通过 |

### SQLite / SQL.js

证据`.tmp/obs-16-04-performance-7zKmJO/evidence.json`，日志`.tmp/2026-10-08-persistence-projector-eof-performance-sqlite.log`。

| 项目 | 结果 |
| --- | --- |
| 发包 / 响应 | 3000次 / 29.998秒，100.008req/s；3000完整JSON成功，失败0，requestId唯一 |
| 全部请求完成 / 业务p95 | 182.297秒 / 147960.441ms |
| 尾随观察 / 截止 | 300.166秒 / 2026-10-08T08:52:37.106Z |
| 终态可见 | 517/3000，未见2483；已见子集p95 431041ms |
| 普通签名投递 | 517/3000，未收2483；已收子集p95 426518ms |
| 查询容量 | 2497，partialBacklog=true |
| 明细/列表/汇总p95 | 505.481 / 723.214 / 841.419ms |
| 源记录 / 序列 / 成功终态 | 28931 / 28931 / 3000 |
| 源缺口/重复/解析失败/producer丢弃/I/O失败/正文省略 | 0 / 0 / 0 / 0 / 0 / 0 |
| 队列条数/字节高水位 | 49 / 585994B |
| API RSS峰值 / 最大采样loop p95 | 947138560B / 322.175ms |
| 关停与清理 | graceful=true；所有隔离端口关闭=true |
| 结论 | measurementComplete=true，thresholdsPassed=false；exit2，原可见/投递目标未通过 |

SQL.js实际导出：负载前199次/323080192B，最终flush采样14079次/292607049728B；本段增加13880次/292283969536B。单次最大94486528B，同步export累计75.307秒。累计字节是重复整库镜像的总量，不是数据库大小或磁盘新增量；采样在正常关停之前。


## 最终判断与后续执行

本轮实质交付四项：只读事务不再冗余导出、生产身份批投影、确认积压跨EOF立即续扫且异常退避、file-type/UUID兼容迁移。统一API184套/1932项与联合CJS67/67通过；最后两库34个产物hash相同，3000完整JSON响应、源记录无缺口/丢弃及正常关停全部完成。

PG完整终态/投递和完整容量查询继续通过限定验收。全体可见/投递p95从前轮267018/267996ms，经首候选241808/242963ms，降至最终155517/156383ms。相比首候选，整体请求加尾随从约288秒降至197秒，但ingestBatch自身均值147→170ms、总量138→160秒，说明减少固定空等后数据库竞争仍在；不能把整体改善归成每条SQL都更快。最终业务p95为65.167ms，低于首候选338.088ms，但仍高于前轮49.451ms；最终PG RSS约969MB，高于前轮约756MB。汇总查询p95约1439ms，仍通过2秒，却高于前轮235ms。这些回退和波动均保留，未宣称全部指标改善。

SQLite最终可见/投递517/3000（首候选407、前轮479），仍有2483个成功调用在截止时未观察到对应终态/投递；不能把2497条含未完成记录的查询容量当作3000完整终态验收。业务p95约148秒，较首候选161秒下降，但仍高于前轮142秒。实际累计导出约292.6GB，单库最大镜像约94.5MB；只读冗余去除后，真实写入仍造成约398秒累计driver.save区间和75秒同步export，二者嵌套、不能相加。源成功终态3000完整存在，不能将观察窗口积压写成源丢失。

后续按[任务划分](../guides/active-work-package-breakdown.md)推进有界多调用legacy指标事务与SQL合并，减少实际提交而非只读控制；随后据证据处理共享事务通道、正文准备和持久化调度。PG最终caller投影+flush约5.39秒，继续在此处微调难以关闭整体缺口。任何SQL.js进一步提交合并必须保留每调用等待自身generation持久化、事务隔离和失败重试，不能只把文件I/O等待移出owner就宣称group commit。

原3秒可见/5秒首次投递仍失败，两次最终测量均measurementComplete=true、thresholdsPassed=false、exit2。参考4核/8GiB硬件、等价Gateway/upstream采集A/B、Linux和生产签收仍待。SEC-F4-02继续处理Nest SSE框架公告及目标签收；OBS-16-04保持IN_PROGRESS，OPS-01保持WAIT_DEP。历史209项仍204 DONE/2 IN_PROGRESS/1 WAIT_DEP/2 DEFERRED，不新增细叶或用局部优化关闭父包。
