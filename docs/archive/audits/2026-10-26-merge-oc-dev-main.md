# oc_dev合并main记录（2026-10-26）

用户要求检查分支，将oc_dev与主分支合并并推送。合并前远端main=9d27b51c79c83c9684b56638bcb0c44a73ce38e1，oc_dev=3c3fa8d；共同祖先2f495344a3864635ac5d28b4c6affffb0ad5834e，左右独有1/80提交。采用正常双亲merge，不变基、不强推、不删除开发分支。

main独有提交包含NP规划、兼容依赖补丁、Gateway host bootstrap/publication authority及managedMcpMode运行生命周期；oc_dev包含其后的运行时/样例/观察/邮件/交付及文档工作。不能整侧取代另一侧。

## 冲突处置

- 保留最新当前手册、209项状态/原合同及245依赖；main基于2f49534的150-DONE迁移冻结表、31父包/7子项和原阶段记录完整保留到plans/main-2026-10-20，其检查器改读取该历史基线，不回退当前状态。
- Gateway合并两套显式host接线，共享网络token只注册一个工厂；冲突配置关闭两条路径，默认仍off。保留请求绝对deadline、单跳执行、验证凭据/请求绑定的生产authority和缓存绕过；最终在实际目标URL边界校验，不在准备前重复拦截合法受控proof。
- MCP保留managedMcpMode的真实进程/取消/恢复及executionMode协调器的代次/授权租约，两者配置键不同。启动预检必须在状态变更前，受管READY和停止/取消保持各自门禁；保留signal、ACK和permitAuthority。
- 上传保留共享大小解析、单文件/无文字字段/头数量限制；0大小配置拒绝。依赖保留已回移SSE包与main兼容整改，用npm生成锁文件；shell-quote/handlebars的所有副本须满足main原有安全回归，不通过放松测试处理旧锁缓存。
- 新主分支测试夹具对齐合并后的构造参数和事务validator；UI脚本规范化CRLF后读取实际Vue生命周期，不修改UI业务逻辑或降低行为断言。

## 验证与边界

最终验证通过：

- 四个工作区完整构建和类型检查；API全量192套/2051项、Parser全量51套/1213项、Server全量回归、UI 95项，以及真实受管进程生命周期32项。
- Gateway两条host路径的组合回归2套/22项；兼容依赖实际消费回归6项；Nest SSE回移包完整性校验；npm 10.9.2从最终锁文件执行clean ci成功。
- API文档导出与快照检查通过，228路径/268操作/232 schema，包含登录、列表、匿名拒绝及刷新示例的实际验证。
- 文档368份、当前清单57项、2399处本地链接及25个锚点检查无失败；历史NP迁移表检查通过。当前台账仍为209项：204 DONE、2 IN_PROGRESS、1 WAIT_DEP、2 DEFERRED，245依赖。
- Lint为0错误，保留现有288条警告（API 142、Parser 68、UI 78）。生产依赖审计仍有7 high、9 moderate、0 critical，共16个包节点，不能据此关闭SEC-F4-02。

首次失败、冲突修复和最终复验日志保留在.tmp/main-merge-20261026；早期失败结果不代表最终状态。本轮未新跑PostgreSQL服务或跨平台CI，也不替代生产签收。

原始受管流程停止/取消用例、请求授权和上传配置冲突已通过定向复验；Parser初跑60ms例外到期测试在并行负载下提前拒绝（0连接、0HTTP字节），串行全量51套1213项通过，安全边界未放宽。

本轮不是新版本发布，标签、三平台归档、latest、legacy数据库不动。生产安全/观察/OPS签收、人工反馈和延期仍在[open-items](../../reference/open-items.md)。主分支保留当前依赖风险，不把源码合并称为生产可用。
