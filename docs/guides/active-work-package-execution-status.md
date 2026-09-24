---
doc-version: 1.131.0
doc-status: active
doc-updated: 2026-09-24
---
# 活跃子任务执行状态

## 1. 本次重排快照

依据[任务划分合同](./active-work-package-breakdown.md)，重排首批从本地ace5d02起步，首批API构建与OBS五脚本67/67通过；第二批结果见[上一批审计](../audits/2026-09-16-replanned-batch-2-evidence.md)，围栏、基线、二进制采集与安全索引证据见[第三批审计](../audits/2026-09-16-replanned-batch-3-evidence.md)；恢复降级、样例撤销/整理及当时空库证据见[第四批审计](../audits/2026-09-16-replanned-batch-4-evidence.md)；发布意图、孤儿整理和鉴权语义见[第五批审计](../audits/2026-09-16-replanned-batch-5-evidence.md)。
父包专项统计仍是OBS 11/4/1、SEC 10/12/0/1（DONE/IN_PROGRESS/BACKLOG/DEFERRED）；两专项合计21/16/1/1。它不表示全项目完成率。

本次登记201个叶子记录，含治理、DOC、CODE、VALIDATION、ENV与延期项，规模不等且跨计划证据复用，因此禁止用记录数计算项目完成率。原PROD-02拆成后端配置、候选绑定、UI和真实监听四个出口；已完成的历史实现切片不重新计为新开发成果。

