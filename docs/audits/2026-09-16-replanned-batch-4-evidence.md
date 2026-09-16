---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-16
---
# 重拆第四批：保守恢复、二进制样例撤销与当前空库证据

本记录对应[119项叶子任务划分](../guides/active-work-package-breakdown.md)和[统一执行台账](../guides/active-work-package-execution-status.md)。限定子项完成不等于OBS-14、PROD-04或SEC-A4父包退出；测试集互有交叠，不按条数计算项目完成率。

| 子项 | 本批可核查结果 | 保留边界 |
| --- | --- | --- |
| SEC-A4-01 | 当前版本隔离SQLite空库初始化、关闭并重开同一数据库：68个实体、68张业务表；重启新增迁移0、schema drift 0；create与smoke均通过，smoke含事务和API启动。 | 不覆盖PostgreSQL、历史数据升级或生产数据库。 |
| OBS-14-05C2C1 | 既有owner/root只读绑定，在持久inventory围栏下有界扫描final/tmp路径、当前和历史引用及未结算预留；缺失根、损坏数据、页不完整与写者占用保持unknown。专项13/13，相关回归90/90。 | observedBytes仅表示已见路径，totalOccupancyBytes始终未知；无文件/预留唯一关联，不结算、不删文件。 |
| OBS-14-05C2C2A | 仅在owner、epoch、generation、预留ID/hash/金额和账本可精确复核时，把reserved原子标为uncertain并将ledger降级；reservedBytes和committedBytes不变。故障、重复与SQL.js导出重启专项14/14，相关回归46/46。 | 不凭孤儿候选或文件长度释放额度；旧预留缺少崩溃后可反查的持久发布意图，C2C2B/C仍待实施。quotaEnforced=false。 |
| PROD-04B3A | 显式DELETE和过期归档清理在同一事务撤销二进制引用、持久化delete_pending；样例保留pending、不可再PATCH复活，读取前后复核返回410。 | 不unlink，返回pending而非假报物理删除。 |
| PROD-04B3B | server:manage显式入口每轮最多100对象、2秒软预算，仅在首次撤销满5分钟后清理delete_pending的受控文件；失败保墓碑，ENOENT、终结事务失败与SQL.js重启可重试。 | 单次IO可能跨越软预算；无sample行的staged孤儿不覆盖，已拆为B3E；无生产定时器。B3A/B合并四套53/53。 |
| PROD-04B3C | 已知版本的二进制样例只有显式status-only可回放并严格核验HTTP状态；其余模式、未知版本在Gateway/MCP回放前BLOCKED，旧发布版本保留。三套44/44。 | 不支持binary-exact原始字节比较。 |

主任务独立复验：C2C1 13/13、C2C2A 14/14、B3A/B四套53/53、B3C三套44/44；API构建通过。专项回归以Windows本机SQL.js、受控临时目录和loopback为主，不代表Linux权限、PostgreSQL并发、真实多进程或生产部署证据。未连接业务数据库或执行生产清理。

## 依赖重排与下一出口

C2C1确认现有预留的operationId只保存单向摘要。在文件发布后、receipt/metadata事务提交前崩溃时，数据库可能没有可反查的sourceEventId、payloadId或临时文件标识；把候选文件与预留匹配会错误释放额度。故原C2C2细分为已完成的保守降级A、待实施的持久发布意图B和可证明结算C，完整故障验收C3依赖C。

B3B明确只处理同时保留pending样例行的delete_pending对象。run/sample事务失败留下的无样例staged墓碑需要独立安全宽限与显式整理，已新增PROD-04B3E，并作为B3D/04C验收前置。SEC-E1-02C1受管生产生命周期与OBS-14-03E2B事件永久删除仍分别等待其既定授权。