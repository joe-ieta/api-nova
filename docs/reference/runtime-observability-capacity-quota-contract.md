---
doc-version: 1.9.0
doc-status: active
doc-updated: 2026-09-21
implementation-status: partial
---
# 可观测性容量计量、配额与降级合同

本文件交付 OBS-14-04（DOC），冻结 OBS-14-05 的完整代码与验收边界。05A预算原语和05B默认关闭的发布门禁已有局部实现；05C恢复对账与05D整体状态/策略仍未闭合，不能宣称配额完整启用。本合同不授权任何物理删除，当前实现证据见第10节。

规范依据：[需求 FR-04/FR-10、AC-15/16](../guides/runtime-observability-requirements.md)、[设计](runtime-observability-design.md)、[生命周期合同](runtime-observability-lifecycle-contract.md)。已批准的调用/投递/管理审计30天、正文默认7天、事件默认14天等保留目标不因配额工作而下调。OBS-14-02的缺失正文元数据修复和已完成容量样本仅作为依赖复用，不重复计入新成果。

## 1. 现有证据与不得推导的结论

现有 `pipeline.retention.scanUsage` 来自同一次正文GC目录/stat扫描。`observedBytes` 是该批识别到的正文及临时文件的逻辑长度，测量发生在清理前；`scanCoverage` 区分complete/partial/unknown，`freshnessStatus` 使用扫描完成时间。失败批次不复用上一批容量样本。

- `complete` 只表示该次扫描满足既定覆盖条件，不表示文件系统瞬时原子快照。各批可能重复访问文件，不能累计成当前总量。
- `currentTotalBytes` 和 `filesystemAvailableBytes` 当前为null，`quotaEnforced`为false。未知值不是0，`hasMore=false`不是容量已完整测得或GC已全部完成。
- 配额账本、逻辑文件长度、文件系统实际分配量、挂载点可用空间是四种不同量；不得互换、相减后声称得到精确剩余容量。
- 本实例路由注册和管理心跳不证明磁盘可写、额度充足或业务健康。状态更新时间不刷新旧容量证据。

## 2. 计量对象与统计边界

| 口径 | 单位与计量方式 | 覆盖/限制 |
| --- | --- | --- |
| 扫描样本 | byte，已识别路径的stat.size | 沿用现有字段及语义，清理前单批样本。未知文件、缺目录、变化、截断继续显式标记；不升级为配额总量。 |
| 正文逻辑预算 | byte，受管正文根目录内每个最终文件路径与临时路径的逻辑长度，加尚未落盘的预留预算 | OBS-14-05第一阶段的强制配额对象。同一最终对象只收一次最终文件额度；临时路径占用单独收取，即使hard link暂时共享inode也按路径保守记账。该预算不声称等于物理占用。 |
| 文件系统分配量 | byte，平台可支持的分配块等观测 | 单列可选观测；稀疏文件、压缩、hard link和平台差异须说明。不支持或无法可靠去重时为unknown，不从stat.size伪造。 |
| 挂载点可用空间 | byte，操作系统空间观测，带时间与挂载范围 | 是同盘所有应用竞争后的瞬时信息，不是ApiNova独占余额。不同磁盘的正文目录与数据库必须分别观察，不能合并为一个空闲量。 |
| 数据库/源文件暂存/内存队列 | 各自独立预算与观测 | 数据库包含调用、聚合、事件、delivery、receipt、墓碑及审计；源JSONL和正文缓存另有计量边界。首阶段正文配额不覆盖这些对象，不对外声称“全平台配额”。 |

字节单位固定为byte，KiB/MiB仅用于显示。预算配置与账本运算使用安全整数或经过界限校验的整数运算，溢出必须拒绝并公开未知/故障状态，不能截断或变负数。原始传输字节、解压后字节、脱敏后UTF-8存储字节各沿用其测量阶段，正文存储预算以实际待写内容的UTF-8长度计算。