| 状态 | 数量 | 含义 |
| --- | --- | --- |
| DONE | 140 | 限定出口已完成；父包仍按独立退出条件核对 |
| READY | 15 | 可进入队列，当前并非全部开工 |
| IN_PROGRESS | 0 | 当前无已登记实施中叶子；D2b3与C2b2b已就绪但尚未开工 |
| WAIT_DEP | 26 | 等待列明子任务/条件 |
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
| SEC-A3-01 | DONE | 可信actor/reason/expiry、生产双许可、保存冷重开及真实CLI墙钟到期拒绝审计，见在线轮换与临时匿名证据 |
| SEC-A4-01 | DONE | 当前SQLite69实体/表、4迁移；新增accessPolicy旧row NULL不授予、跨重开、down/up及完整schema零漂移；见2026-09-21-unified-consumer-credentials |
| SEC-A4-02 | DONE | Windows PostgreSQL16.10新隔离集群复验69实体/表、4迁移，空库/重连零漂移、持久化、真实API启动；集群已关闭清理；非Linux/旧版本生产升级 |
| SEC-B1-01 | DONE | 同一持久凭证支持Protocol/Tool Scope/Subject/Expiry/Actor，Gateway/MCP共用验证；真实DB11项、MCP HTTP40/40、真实CLI4/4、联合API277/277、双库4迁移零漂移；见统一凭证证据 |
| SEC-B1-02 | DONE | 轮换族、窗口与事务审计；真实Gateway/MCP同PID逐请求DB验证截止/撤销/自然到期，见在线轮换证据 |
| SEC-B2-01 | DONE | 共享algorithms/requiredClaims/skew保存与执行；真实SQLite重开/CLI/Gateway一致、运行中修改须先停止、SSE有效截止17项，见JWT参数证据 |
| SEC-B3-01 | DONE | 真实Streamable/SSE长连接2/2：scope收窄、持久撤销、旧session/新连接/重连拒绝、SQLite重开及同PID有效Key对照；见会话撤销证据 |
| SEC-B3-02 | DONE | SDK1.29.0 dispatcher/双传输Session/同主体换钥/跨主体拒绝/通知边界11项，统一入口71/71；scope不自动通知，目录变更阳性对照，见SDK证据 |
| SEC-C1-01 | DONE | [类型合同](./upstream-credential-types-contract.md)冻结四类目标、拒绝类型、生命周期/Scope与F1兼容；DOC完成，非实现 |
| SEC-C1-02 | DONE | [四类凭据证据](../audits/2026-09-22-credential-types-scope.md)：类型/双引用/生命周期/Scope、Gateway与显式single-hop真实27项、DB归属、533 Parser/428 API联合通过 |
| SEC-C2-01 | NEED_ENV | Env/File本机实现已有 |
| SEC-C2-02 | DONE | Windows原生句柄ACL验证；真实NTFS28/28主任务独立复跑，越权/链接/替换/并发写入均通过；依赖系统PowerShell与Add-Type，Linux另验 |
| SEC-C3-01 | DONE | 固定文件Watch/debounce、坏文件保旧、admin锁内代次检查和Nest关闭已通过；Windows真实监听8/8、Parser252/252、Gateway31/31；见2026-09-21-registry-watch证据 |
| SEC-C3-02 | DONE | Gateway启动/manual/watch激活均强制真实DB Source/Endpoint归属校验，未知/跨源/查询失败保旧；Parser46/46、Gateway46/46；见2026-09-21-registry-db-ownership |
| SEC-C3-03 | WAIT_DEP | 复核发现实验handoff只启动时captureSnapshot且generation恒从1起；完整产品跨进程协调依赖E1-02C1，不能用实验cohort原语冒充交付 |
| SEC-C4-01 | WAIT_DEP | 纯Resolver不重写 |
| SEC-D1-01 | DONE | Header政策1.0.0定稿：双向精确allowlist、多值/framing、保留字段、缓存和限时迁移；H01–H12待实现，N01–N17仍F3提案 |
| SEC-D1-02A | DONE | Parser v1编译/不可变快照/继承/摘要/冲突294项；Gateway双源及未就绪激活拒绝、真实固定文件保旧/SQL.js冷恢复拒绝；仅准备 |
| SEC-D1-02B | DONE | [双向真实流证据](../audits/2026-09-21-header-wire-execution.md)：纯字段60、入口TCP15、proxy真实21及联合353通过；仅显式compiled路径，生产门禁保持 |
| SEC-D1-02C | DONE | [缓存隔离证据](../audits/2026-09-22-header-cache-isolation.md)：命中前预检、必需vary/策略及材料代次、原始禁存信号、真实HTTP32项；生产仍门禁 |
| SEC-D1-02D1 | DONE | 同一Registry快照的策略/凭据/代次/历史名接入不可变Prepared Exchange；5 suites/118通过；生产v1仍等D2/D3/D4 |
| SEC-D1-02D2A | DONE | 纯迁移契约/校验器覆盖具名legacy期限、未知字段与来源变更拒绝；3 suites/57通过；未接生产创建入口或持久化 |
| SEC-D1-02D2B | DONE | PublicationService两新建入口持久写入v1草稿+来源，旧路由不回填；先NOT_READY再任何ACTIVE写；SQL.js重开，6 suites/65通过 |
| SEC-D1-02D2C | DONE | 显式例外登记/校验/撤销与持久墓碑；SQL.js 3 suites/45通过；未生产注册，PG JSONB CAS未实测 |
| SEC-D1-02D2D | DONE | SQLite联合snapshot/旧explicit grant/new v1重开与bad reload保旧；隔离PG并发CAS/重开/providerClosed/expiry/revoke并清理；4 suites/49与API build通过；运行时legacy期限守卫未注册 |
| SEC-D1-02D3 | DONE | Nest/Socket.IO初始化后、listen前安装checkContinue/checkExpectation/upgrade；2 suites/24与API build通过 |
| SEC-D1-02D4A | DONE | Legacy纯guard与局部真实HTTP矩阵，3 files/37通过；不等于生产运行时接线 |
| SEC-D1-02D4B | DONE | 用户明确授权的生产guard接线；5 files，HTTP/SQL.js+Runtime/DI 5 suites/68通过；到期/撤销/删除/unknown/registry例外503且cache/Resolver/upstream零绕过 |
| SEC-D1-02D4C | DONE | 限定矩阵盘点：14 suites/223及隔离PG CAS/reopen/expiry/revoke/noActivation通过；逐项H01–H12证据，acceptanceComplete:false；H07冷启动与membership正式正向未闭环 |
| SEC-D1-02D4D1 | DONE | 可信Parser host历史Store与Registry单调CAS在sync snapshot前提交；3 files、12新增测试，Parser 29 suites/557及build通过 |
| SEC-D1-02D4D2 | DONE | Entity/service、SQLite+PG migrations/注册/schema；CAS单调并集、4096上限与旧库冷重开，SQLite 4 suites/6、API build及全新隔离PG zero-drift通过；不接Provider |
| SEC-D1-02D4D3 | DONE | Gateway Provider接入ledger/Parser Registry bridge与稳定DB namespace；missing/corrupt ledger仅使Gateway empty registry/HTTP503而Nest health200；SQL.js+隔离PG双进程轮换→清空→冷启动后旧header剥离，2 suites/31及API build通过 |
| SEC-D1-02D4D4 | DONE | 真实SQL.js并发CAS、watch stop前后durable commit、迁移回滚不污染；4个API组合37项+Parser契约12项，双Node/HTTP SQLite与隔离PG H07全true并清理；H11 membership→v1仍未闭合 |
| SEC-D1-H11A | DONE | Registry-source v1受控激活限定完成：16项真实Controller/Nest/HTTP/cache/SQL.js冷重启联合用例、strict helper 10项、Gateway+Publication 58 suites/778 tests及API build通过；F1 Verified未接线，inline/legacy/unmigrated/unknown/unsafe仍fail-closed并保留旧snapshot，无外部部署 |
| SEC-D1-H11B | DONE | 沿RuntimeAssets.deployGatewayRuntimeAsset→plan/真实GatewayCandidateReplay→activate→Nest HTTP/cache完成33场景H01–H12验收；相关73 suites/1023 tests与API build通过。H11覆盖Range/If-*、gzip/identity、cache分区及直连/bypass；Proxy仅按已验证chunked策略重建TE。SQL.js同秒精度下以1050ms等待遵守stale gate；无真实外连 |
| SEC-D2-01 | DONE | 真实HTTP独立IP/Anonymous桶、peer可信边界、缓存命中仍限流；Gateway全套201/201、主任务联合复验42/42；见2026-09-21-independent-rate-limits证据 |
| SEC-D2-02 | DONE | 六层真实HTTP组合19项、四套73/73；共享窗口冲突503且到期恢复、24并发精确7准入；见六层限流组合证据 |
| SEC-E0-01 | DONE | 锁SDK1.29.0原始HTTP/Session/错误及真实stdio矩阵60/60；修复已知Streamable端点不支持方法405+Allow；见Adapter证据 |
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
| SEC-F1-01 | DONE | 四态、OpenAPI继承/OR-AND、Binding兼容及验证失效合同定稿；同revision秘密变更须重新验证；F1-02仍依赖C1-02 |
| SEC-F1-02A | DONE | 声明保留、OR/AND显式选择、四态纯对账及发布/装配写入前拒绝；17 suites/234与API build通过；不含可信Registry/耐久验证 |
| SEC-F1-02B | DONE | 可信Registry/Resolver Binding评估与opaque Provider epoch接入；5 suites/57与API build通过；不替代C的耐久验证ledger |
| SEC-F1-02C1 | DONE | 独立entity/repo与挑战服务；真实挑战、磁盘SQL.js重开14/14；F1目录6 suites/71与API build通过；不含生产注册/接线 |
| SEC-F1-02C2 | DONE | 生产专用证据表/双数据库迁移，prototype kind隔离；SQLite+隔离PG 70表/5迁移冷启/重开/回退零漂移，12 suites/83、迁移9/9与API build通过；未接挑战/Verified |
| SEC-F1-02C3a | DONE | 受信上下文authority纯模块完成；与C3b/c合计4 files、27 tests、API security 8 suites/105及build通过；无DB/DI/readiness/生产Verified |
| SEC-F1-02C3b | DONE | 受限挑战transport与失败分类纯模块完成；transport不授予Verified，未接生产DI或readiness |
| SEC-F1-02C3c | DONE | proof authority与可信上下文绑定纯模块完成；未接生产evidence kind、消费者或Verified门禁 |
| SEC-F1-02C3d | DONE | 生产格式独立evidence表、双库CHECK/迁移/注册与prototype隔离完成；16 suites/120，SQLite 72表/7迁移及隔离PG 72/7 zero drift；proof authority拒绝prototype/DB行；不等于生产Verified |
| SEC-F1-02C3e | DONE | 四阶段真实loopback→SQLite耐久重读→context/epoch重评→私有proof编排；新增orchestrator及测试，10 suites/123与API build通过；DB记录不能重建proof，保存/绑定变化/迟到/撤销均拒绝；未接生产意图权威/DI/controller/publication |
| SEC-F1-02C3f | DONE | host-only challenge intent authority限定完成：2 files/24 tests，security目录10 suites/146及API build通过；所有拒绝场景0 transport/HTTP；未接DI/controller/seed/schema及实际session/tenant adapter，不代表生产Verified |
| SEC-F1-02C3G1 | DONE | proof/authorization消费adapter限定完成：真实能力按source/endpoint/target/method/Binding消费，扩展authority/orchestrator fixtures；30 tests、security 11 suites/176及API build通过；不代表production gate已接线 |
| SEC-F1-02C3G2 | DONE | 只读preview/readiness adapter限定完成：2 files、2 suites/43及API build通过；SQL日志仅SELECT、实体/evidence零变更且无新增loopback；canPublish恒false、未接生产入口 |
| SEC-F1-02C3G3 | DONE | 单成员DB事务writer限定完成：2个publication-member-transaction-writer文件，1 suite/10项SQL.js及API build通过；未注册生产入口、未验PostgreSQL |
| SEC-F1-02C3G4 | DONE | 有界executor切片限定完成：3 suites/30 tests及API build通过；生产G2默认false且验证G3零调用，仅显式future-readiness fixture证明部分提交/后续继续；candidate仅host-owned同步swap且无await，未接异步Registry生产链，不代表production batch/candidate activation完整 |
| SEC-F1-02C3G5 | WAIT_DEP | 独立Gateway proof consumer guard与真实HTTP 3 suites/54 tests及API build通过，但未注册module/runtime；仍缺生产host challenge/session/proof issuer、同进程authority lifecycle与request-bound capability provider。只限proof消费，不开放Verified，E1继续拒绝 |
| SEC-F1-02C3G6 | WAIT_DEP | 依赖E3b/G1；MCP/child实时许可与撤销待实现，proof不得序列化 |
| SEC-F1-02D | READY | G2/G4显式依赖已闭合；仍须实现preview/单批发布/激活统一结果与事务内context复核，G4限定完成不代表生产激活已存在 |
| SEC-F1-02E1 | DONE | Gateway每次调用重评guard，6 files；39 suites/556及13项真实HTTP SQL.js重校、API build通过；不声称生产Verified |
| SEC-F1-02E2 | DONE | Parser唯一声明规则与标准HTTP transformer门禁；6 files，Parser28/545、API102/1116、三构建及扩例7/7通过；不含Verified/custom handlers/E3 managed传播 |
| SEC-F1-02E3a | DONE | 受限ManagedChildSecurityLeaseCoordinator纯协调原语；2 files/7 tests通过；未注册、未接handoff |
| SEC-F1-02E3b | WAIT_DEP | 运行中更新前阻断、实时授权与事件IPC等待E3a及E1-03；在线撤销零联网未验 |
| SEC-F1-02F | WAIT_DEP | 双runtime端到端、SQL.js/PostgreSQL重开、并发迟到/同revision变化等待D/E3b/G5/G6 |
| SEC-F2-01 | DONE | Consumer/Upstream分区、真实binding revision/Registry generation与reload恢复；UI12/12、实际UI适配器到Nest/Registry HTTP1/1、后端21/21；进程范围明确，浏览器点击未验 |
| SEC-F2-02 | DONE | Gateway/MCP临时匿名原因/到期/生产风险和actor回显，保存重开及拒绝反馈；UI构建、表单/真实模板26/26，浏览器点击未验，见UI证据 |
| SEC-F3-01 | DONE | [网络合同§4](./security-header-network-boundary-contract.md)冻结public/direct、限期例外、DNS/peer/TLS、safe-read及撤销；仅DOC |
| SEC-F3-02A | DONE | 限定纯compiler完成：严格v1配置/URL/origin、IPv4/IPv6完整分类、IPv4-mapped归一与精确private-exception；静态表版本iana-2025-10-09-conservative-v1，更新表时必须复核IANA差异并重跑边界回归。network专项165项、Parser 30 suites/722 tests及typecheck/build通过；不接DNS、真实发送或host续期/撤销，不关闭父F3 |
| SEC-F3-02B1 | DONE | 限定受控DNS批准结果完成：真实UDP 26/26、Parser 31 suites/748 tests及typecheck/build通过；覆盖A/AAAA/CNAME有界全集、规范化去重、逐地址政策授权及混合/未分类/截断失败关闭。仅产出DNS批准结果，无上游socket、peer或TLS证据 |
| SEC-F3-02B2 | DONE | 限定≤8MiB Buffer单跳transport primitive完成：31专项、Parser 32 suites/779 tests、typecheck/build通过；真实HTTP/TLS/peer/代理陷阱与Windows Node24已有证据。无Gateway/Transformer host接线、Readable/大体积流或逐跳撤销 |
| SEC-F3-02B3a | DONE | 限定共享private verified connection与Readable stream完成：Parser 33 suites/817 tests、stream专项38、B2既有31及typecheck/build通过；真实24MiB双向、backpressure、授权前body零读取、peer/TLS/代理/取消/截断/early response/one-shot已验。首轮816/817为B1真实DNS后置复核50ms夹具负载失败，仅测试改为真实解析后受控时间，生产deadline不变；仍无Transformer/Gateway/child生产接线 |
| SEC-F3-02B3b | DONE | 限定Parser host桥完成：7文件，Parser 34 suites/838 tests、专项21、typecheck/build及diff-check通过；真实Resolver绑定Site/generation/revision（含None），同Snapshot WeakMap host policy与最终序列化URL，bounded≤8MiB JSON/string/Buffer，默认网络模式off且F1零发送；Registry/DNS/HTTP/TLS及clone/reload/伪造/变异负测通过。生产Gateway/managed child、Provider撤销epoch及audit桥未接；父B3/F3保持IN_PROGRESS |
| SEC-F3-02B3c | DONE | 限定Gateway route桥完成：Provider active/denied/unavailable三态；显式撤销/身份错→502，可信host回调抛错与DNS SERVFAIL→503，deadline→504。最终新HTTP/TLS专项46、相关6 suites/111 tests、API build及diff-check通过；修复前Gateway全目录43 suites/627不称最终一次全绿，Parser 34 suites/841仍适用。默认off、无生产DI/Provider注册或外部配置入口；B3a/b/c聚合限定完成 |
| SEC-F3-02C1a | DONE | 限定纯authority模块完成：新2文件/专项24，host-only opaque handle固定epoch/revoke同步abort、总deadline及有界容量；统一Parser 37 suites/907 tests及typecheck/build通过。未接运行时、宿主epoch或Provider事件桥 |
| SEC-F3-02C1b | DONE | 限定Parser接线完成：host-only路径在Resolver/body读取前固定同一opaque handle、Snapshot、凭据、epoch及总deadline/abort；Parser 38 suites/925 tests、最终C1a+C1b定向2 suites/42 tests、typecheck/build及diff-check通过。生产默认仍关闭，真实Provider撤销事件桥和多进程传播未接 |
| SEC-F3-02C1c | DONE | 限定Gateway接线完成：4源码文件，Gateway 43 suites/649 tests、真实HTTP/TLS专项62/62、API build及diff-check通过；prepare/forward共享同一opaque handle、冻结Snapshot/凭据/epoch并贯通总deadline/abort，cache保持关闭且单attempt。生产DI/watch/原子epoch及真实Provider事件桥仍待C1d1–d4，默认生产关闭 |
| SEC-F3-02C1d1 | DONE | 限定host安全epoch/Registry提交事件合同完成：自身2 suites/16 tests、Parser 41 suites/971 tests（含C2a）、typecheck/build及diff-check通过；提供host-owned按source单调epoch与提交观察点。Gateway生产DI/active-route目录及外部Provider原子revision/event仍未接，生产默认关闭 |
| SEC-F3-02C1d2a | DONE | 限定可信active-route目录完成：SQL.js/旧快照2 suites/42 tests、Gateway 44 suites/664 tests、API build及diff-check通过；真实SQL.js dirty-read复现后以同步export到独立query_only副本修复，candidate/rollback不发布且stop/delete同步撤销。PostgreSQL路径未实测，整库复制成本与原候选暂态snapshot行为保留，不构成生产装配 |
| SEC-F3-02C1d2b1 | DONE | 限定immutable host generation store完成：2个credentials文件、自身23 tests，统一Parser 44 suites/1077 tests、typecheck/build及diff-check通过；只保存内存有界材料，CAS激活并同步撤销/到期，无env/file导入、生产issuer或Registry关联。JS string不提供物理擦除保证 |
| SEC-F3-02C1d2b2 | DONE | 限定Registry capture/opaque proof完成：3个credentials文件、专用26 tests、相邻5 suites/99 tests、Parser 46 suites/1124 tests、typecheck/build、cleanup及diff-check全绿；仅host-owned内存generation→Registry真实Snapshot→一次性source proof。无env/file自动捕获、Gateway生产装配、managed child或跨进程传播。首次31 suites/801通过、14 suites因6处TS7006未运行及构建失败保留为历史，修复后已完整复验 |
| SEC-F3-02C1d2b3 | READY | D2b2/D2a/D3依赖已闭合；下一步default-off装配Gateway/Parser、active route、Registry/security epoch与proof。env/file自动捕获、外部Secret Manager、managed child、跨进程/E3b及目标环境证据仍未完成 |
| SEC-F3-02C1d3 | DONE | 限定Parser host生命周期桥完成：5 Parser文件，专项20 tests、Parser 42 suites/991 tests、全量typecheck/build及diff-check通过；source/default-off，缺providerEvidence永拒，WeakMap fixture仅为进程内不可伪造测试能力而非生产issuer。未接managed child/E3b或跨进程传播，不改变生产默认关闭 |
| SEC-F3-02C1d4 | WAIT_DEP | 等C1d2b3/C1d3；真实本地Registry/HTTP/TLS覆盖普通reload固定、失败保旧及撤销/收窄/epoch变化/到期在DNS/连接/大流阶段主动abort，shutdown无遗留资源；外部Secret Manager、多进程/E3b及目标环境另验 |
| SEC-F3-02C2a | DONE | 限定纯目标目录完成：2个独立Parser文件，专项30项及相邻5 suites/240 tests通过；按source asset与精确method+path绑定Endpoint/target，未知、歧义、跨asset、scheme降级及非受信目标失败关闭。未接多跳状态机、真实发送或生产网络模式 |
| SEC-F3-02C2b1 | DONE | 限定纯redirect chain state完成：2个network文件，专项63 tests、相邻5 suites/303 tests、统一Parser 44 suites/1077 tests、typecheck/build及diff-check通过；只接受显式safe-read空正文GET/HEAD，规范化Location/loop、最多5跳及一次性decision。纯模块不触网、不启用生产入口，默认仍single-hop |
| SEC-F3-02C2b2a | DONE | 限定raw Location唯一证据纯模块完成：2个network文件、自身21 tests、相邻3 suites/115 tests、统一Parser 45 suites/1098 tests、typecheck/build、cleanup及diff-check通过；只读rawHeaders并拒绝零个/重复/折叠/歧义/访问器/超长值。不解析目标、不触网、不改默认single-hop |
| SEC-F3-02C2b2b | READY | C2a/C2b1/C2b2a/C1b依赖已闭合；下一步逐跳消费证据与decision、精确重选Endpoint，并在同一authority/deadline/Signal内重跑DNS/peer/TLS和目标凭据，以真实DNS/HTTP/TLS验收 |
| SEC-F3-02C2b3 | WAIT_DEP | 等C2b2b/D3；Transformer仅在显式可信host配置下接入多跳与生产入口矩阵，默认保持single-hop；缺配置、protected/F1、非safe、正文、重放/撤销均失败关闭 |
| SEC-F3-02C3 | WAIT_DEP | 等C1d4；Gateway固定同一operation/route/membership/Registry版本，redirect/retry/取消共享deadline，reload/撤销后旧epoch不得继续 |
| SEC-F3-02C4 | READY | C1b/C1c限定接线已完成；下一步验证新网络模式首轮单attempt且缓存保持关闭，两侧消费同一operation handle；缓存恢复与自动retry另行登记 |
| SEC-F3-02C5a | DONE | 限定纯失败/审计模块完成：新4文件/专项42，品牌失败、502/503/504/cancel、null-prototype审计白名单及sink失败不改变拒绝；统一Parser 37 suites/907 tests及typecheck/build通过。未接生产双运行时 |
| SEC-F3-02C5b | WAIT_DEP | 等C2b3/C3/C5a；双运行时接入统一失败语义和审计，以真实HTTP负测验证fail-closed与零秘密泄漏 |
| SEC-F3-02C6 | WAIT_DEP | 等C2b3/C3/C4/C5b；本地双运行时真实联合矩阵，不代表生产默认启用或F3D Windows/Linux环境验收 |
| SEC-F3-02D | WAIT_DEP | 等C6；N01–N17 Gateway/Parser真实连接、生产默认启用及Windows/Linux环境矩阵待验收 |
| SEC-F3-03 | WAIT_DEP | E1负责argv实现，此项只消费证据 |
| SEC-F3a-01 | READY | 需在线公告时另行验证，不复用旧漏洞数 |
| SEC-F4-01 | DONE | 当前108个SEC叶子以逐项或明确聚合旧ID维护，D2b1–b3及C2b1/b2a/b2b/b3依赖已登记；区分历史/本地限定/未运行环境，不代表F4-02签收 |
| SEC-F4-02 | NEED_ENV | 目标环境与授权另核实 |
| OBS-06-01 | READY | 不重写已有发送边界 |
| OBS-06-02 | NEED_ENV | 真实环境待核实 |
| OBS-10-01 | DONE | 受管业务子进程start/stop/unexpected_exit/lost已进入独立持久投影；runtimeAssetId+serverId+generation绑定，旧generation迟到终止不能覆盖新start，管理心跳不作为业务存活。SQL.js重开4/4、真实child/事件hook 3/3、状态投影1/1、ProcessManager相邻5 suites/32及API type-check/build通过 |
| OBS-10-02A | DONE | 限定retained读模型完成：5100条保留历史有界聚合、revision水位、资产隔离、legacy坏行与SQL.js重开均覆盖，4 suites/15 tests通过。retained unfinished=0只表示保留事实中无未完成项；coverage仍为unknown，live active保持null；只投影最新generation而非全历史 |
| OBS-10-02B1 | DONE | managed start/terminal与最新generation投影在同一Store事务写入server.state_changed并分配sequence；4 suites/21 tests及API build通过。只证明同一DataSource内并发与耐久delta，不接Realtime，不证明跨实例全局水位或实时liveness |
| OBS-10-02B2 | DONE | 限定业务在途delta完成：有runtimeAssetId的gateway_request/mcp_tool仅在in-flight成员变化时与调用修订同事务写入sequence-bound delta；5 suites/28 tests及API build通过。storage旧断言因新增合法delta首轮2项失败，精确更新后storage 32/32；events 16、invocations 38、restart 3首轮通过，共89项分别验证，不称一次性脚本全绿；不接Realtime |
| OBS-13-01A | DONE | 限定server_state_v1 snapshot grant/H完成：5 suites/31 tests及API build通过；兼容43项首轮42过，补旧EventGap夹具后overview 20/20，其余23项沿用先前通过结果，不称一次性全绿。opaque token绑定H/TTL/asset/filter/current auth/isPartial/excluded；不接Realtime或消费者，旧invocation_facts_only不变 |
| OBS-13-01B1 | DONE | 限定状态专用durable delta reader完成：新reader/spec与A authorizer小接口共3文件，6 suites/39 tests、旧events/overview/bridge/Realtime脚本39/39及API build通过。组合首轮38/39源于SQL.js TypeORM bulk fixture ID回写交换；固定UUID复现后以updateEntity(false)+ID不可变断言修夹具，最终39/39，生产reader未放宽。仍未注册module/controller/WS |
| OBS-13-01B2 | DONE | 限定state realtime接线完成：新service/spec及module/gateway接线共4文件，真实Socket.IO 3 suites/23 tests、旧Realtime脚本11/11及API build通过；两真实连接以独立room隔离，无跨协议帧、旧broadcast或initial snapshot泄漏，并覆盖ACK精确、断线重放、gap、撤权和过期。过期测试首轮全局时间跃迁误触Engine.IO heartbeat，改为仅同步grant.resolve内控时，生产TTL未变；旧invocation_facts_only保持不变 |
| OBS-13-01C | DONE | 限定本地协议矩阵完成：3文件，真实Socket.IO+SQL.js 4 suites/41 tests、旧realtime+events脚本27/27及API build通过；新增18项验收，未知evidenceScope由skip改为EVENT_CURSOR_EXPIRED，并以两处合法过滤外fixture保持旧reader断言。撤权/锁定/asset缩窄、grant TTL/重启、ACK前重放/后续传、scoped gap和旧协议隔离通过；正版本乱序只发refreshRequired，DB唯一约束拒绝durable重复sequence，未ACK重放仍为合法语义。无UI reducer/exactly-once、多实例grant或跨部署证据；OBS-13-01聚合限定完成 |
| OBS-13-02 | READY | OBS-13-01 A/B1/B2/C限定出口已闭合；下一步验收长期连接、慢客户端、持久消费者及跨平台/跨部署恢复，不把本地Socket.IO矩阵外推为UI exactly-once或多实例能力 |
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
| OBS-15-02 | WAIT_DEP | 等待OBS-13-01C与OBS-15-01；不重建第二主链 |
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

