---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-15
---
# 活跃工作包划分与验收子任务

## 1. 口径与权限边界

本页是2026-09-15重排后的调度划分，继承原批准需求，不替换或缩减父包退出条件。状态唯一入口为[子任务执行状态](./active-work-package-execution-status.md)，父包证据仍在[OBS台账](./runtime-observability-development-execution-status.md)和[SEC台账](./security-development-execution-status.md)。

39只等于OBS16+SEC23：11 DONE、23 IN_PROGRESS、4 BACKLOG、1 DEFERRED；不是全项目活跃总数，更不是完成百分比。IN_PROGRESS在旧父包表表示有实现，不表示23包正在同时开发。代码、设计草案、验收准备、环境执行分别登记，不能用文档子项DONE冒充功能交付。

上层[阶段计划](./staged-development-plan.md)、[WP00~90](./runtime-instance-and-regression-closure-plan.md)和[open-items](../reference/open-items.md)具有交叉范围，不叠加成49或其它“项目总包数”。本次覆盖这些当前入口；新需求必须先登记归属再进入队列。

## 2. 全部父包与跨计划归属

### 两个专项

OBS父包：01/02/03/04/05/07/08/09/11/12各为DONE；06/10/13/14/15各为IN_PROGRESS；16为BACKLOG。
SEC父包：A0 DONE；A1/A2/A4/B1/B2/B3/C1/C2/C3/C4/D1/D2/E0/E1/E2/F2/F3/F3a各IN_PROGRESS；A3/F1/F4各BACKLOG；G1 DEFERRED。
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
| SEC-A1-02 | SEC-A1 | CODE | 模式标签与持久化闭环 | Private Extension/local_process标签与保存后实际行为一致 | SEC-A1-01 |
| SEC-A2-01 | SEC-A2 | VALIDATION | 非法策略发布/恢复/启动拒绝 | 缺失、未知、非法快照覆盖三入口；合法开发默认可追溯 | — |
| SEC-A3-01 | SEC-A3 | CODE | 临时匿名治理 | reason/actor/expiry、生产双许可、到期拒绝与审计同一用例通过 | SEC-B1-01;SEC-A2-01 |
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
| SEC-C3-03 | SEC-C3 | CODE | 多进程Registry版本协调 | 激活/失败状态与实际generation跨进程可观测且无混版本执行 | SEC-E1-02B;SEC-C3-02 |
| SEC-C4-01 | SEC-C4 | VALIDATION | 两运行时Resolver执行验收 | Gateway与受管MCP继承/覆盖/None/Unresolved的联网前拒绝一致 | SEC-E1-03;SEC-F1-02 |
| SEC-D1-01 | SEC-D1 | DOC | Header业务政策定稿 | 请求/响应、多值/framing、保留字段、迁移例外逐项选择并记录 | — |
| SEC-D1-02 | SEC-D1 | CODE | Allowlist与传输兼容 | 落实D1-01并覆盖缓存、正文长度、响应字段及禁用迁移路径 | SEC-D1-01 |
| SEC-D2-01 | SEC-D2 | CODE | IP与Anonymous独立限流层 | 真实请求分别触发IP、匿名bucket，鉴权缓存不能绕过 | — |
| SEC-D2-02 | SEC-D2 | VALIDATION | 完整层级限流组合 | Global/Runtime/Route/Credential/IP组合顺序与拒绝归因可验证 | SEC-D2-01;SEC-B1-02 |
| SEC-E0-01 | SEC-E0 | VALIDATION | 锁定MCP协议边界矩阵 | Method/Header/错误/Session/stdio按当前协议逐入口验收 | — |
| SEC-E1-01 | SEC-E1 | DOC | 受管启动接口与验收草案 | 实际父/child改动文件、信任来源、版本、argv秘密迁移和验收草案明确；不代表方案批准 | — |
| SEC-E1-01R | SEC-E1 | DOC | 启动方案技术审查与实施切片冻结 | 审查IPC/权限/环境/READY/legacy建议默认值，确定首个受管入口和13组验收中的必选项 | SEC-E1-01 |
| SEC-E1-02A | SEC-E1 | CODE | 安全受管启动通道 | 真实Node child经受信IPC接收配置，禁shell与argv秘密，环境边界按方案执行 | SEC-E1-01R |
| SEC-E1-02B | SEC-E1 | CODE | child可信映射与Resolver接线 | child加载固定Registry源并核验绑定/候选版本，标准handler消费Resolver，缺项不READY | SEC-E1-02A |
| SEC-E1-02C | SEC-E1 | CODE | 重启/失败及legacy边界 | 重启重新准备可信材料，错误/超时清理，legacy明确不冒充新安全模式 | SEC-E1-02B |
| SEC-E1-03 | SEC-E1 | VALIDATION | 真实child单跳执行闭环 | 受控上游验证继承/覆盖/None、缺Secret零发送、零自动跳转、legacy边界 | SEC-E1-02C |
| SEC-E1-04 | SEC-E1 | CODE | 运行中版本更新与撤销 | 运行child更新/撤销生效时间和在途策略明确且可验证 | SEC-E1-03;SEC-B3-01 |
| SEC-E2-01 | SEC-E2 | VALIDATION | 当前传输安全联合矩阵 | 取消/重连/回放隔离/撤销按已支持transport验证 | SEC-E1-03;SEC-E0-01 |
| SEC-E2-02 | SEC-E2 | ENV | 双平台传输矩阵 | 同版本Linux/Windows各单元有真实结果，失败留证 | SEC-E2-01 |
| SEC-F1-01 | SEC-F1 | DOC | 四态与OR/AND门禁契约 | Unsecured/Declared/Configured/Verified及Binding兼容转移表固定 | — |
| SEC-F1-02 | SEC-F1 | CODE | 安全对账与发布门禁 | 声明受保护但未配置/验证时阻止发布；OR/AND不弱化 | SEC-F1-01;SEC-C1-02 |
| SEC-F2-01 | SEC-F2 | CODE | Consumer/Upstream与Reload界面 | 分区明确、binding revision与reload真实generation可查看及恢复 | — |
| SEC-F2-02 | SEC-F2 | CODE | 匿名风险与到期界面 | 申请、风险、到期和服务端拒绝一致显示 | SEC-A3-01 |
| SEC-F3-01 | SEC-F3 | DOC | 上游网络边界政策 | DNS、连接、redirect、代理及内网例外有明确允许/拒绝合同 | — |
| SEC-F3-02 | SEC-F3 | CODE | 网络边界执行 | DNS解析/连接/每跳凭据重建按政策执行与拒绝型验收 | SEC-F3-01;SEC-D1-02 |
| SEC-F3-03 | SEC-F3 | VALIDATION | 秘密与生命周期审计矩阵 | argv/log/错误/证据无完整Secret；创建/更新/撤销审计可检索 | SEC-E1-03;SEC-C3-02 |
| SEC-F3a-01 | SEC-F3a | VALIDATION | 当前依赖可达性审计 | 锁文件固定、生产可达性、补丁/风险处置逐项记录 | — |
| SEC-F4-01 | SEC-F4 | VALIDATION | 安全交付证据索引 | 各验收项映射脚本/版本/环境/缺口，区分准备与执行 | — |
| SEC-F4-02 | SEC-F4 | ENV | 安全发布验收 | 各父包出口、平台/DB/依赖/部署门禁齐备，真实证据签收 | SEC-E2-02;SEC-D2-02;SEC-F1-02;SEC-F2-02;SEC-F3-03;SEC-F3a-01 |
| OBS-06-01 | OBS-06 | VALIDATION | MCP正文与终态矩阵 | 支持transport的成功/超时/取消/大响应及Windows原生对照有结果 | — |
| OBS-06-02 | OBS-06 | ENV | MCP跨平台正文验证 | Linux与Windows同版本矩阵分别留证，限制明确 | OBS-06-01 |
| OBS-10-01 | OBS-10 | CODE | 业务进程生命周期来源 | 至少一个实际受管进程启动/停止/失联证据进入状态，不能用管理心跳替代 | — |
| OBS-10-02 | OBS-10 | CODE | 在途与状态维度补齐 | 当前在途、历史状态及缺证据语义可查询并验证 | OBS-10-01 |
| OBS-13-01 | OBS-13 | CODE | 状态快照与增量接续 | 同一事件源水位、乱序版本、撤权、断线恢复无状态丢失 | OBS-10-01 |
| OBS-13-02 | OBS-13 | VALIDATION | 长期传输与慢客户端验收 | 有限缓冲/ACK/恢复/断连按状态流和调用事实流验证 | OBS-13-01 |
| OBS-14-01 | OBS-14 | DOC | 生命周期引用/墓碑规则 | 事件/投递/receipt/元数据/正文引用和到期顺序逐类定清 | — |
| OBS-14-02 | OBS-14 | CODE | 删除后回滚的过期元数据整理 | 有界持久进度、同fence、重启/重复运行可恢复；有效对象不变 | — |
| OBS-14-03E | OBS-14 | CODE | 事件元数据清理 | 按引用规则有界清理过期事件，分页游标/事件水位不复活 | OBS-14-01;OBS-14-02 |
| OBS-14-03D | OBS-14 | CODE | 投递与receipt墓碑清理 | 满足30天投递留存及引用保护，墓碑边界与重复导入行为可验收 | OBS-14-01;OBS-14-02 |
| OBS-14-04 | OBS-14 | DOC | 配额计量与降级合同 | 明确计量对象、预算分配、并发写入拒绝与fail-open/fail-closed | — |
| OBS-14-05 | OBS-14 | CODE | 配额强制与容量故障验证 | 在既定计量范围强制预算，满盘/并发/重启验收 | OBS-14-04 |
| OBS-14-06A | OBS-14 | CODE | 管理审计30天清理 | 独立审计保留边界与有界删除/权限审计有证据 | OBS-14-01 |
| OBS-14-06T | OBS-14 | CODE | 未导入暂存恢复 | 暂存扫描、导入状态与重启恢复具有持久进度且不丢有效数据 | OBS-14-01 |
| OBS-15-01 | OBS-15 | CODE | 迁移一个旧调用者查询入口 | 新API查询/权限/分页完整；删对应旧调用链，无回退/双计数 | — |
| OBS-15-02 | OBS-15 | VALIDATION | 全链路身份与切换验收 | 外部请求到事件/投递来源一致，拒绝审计、旧端点清单和回退步骤明确 | OBS-15-01;OBS-13-01 |
| OBS-16-01 | OBS-16 | DOC | 验收交接基线校准 | AC01~20证据入口、28/28限定合同、未执行环境清单无矛盾 | — |
| OBS-16-02 | OBS-16 | VALIDATION | 本地故障/承载单元 | 冻结数据规模/指标/版本，运行可用Windows隔离单元并记录失败 | OBS-16-01 |
| OBS-16-03 | OBS-16 | ENV | Linux/PostgreSQL/多进程单元 | 逐环境同版本数据和原始结果，不以历史43表替代 | OBS-16-01 |
| OBS-16-04 | OBS-16 | ENV | 可观测部署交付签收 | 批准AC、性能、运行开关和回退证据齐备 | OBS-16-02;OBS-16-03;OBS-15-02;OBS-14-05 |
| PROD-01 | WP60/DEV01 | DOC | MCP发布端点合同 | port/transport/endpointPath校验、默认值与预览规则一致 | — |
| PROD-02 | WP60/DEV01 | CODE | MCP发布配置与准确预览 | UI可配置、后端保存、实际监听/访问地址与预览相符 | PROD-01 |
| PROD-03 | WP50/DEV02/03 | VALIDATION | 真实治理发布回归准备 | 现有内部实现不重做，注册→变更失效→重验→发布用例可执行 | — |
| PROD-04 | WP40/DEV04 | CODE | 二进制样例存储与留存 | 二进制专用对象策略、访问控制、到期回收与样例引用一致 | — |
| PROD-05 | WP80/DEV05 | CODE | 操作者透传与运营审计检索 | 实例/绑定变更actor到审计可查询，权限拒绝可验证 | — |
| PROD-06 | WP70 | DOC | 核定CAS是否属于原包剩余出口 | 逐条引用批准要求区分原WP70已实现出口与新增并发强化，未确认不排入开发 | — |
| EXT-01 | WP90 | ENV | 真实OpenAPI导入 | 目标上游绝对URL导入及受管调用留证 | — |
| EXT-02 | WP90 | ENV | 未解析导入修复 | 实例绑定后解析/调用成功且原导入可追溯 | — |
| EXT-03 | WP90 | ENV | 真实手工注册 | 手工API从注册到发布执行有证据 | — |
| EXT-04 | WP90 | ENV | 上下线实例迁移 | A下线转B上线不重导入，旧候选不误激活 | PROD-03 |
| EXT-05 | WP90 | ENV | 真实Gateway消费者 | 前缀/认证/聚合访问可验证 | PROD-03 |
| EXT-06 | WP90 | ENV | 真实MCP消费者 | 选定transport凭证和会话访问可验证 | PROD-02;SEC-E1-03 |
| EXT-07 | WP90 | ENV | 真实失败候选保旧 | Gateway/MCP候选失败均保上次可用版本 | PROD-03 |
| EXT-08 | WP90 | ENV | Windows完整交互启动 | API/UI启动、导入/转换、发布路径原始证据 | PROD-02 |
| EXT-09 | WP90 | ENV | Ubuntu完整流程 | 安装/构建/启动/Streamable流程同版本验证 | SEC-E1-03 |
| ENV-01 | 运行环境 | ENV | Windows全量健康探测 | 完整health真实通过或限制有证据；ready不冒充全量 | — |
| OPS-01 | SEC-OPS01/WP90 | ENV | 生产安全与审计签收 | 目标环境权限、审计保留、依赖、开关和回退逐项验收 | SEC-F4-02;OBS-16-04 |
| MAIL-01 | 通知 | DOC | 邮件投递范围与受控验收 | 验证码/重置/通知三类接口、模板及测试邮箱策略明确 | — |
| MAIL-02 | 通知 | CODE | 邮件功能与失败恢复 | 按MAIL-01完成受控投递；实际给他人发信另需授权 | MAIL-01 |
| MAINT-01 | 前端维护 | CODE | 前端结构和分块整理 | 发布行为稳定后按性能测量拆分，关键流程不回归 | PROD-02 |
| MAINT-02 | 国际化维护 | VALIDATION | 本轮交付范围国际化验收 | 只随交付检查可见文案/编码，不无限搜索微修 | — |
| DEFER-01 | SEC-G1/EXT10 | DOC | OAuth2独立里程碑 | 未恢复前不实现、不获取Token、不计当前完成率 | — |
| DEFER-02 | SEC-AUTH01/POLICY01 | DOC | 额外令牌和跨协议QoS | 范围重新批准后另建任务，不扩入当前鉴权/观测 | — |