租户/资产分摊不是第一阶段的强制配额。全局共享预算在同一受管正文存储域执行；权限较窄的调用者不得因余额、剩余对象数或拒绝详情推断其它资产用量。全局容量管理只向已有全局管理/读取权限交集开放，资产用户仅看到其调用正文的省略原因。

## 3. 配置与低/高水位技术默认

本节定义完整配额合同；Q/H/L账本和默认关闭的发布门禁已有05A/05B局部实现，物理余量、恢复与对外状态仍待05C/05D。强制配额默认关闭；启用时必须显式给定正文逻辑上限Q，不猜测主机磁盘大小自动设限。Q须为正安全整数，且至少容纳两倍当前单正文最大存储长度；已有正文上限仍默认16MiB、最多64MiB。较低预算可选择更低正文上限，但不得自动改变已记录正文。

- 逻辑高水位H默认为90%×Q，低水位L默认为80%×Q；配置须满足0<L<H<Q，取整规则固定向下取整。
- 逻辑承诺量C = 已确认路径长度 + 所有未结算预留。C与Q比较执行硬边界；任何新预留后C不得超过Q。达到H进入正文受限状态，停止接纳新的正文写入；已获得预算的在途操作可以完成，不因状态变化擅自释放其额度。
- 恢复接纳须C<=L，账本完整有效、没有未解决异常，且物理空间检查满足恢复门槛。高低水位差用于避免每写一个文件就反复启停。
- 正文卷物理安全余量R技术默认256MiB，可显式调整为正安全整数；可用空间<=R立即停止新增正文。恢复要求可用空间>R+两倍当前单正文上限，且仍满足逻辑低水位。
- 物理空间证据有效期技术默认15秒；启用配额但物理空间未知/陈旧，或预算账本未初始化/不一致时，省略新的可选正文并保留诊断，不把它当成充足空间。关闭配额时不添加新的阻断条件，沿用现有有界采集行为。

只读空间检查无法阻止其它程序占用同一磁盘，因此上述余量不保证永不ENOSPC；实际文件写入错误必须继续按第5节处理。调整Q/H/L/R应受权、版本化、可审计，不能由请求直接指定存储路径。降低Q至当前占用以下只进入受限状态，不同步删除旧数据，不缩短投递或管理审计保留期。

## 4. 并发预留、文件发布与账本

第一阶段强制配额必须覆盖同一存储域的所有正文写入者，不能仅在单进程内存中限额。复用既有存储owner/generation与writer/GC协调，预留与结算使用数据库原子事务/条件更新和唯一操作ID；不在业务请求线程遍历目录，不通过另一套无锁计数器估算余额。

1. 先验证正文上限、内容状态与策略，再计算存储长度B。发布可能同时持有最终路径与临时路径，无法提前证明复用时保守预留2B；零长度正文不因缺文件被误报失败。
2. 在持久原子事务中检查账本epoch/版本、额度及水位，创建唯一预留；重复操作ID不能重复加额度。未获预算即不写临时文件。
3. 复用现有临时文件写入、同步、不可覆盖hard-link发布与摘要一致性检查。不能为省额度覆盖已有证据，不能以请求重试生成另一份逻辑正文。
4. 文件发布成功后，最终路径确认计费一次；临时路径确认消失后才释放对应额度。复用既有最终路径时也要先确认临时路径收尾；不能把“finally尝试unlink”当成实际已删除。
5. 数据库提交失败、进程退出或发布结果不确定时，保留预留/保守占用并进入待对账状态。租约到期只表示需要检查，不能直接释放额度；孤立文件或残留临时文件可能仍在磁盘。
6. 删除额度只在已有且另行授权的生命周期清理实际确认文件消失后释放；发现文件本就缺失可有界修正账本。配额模块自身不获得物理删除权，也不自动调用等待授权的事件清理。

硬上限用于逻辑预算，不保证物理分配量严格小于Q。Q/H/L的计算必须使用同一预算口径；不得一边对hard link按路径收费、一边从额度中按inode去重释放。所有余额变化必须能通过操作ID、generation及结果复核，诊断不公开文件路径或ID明细。

## 5. 拒绝与降级顺序

