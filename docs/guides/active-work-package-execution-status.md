---
doc-version: 1.46.0
doc-status: active
doc-updated: 2026-09-21
---
# 活跃子任务执行状态

## 1. 本次重排快照

依据[任务划分合同](./active-work-package-breakdown.md)，重排首批从本地ace5d02起步，首批API构建与OBS五脚本67/67通过；第二批结果见[上一批审计](../audits/2026-09-16-replanned-batch-2-evidence.md)，围栏、基线、二进制采集与安全索引证据见[第三批审计](../audits/2026-09-16-replanned-batch-3-evidence.md)；恢复降级、样例撤销/整理及当时空库证据见[第四批审计](../audits/2026-09-16-replanned-batch-4-evidence.md)；发布意图、孤儿整理和鉴权语义见[第五批审计](../audits/2026-09-16-replanned-batch-5-evidence.md)。
父包专项统计仍是OBS 10/5/1、SEC 2/17/3/1（DONE/IN_PROGRESS/BACKLOG/DEFERRED）；两专项合计12/22/4/1。它不表示全项目完成率。

本次登记132个叶子记录，含治理、DOC、CODE、VALIDATION、ENV与延期项，规模不等且跨计划证据复用，因此禁止用记录数计算项目完成率。原PROD-02拆成后端配置、候选绑定、UI和真实监听四个出口；已完成的历史实现切片不重新计为新开发成果。

| 状态 | 数量 | 含义 |
| --- | --- | --- |
| DONE | 63 | 限定出口已完成；父包仍按独立退出条件核对 |
| READY | 20 | 可进入队列，当前并非全部开工 |
| IN_PROGRESS | 2 | SEC-B1-01、SEC-C2-02 |
| WAIT_DEP | 27 | 等待列明子任务/条件 |
| NEED_ENV | 17 | 需要核实目标环境，不是假定工具阻塞 |
| SCOPE_REVIEW | 1 | 先判断是否属于批准范围 |
| DEFERRED | 2 | 不属于当前里程碑 |
近期已完成C2B1/B2/B3、C2C1、B2B1/B2/C、B3A/C、SEC-A1-01跨层矩阵及当前版本SQLite空库验证A4-01的限定出口。C2C1证实旧预留无法在崩溃后唯一反查文件，原C2C2已进一步拆为保守降级A、持久发布意图B和可证明结算C；A已完成，B再细分为双方言模型B1、写入接线B2和崩溃验收B3；B1/B2/B3已完成限定出口，C已完成关联、文件证明与安全结算原语，C2C3本地恢复故障验收亦已完成，05C3的Windows隔离PG多写者/进程及PG重启出口已完成，Linux/生产验收仍独立登记。B3B已限定完成；无sample行的staged墓碑再细分为互斥E1、整理E2和故障验收E3，E1/E2/E3已完成限定出口，B3D本地限定验收已完成，真实环境仍归04C。READY不表示已开工。SEC-E1-02C1仍等待明确生产生命周期授权；事件物理删除E2B仍等待明确永久删除授权。

最新收尾见[额度中断恢复审计](../audits/2026-09-17-interruption-recovery-evidence.md)。本次修复迁移测试滞后、关联结果类型缺项及台账计数不一致，并完成三个在执行切片。

2026-09-21后续交付：[受管鉴权模式一致性](../audits/2026-09-21-managed-inbound-mode-evidence.md)及[配额恢复故障验收](../audits/2026-09-21-payload-recovery-acceptance.md)。

## 2. 子任务状态与证据