## 4. 调度规则与本批顺序

1. 实际同时进行的子任务最多3个；READY表示可开始，不表示全部在执行。父包IN_PROGRESS不占据执行槽。
2. 每个实现子任务开工前冻结具体入口、文件边界、最多一组主要交付及验收命令；跨多个独立交付则先拆分。不得以“继续审查还有没有问题”作为连续多轮的唯一交付。
3. 主交付优先：SEC-E1-01R→02A→02B→02C→03；OBS-14-02；PROD-01→02。三线各取一个依赖就绪项。E1不能继续用管理侧装配微修替代child执行闭环。
4. 本轮已推进DOC准备：OBS-16-01交接校准；SEC-E1-01启动方案草案。草案不等于技术定稿；下一步E1-01R处理其中取舍，不预设必须再次向用户索权。
5. 新发现的缺陷只有阻断当前退出或有明确严重影响时抢占；其它进入父项回归维护。一次修复归一个子项，不把重试/停机/异常各轮测试数累计成完成率。
6. C1的安全对账由F1负责，C4网络完整验收引用F3证据；交叉父包消费同一产出，不重复实施。CAS等扩大要求先由PROD-06核对批准条款，不因最近报告写了“仍缺”就自动纳入。
7. 环境任务先做可用性核查；本地准备不等外部环境，Linux/生产签收也不被本地通过伪装完成。任何“受阻”必须写具体缺项。
8. 每轮结束更新状态表的状态、证据、剩余出口；有代码不等于验收DONE，有子任务DONE不自动提升父包。