| 触发 | 行为 | 必须保留的语义 |
| --- | --- | --- |
| 单正文超限/采集内存预算不足 | 按既有契约省略该正文，释放缓存 | 不改成静默截取前几KB；空正文、未读取、超限、容量不足和错误分开。已测业务字节不得改成0。 |
| 正文逻辑高水位/预留失败/物理余量不足 | 停止新增可选正文，记录容量省略原因，继续有界元数据记录 | 不拒绝原业务调用，不重复调用上游，不改已有成功/失败业务结果。 |
| 账本未知、DB不可用、空间观测失效或文件写失败 | 配额启用时不继续无预算写正文；保留有限元数据/健康证据，状态degraded | 不能声称正文captured或余额可用；元数据通道本身失败时记录有限降级/缺口，不无界排队。 |
| JSONL/采集队列/数据库也达自身界限 | 沿既有有界队列与失败通道降级，暂停无法保证安全的新增观测工作 | 业务继续；不悄悄删除未导入暂存、不清空receipt墓碑，不把未知丢失量写成精确0。 |
| 容量压力缓解 | 对账有效、低水位与物理恢复条件同时满足后恢复新正文 | 不重抓旧正文、不重放业务、不复活expired；恢复只作用于之后的新采集。 |

“业务继续”是可观测性故障不改变业务结果；“拒绝正文”是可选证据的局部拒绝，不是绕过业务权限或凭据校验。具体API reason枚举在05实现时与Parser/DTO统一登记：必须区分quota不足、证据未知和真实存储错误，不把拟新增枚举写成今天已支持的响应。

## 6. 初始化、重启和对账

现有scanUsage不能初始化精确预算。05必须提供独立的账本有效性证明：受管owner/generation明确；所有写入路径已经受预算门禁控制；盘点覆盖完整且与期间的写入/清理有一致性边界。可以复用现有scanner的有界遍历接缝，但不能重复累加滚动样本或另开业务线程全盘扫描。

初始化/恢复期间默认停止新增正文预算，保留业务与有限元数据路径。每批有显式上限和持久进度，重启不重复计费；缺目录只有在所有权与盘点边界已证明时才可判空，不能把现有partial样本改名为complete。未知文件、路径替换、账本溢出、存储域变化均阻止发布ready余额，并返回未知/不完整状态。

重启后恢复预留及账本epoch，对未完成操作逐项检查：文件存在仍计费、确认不存在才能释放、错误继续保守持有。到期正文元数据修复由OBS-14-02处理，配额对账只消费其实际文件状态，不重复清理调用/事件。不同卷、owner或generation的余额不得混用；不得仅依赖mtime或旧进程的内存缓存。

## 7. 状态与授权合同

后续新增的配额状态应与scanUsage并列：配置是否启用、计量对象、预算上限、已确认/预留额度、账本epoch及观察时间、是否完整、状态disabled/initializing/ready/limited/degraded、有限静态原因。未初始化或不一致的当前余额返回null，不保留旧数字冒充当前值。

`quotaEnforced`只有在明确范围内所有写入都经过门禁、账本有效且配置启用时才可声明；尚在恢复时明确报告“已配置但未就绪/正文受限”。不要改变现有scanUsage.quotaEnforced=false的历史样本含义来冒充新全局能力；新增合同字段与Swagger/capabilities同步，必要的命名与版本变化在05中完成。

全局诊断无原始文件路径、secret、payload ID或未授权资产计数。失败/恢复管理事件限频或按状态变化记录，不每个省略正文触发无限审计。有限计数溢出、持久化失败与未知损失必须显式，不要求业务请求等待诊断写入成功。

## 8. OBS-14-05代码切片与验收边界

以下切片已登记在统一任务划分中；单切片通过不代表完整配额已交付。

