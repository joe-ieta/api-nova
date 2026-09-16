---
doc-version: 1.19.0
doc-status: active
doc-updated: 2026-09-16
---
# 活跃子任务执行状态

## 1. 本次重排快照

依据[任务划分合同](./active-work-package-breakdown.md)，重排首批从本地ace5d02起步，首批API构建与OBS五脚本67/67通过；第二批结果见[上一批审计](../audits/2026-09-16-replanned-batch-2-evidence.md)，本批围栏、基线、二进制样例与安全索引证据见[第三批审计](../audits/2026-09-16-replanned-batch-3-evidence.md)。
父包专项统计仍是OBS 10/5/1、SEC 1/18/3/1（DONE/IN_PROGRESS/BACKLOG/DEFERRED）；两专项合计11/23/4/1。它不表示全项目完成率。

本次登记111个叶子记录，含治理、DOC、CODE、VALIDATION、ENV与延期项，规模不等且跨计划证据复用，因此禁止用记录数计算项目完成率。原PROD-02拆成后端配置、候选绑定、UI和真实监听四个出口；已完成的历史实现切片不重新计为新开发成果。

| 状态 | 数量 | 含义 |
| --- | --- | --- |
| DONE | 32 | 限定出口已完成；父包仍按独立退出条件核对 |
| READY | 29 | 可进入队列，当前并非全部开工 |
| IN_PROGRESS | 0 | 当前无在执行子项 |
| WAIT_DEP | 31 | 等待列明子任务/条件 |
| NEED_ENV | 16 | 需要核实目标环境，不是假定工具阻塞 |
| SCOPE_REVIEW | 1 | 先判断是否属于批准范围 |
| DEFERRED | 2 | 不属于当前里程碑 |
第二批已完成SEC-E1-02A/B1/B2、OBS-14-03E1/E2A及05A/B/C1、PROD-02/03和04A/B1限定出口；05C1已完成；05C2A与04B2A完成限定验证；C2B1/B2/B3和B2B1/B2/C已限定完成；OBS-14-05C2C与PROD-04B3已解锁，后续完整验收仍按依赖推进；SEC-E1-02C1等待明确生产生命周期授权。事件物理删除E2B仍等待明确永久删除授权。READY不表示已开工。

## 2. 子任务状态与证据

| 子任务 | 状态 | 当前证据/剩余边界 |
| --- | --- | --- |
| GOV-01 | DONE | 本轮三路审计 |
| SEC-A1-01 | READY | 待逐路径验收 |
| SEC-A1-02 | WAIT_DEP | 未完成 |
| SEC-A2-01 | READY | 运行时白名单已有，完整矩阵未验收 |
| SEC-A3-01 | WAIT_DEP | 未实现闭环 |
| SEC-A4-01 | READY | 旧43表证据不复用为当前完成 |
| SEC-A4-02 | NEED_ENV | 环境需重新核实 |
| SEC-B1-01 | READY | 现有Gateway凭证不等于统一模型 |
| SEC-B1-02 | WAIT_DEP | 未完成 |
| SEC-B2-01 | READY | 固定子集已有 |
| SEC-B3-01 | WAIT_DEP | 列表过滤/执行二次授权已有 |
| SEC-B3-02 | READY | 不是升级SDK任务 |
| SEC-C1-01 | READY | header API Key/Bearer已有 |
| SEC-C1-02 | WAIT_DEP | 类型很多时逐类型再拆后执行 |
| SEC-C2-01 | NEED_ENV | Env/File本机实现已有 |
| SEC-C2-02 | READY | 适配未完成 |
| SEC-C3-01 | READY | manual reload不重做 |
| SEC-C3-02 | READY | 管理装配查询不等于Registry校验 |
| SEC-C3-03 | WAIT_DEP | 需先有真实child链 |
| SEC-C4-01 | WAIT_DEP | 纯Resolver不重写 |
| SEC-D1-01 | READY | 现有30项草案不是实现 |
| SEC-D1-02 | WAIT_DEP | Connection修复转维护 |
| SEC-D2-01 | READY | 已有缓存身份边界不重做 |
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
| OBS-14-05C2C | READY | B3限定验收已完成；未结算预留、孤儿与残留占用恢复尚未实施 |
| OBS-14-05C3 | WAIT_DEP | 崩溃重启、多写者与各失败点验收等待C2C |
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
| PROD-04B3 | READY | B2C受权读取已完成；引用撤销/墓碑、显式整理和验证语义尚未实施 |
| PROD-04C | WAIT_DEP | 留存整体验收等待04B3 |
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