| 子任务 | 状态 | 当前证据/剩余边界 |
| --- | --- | --- |
| GOV-01 | DONE | 本轮三路审计 |
| SEC-A1-01 | DONE | [七模式跨层矩阵](../testing/sec-a1-01-auth-mode-cross-layer-matrix.md)逐路径标实现与缺口；API97/97、Parser23/23、stdio12/12及MCP HTTP安全冒烟；不等于A1-02功能完成 |
| SEC-A1-02A | DONE | Gateway UI/DTO旧public安全归一internal，显式external才匿名；空ref阻断新候选并保留旧active。API三套34/34、UI2/2、API/UI typecheck |
| SEC-A1-02B1 | DONE | 独立入站模式DTO/列/摘要；旧行unknown、新部署须显式选择，运行中旧行不改停；SQLite旧库升级/空库/重启零漂移、专项37/37；PG静态核对，effective仍unknown |
| SEC-A1-02B2 | DONE | 持久模式接入现行CLI启动/重启，停机前预检、spawn临时环境不回存新凭证；4套13/13、真实CLI HTTP三模式3/3；effective仍unknown，远端JWKS仅URL预检 |
| SEC-A1-02B3 | DONE | 持久private_api_key→handoff→child api_key→READY一致性；缺失/不支持/不符拒绝，旧实验包不默认兼容；父端46/46、真实child HTTP13/13；未接生产生命周期，CLI effective仍unknown |
| SEC-A1-02B4 | DONE | 三值明确选择、保存/重载、草稿/配置/预览/实际未知分离；旧未知与运行中改模式阻断，详情空记录及Gateway隔离；Vue状态/SFC SSR19/19、UI构建/typecheck；真实浏览器端到端未跑 |
| SEC-A1-02C | DONE | 直连stdio审计标local_process/unknown、不虚构callerId；真实子进程12/12、HTTP权限20/20、Parser规范化41/41；HTTP anonymous保持原义 |
| SEC-A1-02D | DONE | Gateway三模式真实回放/激活/冷恢复18项HTTP，MCP三模式真实发布/失败保旧/磁盘重开/6次child与tools/call，stdio12/12；见2026-09-21-auth-publication-loop证据 |
| SEC-A2-01A | DONE | Gateway缺失/空/损坏active快照拒绝，策略与指纹重核；热恢复保留旧registry，冷启动拒绝；相邻28套339/339，父任务定向28/28 |
| SEC-A2-01B | DONE | 实际部署保存入口拒缺失/未知/非法模式且无候选/保存副作用；自动恢复真实preflight拒绝、显式匿名可追溯；ProcessManager重启先校验再stop且spawn前重验；父任务12套88/88，CLI HTTP3/3、实验child14/14，API构建 |
| SEC-A3-01 | WAIT_DEP | 未实现闭环 |
| SEC-A4-01 | DONE | 当前版本隔离SQLite空库与同文件重开：69实体/69业务表、空库迁移3、重启迁移0、schema漂移0；create与smoke均通过；不代表PostgreSQL或历史升级 |
| SEC-A4-02 | DONE | Windows PostgreSQL16.10全新loopback隔离集群：69实体/69业务表、3迁移，空库/连接重建漂移0、重连迁移0、持久化与真实API启动/管理401；父任务独立复跑；非历史升级/Linux/PG进程故障恢复 |
| SEC-B1-01 | IN_PROGRESS | 核对统一消费者模型和Gateway/MCP解释，避免新增第二套凭证存储；轮换传播仍归B1-02 |
| SEC-B1-02 | WAIT_DEP | 未完成 |
| SEC-B2-01 | READY | 固定子集已有 |
| SEC-B3-01 | WAIT_DEP | 列表过滤/执行二次授权已有 |
| SEC-B3-02 | READY | 不是升级SDK任务 |
| SEC-C1-01 | READY | header API Key/Bearer已有 |
| SEC-C1-02 | WAIT_DEP | 类型很多时逐类型再拆后执行 |
| SEC-C2-01 | NEED_ENV | Env/File本机实现已有 |
| SEC-C2-02 | IN_PROGRESS | 实现Windows受限ACL真实检查与隔离文件拒绝验收，不修改现有秘密权限 |
| SEC-C3-01 | DONE | 固定文件Watch/debounce、坏文件保旧、admin锁内代次检查和Nest关闭已通过；Windows真实监听8/8、Parser252/252、Gateway31/31；见2026-09-21-registry-watch证据 |
| SEC-C3-02 | DONE | Gateway启动/manual/watch激活均强制真实DB Source/Endpoint归属校验，未知/跨源/查询失败保旧；Parser46/46、Gateway46/46；见2026-09-21-registry-db-ownership |
| SEC-C3-03 | READY | E1-02B2与C3-02已完成；下一步真实多进程generation/失败状态与混版本隔离，尚未实施 |
| SEC-C4-01 | WAIT_DEP | 纯Resolver不重写 |
| SEC-D1-01 | READY | 现有30项草案不是实现 |
| SEC-D1-02 | WAIT_DEP | Connection修复转维护 |
| SEC-D2-01 | DONE | 真实HTTP独立IP/Anonymous桶、peer可信边界、缓存命中仍限流；Gateway全套201/201、主任务联合复验42/42；见2026-09-21-independent-rate-limits证据 |
| SEC-D2-02 | WAIT_DEP | 不把限流器单测当整包验收 |
| SEC-E0-01 | READY | 不升级无状态协议 |
| SEC-E1-01 | DONE | managed-mcp-credential-handoff-plan.md 0.1.0 draft；无代码交付；[草案](./managed-mcp-credential-handoff-plan.md) |
| SEC-E1-01R | DONE | [交付设计第9节](./managed-mcp-credential-handoff-plan.md)，02A通道与真实child验收冻结；仅DOC |
| SEC-E1-02A | DONE | 真实Node IPC、精确环境、ACK后固定拒绝、断连/超时/幂等关闭；专项11/11，ProcessManager 3/3 |
| SEC-E1-02B1 | DONE | 固定Config源、双DB快照、稳定Registry摘要、候选/绑定/环境核验；专项23/23 |
| SEC-E1-02B2 | DONE | 真实child稳定重读Registry、single-hop Resolver、API key认证与监听后READY；三脚本47例 |
| SEC-E1-02C1 | WAIT_DEP | 未验收生命周期草稿已撤回；B1/B2独立准备与真实child测试保留。自动审批要求明确授权生产启动/停止状态行为变更后再实现 |
| SEC-E1-02C2 | WAIT_DEP | 重启/失败/legacy边界等待C1 |
| SEC-E1-03 | WAIT_DEP | 不能用进程内transform替代 |
| SEC-E1-04 | WAIT_DEP | 未完成 |
| SEC-E2-01 | WAIT_DEP | 复用已有smoke |
| SEC-E2-02 | NEED_ENV | 需核实环境 |
| SEC-F1-01 | READY | 不回塞到C1造成循环 |
| SEC-F1-02 | WAIT_DEP | 未完成 |
| SEC-F2-01 | READY | 缺策略文案已完成 |
| SEC-F2-02 | WAIT_DEP | 未完成 |
| SEC-F3-01 | READY | 不将零redirect称SSRF完成 |
| SEC-F3-02 | WAIT_DEP | 未完成 |
| SEC-F3-03 | WAIT_DEP | E1负责argv实现，此项只消费证据 |
| SEC-F3a-01 | READY | 需在线公告时另行验证，不复用旧漏洞数 |
| SEC-F4-01 | DONE | 45个SEC叶子逐项索引、70个链接有效；区分历史/本地限定/未运行环境，不代表F4-02签收 |
| SEC-F4-02 | NEED_ENV | 目标环境与授权另核实 |
| OBS-06-01 | READY | 不重写已有发送边界 |
| OBS-06-02 | NEED_ENV | 真实环境待核实 |
| OBS-10-01 | READY | 管理心跳/路由注册已有 |
| OBS-10-02 | WAIT_DEP | 未完成 |
| OBS-13-01 | WAIT_DEP | 调用事实页流已完成 |
| OBS-13-02 | WAIT_DEP | 长期/跨平台证据未完成 |
| OBS-14-01 | DONE | [生命周期合同](../reference/runtime-observability-lifecycle-contract.md)冻结引用、保留、墓碑与重放边界；仅DOC |
| OBS-14-02 | DONE | 持久keyset分页、同GC fence、修复与cursor同事务；真实SQL.js连接重建恢复；新增7项专项，联合67/67 |
| OBS-14-03E1 | DONE | 持久非连续gap、授权查询与afterSequence 410；SQL/schema/migration同步，专项6/6 |
| OBS-14-03E2A | DONE | 默认关闭的只读候选分类、授权/TTL/lease/delivery保护；无写入，专项4/4 |
| OBS-14-03E2B | WAIT_DEP | 物理delete、gap与持久cursor同事务；自动审批要求具体删除授权 |
| OBS-14-03E3 | WAIT_DEP | 整体验收等待物理清理完成 |
| OBS-14-03D | READY | 引用/墓碑合同已冻结；不以仅有TTL字段代替清理 |
| OBS-14-04 | DONE | [容量配额合同](../reference/runtime-observability-capacity-quota-contract.md)冻结计量、水位、并发预留、恢复与05A~D；仅DOC |
| OBS-14-05A | DONE | 独立ledger/reservation、epoch/CAS、幂等预留结算与严格配置；联合18/18，未接写入 |
| OBS-14-05B | DONE | 默认关闭的payload prepare/publish门禁；专项11/11、旧六脚本81/81、API类型检查/构建通过；外围元数据失败孤儿计费留05C2 |
| OBS-14-05C1 | DONE | 只读有界正文盘点、跨会话完整shard前缀复核；专项6/6、旧GC/容量27/27、API typecheck；writerFenceRequired=true、baselineReady=false，不改账本/schema/删除 |
| OBS-14-05C2A | DONE | 持久未验证完整shard前缀与owner/epoch/generation CAS；专项5/5、C1 6/6、quota 8/8、API typecheck；不持围栏、不确认baseline、不改ledger |
| OBS-14-05C2B1 | DONE | 独立跨批inventory围栏、双Store互斥、过期代次持久失效；专项7/7、旧回归61/61、API typecheck；不确认baseline |
| OBS-14-05C2B2 | DONE | 同围栏从0重扫、陈旧前缀CAS重建和原子baseline；专项15/15、旧回归53/53、API typecheck；超预算incomplete，quotaEnforced=false |
| OBS-14-05C2B3 | DONE | 独立SQL.js故障矩阵7/7：双Store竞争、模拟重启、事务/租约故障及确认后硬上限；不等于Linux/PG/真实多进程C3 |
| OBS-14-05C2C1 | DONE | 受持久围栏的只读有界残留/预留证据，未知占用不释放；专项13/13、旧回归90/90、API typecheck；总占用保持未知 |
| OBS-14-05C2C2A | DONE | 围栏内精确核对预留后仅reserved→uncertain、账本degraded，额度不释放；专项14/14、相关回归46/46、API typecheck |
| OBS-14-05C2C2B1 | DONE | 双方言前向迁移/当前schema及意图原语；隔离SQLite新库69表/2迁移、旧库仅1次前向迁移、重启零漂移；9/9；真实PG未验 |
| OBS-14-05C2C2B2 | DONE | 首次文件I/O前预留与精确意图同事务提交；重放沿用temp key且未知占用不释放，旧无意图不回填；13/13 |

