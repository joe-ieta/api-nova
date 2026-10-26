---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-08
---
# OBS-16-04 采集与投递限定验收及时间诊断

本轮基于 `oc_dev / da15e67`，完成采集协调和投递两条并行实现。按用户2026-10-08明确要求，未关闭事项的时间目标不再作为任务不能关闭的硬条件。可见3秒、签名投递5秒、查询2秒和等价采集A/B开销目标保留诊断；不把本机耗时归因为已证实的环境问题，也不将未测量写成达标。生产签收按既有选择保留待办。

## 实现与失败合同

采集侧将writer租约取得与保留视图读取合并，成功提交同时释放writer。正文I/O仍在数据库事务外；每次访问检查租约期限，最终在同事务重新读取owner/generation/expiry。提交前等待心跳停止，避免已释放租约被排队续约复活。成功只有在持久事务返回后确认；失败清理不自动重试业务写入。16次writer断言的真实fixture由4次事务/3次SQLite导出降为2次事务/2次导出，SQL47→22。

投递侧每波最多4条：批量领取，事务外DNS准备及逐项授权，读取快照复验，然后最多4个HTTP并发，批量完成并保存逐项attempt。claim使用唯一token和精确lease/replay/attempt等字段隔离旧worker。暂停、停机和租约剩余不足会恢复待发状态，不消耗尝试次数。实际HTTP起止逐项记录，绝对截止不因持续小片响应重置。8条任务fixture中SQLite SQL320→71、COMMIT32→7、导出24→5；PG SQL296→65。

保留两项真实边界：SQL.js内存COMMIT后文件保存失败仍拒绝调用，但不能宣称回滚或盲重试安全；HTTP发送后完成事务失败，恢复可能重复外发，语义为至少一次。专项显式验证这些失败，没有以减少持久化或正文采集换取结果。

## 功能验证

- 采集SQLite10组、PG9组：`.tmp/prepared-writer-sqlite-Rbrzba/evidence.json`、`.tmp/prepared-writer-pg-rXzbut/evidence.json`。包含跨协调器GC竞争、最终fence篡改、正文期限收窄、外层回滚和提交后失败。
- 投递两库各12组：`.tmp/delivery-batch-sqlite-9WKJ7Z/evidence.json`、`.tmp/delivery-batch-pg-IX0FnE/evidence.json`。包含真实签名HTTP、双worker、部分失败、DNS期间撤销/到期、暂停/停机、旧租约/重放及真实重开恢复。所有隔离PG已停止。
- API构建与全量186套/1940项通过；流水线及配额/保留/恢复CJS114项通过；本地统计/查询/正文/故障94项通过，重启专项修正后3项通过。验收策略4项、管理会话真实HTTP5项及IPC诊断检查通过。
- 重启旧断言最初失败：源扫描完成后仍有24个派生桶待算，下个进程完成8个桶，合法水位16→25。fixture改为通过真实worker排空派生桶后建立幂等基线；仍严格验证重复采集前后水位、全部事件、调用和pending不变，未修改产品。证据 `.tmp/restart-watermark-diagnosis.log` 与 `.tmp/restart-quiescent-regression.log`。

可复用专项入口（各脚本默认SQLite，加`--postgres`使用自有隔离PG）：

`node packages/api-nova-api/scripts/test-call-observability-prepared-writer.cjs`

`node packages/api-nova-api/scripts/test-call-observability-delivery-batch.cjs`

策略与会话：`node --test scripts/test-obs-acceptance-policy.cjs scripts/test-obs-management-session.cjs`。

## 统一候选验收规则

`node scripts/verify-obs-16-04-performance.cjs --postgres --relaxed-timeouts` 与无`--postgres`的SQLite运行顺序执行。产品、构建产物、锁和执行器在两次运行间冻结；测量期间不运行其它构建或测试。

默认时间目标仅作诊断，`--enforce-timing-gates`可显式恢复严格benchmark判定。`thresholdsPassed`仍表示严格时间及功能共同通过，不把慢结果改称达标；`functionalAcceptancePassed`和`acceptancePassed`用于新口径。该3000次压力运行若要标为全量通过，证据必须为100req/s计划、30秒、3000次（实际发包节奏仍诊断），小规模smoke不算完整验收。观察保护上限默认1200秒，可有界配置到1800秒；到期仍未完整则功能证据不充分，不会以部分样本通过。

硬条件包括：全部合法成功响应和唯一requestId、3000终态可见、3000普通签名投递、完整查询容量、20次详情/列表/汇总内容检查、源序列无缺口/重复/解析失败、producer无丢弃/失败/遗漏且已排空、API退出码0且无signal、全部自有端口关闭和自有PG停止。查询验证详情对应调用和终态、列表属于本cohort且不重复、汇总成功数及分母均一致。

