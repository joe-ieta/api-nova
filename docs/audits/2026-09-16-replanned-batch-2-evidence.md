---
doc-version: 1.4.0
doc-status: active
doc-updated: 2026-09-16
---
# 重拆第二批：受管通道、生命周期基础与发布循环证据

## 审查口径

本记录覆盖104条叶子任务中的已完成切片，状态唯一入口是[执行台账](../guides/active-work-package-execution-status.md)，合同是[任务划分](../guides/active-work-package-breakdown.md)。DOC、CODE、VALIDATION、ENV出口分开判断；本页不是父包完成证明。计划/状态ID各104条，集合一致且无重复；旧聚合依赖SEC-C3-03→SEC-E1-02B已改为B2，复核悬空依赖、已完成子项的未完成前置与环路均为0。此核对是文档图验证，不是实现验收。

## 已完成的限定出口

| 子项 | 可核查结果 | 不覆盖 |
| --- | --- | --- |
| SEC-E1-02A/B1/B2 | 私有Node IPC直启、精确环境和ACK/READY分离；父端固定Registry可信准备；child稳定复核、single-hop标准handler、Streamable/SSE监听后READY。三脚本联合47/47，父端准备23/23；通道11/11及既有ProcessManager 3/3 | 产品生命周期接线、重启、运行中撤销、真实业务Registry/双平台 |
| OBS-14-01、14-04 | [生命周期合同](../reference/runtime-observability-lifecycle-contract.md)与[配额合同](../reference/runtime-observability-capacity-quota-contract.md)冻结引用、缺口、水位和故障语义 | 文档不是清理/强制配额能力 |
| OBS-14-03E1/E2A | 非连续事件gap与授权410；默认关闭、只读的保留候选预览；事件相关联合26/26 | 没有物理删除或空间回收 |
| OBS-14-05A/B | 独立ledger/reservation，epoch/CAS、幂等结算、高低水位及未知占用保护；默认关闭的门禁接入可选正文prepare/publish，05B专项11/11、旧六脚本81/81及API类型检查/构建通过 | 发布后外围元数据事务失败留下的已计费孤儿对象待05C恢复；quotaEnforced仍为false |
| OBS-14-05C1 | 只读有界正文盘点、跨会话完整shard前缀复核；专项6/6、旧GC/容量27/27及API typecheck通过 | writerFenceRequired=true、baselineReady=false；不改账本/schema/文件，C2持久恢复与C3验收仍待完成 |
| PROD-02A1/A2/B/C | 管理端严格端点配置/预览、候选哈希和激活复核、三入口共享UI、Streamable/SSE实际自定义路径回环；后端候选四套81/81、UI45/45及构建、真实传输3/3与生命周期联合84/84 | 不等于真实注册→受权发布→上游全链路或生产部署 |
| PROD-03 | Gateway/MCP本地失效→重验→再次发布；修复Gateway旧候选误激活，七套76/76；详细夹具范围见[专项报告](./2026-09-15-prod-03-local-publication-cycle.md) | SQL.js前置数据/注入回放不证明注册HTTP、真实上游或操作者登录 |
| PROD-04A/B1 | [二进制样例合同](../guides/endpoint-test-binary-sample-contract.md)冻结边界；B1专用对象原语、默认关闭私有根、staged→ready、有界内部读取及rename后DB失败幂等恢复，9/9、API构建、SQLite空库67表零漂移 | 未接真实响应字节采集、HTTP受权下载、对象删除或生产存储启用；B2刚解锁 |

本地证据文件分别为 tmp/replan-batch2-managed-tests.log、tmp/replan-batch2-managed-preparation.log、tmp/replan-batch2-obs-events.log、tmp/replan-batch2-obs-storage-tests.log、tmp/prod-03-local-validation.log、tmp/prod-02c-real-transport.log、tmp/prod-02c-lifecycle-candidate.log、tmp/replan-batch2-ui-publication.log、tmp/replan-batch2-ui-typecheck.log和tmp/replan-batch2-ui-build.log。这些日志可能不进入提交或发布包；测试总数涉及重叠范围，不能相加计算进度。第二批最终API整包构建/全量回归应以本轮收口后的单独日志为准，不能把先前中间构建冒充最终构建。

## 未关闭与授权边界

SEC-E1-02C1的本地生命周期草稿未验收且已撤回；自动审批要求明确授权改变生产托管启动/停止状态行为，故产品Server启动路径仍未接线。OBS-14-03E2B是永久物理删除执行器，自动审批要求明确永久删除授权；当前仅有只读候选，不存在删除执行器或实际删除。两个待授权项均不能通过文档标记、独立测试或默认关闭开关推断为完成。

OBS-14-05C1只读盘点原语已通过限定验证，05C2持久恢复可进入队列；PROD-04B1对象原语已通过限定验证，04B2真实采集与受权下载亦已解锁。配额持久游标/epoch恢复及崩溃重启验收、二进制采集/下载/引用清理、受管生命周期重启/legacy、PostgreSQL/Linux/多进程和真实外部服务仍有独立出口。本批没有连接业务数据库、运行生产迁移、真实删除、推送或部署。