## 6. 凭证与权限批次收尾（2026-09-21）

B1-01、C2-02、C3-02三个既有出口完成，DONE从62增至65。B1-02、A3-01、C3-03已满足列明依赖转READY。统一凭证只显式导出摘要配置，受管启动校验Runtime归属；没有宣称运行中的child已收到撤销或轮换。Windows原生权限28/28通过，Linux30项仍未执行。新增模型的SQLite/PostgreSQL当前基线更新为4迁移、零漂移。父包计数不因局部出口自动提升。

## 在线轮换与临时匿名（2026-09-21）

B1-02、A3-01完成，见[真实闭环证据](../audits/2026-09-21-live-rotation-temporary-anonymous.md)。A2历史父状态滞后已按原退出标准修正，与本批B1/A3共同闭合；B3-01、F2-02转READY。C3-03补真实生产接线依赖回WAIT_DEP，不以实验入口假充产品完成。

六层限流组合D2-02完成，见[验收](../audits/2026-09-21-layered-rate-limit-composition.md)。本批3个功能叶子完成，DONE由65升68；132项总量不变。共享生命周期集成已推送4680316，D2随本报告提交单独推送。

## JWT/会话/UI批次（2026-09-21）

B3-01真实双传输通过，见[会话证据](../audits/2026-09-21-persistent-session-revocation.md)。B2-01/F2-02并行实现和集成继续；不重复增加验证子任务。

