---
doc-version: 1.88.0
doc-status: active
doc-updated: 2026-09-24
---
# 活跃工作包划分与验收子任务

## 1. 口径与权限边界

本页是2026-09-15重排后的调度划分，继承原批准需求，不替换或缩减父包退出条件。状态唯一入口为[子任务执行状态](./active-work-package-execution-status.md)，父包证据仍在[OBS台账](./runtime-observability-development-execution-status.md)和[SEC台账](./security-development-execution-status.md)。

39只等于OBS16+SEC23：19 DONE、17 IN_PROGRESS、2 BACKLOG、1 DEFERRED；不是全项目活跃总数，更不是完成百分比。IN_PROGRESS在旧父包表表示有实现，不表示16包正在同时开发。代码、设计草案、验收准备、环境执行分别登记，不能用文档子项DONE冒充功能交付。

上层[阶段计划](./staged-development-plan.md)、[WP00~90](./runtime-instance-and-regression-closure-plan.md)和[open-items](../reference/open-items.md)具有交叉范围，不叠加成49或其它“项目总包数”。本次覆盖这些当前入口；新需求必须先登记归属再进入队列。

## 2. 全部父包与跨计划归属

### 两个专项

OBS父包：01/02/03/04/05/07/08/09/10/11/12各为DONE；06/13/14/15各为IN_PROGRESS；16为BACKLOG。
SEC父包：A0/A1/A2/A3/B1/B2/B3/C1/E0 DONE；A4/C2/C3/C4/D1/D2/E1/E2/F1/F2/F3/F3a各IN_PROGRESS；F4 BACKLOG；G1 DEFERRED。
以下SEC-A1等子项主归属为原TP-A1；OBS-06等主归属为原OBS-TP-06。已DONE父包不为增加任务数量重新拆开发项。

| 原入口 | 本次核查后的实际边界 | 唯一执行归属/关联 |
| --- | --- | --- |
| Phase1/2 | 历史主线已交接，不重新开发 | 回归证据复用 |
| Phase3 | 活跃收口层；不是新增可相加的专项 | 下列PROD/EXT与OBS/SEC |
| WP00/10 | 历史数据库/模型实现；当前版本空库证据需刷新 | SEC-A4-01/02 |
| WP20 | 实例后端已有；归属/凭据/审计和实体验收有剩余 | SEC-C3/C4、PROD-05、EXT-04 |
| WP30 | 实例管理UI已有；真实迁移工作流需验收 | EXT-02/04 |
| WP40 | 样例护栏与授权清理已有；二进制/生产留存未闭合 | PROD-04 |
| WP50 / DEV02/03 | 内部失效/证据实现已完成，不能按旧段落重新开发 | PROD-03及EXT01~07 |
| WP60 / DEV01 | 部分完成；MCP端点配置/实际预览是明确未交付入口 | PROD-01/02 |
| WP70 | 原文声明实现完成，WP90外部场景待验；近期旧候选guard属补强 | EXT-07；PROD-06先判定CAS是否原出口，禁止自动扩包 |
| WP80 / DEV05 | 监控关联部分已有，操作者透传/运营检索仍待交付 | PROD-05与OBS10/15 |
| WP90 | 当前版本全链路和平台交付未完成 | EXT01~09、SEC-A4、OBS16、SEC-F4 |
| AUDIT01~04 | 是问题视图，不另开重复实现包 | OBS13/14/15/16 |
| SEC-DEP01 / OPS01 | 依赖审计与生产门禁 | SEC-F3a-01、OPS-01 |
| 邮件投递 | 39专项之外的未闭环工作，需先核实接口范围 | MAIL-01/02 |
| 前端整理/国际化 | 稳定后整理与随交付维护，不能无限主动微修 | MAINT-01/02 |
| OAuth / 额外令牌 / 跨协议QoS | 明确延期或范围外 | DEFER-01/02，不进当前开发队列 |

### 已验收切片：转入回归维护，不重新开开发任务

| 主归属 | 冻结的已实现范围 | 证据入口 |
| --- | --- | --- |
| SEC-A2/F2 | 管理JWT缺密钥拒绝、模式白名单、缺策略不误显示匿名 | SEC台账§10/14及对应专项 |
| SEC-B3 | tools/list过滤、tools/call二次检查、Session已有边界 | SEC台账§4及相关授权脚本 |
| SEC-C1/C2/C3 | 配置loader、Env/File Provider、Registry、stable read、manual reload/状态/审计 | SEC台账§14~20；不含Watch/平台ACL |
| SEC-C4/E1 | 纯Resolver、Gateway激活、显式single-hop、可信映射和管理侧装配 | SEC台账§22~28；不含真实受管child接线 |
| WP70关联 | 同语句归属/发布读取、跨源校验、旧候选观察时点guard | SEC台账§25~29；不等于完整CAS |
| SEC-D1/D2 | Connection/代理头修复、缓存身份隔离 | SEC台账§19/21；不含业务allowlist/全层限流 |
| OBS10/13/15 | 管理心跳、路由注册、调用事实页流、Gateway日志UI | OBS台账§7~12；不含业务健康/全局状态流 |
| OBS14 | TTL策略/管理UI、有界正文GC、扫描容量样本、恢复/停机/重试 | OBS台账§9~15；不含配额/全部元数据清理 |

## 3. 剩余子任务合同

类型：CODE为实现交付，DOC为方案/交接交付，VALIDATION为执行验收，ENV为依赖目标环境的验收。依赖“—”只表示无需等待另一个新子项，仍依赖既有基线。环境可用性未复核的任务不得写成“工具阻塞”，由状态表登记NEED_ENV。以下为剩余工作重拆，不是等权工作量分母。