| 切片 | 可交付内容 | 验收 |
| --- | --- | --- |
| 05A 账本与预留原语 | 受管存储域、原子额度、幂等预留/结算、严格配置和状态 | Q/H/L边界、safeInteger溢出、同操作重试、两并发写者不能超卖、DB回滚与错误不释放未知占用；无文件删除。 |
| 05B 正文发布门禁 | 现有prepare/publish接入预算与省略语义 | 临时+最终峰值、既有对象复用、摘要冲突、空正文、并发大正文、ENOSPC/EACCES；业务响应与上游次数不变，原因与字节语义正确。 |
| 05C1 只读盘点原语 | 有界枚举、完整性/字节/游标证据；不改账本、不删除 | 空目录、未知文件、路径变化、分页边界和失败不伪造完整覆盖。 |
| 05C2A 持久只读前缀 | 完整shard前缀与owner/epoch/generation核验 | 跨会话前缀一致、持久游标可复核；不建立ready baseline。 |
| 05C2B1 跨批围栏 | 同owner/generation的inventory租约，跨批阻挡writer/GC | 过期、重启和双Store竞争不复用旧证据。 |
| 05C2B2 原子baseline | 围栏下重扫持久前缀，必要时CAS重建，并在最终事务确认 | 完整256 shard、owner/epoch/generation和预留一致；不完整不ready。 |
| 05C2B3 故障验收 | 独立并发、重启、事务故障矩阵 | 不超卖、不误ready；不代替05C3跨平台验收。 |
| 05C2C 预留与孤儿恢复 | 未结算预留、发布后孤儿和残留占用保守对账 | 未知占用不少计；恢复失败不释放额度。 |
| 05C3 崩溃与多写者验收 | 预留、写入、发布、DB提交各失败点重建验证 | 多实例不能超卖/少计，重启不重复收费，残留保护和回滚证据完整。 |
| 05D 状态/策略与本地故障联调 | 受权配置、版本审计、只读容量状态、水位恢复 | 90%受限、80%恢复、物理余量及15秒陈旧边界；缩小Q不删旧数据；账号/资产权限不泄余额；长期压力下队列/内存有限，业务不中断。 |

完整OBS-14-05验收需要05A~D共同闭合，并记录机器、数据库、文件系统、正文策略、并发/时长和原始日志。Windows/SQL.js或注入满盘故障不等于Linux/PostgreSQL/真实多进程磁盘压力已经通过；实际环境单列未跑项，不伪造性能保证。

本合同不实现全数据库/暂存/多租户配额，不改变墓碑保留，不处理事件物理删除授权。若产品需要对这些存储对象强制预算，应另建明确范围与引用安全验收；不能把首阶段正文配额宣传为完整生命周期治理。

## 9. 源码和现有证据入口

- [容量DTO与样本验证](../../packages/api-nova-api/src/modules/call-observability/call-observability-payload-capacity.dto.ts)：当前总量null、单批覆盖与新鲜度。
- [正文存储](../../packages/api-nova-api/src/modules/call-observability/call-observability-payload.store.ts)：prepare中的上限/存储错误、scanner、临时文件与hard-link发布。
- [Store](../../packages/api-nova-api/src/modules/call-observability/call-observability.store.ts)、[协调器](../../packages/api-nova-api/src/modules/call-observability/call-observability-payload.coordinator.ts)：写入事务、owner/generation及writer/GC fence。
- [GC](../../packages/api-nova-api/src/modules/call-observability/call-observability-garbage.service.ts)、[retention worker](../../packages/api-nova-api/src/modules/call-observability/call-observability-retention.worker.ts)：现有默认关闭流程与独立统计，非配额实现。
- [管线retention投影](../../packages/api-nova-api/src/modules/call-observability/call-observability-pipeline-retention.ts)、[能力接口](../../packages/api-nova-api/src/modules/call-observability/call-observability-capabilities.service.ts)：后续受控状态接入位置。
- [Parser采集器](../../packages/api-nova-parser/src/audit/runtime-call-audit.ts)、[collector](../../packages/api-nova-api/src/modules/call-observability/call-observability.collector.ts)：业务旁路采集和唯一导入路径，不在配额模块重建。
- [容量专项](../../packages/api-nova-api/scripts/test-call-observability-payload-capacity.cjs)、[保留worker专项](../../packages/api-nova-api/scripts/test-call-observability-retention-worker.cjs)、[元数据恢复专项](../../packages/api-nova-api/scripts/test-call-observability-payload-reconciliation.cjs)：现有证据可复用，不能代替新配额并发/恢复测试。