| OBS-14-05C2C2B3 | DONE | SQL.js导出重启与崩溃/旧预留/残留temp/owner-epoch-generation矩阵8/8；不等于PG/Linux/多进程验收 |
| OBS-14-05C2C2C1 | DONE | inventory围栏内只读关联意图/预留/receipt/当前及历史引用，结果仅linked_unverified；缺失/冲突blocked、写者busy；SQL.js 5/5、类型检查，不改账本/文件 |
| OBS-14-05C2C2C2A | DONE | 同一inventory围栏内完整扫描、final digest/长度与temp缺失只读证明，返回file_proof_uncommitted；SQL.js 8/8、相关回归，不结算 |
| OBS-14-05C2C2C2B | DONE | 同inventory围栏最终事务复核意图/receipt/元数据/预留和完整扫描、精确文件字节后安全结算；专项10/10、相邻55/55；不确定保守持有、quotaEnforced=false |
| OBS-14-05C2C3 | DONE | 实际ingest/发布故障、关闭并重建SQL.js连接、缺receipt/元数据回滚/残留temp、重复恢复与重放5/5；每次确认reserved+committed覆盖实际路径字节；仅Windows隔离验收 |
| OBS-14-05C3 | NEED_ENV | Windows PostgreSQL16.10真实9/9：四进程预算/幂等、四个实际ingest中断窗口、完整文件链并发和PG重启重放守恒；本机出口完成，Linux无就绪环境，整包不标DONE；PG掉电/长期压力未验 |
| OBS-14-05D | WAIT_DEP | 状态/故障联调等待05C3 |
| OBS-14-06A | READY | 生命周期合同已冻结；审计清理尚未实施 |
| OBS-14-06T | READY | 生命周期合同已冻结；暂存恢复尚未实施 |
| OBS-15-01 | READY | Gateway日志入口已迁移 |
| OBS-15-02 | WAIT_DEP | 不重建第二主链 |
| OBS-16-01 | DONE | 交接文档2.2.0；AC01~20与脚本入口静态核对，未运行新全量矩阵；[交接](./runtime-observability-external-validation-handoff.md) |
| OBS-16-02 | READY | 不等同全量平台验收 |
| OBS-16-03 | NEED_ENV | 环境待核实 |
| OBS-16-04 | WAIT_DEP | 部署需具体环境及授权 |
| PROD-01 | DONE | [发布端点合同](./mcp-publication-endpoint-contract.md)，后端/监听/UI边界冻结；仅DOC |
| PROD-02A1 | DONE | DTO、统一解析、授权preview、更新保留、归属/运行态保护及summary；专项与部署回归49/49 |
| PROD-02A2 | DONE | 实际端点三项进入候选哈希/metadata并在激活事务复核；四套81/81 |
| PROD-02B | DONE | 三入口共享typed表单、preview/回填/部署/重部署、会话代次与失败保稿；45/45及typecheck |
| PROD-02C | DONE | 真实Streamable/SSE自定义路径、/messages、health、bind失败与配置一致；3/3及联合84/84 |
| PROD-03 | DONE | Gateway/MCP本地失效→重验→再发布循环；修Gateway stale激活，七套76/76；真实入口仍归EXT |
| PROD-04A | DONE | [二进制样例合同](./endpoint-test-binary-sample-contract.md)冻结采集/存储/权限/TTL与回放边界；仅DOC |
| PROD-04B1 | DONE | 专用对象原语、默认关闭私有根、staged→ready及有界内部读取；rename后DB失败幂等恢复；9/9、API构建、SQLite空库67表零漂移；无采集/HTTP读取/删除 |
| PROD-04B2A | DONE | 显式开关下真实loopback响应字节有界descriptor；未声明二进制只unavailable，JSON/text/HTTP失败与默认off回归；27/27、API typecheck；不落盘/下载 |
| PROD-04B2B1 | DONE | 受信HTTP流字节接样例/对象同事务；SQL.js文件故障和删除围栏、四组54/54、API typecheck；默认关闭，无下载/回收 |
| PROD-04B2B2 | DONE | SQL.js导出/重启、半对象不可读、重复ID隔离和文件/DB故障专项59/59、API typecheck；不含撤销/删除/GC |
| PROD-04B2C | DONE | server:manage受权下载、sample归属/ready复核和固定响应头；真实JWT/SQL.js HTTP联合68/68、API构建；无撤销/GC |
| PROD-04B3A | DONE | 显式删除及过期归档清理同事务撤销引用、持久delete_pending并保留样例/文件；读中撤销返回410，3套34/34、API构建；不unlink |
| PROD-04B3B | DONE | server:manage显式清理仅处理撤销满5分钟的delete_pending对象，最多100/2秒软预算；失败保墓碑、重启可重试，4套53/53、API构建；不含无sample staged孤儿 |
| PROD-04B3C | DONE | kind=binary未知版本/非显式status-only在回放前BLOCKED；显式status-only仍核验HTTP状态，3套44/44、API typecheck；不支持binary-exact |
| PROD-04B3E1 | DONE | 发布/撤销/清理共用对象围栏；SQL.js同进程队列、PG会话锁与活性检查；真实PG跨进程断连未验 |
| PROD-04B3E2 | DONE | 无引用staged满5分钟后围栏内复查并持久CAS至delete_pending，再按受控key有界整理；失败保ORPHAN墓碑，SQL.js隔离验证 |
| PROD-04B3E3 | DONE | SQL.js临时目录双服务排队、旧写者、CAS/文件/DB失败与重启矩阵；四套75/75、API typecheck；不代表PG跨进程/生产验收 |
| PROD-04B3D | DONE | 本地JWT HTTP删除→410→重启/失败墓碑重试→404，回放前/中撤销鲜读BLOCKED且旧版本保留；11套148/148；候选外发为mock、PG/平台待04C |
| PROD-04C | NEED_ENV | B3D本机出口已完成；完整留存、跨进程PG/平台权限、生产身份及真实候选外发需要明确隔离目标环境 |
| PROD-05 | READY | 既有变更审计不重做 |
| PROD-06 | SCOPE_REVIEW | 近期把完整CAS反复列作未完成，存在范围扩张风险 |
| EXT-01 | NEED_ENV | 不当成代码未实现 |
| EXT-02 | NEED_ENV | 环境待核实 |
| EXT-03 | NEED_ENV | 环境待核实 |
| EXT-04 | NEED_ENV | 环境待核实 |
| EXT-05 | NEED_ENV | 环境待核实 |
| EXT-06 | NEED_ENV | 环境待核实 |
| EXT-07 | NEED_ENV | 本地SQL.js不是该证据 |
| EXT-08 | NEED_ENV | 需核实当前可运行条件 |
| EXT-09 | NEED_ENV | 环境待核实 |
| ENV-01 | NEED_ENV | 不放宽执行策略 |
| OPS-01 | WAIT_DEP | 不能与F4重复计算发布成果 |
| MAIL-01 | READY | 不在39专项内 |
| MAIL-02 | WAIT_DEP | 未核实当前具体实现 |
| MAINT-01 | WAIT_DEP | 等待发布行为与接口边界稳定后再冻结维护验收，当前不进入主线 |
| MAINT-02 | READY | 持续维护，不算固定父包完成率 |
| DEFER-01 | DEFERRED | 明确延期 |
| DEFER-02 | DEFERRED | 明确延期 |