B2-01完成，见[JWT参数证据](../audits/2026-09-21-jwt-policy-lifecycle.md)，安全父包B2原出口闭合。F2-02界面收尾继续。

F2-02已完成，见[匿名界面证据](../audits/2026-09-21-temporary-anonymous-ui.md)。本批DONE 68→71，132总量不变；B3与B2已分别推送c044ca2、30f6a71，本UI随本报告单独提交推送。当前无遗留IN_PROGRESS叶子，剩余18 READY、23 WAIT_DEP、17 NEED_ENV、1 SCOPE_REVIEW、2 DEFERRED按原条件继续。

## SDK/管理分区/Header批次（2026-09-21）

D1-01已定稿，D1-02转READY；这1项是DOC完成，不计为Header功能实现。B3-02与F2-01独立验收中。

B3-02完成，见[SDK合同](../audits/2026-09-21-sdk-session-contract.md)。B3两叶出口完成但父依赖E0仍缺；不机械提升父状态。

F2-01完成，见[真实管理面板证据](../audits/2026-09-21-upstream-credential-management-ui.md)。本批3叶完成（CODE1/VALIDATION1/DOC1），DONE由71升74；132总量不变，剩余READY16、WAIT_DEP22、NEED_ENV17、SCOPE_REVIEW1、DEFERRED2。D1-02已解锁，Header执行缺口仍真实登记；B3/F2父包只保留原独立依赖。