| 子任务 | 主归属 | 类型 | 独立交付 | 退出条件 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| GOV-01 | 治理 | DOC | 全范围归属与重拆台账 | 39专项父包、交叉计划和独立项有入口；不重复统计；计划与状态互链 | — |
| SEC-A1-01 | SEC-A1 | VALIDATION | 鉴权模式跨层合同矩阵 | DTO/持久策略/UI/发布/运行时逐路径标实现与缺口；复用既有测试 | — |
| SEC-A1-02A | SEC-A1 | CODE | Gateway可见性与策略引用一致 | UI public/external语义与保存、候选和执行同一模式；清空策略引用可明确生效，不静默放开内部路由 | SEC-A1-01 |
| SEC-A1-02B1 | SEC-A1 | CODE | MCP HTTP入站模式合同与持久化 | 独立inboundAuthMode三值、DTO和双方言持久结构；旧记录模式未知时显式阻断新部署，不混用上游authConfig | SEC-A1-01 |
| SEC-A1-02B2 | SEC-A1 | CODE | 现行CLI启动与重启模式 | 每服务持久模式映射受控运行环境；启动前校验凭证配置，重启保持模式，请求正反例 | SEC-A1-02B1 |
| SEC-A1-02B3 | SEC-A1 | CODE | managed IPC模式一致性 | 实验性handoff、child预检和READY摘要核对有效模式；与存储不一致时失败关闭，不宣称生产生命周期已接线 | SEC-A1-02B1 |
| SEC-A1-02B4 | SEC-A1 | CODE | MCP模式UI选择与回填 | 选择、保存、重载、预览和有效模式标签同服务端一致；阻断态可见 | SEC-A1-02B1;SEC-A1-02B2;SEC-A1-02B3 |
| SEC-A1-02C | SEC-A1 | CODE | stdio本地进程身份标签 | local_process在直连stdio元数据和审计中明确，不误报HTTP anonymous | SEC-A1-01 |
| SEC-A1-02D | SEC-A1 | VALIDATION | 鉴权模式保存到执行闭环 | Gateway/MCP/stdio按保存、发布、重启和真实请求核对有效模式与标签 | SEC-A1-02A;SEC-A1-02B4;SEC-A1-02C |
| SEC-A2-01A | SEC-A2 | VALIDATION | Gateway非法策略三入口拒绝 | 缺失/未知ref、非法或坏指纹持久快照在发布/热恢复/冷启动均拒绝；热恢复保旧有效快照 | SEC-A1-02A |
| SEC-A2-01B | SEC-A2 | VALIDATION | MCP入站模式三入口拒绝 | 缺失/未知/配置不符模式在部署、恢复和child启动均失败关闭，合法开发默认可追溯 | SEC-A1-02B2;SEC-A1-02B3 |
| SEC-A3-01 | SEC-A3 | CODE | 临时匿名治理 | reason/actor/expiry、生产双许可、到期拒绝与审计同一用例通过 | SEC-B1-01;SEC-A2-01A;SEC-A2-01B |
| SEC-A4-01 | SEC-A4 | VALIDATION | 当前版本SQLite空库和重启 | 当前实体数、初始化一次、重启零漂移记录到同一基线 | — |
| SEC-A4-02 | SEC-A4 | ENV | 当前版本PostgreSQL空库 | 同版本初始化/重启/零漂移原始日志；明确目标隔离库 | SEC-A4-01 |
| SEC-B1-01 | SEC-B1 | CODE | 统一消费者凭证模型 | Protocol/Tool scope、Subject、到期、Actor字段管理与Gateway/MCP解释一致 | — |
| SEC-B1-02 | SEC-B1 | CODE | 多Key轮换与到期执行 | 轮换族旧新Key窗口、到期和撤销跨两运行时可验证 | SEC-B1-01 |
| SEC-B2-01 | SEC-B2 | CODE | JWT校验参数化 | 允许算法/必需claims/clock skew的保存、执行和拒绝矩阵一致 | — |
| SEC-B3-01 | SEC-B3 | CODE | 持久撤销与权限传播 | 撤销后新请求和既有长连接执行拒绝；重连不恢复旧权限 | SEC-B1-02 |
| SEC-B3-02 | SEC-B3 | VALIDATION | SDK桥接与会话合同 | 当前锁定SDK的dispatcher、Session身份与scope通知边界有固定矩阵 | — |
| SEC-C1-01 | SEC-C1 | DOC | 完整凭据类型契约 | 批准类型逐项列支持/明确拒绝及生命周期、作用域；不再扩写loader | — |
| SEC-C1-02 | SEC-C1 | CODE | 剩余批准类型实现 | 按C1-01逐类型解析/注入/脱敏/拒绝验收，不引入OAuth | SEC-C1-01 |
| SEC-C2-01 | SEC-C2 | ENV | Linux Secret File权限矩阵 | 30个既定真实权限场景与隔离证据齐备 | — |
| SEC-C2-02 | SEC-C2 | CODE | Windows Secret File ACL | 受限ACL检查与合法/越权文件拒绝，不放宽系统权限 | — |
| SEC-C3-01 | SEC-C3 | CODE | Watch/debounce生命周期 | 固定源变更合并、坏文件保旧、并发reload、停机释放均通过 | — |
| SEC-C3-02 | SEC-C3 | CODE | Registry配置资产归属校验 | 配置Source/Endpoint与可信DB归属核验，未知/跨源拒绝 | — |
| SEC-C3-03 | SEC-C3 | CODE | 多进程Registry版本协调 | 激活/失败状态与实际generation跨进程可观测且无混版本执行 | SEC-E1-02B2;SEC-C3-02;SEC-E1-02C1 |
| SEC-C4-01 | SEC-C4 | VALIDATION | 两运行时Resolver执行验收 | Gateway与受管MCP继承/覆盖/None/Unresolved的联网前拒绝一致 | SEC-E1-03;SEC-F1-02F |
| SEC-D1-01 | SEC-D1 | DOC | Header业务政策定稿 | 请求/响应、多值/framing、保留字段、迁移例外逐项选择并记录 | — |
| SEC-D1-02A | SEC-D1 | CODE | Header策略编译与快照准备 | v1 schema/继承/摘要/认证名冲突与候选保旧；Gateway两源冲突及未就绪激活拒绝 | SEC-D1-01 |
| SEC-D1-02B | SEC-D1 | CODE | 双向Header与真实流执行 | 显式compiled路径allowlist/rawHeaders/framing/可信注入、Expect边界及真实流；生产启用归02D | SEC-D1-02A |
| SEC-D1-02C | SEC-D1 | CODE | Header缓存隔离 | 必需vary/策略identity、条件和范围bypass、原始响应禁存信号及真实miss/hit | SEC-D1-02B |
| SEC-D1-02D1 | SEC-D1 | CODE | Registry策略与路由执行接线 | 同一Registry快照的Site/Endpoint策略、凭据、代次、历史名随不可变Prepared Exchange供双向过滤/缓存使用 | SEC-D1-02C |
| SEC-D1-02D2A | SEC-D1 | CODE | 迁移合同与Schema校验器 | 纯迁移契约/校验器覆盖具名legacy期限、未知字段与来源变更拒绝；不接生产创建入口或持久化 | SEC-D1-02D1 |
| SEC-D1-02D2B | SEC-D1 | CODE | 新Binding v1持久创建 | 新Binding默认写入v1并持久验证；旧Binding不静默回填 | SEC-D1-02D2A |
| SEC-D1-02D2C | SEC-D1 | CODE | Legacy例外生命周期 | legacy允许显式持久写入、最长30天、到期/删除/关Provider撤销 | SEC-D1-02D2B |
| SEC-D1-02D2D | SEC-D1 | VALIDATION | 迁移冷重启与防降级验收 | 冷重启、坏迁移保留旧snapshot、unknown/deleted/disabled Provider拒绝降级 | SEC-D1-02D2B;SEC-D1-02D2C |
| SEC-D1-02D3 | SEC-D1 | CODE | 实际HTTP入口边界安装 | 在Nest/Socket.IO初始化后、listen前安装checkContinue/checkExpectation/upgrade；受信路由状态predicate，无策略头判断 | SEC-D1-02D1 |
| SEC-D1-02D4A | SEC-D1 | VALIDATION | Legacy纯Guard与局部HTTP矩阵 | 未获有效例外的旧Gateway路由拒绝，局部真实HTTP覆盖；不接生产运行时 | SEC-D1-02D2D;SEC-D1-02D3 |
| SEC-D1-02D4B | SEC-D1 | CODE | 生产运行时Legacy守卫接线 | 将期限/撤销守卫接入生产Gateway路由，未获有效例外的旧路由返回503 | SEC-D1-02D4A |
| SEC-D1-02D4C | SEC-D1 | VALIDATION | H01–H12矩阵盘点与缺口证据 | 逐项证据及隔离PG矩阵；acceptanceComplete:false，H07冷启动与membership正式正向转交D4D链 | SEC-D1-02D4B |
| SEC-D1-02D4D1 | SEC-D1 | CODE | Parser Host历史Store与Registry CAS | 受信Parser host历史存储、Registry单调CAS；跨进程重开不回退历史名集合 | SEC-D1-02D4B |
| SEC-D1-02D4D2 | SEC-D1 | CODE | Gateway历史Ledger与双库迁移 | Gateway专用Entity、SQLite/PostgreSQL ledger及前向迁移；不由请求提供历史 | SEC-D1-02D4B |
| SEC-D1-02D4D3 | SEC-D1 | CODE | Bootstrap历史编译与原子提交 | Gateway bootstrap先读历史再编译，验证后原子CAS ledger并swap快照 | SEC-D1-02D4D1;SEC-D1-02D4D2 |
| SEC-D1-02D4D4 | SEC-D1 | VALIDATION | H07双进程与坏迁移冷启动验收 | 双进程真实HTTP、坏迁移、并发reload、ledger故障及PostgreSQL/SQL.js冷启动验收 | SEC-D1-02D4D3 |
| SEC-D1-H11A | SEC-D1 | CODE | 真实Membership v1原子激活 | 仅Registry-source可信membership经持久v1 marker、trusted compile与validate后，复用G3同事务writer提交ACTIVE并在afterCommit切换route-specific snapshot；失败保留旧snapshot，inline/legacy/unmigrated/非法/未知策略继续NOT_READY | SEC-D1-02D2D;SEC-D1-02D3;SEC-D1-02D4D4;SEC-F1-02C3G3 |
| SEC-D1-H11B | SEC-D1 | VALIDATION | 生产H01–H12与缓存语义验收 | 沿RuntimeAssets.deployGatewayRuntimeAsset→plan/真实GatewayCandidateReplay→activate→Nest HTTP/cache路径重跑H01–H12，重点验证Range/If-*/Accept-Encoding在cache miss/hit下状态、Header、正文与直连一致并有隔离或bypass证据 | SEC-D1-H11A |
| SEC-D2-01 | SEC-D2 | CODE | IP与Anonymous独立限流层 | 真实请求分别触发IP、匿名bucket，鉴权缓存不能绕过 | — |
| SEC-D2-02 | SEC-D2 | VALIDATION | 完整层级限流组合 | Global/Runtime/Route/Credential/IP组合顺序与拒绝归因可验证 | SEC-D2-01;SEC-B1-02 |
| SEC-E0-01 | SEC-E0 | VALIDATION | 锁定MCP协议边界矩阵 | Method/Header/错误/Session/stdio按当前协议逐入口验收 | — |
| SEC-E1-01 | SEC-E1 | DOC | 受管启动接口与验收草案 | 实际父/child改动文件、信任来源、版本、argv秘密迁移和验收草案明确；不代表方案批准 | — |
| SEC-E1-01R | SEC-E1 | DOC | 启动方案技术审查与实施切片冻结 | 审查IPC/权限/环境/READY/legacy建议默认值，确定首个受管入口和13组验收中的必选项 | SEC-E1-01 |
| SEC-E1-02A | SEC-E1 | CODE | 安全受管启动通道 | 真实Node child经受信IPC接收配置，禁shell与argv秘密，环境边界按方案执行 | SEC-E1-01R |
| SEC-E1-02B1 | SEC-E1 | CODE | 父端可信handoff准备 | 固定受保护Registry来源、候选/绑定/环境重读核验后构造02A包，缺项fail closed | SEC-E1-02A |
| SEC-E1-02B2 | SEC-E1 | CODE | child可信映射与Resolver激活 | child加载固定Registry源并核验绑定/候选版本，标准handler消费Resolver，缺项不READY | SEC-E1-02B1 |
| SEC-E1-02C1 | SEC-E1 | CODE | 显式受管生命周期接线 | 仅持久trusted_ipc_v1模式消费B1/B2，READY后RUNNING，stop清理且无fallback | SEC-E1-02B2 |
| SEC-E1-02C2 | SEC-E1 | VALIDATION | 重启、失败与legacy边界 | 每次重启重新准备，timeout/exit/stop状态正确；旧模式不自动迁移或冒充安全 | SEC-E1-02C1 |
| SEC-E1-03 | SEC-E1 | VALIDATION | 真实child单跳执行闭环 | 受控上游验证继承/覆盖/None、缺Secret零发送、零自动跳转、legacy边界 | SEC-E1-02C2 |
| SEC-E1-04 | SEC-E1 | CODE | 运行中版本更新与撤销 | 运行child更新/撤销生效时间和在途策略明确且可验证 | SEC-E1-03;SEC-B3-01 |
| SEC-E2-01 | SEC-E2 | VALIDATION | 当前传输安全联合矩阵 | 取消/重连/回放隔离/撤销按已支持transport验证 | SEC-E1-03;SEC-E0-01 |
| SEC-E2-02 | SEC-E2 | ENV | 双平台传输矩阵 | 同版本Linux/Windows各单元有真实结果，失败留证 | SEC-E2-01 |
| SEC-F1-01 | SEC-F1 | DOC | 四态与OR/AND门禁契约 | Unsecured/Declared/Configured/Verified及Binding兼容转移表固定 | — |
| SEC-F1-02A | SEC-F1 | CODE | 声明保留与纯对账门禁 | 规范化声明、OR/AND选择、四态纯对账；受保护未配置/未验证在发布写入前拒绝 | SEC-F1-01;SEC-C1-02 |
| SEC-F1-02B | SEC-F1 | CODE | 可信Registry与Resolver适配 | 从可信DB/Registry准备Binding并关联opaque Provider epoch；不从请求或Secret值推导身份 | SEC-F1-02A |
| SEC-F1-02C1 | SEC-F1 | CODE | 脱敏耐久证据原型 | 独立entity/repo与挑战服务；真实挑战、磁盘SQL.js重开；不注册生产Entity或接Transport/API | SEC-F1-02B |
| SEC-F1-02C2 | SEC-F1 | CODE | 生产证据存储注册 | 专用证据Entity与双数据库迁移，prototype kind隔离、冷启动/重开/回退零漂移；不接生产挑战或Verified | SEC-F1-02C1 |
| SEC-F1-02C3a | SEC-F1 | CODE | 受信上下文Authority | 生产挑战前解析并冻结可信上下文authority，拒绝从请求或Secret内容反推身份 | SEC-F1-02C2 |
| SEC-F1-02C3b | SEC-F1 | CODE | 受信挑战Transport | 为真实上游挑战建立受限transport与失败分类，不在transport内授予Verified | SEC-F1-02C2 |
| SEC-F1-02C3c | SEC-F1 | CODE | Proof Authority | 对挑战proof执行可信重评与authority绑定，输出可供持久证据消费的判定 | SEC-F1-02C2 |
| SEC-F1-02C3d | SEC-F1 | CODE | 生产持久Evidence Kind | 将生产proof结果写入专用持久evidence kind，保持prototype隔离并覆盖双数据库路径 | SEC-F1-02C3c |
| SEC-F1-02C3e | SEC-F1 | CODE | 生产挑战编排 | 编排context、transport、proof与持久证据，失败时不产生Verified副作用 | SEC-F1-02C3a;SEC-F1-02C3b;SEC-F1-02C3c;SEC-F1-02C3d |
| SEC-F1-02C3f | SEC-F1 | CODE | 生产安全入口 | 在受信生产入口执行挑战编排、重评与拒绝门禁，闭合Transport/API路径 | SEC-F1-02C3e |
| SEC-F1-02C3G1 | SEC-F1 | CODE | Proof与Authorization消费Adapter | 以真实能力按source/endpoint/target/method/Binding消费proof与authorization；伪造、过期、撤销及DB行均拒绝 | SEC-F1-02C3e;SEC-F1-02C3f |
| SEC-F1-02C3G2 | SEC-F1 | CODE | 只读Preview与Readiness | preview/readiness只读消费受信结果，不写profile、route或binding | SEC-F1-02C3e;SEC-F1-02C3f |
| SEC-F1-02C3G3 | SEC-F1 | CODE | 单成员DB事务Writer | 单成员publication记录在同一数据库事务写入，部署副作用仅在commit后发生 | SEC-F1-02C3e;SEC-F1-02C3f |
| SEC-F1-02C3G4 | SEC-F1 | CODE | 批量发布与Verification Candidate | 有界切片验证批量executor的每成员独立事务与partial failure语义；生产G2保持默认拒绝，测试注入readiness不得作为生产接线或激活证据 | SEC-F1-02C3G1;SEC-F1-02C3G3 |
| SEC-F1-02C3G5 | SEC-F1 | CODE | Gateway执行Proof Guard | 独立Gateway proof consumer在Resolver/cache前拒绝缺失、过期或范围不符proof；完整接线还须同进程host challenge/session/proof issuer authority lifecycle及request-bound capability provider；不开放Verified、不改Publication入口 | SEC-F1-02C3G1;SEC-F1-02C3G3 |
| SEC-F1-02C3G6 | SEC-F1 | CODE | MCP与Child实时许可撤销 | MCP/child每次执行复核实时许可与撤销；proof不得序列化或跨IPC传递 | SEC-F1-02E3b;SEC-F1-02C3G1 |
| SEC-F1-02D | SEC-F1 | CODE | 预览发布激活统一结果 | preview、单批发布和激活消费同一结果，事务内复核context与验证证据 | SEC-F1-02C3G2;SEC-F1-02C3G4 |
| SEC-F1-02E1 | SEC-F1 | CODE | Gateway每次调用重评 | Gateway运行时每次调用重评声明与Binding，旧snapshot/撤销零联网；当前不声明生产Verified | SEC-F1-02B;SEC-F1-02C1 |
| SEC-F1-02E2 | SEC-F1 | CODE | MCP Transformer声明规则接线 | Parser共享normalizer与transformer消费同一声明规则并完成依赖审查；核心移动继续暂缓 | SEC-F1-02B;SEC-F1-02C1 |
| SEC-F1-02E3a | SEC-F1 | CODE | 受限Managed Child安全租约协调器 | ManagedChildSecurityLeaseCoordinator纯协调原语；不注册、不接handoff或事件IPC | SEC-F1-02E2 |
| SEC-F1-02E3b | SEC-F1 | VALIDATION | 运行中更新阻断与实时授权 | 真实child运行中更新前阻断、实时授权及事件IPC，在线声明撤销后零联网 | SEC-F1-02E3a;SEC-E1-03 |
| SEC-F1-02F | SEC-F1 | VALIDATION | 双运行时重开与并发验收 | Gateway/MCP端到端、SQL.js/PostgreSQL重开、并发迟到和同revision Provider变化矩阵 | SEC-F1-02D;SEC-F1-02E3b;SEC-F1-02C3G5;SEC-F1-02C3G6 |
| SEC-F2-01 | SEC-F2 | CODE | Consumer/Upstream与Reload界面 | 分区明确、binding revision与reload真实generation可查看及恢复 | — |
| SEC-F2-02 | SEC-F2 | CODE | 匿名风险与到期界面 | 申请、风险、到期和服务端拒绝一致显示 | SEC-A3-01 |
| SEC-F3-01 | SEC-F3 | DOC | 上游网络边界政策 | DNS、连接、redirect、代理及内网例外有明确允许/拒绝合同 | — |
| SEC-F3-02A | SEC-F3 | CODE | 网络政策Schema与地址分类原语 | 严格校验v1配置、URL/origin规范化、IPv4/IPv6完整拒绝分类、IPv4-mapped归一及private-exception精确CIDR/期限/始终拒绝集合；纯原语不接真实发送 | SEC-F3-01;SEC-D1-H11B |
| SEC-F3-02B1 | SEC-F3 | CODE | 受控DNS全集授权 | 受信Resolver有界解析A/AAAA/CNAME最终全集，规范化去重后逐地址套用A的编译政策；混合、未分类、截断或非法结果全部拒绝，仅返回不可变授权解析结果，不创建socket | SEC-F3-02A |
| SEC-F3-02B2 | SEC-F3 | CODE | 固定IP单跳直连与Peer复核 | 消费B1授权解析结果，每次连接固定获批IP并保留原Host/SNI/证书校验；仅直连，拒绝代理/外部Agent，Header/正文写出前复核实际peer；本叶只交付≤8MiB Buffer单跳transport primitive，不实现host/stream接线、redirect、逐跳凭据或撤销状态机 | SEC-F3-02B1 |
| SEC-F3-02B3a | SEC-F3 | CODE | Parser共享Verified Connection与大体积流矩阵 | 抽取B2固定IP/DNS/peer/TLS后的共享verified-connection句柄，Parser以Readable单跳发送并用有界背压处理大于8MiB请求/响应，覆盖取消、超时、早响应与零部分回退；不接host配置或自动redirect | SEC-F3-02B2 |
| SEC-F3-02B3b | SEC-F3 | CODE | Parser Host可信Site/Registry版本桥 | 在host-only入口把可信Site、Registry/网络政策版本与B3a bounded adapter绑定到同一逻辑操作；禁止legacy Axios/global Agent回退，不在本叶实现逐跳凭据或撤销状态机 | SEC-F3-02B3a |
| SEC-F3-02B3c | SEC-F3 | CODE | Gateway可信Route网络Provider与Stream桥 | 将可信route/membership/Registry来源接入Gateway网络Provider和stream桥，复用B3a verified connection；完整网络身份与撤销进入F3C前关闭缓存，不提前启用生产路由 | SEC-F3-02B3a |
| SEC-F3-02C1a | SEC-F3 | CODE | 共享Opaque整操作Authority | 提供host-owned不可序列化operation handle，固定policy epoch、deadline与撤销/abort信号；拒绝伪造、续期、跨操作复用及客户端构造 | SEC-F3-02B3b;SEC-F3-02B3c |
| SEC-F3-02C1b | SEC-F3 | CODE | Parser操作Authority接线 | Parser host-only路径绑定C1a handle，在Resolver与body读取前冻结同一Snapshot/凭据/epoch，所有DNS/连接/流操作共享总deadline与abort；不允许body或序列化配置创建authority | SEC-F3-02C1a |
| SEC-F3-02C1c | SEC-F3 | CODE | Gateway操作Authority接线 | Gateway可信route/Provider路径绑定C1a handle，Resolver/cache前冻结同一Snapshot/凭据/epoch与总deadline并把abort传入stream；不注册生产默认启用 | SEC-F3-02C1a |
| SEC-F3-02C1d1 | SEC-F3 | CODE | Host安全Epoch与事件合同 | 提供host-owned、按source单调的security/provider epoch事件合同及Registry提交观察点；普通reload只影响新操作，显式撤销、安全收窄、epoch不可读与到期才同步abort；禁止从文件mtime、环境变量值或配置文本猜测可信epoch | SEC-F3-02C1b;SEC-F3-02C1c |
| SEC-F3-02C1d2a | SEC-F3 | CODE | 可信Active Route目录与生命周期事件 | 只发布已提交ACTIVE route的单调版本目录与生命周期事件；candidate/rollback不发布，stop/delete同步撤销，迟到reload不得复活；外部Provider原子revision/event另由D2b闭合 | SEC-F3-02C1c |
| SEC-F3-02C1d2b1 | SEC-F3 | CODE | Immutable Host Provider Generation Store | 建立host-owned不可变generation存储，按source绑定精确Registry Snapshot与secret capture，单调发布并同步表达revoke/expiry；不从环境值、文件mtime或调用方revision推导，不接外部Secret Manager | SEC-F3-02C1d1;SEC-F3-02C1c |
| SEC-F3-02C1d2b2 | SEC-F3 | CODE | Registry Capture与Opaque Proof | 基于b1对精确Registry capture、Provider材料与generation签发/消费一次性不可伪造proof；并发变化、重放、过期、撤销及读取失败均拒绝，不把proof序列化或交给请求方 | SEC-F3-02C1d2b1 |
| SEC-F3-02C1d2b3a | SEC-F3 | CODE | Gateway Host generation capability端口 | 独立host-only不可伪造generation/issuer capability与可选注入边界；缺失默认off，不从request/config/env/file自动导入，重复issuer拒绝，close同步失效且秘密不序列化；不接RuntimeModule/Registry | SEC-F3-02C1d2b1 |
| SEC-F3-02C1d2b3b1 | SEC-F3 | CODE | Registry/evidence本地安全组合 | 显式host capability把同一store的RegistryProviderEvidence注入Registry；Snapshot→proof/epoch/readSignal同代，坏配置/缺材料失败关闭且不混用legacy providerFactory；SQL.js共享事务交错时boot fail-closed | SEC-F3-02C1d2b3a;SEC-F3-02C1d2b2;SEC-F3-02C1d3 |
| SEC-F3-02C1d2b3b2 | SEC-F3 | ENV | PostgreSQL持久ledger验收 | 真实PostgreSQL验证独立事务读、历史ledger CAS/rollback/reopen/并发与同generation proof；不得以SQL.js fail-closed替代生产持久账本正向证据 | SEC-F3-02C1d2b3b1 |
| SEC-F3-02C1d2b3c1 | SEC-F3 | CODE | Active-route原子捕获seam | 只将当前GatewayActiveRouteCatalog snapshot对象原子关联到同次已提交route对象引用；拒绝ID-only、克隆/旧snapshot，candidate/rollback零发布，stop/delete与迟到reload不能复活；不构造网络许可 | SEC-F3-02C1d2a |
| SEC-F3-02C1d2b3c2 | SEC-F3 | CODE | Active-route注册协调器 | 仅消费c1不可伪造捕获与D2b3b2已验收安全Registry组合，构造/替换可信registration；reload/removed同步撤销，坏证据保守拒绝，不接生产DI | SEC-F3-02C1d2b3c1;SEC-F3-02C1d2b3b2 |
| SEC-F3-02C1d2b3d1 | SEC-F3 | CODE | 品牌稳定facade与成对原子装配 | 同bundle provider/resolver原子swap、旧lease固定旧pair、受保护scope有界墓碑与同步撤销；缺capability默认off，proof到期须host显式新proof重装；不接RuntimeModule | SEC-F3-02C1d2b3c2 |
| SEC-F3-02C1d2b3d2a | SEC-F3 | CODE | host模式早期互斥与可信只读Snapshot | 共同启动依赖早于旧Registry/watch判互斥；host旧Registry=null/admin disabled，PolicyService读取受控Snapshot供route初始化，启动/失败整个Gateway闭锁且非Gateway健康，无host不变 | SEC-F3-02C1d2b3d1 |
| SEC-F3-02C1d2b3d2b | SEC-F3 | CODE | Nest启动后显式网络装配 | onApplicationBootstrap等待真实committed route初始化，再以新proof执行c2/d1装配；稳定facade/冲突拒绝和真实Nest/PG/HTTP联合验收 | SEC-F3-02C1d2b3d2a |
| SEC-F3-02C1d3 | SEC-F3 | CODE | Parser Host生命周期桥 | host-only装配TrustedSingleHopNetworkExecution与C1d1 lifecycle，注册可信Snapshot/policy并消费同进程reload/revoke/expiry；source/default-off，providerEvidence缺失永拒，WeakMap只作进程内不可伪造夹具且不是生产issuer；不接managed child/E3b IPC或跨进程传播 | SEC-F3-02C1d1;SEC-F3-02C1b |
| SEC-F3-02C1d4 | SEC-F3 | VALIDATION | Host/Provider生命周期联合验收 | 真实本地Registry/HTTP/TLS验证普通reload在途固定旧Snapshot且新请求见新，撤销/安全收窄/provider epoch变化/到期在DNS、连接和大流阶段主动abort，失败reload保旧且shutdown无遗留监听/定时器；外部Secret Manager、多进程/E3b及目标环境另验 | SEC-F3-02C1d2b3d2b;SEC-F3-02C1d3 |
| SEC-F3-02C2a | SEC-F3 | CODE | 精确受信Redirect目标目录 | 纯host-owned目录按source asset、精确method+path与Endpoint绑定目标；只接受精确路径，未知、歧义、跨asset、scheme降级和非受信目标一律拒绝，不启用生产网络模式 | SEC-F3-02C1b |
| SEC-F3-02C2b1 | SEC-F3 | CODE | 纯Redirect Chain State | 纯模块只接受显式safe-read空正文GET/HEAD，规范化Location与loop key、最多5跳，并为每跳产生一次性decision；非safe method、正文、歧义/重复/过量跳数失败关闭，不触网也不启用生产入口 | SEC-F3-02C2a |
| SEC-F3-02C2b2a | SEC-F3 | CODE | Raw Location唯一证据 | 纯模块只从transport rawHeaders读取唯一Location，拒绝零个/重复/折叠/歧义/访问器/超长值，并输出一次性不可伪造证据供C2b1消费；不解析目标、不触网、不改默认single-hop | SEC-F3-02C2b1 |
| SEC-F3-02C2b2b1 | SEC-F3 | CODE | Host-only同代readSignal | 从D2b2可信Registry proof读取同一generation并与issuer生命周期稳定合成同步AbortSignal；只提供host-owned进程内读信号，消费者仍须把可信撤销原因映射为denied/unavailable，不启用env/file或生产网络模式 | SEC-F3-02C1d2b2 |
| SEC-F3-02C2b2b2 | SEC-F3 | CODE | 同一Authority逐跳真实Transport | 每跳消费b2a证据与C2b1 decision，通过C2a精确重选Endpoint，在D2b2同代proof及b2b1 readSignal约束的同一operation authority/deadline/AbortSignal内重跑DNS/peer/TLS和目标凭据；真实DNS/HTTP/TLS验收且默认single-hop | SEC-F3-02C2a;SEC-F3-02C2b1;SEC-F3-02C2b2a;SEC-F3-02C1d2b2;SEC-F3-02C2b2b1 |
| SEC-F3-02C2b3 | SEC-F3 | CODE | Transformer显式Host配置与生产入口矩阵 | Transformer仅在显式可信host配置下接入b2b2多跳状态机，默认保持single-hop；覆盖缺配置、protected/F1、非safe、正文、重放/撤销与生产入口矩阵，不把请求字段当授权 | SEC-F3-02C2b2b2;SEC-F3-02C1d3 |
| SEC-F3-02C3 | SEC-F3 | CODE | Gateway固定操作生命周期 | Gateway每次请求固定同一host-owned operation、route/membership/Registry版本与deadline；redirect/retry/取消共享该操作，reload/撤销后不得继续旧epoch | SEC-F3-02C1d4 |
| SEC-F3-02C4 | SEC-F3 | CODE | 首轮缓存关闭单Attempt合同 | 新网络模式首轮仅允许单attempt并强制缓存关闭，证明Parser/Gateway均消费同一operation handle；恢复缓存与自动retry另行登记，不能由本叶提前启用 | SEC-F3-02C1b;SEC-F3-02C1c |
| SEC-F3-02C5a | SEC-F3 | CODE | 网络失败语义与脱敏审计合同 | 冻结DNS/peer/TLS/redirect/取消/到期/撤销的拒绝码、白名单决策与脱敏审计字段，以纯合同/spec验证denied与unavailable分类；可在B3c闭合后与C1并行 | SEC-F3-02B3c |
| SEC-F3-02C5b | SEC-F3 | CODE | 双运行时失败与审计接线 | Parser/Gateway接入C5a统一失败语义和审计，真实HTTP负测确保各跳拒绝fail-closed、零秘密泄漏且不绕过operation lifecycle | SEC-F3-02C2b3;SEC-F3-02C3;SEC-F3-02C5a |
| SEC-F3-02C6 | SEC-F3 | VALIDATION | 双运行时真实联合矩阵 | 本地真实Parser/Gateway联合验证整操作epoch、逐跳重选/凭据重建、主动abort、单attempt/cache-off及拒绝审计；不代表生产默认启用或F3D Windows/Linux环境矩阵 | SEC-F3-02C2b3;SEC-F3-02C3;SEC-F3-02C4;SEC-F3-02C5b |
| SEC-F3-02D | SEC-F3 | VALIDATION | N01–N17双运行时网络拒绝验收 | Gateway/Parser真实连接覆盖DNS全集、peer/TLS、代理拒绝、redirect、凭据零泄漏、reload/撤销，并记录Windows/Linux与未运行环境边界；生产默认启用仍须独立验收 | SEC-F3-02C6 |
| SEC-F3-03 | SEC-F3 | VALIDATION | 秘密与生命周期审计矩阵 | argv/log/错误/证据无完整Secret；创建/更新/撤销审计可检索 | SEC-E1-03;SEC-C3-02 |
| SEC-F3a-01 | SEC-F3a | VALIDATION | 当前依赖可达性审计 | 锁文件固定、生产可达性、补丁/风险处置逐项记录 | — |
| SEC-F4-01 | SEC-F4 | VALIDATION | 安全交付证据索引 | 各验收项映射脚本/版本/环境/缺口，区分准备与执行 | — |
| SEC-F4-02 | SEC-F4 | ENV | 安全发布验收 | 各父包出口、平台/DB/依赖/部署门禁齐备，真实证据签收 | SEC-E2-02;SEC-D2-02;SEC-F1-02F;SEC-F2-02;SEC-F3-03;SEC-F3a-01 |
| OBS-06-01 | OBS-06 | VALIDATION | MCP正文与终态矩阵 | 支持transport的成功/超时/取消/大响应及Windows原生对照有结果 | — |
| OBS-06-02 | OBS-06 | ENV | MCP跨平台正文验证 | Linux与Windows同版本矩阵分别留证，限制明确 | OBS-06-01 |
| OBS-10-01 | OBS-10 | CODE | 业务进程生命周期来源 | 至少一个实际受管进程启动/停止/失联证据进入状态，不能用管理心跳替代 | — |
| OBS-10-02A | OBS-10 | CODE | 在途、历史与缺证据读模型 | 复用当前调用行、受管生命周期投影与同一Store快照水位，使持久当前在途、start/terminal历史和unknown/unavailable语义可查询；零值不得解释为无业务流量 | OBS-10-01 |
| OBS-10-02B1 | OBS-10 | CODE | Managed生命周期耐久Delta | managed start/terminal在更新最新generation投影的同一CallObservabilityStore事务分配sequence并写既有耐久事件表；仅交付sequence-bound durable delta，不接Realtime | OBS-10-02A |
| OBS-10-02B2 | OBS-10 | CODE | In-flight状态耐久Delta | 仅对有runtimeAssetId的gateway_request/mcp_tool，把in-flight started/terminal成员变化在更新调用修订的同一Store事务写入共用状态delta；不把保留窗口计数写成实时存活，不接Realtime/grant/ACK/gap恢复 | OBS-10-02B1 |
| OBS-13-01A | OBS-13 | CODE | server_state_v1 Snapshot Grant与水位 | 在servers/status同一Store.readSnapshot成功提交后签发独立server_state_v1 grant，绑定水位H、principal/fingerprint、授权asset集合及筛选；范围只含B1 managed lifecycle与B2 retained business in-flight，旧invocation_facts_only合同不变 | OBS-10-02B1;OBS-10-02B2 |
| OBS-13-01B1 | OBS-13 | CODE | 状态专用Durable Delta Reader | 复用A的server_state_v1 grant、签名cursor及同一runtime_observability_events；每页读前后复核当前DB角色/资产范围，只接受managed_server_process_lifecycle与retained_business_in_flight，gap/expiry强制resnapshot。生命周期delta只返回受限字段与refreshRequired，不能单靠delta重建完整status DTO；不接WebSocket | OBS-13-01A |
| OBS-13-01B2 | OBS-13 | CODE | 显式状态WebSocket订阅、ACK与重连 | 以新的状态订阅/确认/delta/error事件名消费B1页；整页ACK后推进签名cursor，ACK前断线重放，使用last fully processed cursor恢复，并保持既有invocation_facts_only事件名、handler与cursor不变 | OBS-13-01B1 |
| OBS-13-01C | OBS-13 | VALIDATION | 权限变化、重连与乱序负测 | 覆盖读前后撤权、角色/asset缩窄、错误principal/filter/grant、TTL/重启失效、ACK前后断连、旧subjectVersion与重复sequence；legacy/asset/global多实例水位及live liveness仍unknown | OBS-13-01A;OBS-13-01B1;OBS-13-01B2 |
| OBS-13-02 | OBS-13 | VALIDATION | 长期传输与慢客户端验收 | 有限缓冲/ACK/恢复/断连按状态流和调用事实流验证 | OBS-13-01C |
| OBS-14-01 | OBS-14 | DOC | 生命周期引用/墓碑规则 | 事件/投递/receipt/元数据/正文引用和到期顺序逐类定清 | — |
| OBS-14-02 | OBS-14 | CODE | 删除后回滚的过期元数据整理 | 有界持久进度、同fence、重启/重复运行可恢复；有效对象不变 | — |
| OBS-14-03E1 | OBS-14 | CODE | 事件删除缺口与查询保护 | 持久非连续sequence缺口，旧游标/afterSequence命中时安全返回410 | OBS-14-01;OBS-14-02 |
| OBS-14-03E2A | OBS-14 | CODE | 过期事件候选与dry-run | 无删除副作用的有界候选选择、引用/租约保护与脱敏计数 | OBS-14-03E1 |
| OBS-14-03E2B | OBS-14 | CODE | 过期事件有界物理清理 | 明确授权后将缺口、删除和持久进度置于同事务，默认关闭 | OBS-14-03E2A |
| OBS-14-03E3 | OBS-14 | VALIDATION | 事件生命周期整体验收 | 非连续TTL、回滚/重启、Outbox水位、新旧游标与重复清理完整验证 | OBS-14-03E2B |
| OBS-14-03D | OBS-14 | CODE | 投递与receipt墓碑清理 | 满足30天投递留存及引用保护，墓碑边界与重复导入行为可验收 | OBS-14-01;OBS-14-02 |
| OBS-14-04 | OBS-14 | DOC | 配额计量与降级合同 | 明确计量对象、预算分配、并发写入拒绝与fail-open/fail-closed | — |
| OBS-14-05A | OBS-14 | CODE | 正文配额账本与预留原语 | 持久epoch、原子额度、幂等预留/结算、严格配置与未知占用保护 | OBS-14-04 |
| OBS-14-05B | OBS-14 | CODE | 正文发布配额门禁 | prepare/publish接入预算，峰值/复用/失败的正文省略语义正确 | OBS-14-05A |
| OBS-14-05C1 | OBS-14 | CODE | 正文配额只读盘点原语 | 有界只读枚举、完整性/字节/游标证据；不改账本、不删对象 | OBS-14-05B |
| OBS-14-05C2A | OBS-14 | CODE | 持久只读完整前缀 | 完整shard前缀及游标持久证据，复核owner/epoch/generation；不建立baseline | OBS-14-05C1 |
| OBS-14-05C2B1 | OBS-14 | CODE | 跨批writer/GC围栏原语 | 同owner/generation隔离围栏跨扫描批次持有，失败/停机安全收敛；不确认baseline | OBS-14-05C2A |
| OBS-14-05C2B2 | OBS-14 | CODE | 受围栏保护的原子baseline | 围栏下复核持久前缀，按一致性边界确认初始化预算 | OBS-14-05C2B1 |
| OBS-14-05C2B3 | OBS-14 | VALIDATION | 围栏与baseline故障验收 | 双Store写者、崩溃重启和事务失败不超卖、不误ready | OBS-14-05C2B2 |
| OBS-14-05C2C1 | OBS-14 | CODE | 预留与孤儿占用只读证据 | 有界识别未结算预留、最终/临时残留及未知占用，不改账本或文件 | OBS-14-05C2B3 |
| OBS-14-05C2C2A | OBS-14 | CODE | 未结算预留保守降级 | 围栏下精确复核owner/epoch/generation与预留，将reserved原子标为uncertain且ledger degraded，不减少reservedBytes | OBS-14-05C2C1 |
| OBS-14-05C2C2B1 | OBS-14 | CODE | 双方言发布意图模型 | 独立表、SQLite/PostgreSQL前向迁移与注册/原语；旧预留不回填，不接写入或结算 | OBS-14-05C2C2A |
| OBS-14-05C2C2B2 | OBS-14 | CODE | 预留与意图同事务写入 | 首次文件操作前同事务保存预留/精确final/temp意图，重复发布复用原路径；不结算旧未知 | OBS-14-05C2C2B1 |
| OBS-14-05C2C2B3 | OBS-14 | VALIDATION | 意图崩溃窗口验收 | 写前、临时写、发布、结算及receipt前崩溃导出重启；旧无意图保持未知 | OBS-14-05C2C2B2 |
| OBS-14-05C2C2C1 | OBS-14 | CODE | 围栏内只读精确关联判定 | 从意图到预留、receipt、invocation及当前/历史payload引用逐项证明；缺失/冲突仅blocked，不改账本或文件 | OBS-14-05C2C2B3 |
| OBS-14-05C2C2C2A | OBS-14 | CODE | 围栏内只读文件占用证明 | 在单次inventory围栏内重验DB链、完整扫描受管根、final digest/长度与temp缺失；仅产未提交证明，不动账本 | OBS-14-05C2C2C1 |
| OBS-14-05C2C2C2B | OBS-14 | CODE | 最终事务原子结算 | 同围栏内再次核对DB/文件与账本CAS，只对完整正向证据结算；任何旧未知或冲突保持占用 | OBS-14-05C2C2C2A |
| OBS-14-05C2C3 | OBS-14 | VALIDATION | 恢复对账故障验收 | 重启、重复、外部元数据失败和残留占用不漏计 | OBS-14-05C2C2C2B |
| OBS-14-05C3 | OBS-14 | VALIDATION | 崩溃重启与多写者配额验收 | 预留、写入、发布及元数据事务失败各点重启；不超卖、不少计、残留保护 | OBS-14-05C2C3 |
| OBS-14-05D | OBS-14 | VALIDATION | 配额状态与故障联调 | 高低水位、物理余量、权限、长期压力与业务旁路完整验证 | OBS-14-05C3 |
| OBS-14-06A | OBS-14 | CODE | 管理审计30天清理 | 独立审计保留边界与有界删除/权限审计有证据 | OBS-14-01 |
| OBS-14-06T | OBS-14 | CODE | 未导入暂存恢复 | 暂存扫描、导入状态与重启恢复具有持久进度且不丢有效数据 | OBS-14-01 |
| OBS-15-01 | OBS-15 | CODE | 迁移一个旧调用者查询入口 | 新API查询/权限/分页完整；删对应旧调用链，无回退/双计数 | — |
| OBS-15-02 | OBS-15 | VALIDATION | 全链路身份与切换验收 | 外部请求到事件/投递来源一致，拒绝审计、旧端点清单和回退步骤明确 | OBS-15-01;OBS-13-01C |
| OBS-16-01 | OBS-16 | DOC | 验收交接基线校准 | AC01~20证据入口、28/28限定合同、未执行环境清单无矛盾 | — |
| OBS-16-02 | OBS-16 | VALIDATION | 本地故障/承载单元 | 冻结数据规模/指标/版本，运行可用Windows隔离单元并记录失败 | OBS-16-01 |
| OBS-16-03 | OBS-16 | ENV | Linux/PostgreSQL/多进程单元 | 逐环境同版本数据和原始结果，不以历史43表替代 | OBS-16-01 |
| OBS-16-04 | OBS-16 | ENV | 可观测部署交付签收 | 批准AC、性能、运行开关和回退证据齐备 | OBS-16-02;OBS-16-03;OBS-15-02;OBS-14-05D |
| PROD-01 | WP60/DEV01 | DOC | MCP发布端点合同 | port/transport/endpointPath校验、默认值与预览规则一致 | — |
| PROD-02A1 | WP60/DEV01 | CODE | MCP发布后端配置与预览 | DTO、统一配置解析、保存/更新语义、授权预览及summary一致 | PROD-01 |
| PROD-02A2 | WP60/DEV01 | CODE | MCP候选与端点配置一致性 | 实际端点三项进入候选身份，激活前复核，失败保留旧配置 | PROD-02A1 |
| PROD-02B | WP60/DEV01 | CODE | MCP发布UI接线 | 发布表单、回填、预览取消、部署提交与中英文文案一致 | PROD-02A2 |
| PROD-02C | WP60/DEV01 | VALIDATION | MCP端点真实监听验收 | Streamable/SSE自定义路径、消息路径、失败保旧及访问地址与预览一致 | PROD-02A2;PROD-02B |
| PROD-03 | WP50/DEV02/03 | VALIDATION | 真实治理发布回归准备 | 现有内部实现不重做，注册→变更失效→重验→发布用例可执行 | — |
| PROD-04A | WP40/DEV04 | DOC | 二进制样例存储合同 | 内容类型/编码/摘要/大小、对象引用、权限、TTL与清理顺序冻结 | — |
| PROD-04B1 | WP40/DEV04 | CODE | 二进制对象模型与存储原语 | 专用实体、默认关闭根目录、staged→ready、有界字节/摘要与内部读取 | PROD-04A |
| PROD-04B2A | WP40/DEV04 | CODE | 真实HTTP字节与描述符 | 识别真实响应字节、有界测量与描述符，默认关闭且不伪造完整摘要 | PROD-04B1 |
| PROD-04B2B1 | WP40/DEV04 | CODE | 成功样例原始对象接线 | 真实响应字节与run/sample对象引用按默认关闭门禁接入 | PROD-04B2A |
| PROD-04B2B2 | WP40/DEV04 | VALIDATION | 对象事务补偿与重启验收 | 文件/DB失败、重复执行、不可读半对象与待清理墓碑 | PROD-04B2B1 |
| PROD-04B2C | WP40/DEV04 | CODE | 受权二进制内容读取 | server:manage校验关联sample后读取，不泄路径与未授权内容 | PROD-04B2B2 |
| PROD-04B3A | WP40/DEV04 | CODE | 样例引用撤销与持久墓碑 | 显式删除/到期清理先撤销读取权并持久待删状态，不物理unlink | PROD-04B2C |
| PROD-04B3B | WP40/DEV04 | CODE | 显式有界对象整理 | 仅已撤销引用的对象按受控key有界unlink、失败保墓碑/重试 | PROD-04B3A |
| PROD-04B3C | WP40/DEV04 | CODE | 二进制验证语义阻断 | 不支持原始字节比较时明确unsupported；仅显式status-only可跳过内容 | PROD-04B2C |
| PROD-04B3E1 | WP40/DEV04 | CODE | 对象发布与清理互斥原语 | SQL.js同进程及PostgreSQL跨进程持锁覆盖文件动作；失败不误清，尚不整理无sample孤儿 | PROD-04B3B |
| PROD-04B3E2 | WP40/DEV04 | CODE | 无样例暂存墓碑受控整理 | 仅安全宽限后、无sample引用的staged对象持久认领并按受控key有界清理，失败保墓碑重试 | PROD-04B3E1 |
| PROD-04B3E3 | WP40/DEV04 | VALIDATION | 暂存孤儿并发/重启验收 | 发布与清理竞争、无sample事务失败、ENOENT/文件/DB故障、跨进程与重复执行不误删 | PROD-04B3E2 |
| PROD-04B3D | WP40/DEV04 | VALIDATION | 删除与回放恢复验收 | 撤销竞争、重启重试、回放不伪成功和留存边界 | PROD-04B3B;PROD-04B3C;PROD-04B3E3 |
| PROD-04C | WP40/DEV04 | VALIDATION | 二进制样例留存验收 | 到期回收、引用一致、重启/重复执行及越权读取完整验证 | PROD-04B3D |
| PROD-05 | WP80/DEV05 | CODE | 操作者透传与运营审计检索 | 实例/绑定变更actor到审计可查询，权限拒绝可验证 | — |
| PROD-06 | WP70 | DOC | 核定CAS是否属于原包剩余出口 | 逐条引用批准要求区分原WP70已实现出口与新增并发强化，未确认不排入开发 | — |
| EXT-01 | WP90 | ENV | 真实OpenAPI导入 | 目标上游绝对URL导入及受管调用留证 | — |
| EXT-02 | WP90 | ENV | 未解析导入修复 | 实例绑定后解析/调用成功且原导入可追溯 | — |
| EXT-03 | WP90 | ENV | 真实手工注册 | 手工API从注册到发布执行有证据 | — |
| EXT-04 | WP90 | ENV | 上下线实例迁移 | A下线转B上线不重导入，旧候选不误激活 | PROD-03 |
| EXT-05 | WP90 | ENV | 真实Gateway消费者 | 前缀/认证/聚合访问可验证 | PROD-03 |
| EXT-06 | WP90 | ENV | 真实MCP消费者 | 选定transport凭证和会话访问可验证 | PROD-02C;SEC-E1-03 |
| EXT-07 | WP90 | ENV | 真实失败候选保旧 | Gateway/MCP候选失败均保上次可用版本 | PROD-03 |
| EXT-08 | WP90 | ENV | Windows完整交互启动 | API/UI启动、导入/转换、发布路径原始证据 | PROD-02C |
| EXT-09 | WP90 | ENV | Ubuntu完整流程 | 安装/构建/启动/Streamable流程同版本验证 | SEC-E1-03 |
| ENV-01 | 运行环境 | ENV | Windows全量健康探测 | 完整health真实通过或限制有证据；ready不冒充全量 | — |
| OPS-01 | SEC-OPS01/WP90 | ENV | 生产安全与审计签收 | 目标环境权限、审计保留、依赖、开关和回退逐项验收 | SEC-F4-02;OBS-16-04 |
| MAIL-01 | 通知 | DOC | 邮件投递范围与受控验收 | 验证码/重置/通知三类接口、模板及测试邮箱策略明确 | — |
| MAIL-02 | 通知 | CODE | 邮件功能与失败恢复 | 按MAIL-01完成受控投递；实际给他人发信另需授权 | MAIL-01 |
| MAINT-01 | 前端维护 | CODE | 前端结构和分块整理 | 发布行为稳定后按性能测量拆分，关键流程不回归 | PROD-02C |
| MAINT-02 | 国际化维护 | VALIDATION | 本轮交付范围国际化验收 | 只随交付检查可见文案/编码，不无限搜索微修 | — |
| DEFER-01 | SEC-G1/EXT10 | DOC | OAuth2独立里程碑 | 未恢复前不实现、不获取Token、不计当前完成率 | — |
| DEFER-02 | SEC-AUTH01/POLICY01 | DOC | 额外令牌和跨协议QoS | 范围重新批准后另建任务，不扩入当前鉴权/观测 | — |