## 3. 最近轮次审核与纠偏

最近9个提交从c34756f到3eed902均有实际交付或修复，但c34756f后主要聚集SEC-C4/E1管理装配一致性与OBS14扫描恢复。11个父包DONE未增加，不能据此说“没做工作”，也不能据测试数说核心目标已接近完成。

工作偏移表现为：未先冻结一个用户可验收的子任务出口，就连续扩展同一接缝的防御；反复列出受管启动/撤销/配额未完成却未调度它们；各轮只追加台账，父表/交接摘要滞后。工作包过大又混合实现与跨平台/部署验收，造成进度不可见。两类原因并存。

治理动作：已保留严格父包状态，显式冻结已验收切片；新建跨计划去重和子任务出口；将外部环境状态单列；修正陈旧Reload、继承和HTTP/Socket.IO摘要。本轮没有把新的文档DONE计为代码完成。




## 4. 重排后首批实际交付

- SEC-E1-01R：完成真实IPC、权限、精确环境、ACK/READY与legacy边界技术审查；02A实现与必选验收冻结，解锁02A。
- OBS-14-02：collect实际路径增加每轮最多scanLimit条过期metadata检查。修复和cursor同事务；同租约隔离writer；缺文件且TTL到期才标expired，有效文件和调用/历史引用保留。进度可跨DB连接与服务重建恢复。此项是代码交付，未完成事件/receipt生命周期或配额。
- PROD-01：冻结port/transport/endpointPath默认、严格校验、更新保留、监听和预览合同，解锁PROD-02；UI及后端实现尚未交付。

验证：`npm run build --workspace api-nova-api`通过；payload-reconciliation、payloads、payload-capacity、retention-worker、pipeline五脚本联合67/67通过（Windows、隔离SQL.js/本地夹具）。日志位于`tmp/replan-batch1-api-build.log`与`tmp/replan-batch1-obs-tests.log`；无生产数据库、真实业务重放或部署。本轮新增7项恢复专项，不把回归总数当开发完成率。

## 5. 三路并行批次收尾（2026-09-21）

C3-01、D2-01、A1-02D三个原有叶子均完成，没有新增拆分记录。经逐条对照原TP-A1“Gateway/MCP三模式、stdio local_process”及禁止旧OAuth策略迁移的退出条件，A1各叶证据已闭合，父包A1提升DONE；未把该结论外推为整套安全或生产交付。62个DONE叶子不代表项目完成百分比。下一组可并行候选为B1-01统一凭证模型、C3-02配置DB归属、C2-02 Windows秘密文件权限，先按各自既定出口实施；D2-02仍依赖B1-02。
