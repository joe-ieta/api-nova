---
doc-version: 1.1.0
doc-status: active
doc-updated: 2026-09-15
---
# 活跃子任务执行状态

## 1. 本次重排快照

依据[任务划分合同](./active-work-package-breakdown.md)，本批从本地ace5d02推进，远端此前核对为7ea27a0；API构建通过，OBS五脚本联合67/67通过，未推送。
父包专项统计仍是OBS 10/5/1、SEC 1/18/3/1（DONE/IN_PROGRESS/BACKLOG/DEFERRED）；两专项合计11/23/4/1。它不表示全项目完成率。

本次登记87个叶子记录，含治理、DOC、CODE、VALIDATION、ENV与延期项，规模不等且跨计划证据复用，因此禁止计算“3/87完成率”。已完成的历史实现切片在划分文档单列，本表不重新计为新开发成果。

| 状态 | 数量 | 含义 |
| --- | --- | --- |
| DONE | 6 | 本批新增1项CODE、2项DOC完成，父包退出仍独立核对 |
| READY | 31 | 可进入队列，当前并非全部开工 |
| IN_PROGRESS | 0 | 本批三项已验收，下一批尚未开工 |
| WAIT_DEP | 31 | 等待列明子任务/条件 |
| NEED_ENV | 16 | 需要核实目标环境，不是假定工具阻塞 |
| SCOPE_REVIEW | 1 | 先判断是否属于批准范围 |
| DEFERRED | 2 | 不属于当前里程碑 |
本批SEC-E1-01R、OBS-14-02、PROD-01已完成限定退出。下一批优先SEC-E1-02A、PROD-02；OBS进入OBS-14-01引用/墓碑合同，再解锁事件与receipt清理。READY不表示已开工。

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
| SEC-E1-02A | READY | 待实现；仅进程内transform不满足退出 |
| SEC-E1-02B | WAIT_DEP | 待实现；仅进程内transform不满足退出 |
| SEC-E1-02C | WAIT_DEP | 待实现；仅进程内transform不满足退出 |
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
| SEC-F4-01 | READY | 不等待全部包才整理索引 |
| SEC-F4-02 | NEED_ENV | 目标环境与授权另核实 |
| OBS-06-01 | READY | 不重写已有发送边界 |
| OBS-06-02 | NEED_ENV | 真实环境待核实 |
| OBS-10-01 | READY | 管理心跳/路由注册已有 |
| OBS-10-02 | WAIT_DEP | 未完成 |
| OBS-13-01 | WAIT_DEP | 调用事实页流已完成 |
| OBS-13-02 | WAIT_DEP | 长期/跨平台证据未完成 |
| OBS-14-01 | READY | 已批准保留天数不下调 |
| OBS-14-02 | DONE | 持久keyset分页、同GC fence、修复与cursor同事务；真实SQL.js连接重建恢复；新增7项专项，联合67/67 |
| OBS-14-03E | WAIT_DEP | 未完成；不以仅有TTL字段代替清理 |
| OBS-14-03D | WAIT_DEP | 未完成；不以仅有TTL字段代替清理 |
| OBS-14-04 | READY | 扫描样本不能作当前总量 |
| OBS-14-05 | WAIT_DEP | 未完成 |
| OBS-14-06A | WAIT_DEP | 未完成 |
| OBS-14-06T | WAIT_DEP | 未完成 |
| OBS-15-01 | READY | Gateway日志入口已迁移 |
| OBS-15-02 | WAIT_DEP | 不重建第二主链 |
| OBS-16-01 | DONE | 交接文档2.2.0；AC01~20与脚本入口静态核对，未运行新全量矩阵；[交接](./runtime-observability-external-validation-handoff.md) |
| OBS-16-02 | READY | 不等同全量平台验收 |
| OBS-16-03 | NEED_ENV | 环境待核实 |
| OBS-16-04 | WAIT_DEP | 部署需具体环境及授权 |
| PROD-01 | DONE | [发布端点合同](./mcp-publication-endpoint-contract.md)，后端/监听/UI边界冻结；仅DOC |
| PROD-02 | READY | 下一用户入口交付 |
| PROD-03 | READY | 执行环境归EXT01~07 |
| PROD-04 | READY | 已有大小护栏/清理不重写 |
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
| MAINT-01 | WAIT_DEP | 非当前主线 |
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
