---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-15
implementation-status: partial
---
# 可观测性生命周期、引用与墓碑合同

本文件交付 OBS-14-01（DOC），冻结后续生命周期子任务的技术边界。表中的“现状”来自源码；“必须”是后续实现和验收要求，不代表清理已经上线。批准保留目标以[需求 FR-10 与 AC-15/16](../guides/runtime-observability-requirements.md)为准；本文不降低期限、不授权生产清理、不提升父包完成状态。

## 1. 范围和术语

逻辑到期决定读取、发送或重投资格；物理删除是独立动作，允许为了引用安全延后。墓碑是防止重放、重复计数或游标缺口被隐藏的最小持久证据，不是保留原始正文的理由。无有效到期时间、未知所有权、未知引用状态一律保留并报告无法判定，不能当作已回收。

OBS-14-02 已完成的功能是：现有 GC fence 内有界检查过期 payload 元数据，文件确认缺失才修正为 expired；进度与修正同事务、可重建恢复。它不删除事件、投递、receipt、调用或审计，不实施配额。后续子任务复用这条恢复基础，不再次计算为新交付。

## 2. 保留期限与当前实现

| 对象 | 保留起点及期限 | 现状与后续限制 |
| --- | --- | --- |
| 调用当前行及历史修订 | completedAt，否则 startedAt，默认30天 | Store 已写 expiresAt；历史引用/MVCC及聚合修正关系不能由正文GC删除。完整调用/聚合清理不包含在03E/03D内。 |
| 正文对象与其元数据 | 新正文采用写入策略快照，payloadDays默认7天；已存在调用侧保持原expiresAt | 读取按expiresAt或expired状态拒绝；正常GC及02恢复已实现。策略更新不得延长旧对象、重新发布已到期正文或删除仍有效正文。 |
| 分钟聚合；小时/日聚合 | 批准默认分别30天；180天 | 是保留目标，不能由“现存调用少了”推断历史统计应重置。其清理需要单独实现和验收。 |
| 报送事件 | 新事件创建时eventDays，默认14天 | 查询/分发/发送已有到期判断；策略允许不同事件有不同期限，物理清理不能假定过期sequence总是连续前缀。 |
| 投递及尝试历史 | 新delivery创建后30天 | 已独立于事件期限；事件先到期只停止发送/重投，不能提前删除仍在30天内的投递历史。旧记录不自动回填延长；新清理不能据旧短expiresAt将记录删除得早于createdAt+30天。 |
| 导入receipt | 当前创建后32天写入expiresAt | Store查重不以expiresAt过滤。32天不是可直接DELETE的证明；去重和冲突判定证据必须按第4节保留。 |
| 管理命令幂等记录 | 当前成功操作后24小时 | 有效期内相同身份/路径/方法/key复用结果并复核权限，不同请求冲突；到期允许重新执行。不得改成永久禁止key重用。 |
| 本功能管理审计 | 创建后至少30天 | 批准目标不因事件14天或幂等24小时而缩短；06A负责独立有界清理。 |
| 已入库源文件暂存 | 证明完整导入后至少48小时恢复窗口 | 仅是已导入内容的目标。未导入、半行、活动写入或身份不明文件不能按mtime+48小时删除。06T负责落实。 |

期限均使用UTC绝对时间。边界为now达到expiresAt才逻辑到期；存在活跃租约或保留引用时仍不得物理删除。已批准30天审计和投递下限优先于实现中旧数据的较短时间。历史数据不自动延长不是授权提前物理清除。

## 3. 引用与清理顺序

| 持有者 → 被引用者 | 合同 |
| --- | --- |
| invocation/current、invocation/revision → request/response payloadId | 正文TTL独立于调用存续；到期正文可删除文件并保留expired元数据。不能删除或改写调用及修订引用。缺payload元数据但调用/修订仍引用该ID时，现有GC保护磁盘文件，不自行认定为孤儿。 |
| delivery → eventId/eventSequence | event先逻辑到期后仍不可重投。任一未满保留期delivery或在途delivery/attempt租约保护事件的物理存在；已到期事件保留在库不恢复查询/发送资格。 |
| attempt → delivery；delivery → subscription及其revision | 未到期投递保留完整尝试与解释其发送的修订；不可删除父记录后留下无法审计的尝试。先终结/排空租约，再同事务清理符合期限的尝试与delivery。订阅软删除不是清除历史的理由；订阅修订压缩不属于本次03D。 |
| ingest receipt → sourceInstanceId/eventId、recordHash、invocationId | 相同来源事件重复不产生新调用/事件/sequence；相同身份不同hash维持冲突隔离。删调用不应顺带删去重证据。 |
| checkpoint/源边界封印 → 文件身份、已提交byteOffset、源序号 | 仅证明特定文件身份已导入区间，不能替代跨文件或重置后的receipt查重。与业务投影同事务的检查点不得在清理后退回较小位置。 |
| 管理幂等响应 → delivery/subscription/audit结果ID | 有效幂等记录仍须可按原合同返回/授权；不得先删其仍有效结果对象。24小时到期后不保证复用原结果，但管理审计仍保留30天。 |