## 4. 调度规则与本批顺序

1. 实际同时进行的子任务最多3个；READY表示可开始，不表示全部在执行。父包IN_PROGRESS不占据执行槽。
2. 每个实现子任务开工前冻结具体入口、文件边界、最多一组主要交付及验收命令；跨多个独立交付则先拆分。不得以“继续审查还有没有问题”作为连续多轮的唯一交付。
3. 主交付优先：SEC-E1-01R→02A→02B1→02B2→02C1→02C2→03；OBS-14-02；PROD-01→02A1→02A2→02B→02C。三线各取一个依赖就绪项。E1不能继续用管理侧装配微修替代child执行闭环。
4. 本轮已推进DOC准备：OBS-16-01交接校准；SEC-E1-01启动方案草案。草案不等于技术定稿；下一步E1-01R处理其中取舍，不预设必须再次向用户索权。
5. 新发现的缺陷只有阻断当前退出或有明确严重影响时抢占；其它进入父项回归维护。一次修复归一个子项，不把重试/停机/异常各轮测试数累计成完成率。
6. C1的安全对账由F1负责，C4网络完整验收引用F3证据；交叉父包消费同一产出，不重复实施。CAS等扩大要求先由PROD-06核对批准条款，不因最近报告写了“仍缺”就自动纳入。
7. 环境任务先做可用性核查；本地准备不等外部环境，Linux/生产签收也不被本地通过伪装完成。任何“受阻”必须写具体缺项。
8. 每轮结束更新状态表的状态、证据、剩余出口；有代码不等于验收DONE，有子任务DONE不自动提升父包。