原始DOC交付只核对链接与源码边界；后续05A/05B的实际隔离实现及测试单列于下节。没有修改生产配置或进行任何删除。
## 10. 当前局部实现快照（2026-09-16）

OBS-14-05A新增受管正文预算ledger/reservation、严格Q/H/L配置、epoch/CAS与幂等预留结算；隔离联合18/18通过。OBS-14-05B将可选正文prepare/publish接入预算：启用但账本未就绪或额度不足时在写临时文件前省略正文，维持业务结果和有限元数据；已验证峰值预留、复用、结算失败保守占用和默认关闭回归。05B专项11/11、旧六脚本81/81以及API类型检查/构建通过。关闭开关时沿用旧行为；对外scanUsage.quotaEnforced仍为false，不能把局部写入门禁称为全域强制配额。

发布成功后若外围元数据事务失败，已计费对象可能暂时成为孤儿。05C1只读有界盘点与跨会话完整shard前缀复核已通过专项6/6、旧GC/容量27/27及API typecheck；它只提供writerFenceRequired=true、baselineReady=false的证据，不改账本、schema或文件。05C2A已完成持久但未验证的完整shard前缀与owner/epoch/generation CAS，专项5/5、C1 6/6、quota 8/8及API typecheck通过；未持writer/GC围栏、未确认baseline、未改ledger。05C2B1/B2/B3的后续限定证据见第11节；05C2C未结算预留/孤儿对象恢复、05C3重启/多写者验收和05D受权状态、物理余量及全局策略均尚未完成。未知占用仍须保守保留，不能把C1盘点证据用作ready baseline。以上为Windows本地SQL.js/故障夹具结果，不是当前版本PostgreSQL/Linux、多进程磁盘压力或生产配额验收。完整状态以[统一子任务台账](../guides/active-work-package-execution-status.md)为准。

## 11. 05C2B1/B2/B3限定证据（2026-09-16）

05C2B1完成跨批inventory围栏：同一generation下持有、续租、事务断言和原子结束，跨Store阻挡writer/GC；租约过期使旧前缀代次持久失效，专项7/7。05C2B2在该围栏内从shard 0有界重扫，核对C2A未验证前缀；旧代次或原地变化时仅在ledger仍initializing、无reservation且owner/epoch已确认的条件下CAS废弃并重建。完整256 shard与owner/root/generation/账本/预留在最终事务复核，确认baseline后quotaEnforced仍为false。单批最多1000条，默认32批、显式上限10000批；超预算仅返回incomplete，不标ready。专项15/15。05C2B3隔离SQL.js故障矩阵7/7，覆盖双Store竞争、模拟崩溃导出重启、扫描/事务失败、租约超时及确认后硬上限。

这三项仅证明受管正文域的限定基线能力，未接入管理入口或启动流程，也未结算未知预留/孤儿或启用全域强制配额。外部直接修改文件不能与数据库形成原子快照；Linux、PostgreSQL、真实多进程/杀进程和磁盘压力仍属05C3/05D独立验收。OBS-14-05C2C已解锁，完整状态见[统一台账](../guides/active-work-package-execution-status.md)。
## 12. 05C2C1/C2C2A限定恢复证据（2026-09-16）

C2C1在已存在的owner与私有根上绑定只读证据，并持有B1持久inventory围栏，有界列出受管final/tmp路径、当前/历史引用和预留。无元数据的文件与有元数据但无引用的文件仅是孤儿候选；损坏、截断、读取失败或写者占用均保持unknown。observedBytes只表示已见路径，totalOccupancyBytes始终为null；专项13/13、相关回归90/90。盘点不会创建缺失的owner/root，不改账本、不删文件，也不据此确认配额可强制执行。