清理顺序：先判断逻辑到期与租约 → 保留必要墓碑/引用证据 → 同事务删候选及推进持久进度 → 发布真实完成/失败报告。正文unlink无法与数据库原子提交，继续由02补偿；不能用“回滚”宣称文件已恢复。清理事务不得分配新的业务事件序号或重放原调用。诊断可以记录独立运行证据，不能改变业务事件水位含义。

## 4. 导入与命令幂等墓碑

03D必须先实现并测试墓碑读取，再启用receipt物理删除；只有DELETE没有查重门禁不验收。

- 导入墓碑至少保存稳定来源事件身份及原recordHash（可沿用既有不可逆身份键）、冲突判定所需信息、所属数据集/保留边界；不保存正文、凭据或原始请求。重复命中不得分配sequence、写新事件或改变已到期调用状态。冲突命中继续隔离，不把不同内容当成功重放。
- 技术默认：不能证明该来源/数据集已不可重放时，保留最小墓碑，不设置一个会自动放开重导入的新TTL。32天receipt到期、文件mtime变老、调用已删除均不构成这种证明。若尚无墓碑存储/读取实现，保留原receipt即可；不得以磁盘配额为由静默释放去重约束。
- 墓碑最终删除须另行证明数据集/来源退休及所有导入入口拒绝旧身份，且恢复介质不能绕过；本子任务不实现这种退休流程。该安全默认不宣称墓碑容量已受配额控制。
- 不把sourceSequence的最大值当作所有较小事件均已提交的证据；乱序/晚到和冲突仍按原导入规则处理。保留期外输入仍进入原OUTSIDE_METADATA_RETENTION语义，不能通过清理或重导入更新旧TTL。
- 管理幂等记录沿用24小时有效期、身份/范围/请求hash复核与到期重用，不复用上述永久导入墓碑策略。有效记录先保留，过期记录可有界移除；这不删除其30天审计证据。

## 5. 事件游标、分发水位与删除墓碑

当前EventsService通过范围内已到期事件触发EVENT_CURSOR_EXPIRED；直接物理删除会移除这项证据。03E必须同步加入持久删除边界判定，才能启用删除。

- 在删除事务内记录被删除sequence的缺口证据，再删除实体；删除失败、事务回滚时缺口和进度也回滚。采用可合并的sequence区间或等价无漏判结构，不存事件正文；不同TTL造成非连续缺口时不能仅依赖最小存活sequence。
- after签名游标及afterSequence快照桥接落入清理缺口时返回既有EVENT_CURSOR_EXPIRED及安全重建语义，不能返回complete=true的假连续结果。可以保守要求重建，但不得泄漏未授权资产、事件数量或动态范围。首次无游标查询仍按保留事件创建新快照。
- 全局提交sequence只增不减、不复用；固定高水位不因删除缩小。Outbox水位沿用“首个尚未解决且仍可分发事件之前的最高sequence”，不得跨越仍有效pending/leased事件。事件到期使其不再可分发，不表示删除操作发送了事件。
- 活跃事件分发租约、在保留期delivery引用或未排空发送尝试阻止物理删除。清理不能取消租约来获得删除资格，也不能制造新的delivery补洞。
- 删除缺口证据至少覆盖所有仍允许提交的旧游标/afterSequence；在没有明确最早可接受启动水位且所有入口强制检查前，保留可压缩的缺口证据。签名游标过期不能单独证明任意afterSequence不会再次提交。

## 6. 有界执行、租约与失败报告

后续清理复用Store事务和现有payload coordination GC fence，避免与写入/正文清理建立相互独立的删除授权。每批显式有限上限，稳定唯一键排序，持久分页；进度与该项墓碑/删除同事务。对象检查与落库前复验租约。payload GC fence不能单独当作Outbox/发送worker已被互斥的证明：事件及投递的引用/活跃租约复核必须与删除处于同一受锁事务或等价条件写入，和既有claim操作保持互斥；不得先查后无条件删除。数据库失败、文件检查异常、租约失效不得推进未处理项；重启从持久位置继续，扫尾后允许后续新到期记录进入下一轮。

默认不开启新自动清理。各类计数分开：扫描、保留、修复、删除、未知/失败；不能把正文stat样本当成当前总磁盘用量，不能把半批完成推成整轮成功。状态/手动入口复用既有授权与脱敏边界，不允许请求指定任意文件路径或绕过fence。