## 7. 重排后首批实施合同（2026-09-15）

SEC-E1-01R已冻结[受管启动交付设计第9节](./managed-mcp-credential-handoff-plan.md)：02A交付真实Node IPC与严格环境通道，ACK不代表READY；02B1/02B2接入同一通道，不能另起实现。PROD-01已冻结[MCP发布端点合同](./mcp-publication-endpoint-contract.md)：原PROD-02进一步拆成02A1后端、02A2候选绑定、02B UI、02C真实监听验收，避免一个子任务横跨三种独立退出。

OBS-14-02限定为同GC fence下的过期metadata缺文件整理，持久分页和恢复；不扩大为事件/receipt清理或配额。三个首批子任务完成后，第二批按SEC-E1-02A、PROD-02A1/02A2及OBS-14-01推进，具体状态只在执行台账登记。

## 8. 额度中断恢复后的调度（2026-09-17）

本批收尾B1/B2持久模式与现行CLI接线、SEC-A2-01A、PROD-04B3D及OBS-14-05C2C2C关联/文件证明/安全结算；证据见[恢复审计](../audits/2026-09-17-interruption-recovery-evidence.md)。132个叶子不继续机械扩拆。下一批可并行取SEC-A1-02B3与OBS-14-05C2C3；B4和A2-01B仍等待B3。生产和跨平台验收继续单列环境项。