## 首次长观察的测试会话中断

SQLite运行`efya9d`在15分钟管理JWT到期后连续401，HTTP可见记录停在2078；此后受可见集合约束的投递计数也停在2078，但关停前接收端累计收到2562条有效签名记录。3000个业务响应均成功，3000条源终态完整，17399条源序列无缺口/重复/解析失败，producer丢弃、失败和正文遗漏均0；API正常退出、自有端口关闭。该次执行最终因管理查询401退出1，不算完整验收，不能从2078条子集推断全体延迟。

本轮修复的是测试脚本的正常管理会话续期：到期前60秒通过原登录接口重新认证，并发只发起一次登录；GET遇401最多重登录重试一次，变更请求不自动重放，所有新令牌进入日志脱敏集合。真实HTTP5项覆盖上述行为、登录失败恢复和取消请求。保持产品令牌期限与验证规则不变；不通过放宽鉴权实现长观察。PostgreSQL先前完整通过结果仍有效，核对未变产品候选后复用；SQLite以支持续期的执行器复跑，单次设置`OBS_PERF_TAIL_SECONDS=1800`以收集完整性；PG保留默认1200秒观察上限。原失败证据保留，不覆盖或改写为成功。

## 最终结果与关闭口径

PG的3000次响应、终态可见、签名投递与完整容量查询通过。SQLite的3000次响应和源终态完整；30分钟内观察到1799条终态、1615条对应投递，完整查询检查未通过。关停后磁盘复核1943条已完成、1057条待采集，1617条投递成功、246条待发，无隔离/失败/死信，数据库完整性正常。SQLite大样本不标全量通过；此项列为非阻断诊断，不因本机耗时再次开启优化轮次。

| 项目 | PostgreSQL zA2lwK | SQLite I2Wl1H |
| --- | --- | --- |
| 业务合法成功/源终态 | 3000/3000，源15008条完整 | 3000/3000，源20047条完整 |
| 观察到终态/对应签名投递 | 3000/3000、3000/3000 | 1799/3000、1615/3000 |
| 可见/投递p95（仅诊断） | 116.1/117.1秒，全体 | 1796.1/1691.4秒，仅子集；分别1201/1385未观察 |
| 业务p95（仅诊断） | 241.5ms | 44327.2ms |
| 详情/列表/汇总 | 各20次内容通过；p95 7.8/46.5/1504.8ms | 完整检查未通过：详情仍running；不能当作全容量通过 |
| 运行验收 | 功能true，严格时间目标false，退出0 | 功能false，退出1；不覆盖为成功 |
| 清理与源完整 | exit0/no signal、全部端口关闭、PG停止；源无缺口/重复/解析失败 | exit0/no signal、全部端口关闭；源无缺口/重复/解析失败，pollErrors为空 |

SQLite关停后以Python sqlite3 mode=ro复核：quick_check=ok；3000条持久调用中1943 finished/success、1057 progress；投递1617 succeeded、246 pending，均无lastError，无dead/retry/failed；quarantine=0。最后一次collector报告有源文件积压、errors为空。这说明尚有待消费工作，不等于剩余调用已完成；不把源完整性自动换算成投影/投递完成。证据：`.tmp/obs-16-04-performance-I2Wl1H/durable-backlog-review.json`。

两次36个共享产品、构建、策略等文件hash一致。SQLite执行器增加会话续期（38个候选文件），与提交前文件核对一致；未假称执行器hash与PG完全相同。原始证据：`.tmp/obs-16-04-performance-zA2lwK/evidence.json`与`.tmp/obs-16-04-performance-I2Wl1H/evidence.json`。SQLite累计导出约780.7GB为诊断计数，不据单机结果宣称提速或达标。

**A/B工程及限定功能专项关闭，转回归维护；C大样本运行保持上述不完整记录，按用户要求不作为继续开发/反复优化的硬门禁。** 原OBS-16-04仍IN_PROGRESS，保留实际目标账户/开关/平台、容量与回退签收；OPS不能据此宣称生产可用。

## 状态与后续边界

本机工程及限定功能专项已完成；SQLite大样本完整性未证实，原始运行不标通过。此项作为非阻断诊断，不继续反复优化。原OBS-16-04为部署ENV任务，运行账户、有效开关、目标平台与回退签收仍按原合同保留；生产选择未变。此后不因本机3/5/2秒或未测采集开销自动追加优化任务，转向OPS的浏览器主流程和统一部署验收。

本轮附带只读磁盘核对：C盘Used=97,534,246,912、Free=9,223,413,760字节，约91.36%已用；距既有90%健康阈值约差1.35GiB。OPS完整health复核前需人工释放至少2GiB并留余量。本轮未重跑完整health，也不据此断言SQLite耗时由磁盘容量造成。