## Header拆分、Adapter与对账批次（2026-09-21）

原D1-02替换为02A/B/C/D四叶，总量132→135不是新增完成。F1-01[四态合同](./upstream-security-reconciliation-contract.md)已定稿，实际门禁F1-02仍等待C1-02。

D1-02A编译准备完成，02B转READY，见[证据](../audits/2026-09-21-header-policy-compilation.md)。不将未接过滤执行器的候选元数据计为Header保护上线。

E0-01完成，见[Adapter证据](../audits/2026-09-21-mcp-adapter-contract.md)，原E0/B3父包出口与依赖复核DONE。本批实际关闭3叶（DOC1/CODE准备1/VALIDATION含修复1）；当前77DONE/135叶，14READY、24WAIT_DEP、17NEED_ENV、1SCOPE_REVIEW、2DEFERRED。

## 2026-09-21 类型合同与双向流推进

C1-01已完成[合同](./upstream-credential-types-contract.md)与源码静态对照；新增Basic/CustomHeader、生命周期/Scope尚待C1-02执行。DOC不计作新代码或测试，父包C1继续IN_PROGRESS。02B与F3-01并行推进中。

F3-01合同及矩阵同步完成，C1-01/F3-01两项DOC已关闭；当前79DONE、12READY、1IN_PROGRESS、23WAIT_DEP、17NEED_ENV、1SCOPE_REVIEW、2DEFERRED，总量135。02B真实流继续推进，所有父包状态不变。