用户已明确授权将ApiNova源码、测试和文档提交推送到joe-ieta/api-nova的main，后续每完成一个任务包推送一次，无需重复索取该推送授权。提交推送授权不替代独立生产启用或永久数据删除边界。

## 9. 后续批次冻结出口（2026-09-21）

本批并行推进两个已就绪项，沿用132个叶子，不新增重复任务。SEC-A1-02B3核对持久模式、实验性handoff、child启动前校验和READY回执；该通道仅支持private_api_key映射api_key，其余模式明确拒绝，不静默降级，也不据此更改现行CLI的effective未知摘要或接入生产生命周期。OBS-14-05C2C3通过实际ingest与文件发布，注入结算/外部元数据事务/临时文件清理失败，再导出、关闭并重建SQL.js连接，验收恢复和重复操作不漏计；不以直接篡改账本制造成功证明，不代替05C3的多写者/平台出口。

## 10. UI、入口拒绝与多写者验收批次（2026-09-21）

本批独立推进SEC-A1-02B4、SEC-A2-01B和OBS-14-05C3，不扩大父包范围。B4覆盖MCP发布/重发布的显式选择、保存/重载、预览一致性以及配置模式与实际未知的独立标签；A2-01B验证部署、恢复与child启动的拒绝，不以实验性IPC替代生产生命周期。C3优先核实隔离共享数据库，禁止用SQL.js多副本模拟真实多进程成功；本机新建PostgreSQL集群和回环端口只用于测试，跨平台或物理故障未跑部分保留NEED_ENV，不用新增细碎叶子掩盖缺项。