C2C2A是保守持有原语：同一围栏内精确核对owner、epoch、generation、预留ID/hash/金额及ledger后，只将合法reserved预留变为uncertain并令ledger degraded；reservedBytes与committedBytes均不减少。重复、故障与SQL.js导出重启专项14/14、相关回归46/46。旧reservation只保存由sourceInstanceId、sourceEventId、payloadId及generation生成的单向operationId，文件发布后而receipt/metadata提交前崩溃时没有可反查文件的持久关联。因此C2C2B须在预留事务内、首次文件写入前持久发布意图；C2C2C再对有完整证明的记录结算。旧无意图记录不能根据候选文件、长度或当前路径不存在推断释放。本段记录C2C2B实施前的缺口；其后续限定进展见第13节。quotaEnforced继续为false；本机SQL.js证据不能代替PostgreSQL/Linux或真实多进程验收。
## 13. 05C2C2B1/B2/B3限定发布意图证据（2026-09-16）

B1新增独立发布意图实体及SQLite/PostgreSQL前向迁移，旧reservation不回填。隔离SQLite新库为69实体/69业务表、2次迁移，旧库只运行1次前向迁移，同库重启0迁移/0漂移；真实PostgreSQL运行未验。B2在writer校验的同一事务中先持久预留与owner/epoch/generation/sourceEvent/payload/final/temp/digest/bytes意图，事务提交后才开始文件I/O；重放使用原temp key，残留temp不覆盖，settled仅核验final，uncertain不写，reserved重放无论看到旧final与否都不释放未知额度。B3隔离SQL.js导出重启矩阵8/8覆盖首次open前崩溃、旧无意图记录、残留temp及owner/epoch/generation变化。B1/B2/B3专项分别9/9、13/13、8/8，详见[第五批证据](../audits/2026-09-16-replanned-batch-5-evidence.md)。

这三项不实施C2C2C的可证明恢复结算，旧无意图预留仍为unknown；quotaEnforced保持false。PostgreSQL、Linux、真实多进程/杀进程和容量压力仍须单独验收。
## 14. 可证明恢复结算原语（2026-09-17）

05C2C2C1在inventory围栏内关联持久意图/预留/receipt/元数据，仅产生linked_unverified；C2A完整有界扫描并核对最终文件摘要/长度和临时文件缺失，仅产生file_proof_uncommitted。C2B在同一活跃围栏的最终事务重核owner/epoch/generation、意图/receipt/元数据/ledger/reservation版本与金额，再次完整扫描并在结算前后核对精确文件证明，才允许reserved峰值转为实际committed金额。失败回滚、证据缺失保守持有；旧无意图记录不推测释放。

三专项分别5/5、8/8、10/10，相邻回归55/55。该原语尚不代表C2C3综合故障矩阵、C3跨平台多写者或05D完成；quotaEnforced保持false，未接生产恢复调度。外部直接改盘不具有SQL与文件系统原子保证。当前SQLite迁移总数已随入站模式迁移变为3，历史第13节的2次迁移保留为当时证据。详见[恢复审计](../audits/2026-09-17-interruption-recovery-evidence.md)。

## 15. C2C3本地完整恢复链验收（2026-09-21）

OBS-14-05C2C3新增真实ingest/文件发布后的5条隔离故障链：延后结算后完整恢复；外部元数据事务回滚后保留已计费对象并重放修复；延后结算且缺receipt跨重启拒绝释放；真实final发布但temp清理失败保留峰值；显式temp故障注入阻断、仅测试夹具修复后安全结算。每次重启先export并关闭旧SQL.js连接，再以同文件根重建连接/服务；每次账本断言统计真实.body/.tmp路径字节，reserved+committed不得低于实物。无直接改写账本制造成功状态。

新专项5/5、相邻关联/文件证明/结算23/23、整合API构建通过。仅Windows本地SQL.js和临时目录证据，不是杀进程、PG/Linux、多写者或生产配额验收；quotaEnforced仍false。下一项05C3已就绪，05D继续等待。完整证据见[恢复故障验收](../audits/2026-09-21-payload-recovery-acceptance.md)。