02B完成，[证据](../audits/2026-09-21-header-wire-execution.md)含双向过滤、真实压缩/分块/取消/重复framing、提前响应/103、Expect入口和连接隔离；生产NOT_READY全部保留，02C READY。最终80DONE、13READY、22WAIT_DEP、17NEED_ENV、1SCOPE_REVIEW、2DEFERRED、0IN_PROGRESS，总量135。两个DOC已分别推送f592deb/e3dd364；本代码包随本记录提交推送。

## 2026-09-22 凭据类型与缓存批次

C1-02及父包C1已按[原出口证据](../audits/2026-09-22-credential-types-scope.md)闭合，F1-02已READY。没有增加叶子；当前81DONE/135，02C缓存接线继续收尾。

02C[缓存隔离](../audits/2026-09-22-header-cache-isolation.md)完成，02D READY；C1包已推送fec02f7，本缓存包随本记录提交推送。最终82DONE、13READY、20WAIT_DEP、17NEED_ENV、1SCOPE_REVIEW、2DEFERRED、0IN_PROGRESS，总数135；安全父包9/11/2/1，跨两专项19/16/3/1。
## 2026-09-24 F1-02真实交付链拆分

原F1-02从纯声明对账延伸到可信Binding适配、耐久验证证据、发布/激活事务复核、两运行时执行前复核及双数据库/并发验收，不能继续作为单叶推进。现替换为A–F六叶，总量138→143。A已有声明保留、OR/AND纯对账及发布写入前拒绝，限定DONE；B READY；C/D/E/F按前置WAIT_DEP。父TP-F1保持IN_PROGRESS，A完成不代表可信验证、Gateway/MCP零联网或PostgreSQL重开已验收。
## 2026-09-24 D1与F1首叶完成