本批环境核查发现本机PostgreSQL16工具可用，原SEC-A4-02未知目标阻塞已解除：使用另一个新建私有集群补当前全实体空库/迁移/重启/持久化/API启动验收，不复用配额夹具或默认连接参数。两个PG任务使用独立目录、端口与测试身份。

## 11. 剩余功能与闭环验收并行批次（2026-09-21）

冻结三条独立线：SEC-A1-02D以新增端到端脚本验证既定鉴权保存/发布/重启/请求和标签；SEC-C3-01在固定受保护Registry源接入Watch/debounce与关闭生命周期，避免重写manual；SEC-D2-01实现IP和Anonymous独立限流层及真实请求验收，完整多层组合仍归D2-02。若三线发现跨文件依赖，由主任务协调，不能并发覆盖同一路实现。

SEC-C3-01已按原出口完成：主机明确启用watch，固定文件、并发代次检查、关闭释放均有真实文件和Nest接线证据；C3-02 DB归属与C3-03多进程仍各按依赖推进，不随此项提升。

SEC-D2-01已完成route+socket peer与route共享匿名桶。按鉴权→限流→缓存执行；完整层级组合D2-02仍等待B1-02，不把局部HTTP结果当成多节点或完整Credential模型验收。

SEC-A1-02D已补齐真实发布/重启/请求闭环，Windows含空格Node路径和空来源名生成非法OpenAPI两处缺陷一并修复。依据原TP-A1退出条件复核模式与历史策略边界后提升父包A1为DONE，不由子项数量机械推导。C3与D2仍有独立剩余出口，不随本批提高父包状态。后续可并行B1-01、C3-02、C2-02；沿用现有划分，不新造验证叶子。