## 7. 后续子任务的独立退出条件

| 子任务 | 交付范围 | 必须通过的验收 |
| --- | --- | --- |
| OBS-14-03E | 过期事件有界物理清理、删除缺口证据、查询/快照启动水位保护 | 默认关闭；事件与gap墓碑同事务回滚；非连续TTL缺口；旧after/afterSequence明确410；无游标新快照；保留delivery/活跃租约保护；Outbox不越过有效pending；重启/重复清理不复活sequence。 |
| OBS-14-03D | 投递/尝试按30天及引用规则清理；导入receipt去重墓碑及过期管理幂等记录有界清理 | 第29/30天边界；事件先到期仍可查投递且拒绝重投；在途尝试不删除；墓碑后原文件/改名文件重复导入不增调用/事件，hash冲突仍隔离；事务失败进度回滚；24小时管理key到期可按原合同重新执行；审计不被级联删除。 |
| OBS-14-06A | 本功能管理审计至少30天、有界删除和权限审计证据 | 用明确来源/资源分类仅选择本功能记录；无法归属的保留，不能按笼统CONFIG_UPDATED类型删除所有产品审计；30天边界、并发写入、失败/重启恢复、非本功能记录不变；清理自身形成有限管理记录，不逐行触发审计循环。 |
| OBS-14-06T | 当前格式源文件的未导入暂存恢复与已导入暂存清理 | 原collector唯一导入路径；稳定文件身份、完整行与已提交offset复核；活动文件、半行、未导入数据和不明身份不删；已完整导入文件的48小时窗口；轮转/替换/重启有持久进度；checkpoint/receipt防重复；失败不影响业务响应或重发上游。 |

03E/03D不顺带删除invocation、revision、metric bucket或订阅修订；06A不接管全产品安全审计；06T不导入旧schema，不重建第二套collector，不按目录年龄强制清空。02作为共同依赖只复用，不重复验收计数。完整配额、业务存活及跨平台全链路验收仍属于其它子任务。

## 8. 源码与证据核对入口

以下路径已按当前工作区存在性核对；本DOC未执行功能测试，也未证明后续清理代码存在。

- [运行实体与索引](../../packages/api-nova-api/src/database/entities/runtime-call-observability.entity.ts)：payload、invocation/revision、receipt、delivery/attempt、idempotency、pipeline状态。
- [持久事件实体](../../packages/api-nova-api/src/database/entities/runtime-observability-event.entity.ts)：sequence、expiresAt、dispatch租约。
- [Store](../../packages/api-nova-api/src/modules/call-observability/call-observability.store.ts)：receipt先查重/冲突、32天字段、调用30天和正文原TTL、事务sequence。
- [GC与02恢复](../../packages/api-nova-api/src/modules/call-observability/call-observability-garbage.service.ts)、[payload store](../../packages/api-nova-api/src/modules/call-observability/call-observability-payload.store.ts)、[GC协调器](../../packages/api-nova-api/src/modules/call-observability/call-observability-payload.coordinator.ts)：引用保护、缺失修复、文件检查和writer/GC fence。
- [事件查询](../../packages/api-nova-api/src/modules/call-observability/call-observability-events.service.ts)、[Outbox](../../packages/api-nova-api/src/modules/call-observability/call-observability-outbox.service.ts)：当前过期范围判断、sequence分发水位与30天delivery创建。
- [投递管理](../../packages/api-nova-api/src/modules/call-observability/call-observability-deliveries.service.ts)、[发送worker](../../packages/api-nova-api/src/modules/call-observability/call-observability-delivery.worker.ts)：事件失效拒绝重投/发送，投递历史独立保留。
- [命令Store](../../packages/api-nova-api/src/modules/call-observability/call-observability-command.store.ts)：24小时管理幂等与权限复核。
- [collector](../../packages/api-nova-api/src/modules/call-observability/call-observability.collector.ts)、[源身份](../../packages/api-nova-api/src/modules/call-observability/call-observability-source-identity.ts)：文件身份/边界封印、完整行、事务checkpoint。
- [审计服务](../../packages/api-nova-api/src/modules/security/services/audit.service.ts)：复用审计持久化/读取，不据此宣称06A保留清理已经实现。
- [02恢复专项](../../packages/api-nova-api/scripts/test-call-observability-payload-reconciliation.cjs)、[GC专项](../../packages/api-nova-api/scripts/test-call-observability-gc.cjs)、[事件专项](../../packages/api-nova-api/scripts/test-call-observability-events.cjs)：现有边界与后续回归入口；新增墓碑/清理须补专属测试。