SEC-D1-02D1以5套118项完成同一Registry快照到Prepared Exchange的执行材料接线；D3再以2套24项及API构建完成listen前实际HTTP入口事件安装。D2A以3套57项完成纯迁移合同/Schema helper；D2B以6套65项完成两新建入口v1草稿/来源持久写入、旧路由不回填与NOT_READY先行，D2C以3套45项完成显式例外生命周期与持久墓碑，D2D以SQLite/隔离PG迁移冷启动、CAS、撤销及重开4套49项和API构建完成；D4拆为A/B/C：A纯guard与局部HTTP 37项DONE，B以5套68项完成生产503守卫且无cache/Resolver/upstream绕过，C以14套223项及隔离PG完成限定矩阵盘点，acceptanceComplete:false，H07冷启动与membership正式正向未闭环；D4D1与D4D2 DONE；D2以SQLite 4套6项、API build及隔离PG zero-drift完成双库Ledger但不接Provider，D4D3以2 suites/31、API build及SQL.js/隔离PG双进程冷启动路径完成，D4D4以SQL.js/隔离PG双Node真实HTTP、4个API组合37项与Parser契约12项完成H07跨启动历史验收；H11A以16项真实联合用例、strict helper 10项、Gateway+Publication 58 suites/778 tests及API build完成Registry-source v1受控激活；H11B已开工，沿RuntimeAssets deploy→plan/replay→activate→Nest HTTP/cache路径执行生产H01–H12验收；全API首轮116 suites/1293 tests中115 suites/1292 tests通过，唯一process-manager.temporary-anonymous suite超时；该suite单跑4/4在12.09s通过且未改测试，不记录为一次性全API全绿。F1 Verified未接线，inline/legacy/unknown继续fail-closed，无外部部署；父TP-D1仍IN_PROGRESS。SEC-F1-02A以17套234项及API构建完成声明保留、OR/AND纯对账和发布/装配写入前拒绝；B以5套57项及API构建完成可信Binding评估与opaque Provider epoch接入，C1以独立entity/repo、挑战服务、真实挑战与磁盘SQL.js重开14/14完成原型，F1目录6套71项和API构建通过；C2以SQLite+隔离PG 70表/5迁移冷启/重开/回退零漂移、12套83项、迁移9/9及API构建完成生产证据存储注册；C3进一步拆为a上下文authority、b挑战transport、c proof authority、d生产持久evidence kind、e挑战编排、f安全入口、g发布/运行消费者；a/b/c以4 files、27 tests、API security 8 suites/105及build限定完成，d以生产独立evidence表、双库CHECK/迁移/注册、16 suites/120及双库72表/7迁移zero drift限定完成；e以四阶段loopback/SQLite编排、10 suites/123及API build限定完成，f以2 files/24 tests、security 10 suites/146及API build限定完成；G1以30 tests、security 11 suites/176及API build完成消费adapter，G3以2 files、1 suite/10项SQL.js及API build完成单成员事务writer；G2以2 files、2 suites/43及API build完成只读adapter，SQL仅SELECT且实体/evidence零变更、canPublish恒false；G4有界executor切片以3 suites/30 tests及API build限定完成：生产G2默认false/G3零调用，future-readiness fixture仅证明部分提交/后续继续，candidate仅host-owned同步swap无await且未接异步Registry生产链；D READY、G5独立Gateway proof consumer guard实施中、G6等待，不代表production batch/candidate activation完整且全部保护fail-closed；Gateway E1以39套556项、13项真实HTTP SQL.js重校及API构建DONE但不声明生产Verified；E2以Parser28套545项、API102套1116项、三构建与扩例7/7完成唯一声明规则/标准HTTP门禁；Verified/custom handlers及E3 managed在线传播不在该出口，E3a以2 files/7 tests完成受限协调原语但未注册/未接handoff；E3b运行中阻断/实时授权/事件IPC等待，D/F保持依赖。父TP-D1和TP-F1均保持IN_PROGRESS。