## 12. 凭证模型、Windows权限和归属验证批次（2026-09-21）

沿用B1-01/C2-02/C3-02三个既有出口并行推进。统一模型以现有消费者凭证为基础；Windows仅检查隔离文件权限，不放宽系统ACL；Registry归属从可信数据库校验，不能将已有运行时映射测试冒充配置激活验证。根任务负责共享文档、集成和逐包推送。

C3-02已通过真实SQL.js及Nest工厂接线；C3-03依赖已满足转READY。校验发生于每次候选激活，既有有效代不会因后续DB变化自动撤销；该边界不冒充多进程协调或动态撤销。

C2-02已完成Windows本地驱动器权限出口：当前用户拥有、限制允许主体、原生句柄检查与链接拒绝，真实28项通过。Linux30项环境出口C2-01保持NEED_ENV；没有将平台跳过计为成功。

B1-01已完成统一持久策略、Gateway/MCP共享解释与摘要配置导出。受管CLI在启动/重启前检查导出Runtime ID与持久服务一致；动态轮换/撤销传播仍归B1-02。B1-02与A3-01转READY，本批不新增叶子。下一并行面为B1-02、C3-03、A3-01；Linux环境任务仍单列。

## 13. 轮换、临时匿名和限流组合批次（2026-09-21）

重新核对发现C3-03缺少产品生命周期真实接线依赖：managed/runtime只保留启动snapshot，handoff/channel尚无产品reload消费者。补E1-02C1依赖并回WAIT_DEP，不开发无消费者的实验cohort。改为并行B1-02、A3-01和D2-02组合验收；D2-02的完成仍须等待B1-02。现行CLI的消费者凭证DB查询不等于生产managed IPC接线。

B1-02与A3-01真实现行CLI闭环通过，A2/B1/A3按归档原出口复核DONE。SEC-B3-01及SEC-F2-02解除依赖转READY；不新增叶子。共享生命周期改动随同一集成提交交付，D2组合独立收尾。

D2-02在B1-02完成后闭合：六层组合、同主体轮换计量、窗口冲突与并发上限均有真实HTTP证据。父包D2只保留原B2/D1依赖整体验收，不追加多节点门槛。本批结束132叶子中68DONE；下一队列B3-01、F2-02及既有B2-01。

## 14. JWT配置、会话撤销与匿名界面（2026-09-21）

沿用B2-01、B3-01、F2-02三个既有出口并行，分别负责共享JWT与管理策略、真实现行CLI长连接撤销、匿名管理UI。根任务负责生命周期接线、集成验收、文档与逐包推送。不得以静态配置或模拟Session代替真实运行验证，不扩展生产managed IPC授权边界。

B2-01已通过保存/真实冷重开CLI和双运行时签名矩阵，TP-B2按原出口DONE。持久JWT策略在线修改要求先停止，未暗示支持运行中策略热更新。

本批B2-01、B3-01、F2-02三个既有叶子完成，总数仍132，DONE由68升71。B2父包原条件闭合，B3/F2保留独立SDK/分区出口。下一并行候选为B3-02 SDK桥接/通知矩阵、F2-01管理分区、D1-01请求头合同；不因相邻完成解除C3产品生命周期依赖。

## 15. SDK会话、管理分区与Header政策（2026-09-21）

并行B3-02实际锁定SDK合同、F2-01真实管理接口分区/Reload、D1-01政策冻结。D1明确属于DOC，不计作Header代码完成；D1-02仍须其依赖闭合后实施。Registry状态仅代表当前API进程，不能冒充MCP多进程同步。

D1-01政策出口完成，D1-02解除依赖。D1-02按编译/快照、双向传输、缓存、迁移防降级四个内部阶段实施，最终统一通过H01–H12；政策定稿不代表任何新过滤代码已经上线。

本批B3-02、F2-01、D1-01闭合，分别为SDK合同验证、管理分区/Reload功能、Header政策DOC。DONE71→74，132总量不变。D1-02已READY；后续并行优先D1-02实现、E0-01 Adapter合同、F1-01安全对账模型，继续解除真实父依赖。B3/F2父依赖未完成，不因叶子数自动提升。

## 16. Header实施拆分、Adapter与安全对账（2026-09-21）

原D1-02横跨四个真实出口，替换为02A编译快照、02B双向流、02C缓存、02D迁移验收（顺序依赖），原引用改依赖02D。叶子132→135只因这次替换，不能算新增完成。本批并行02A、E0-01、F1-01；02A接线明确拒绝尚无执行器的策略激活，不能以编译通过宣称Header过滤上线。

本批F1-01 DOC、D1-02A编译准备和E0-01协议验收完成，DONE74→77；总量因原D1-02拆分132→135，未把拆分当完成。E0/B3按原出口与依赖共同闭合。下一代码主线02B双向真实流，C1-01类型合同和F3-01网络政策可并行；F1-02仍等C1-02。

## 2026-09-21 双向流与后续政策批次

沿用135个叶子，并行02B真实双向Header流、C1-01类型合同与F3-01网络政策。C1-01按[合同](./upstream-credential-types-contract.md)完成DOC，C1-02转READY，其四个实施切片暂不新增编号。02B保留生产未就绪门禁，缓存与迁移仍由02C/D验收。

F3-01[网络政策](./security-header-network-boundary-contract.md)已完成DOC；F3-02保持D1-02D4硬依赖。后续代码并行面为D1-02B和已解锁C1-02，不再为已有Loader增加准备任务。

02B按[受控真实流证据](../audits/2026-09-21-header-wire-execution.md)完成，02C转READY。02D还须真实Registry/路由元数据到执行器接线与main入口安装，再做默认迁移/例外/防降级；不得删除门禁直接启用。当前80DONE/135叶，本批实际为2DOC和1CODE执行切片，D1父包保持IN_PROGRESS；下一并行主线02C缓存与C1-02类型实现。

## 2026-09-22 Header缓存与凭据类型

按现有02C/C1-02两个叶子并行推进，不新增拆分计数。缓存命中前仍检查消费者权限及当前上游凭据可用性；类型核心和宿主适配分工实施。生产Header启用仍归02D，受管IPC边界不变。

C1-02按[四类凭据证据](../audits/2026-09-22-credential-types-scope.md)完成；原Schema/Loader/Site/Endpoint条件及A0依赖已闭合，C1父包DONE，F1-02 READY。F1对账与受管生产E1保留独立退出条件，不以C1测试替代。02C仍在本批集成收尾。

02C按[真实缓存证据](../audits/2026-09-22-header-cache-isolation.md)闭合，02D READY。纠正02D仅标VALIDATION的分类：它还包含实际生产入口和迁移代码，原范围不扩大、不新增编号。下一并行主线为02D与F1-02。135叶保持不变，本轮两项CODE闭合，82DONE；C1父包已按原退出条件DONE。

## 2026-09-24 D1-02D有界拆分与F1实施

代码与启动路径审查证实原02D把同快照Registry策略执行接线、路由持久迁移、Nest实际入口事件安装和真实重启/矩阵验收合为一个跨层大任务，而且活动旧snapshot把compiled policies纳入fingerprint，直接给缺省值会让重启失败。为减小集成风险，将原叶替换为D1/D2/D3/D4四步：D1共享Prepared Exchange，D2新路由默认与具名legacy到期/防降级，D3实际HTTP入口，D4真实数据库重开与联合迁移矩阵。总叶子135→138只是D1拆分，完成数不增加。随后F1-02按真实交付链拆为A–F六叶，总量138→143；A/B完成，C/E READY，D/F等待依赖。D2又拆为A纯合同校验、B新Binding v1持久创建、C legacy例外生命周期、D冷重启/防降级验收，总量143→146；仅A完成，B READY，C/D等待依赖。F1-C先拆为C1脱敏耐久证据原型与C2生产验证/双库/运行接线，总量146→147；后续把C2收窄为生产证据存储注册并新增C3受信挑战重评/Verified门禁，总量147→148。C1/C2完成，原C3继续按生产闭环拆分；E再拆为E1 Gateway每次调用重评与E2 MCP Transformer同规则接线，总量148→149；随后增加E3 live child/在线撤销验收，总量149→150，E1/E2完成，E3后续拆分。D4再拆为A纯Guard/局部HTTP、B生产运行时接线、C完整H01–H12/历史名持久性，总量150→152。H07只读审计又新增D4D1 Parser Host历史Store、D4D2 Gateway双库Ledger、D4D3 bootstrap历史编译/CAS/swap、D4D4并发故障重启验收四叶，总量152→156；D1/D2/D3/D4已完成H07跨启动历史验收；D4C原盘点仍是acceptanceComplete:false，H11 membership→v1保持未闭环。E3再拆为E3a受限Managed Child安全租约协调器与E3b运行中更新/实时授权/事件IPC，总量156→157；E3a完成，E3b等待。最后把C3受信挑战大项替换为C3a上下文authority、C3b挑战transport、C3c proof authority、C3d生产持久evidence kind、C3e挑战编排、C3f安全入口及C3g发布/运行消费者七叶，总量157→163；a/b/c以4 files、27 tests、API security 8套105项及build限定完成；d以生产格式独立evidence表、双库CHECK/迁移/注册及原型隔离限定完成；e以四阶段loopback/SQLite编排、10套123项及API build限定完成；f以2 files/24 tests、security 10套146项及API build限定完成。D1父包审计新增H11A真实membership v1原子激活与H11B生产H01–H12缓存语义验收两叶，总量163→165；H11A以Registry-source v1受控激活专项限定完成，inline/legacy/unmigrated/unknown/unsafe仍NOT_READY并保旧；H11B已进入生产H01–H12验收实施。随后只读审计将g替换为G1 proof/authorization adapter、G2只读preview/readiness、G3单成员事务writer、G4批量/candidate、G5 Gateway guard、G6 MCP/child实时许可六叶，总量165→170；G1/G2/G3与G4有界executor切片限定完成，D READY、G5独立proof consumer guard实施中、G6等待；G4只证明fixture下的执行器语义，异步Registry生产链未接，G2生产默认拒绝且production gate保持fail-closed；父D1/F1均不提升。
