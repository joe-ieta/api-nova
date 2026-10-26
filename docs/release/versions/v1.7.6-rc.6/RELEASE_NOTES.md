# ApiNova v1.7.6-rc.6

> 发布状态：prerelease，供人工测试，生产签收未完成
> Git 提交：`@GIT_COMMIT@`
> 发布日期：2026-10-26
> 上一版本：v1.7.6-rc.5

## 核心变化与修复

- 在main整合oc_dev后发布，保留rc.5的真实运行日志、OpenAPI无servers导入及运行绑定修复。
- Gateway整合显式宿主网络接线与生产发布authority校验，保持请求与目标绑定、绝对deadline、单跳执行和授权缓存隔离。两条host路径同时配置时拒绝建立网络provider，默认不启用。
- 受管MCP同时保留managedMcpMode真实进程的READY、停止、取消与恢复，以及executionMode协调器的授权租约。两个配置键有不同合同，不能互换；启动预检失败不提前标记STARTING。
- 增加发布运行成员的只读门禁预览接口；收紧OpenAPI上传的单文件、字段、头数量及有效大小配置边界。
- 合并兼容依赖整改，保留Nest SSE回移包；锁文件通过npm10.9.2 clean ci及实际消费回归。
- 统一当前任务台账和open-items，归档历史规划，修复文档引用；本版本首次随包交付设计、架构、能力定位、使用/运维及开发API手册、OpenAPI快照和文档校验清单。

## 兼容性与配置

产品版本由Git标签定义，工作区npm包版本不因此改号。新增只读GET /api/v1/publication/endpoints/runtime-memberships/{membershipId}/preview；管理API快照228路径、268操作、232 schema。既有UI、认证及动态Gateway/MCP合同见包内docs/README.md。

从rc.5到本版本未新增数据库迁移文件；旧数据仍按既有迁移链校验，不能将latest切换当成数据迁移。生产宿主授权/网络或受管MCP采用其原有显式配置，不建议未经隔离验收切换运行模式。完整健康磁盘门槛保持5GiB，仍检查内存及MCP依赖。

## 平台产物与验证合同

三个原生离线产物使用同一提交、锁文件、Node24.15.0和npm10.9.2。Linux实际构建/验证基线为Ubuntu24.04；本版本不声明已验证Ubuntu22.04。

- api-nova-release-v1.7.6-rc.6-win-x64.zip
- api-nova-release-v1.7.6-rc.6-linux-x64.tar.gz
- api-nova-release-v1.7.6-rc.6-linux-arm64.tar.gz

合并提交本机验收：API192套/2051项、Parser51套/1213项、UI95项、Server全量及真实受管生命周期32项通过，构建/类型通过；Lint零错误、288条警告。发布精确提交仍须重新执行锁文件安装、包管理器、runtime-closure、数据库初始化、全量测试、类型、lint、构建和文档/API快照门禁，并在各原生平台通过暂存与最终归档新解压的离线启动。最终结果以对应GitHub Actions运行和本地evidence为准；任何门禁或平台失败均不发布、不晋升latest。

## 已知限制

- SEC-F4-02、OBS-16-04生产签收及OPS-01人工反馈继续开放，209项任务仍为204 DONE、2 IN_PROGRESS、1 WAIT_DEP、2 DEFERRED，不新增功能或代签生产。
- 合并后生产依赖审计仍有7 high、9 moderate、0 critical包节点；Nest维护迁移、残余依赖和Lint警告继续维护，不声明风险清零。
- 真实SMTP/Webhook、反代/TLS、systemd、长时多主机、独立API workspace安装，以及未验认证/角色/MCP/二进制ACL组合，继续按open-items签收。
- SQLite3000样本不代表有限窗口内全量采集投递或生产容量承诺；OAuth2、额外令牌适配、跨协议QoS继续延期。

## 升级与回退

停止旧版本并完整备份配置、数据和日志，在新目录解压测试；不要在archive中运行。latest切换前完整备份旧latest至backups，历史archive和legacy数据库保留。旧业务数据不自动复制到新latest；通过隔离副本验证后再按现有部署手册迁移。回退使用rc.5完整归档及与该版本匹配的数据备份，不能直接以旧程序打开升级后数据。

包内仅含公开本地测试值：账号admin / admin@123456，JWT_SECRET=api-nova-local-release-change-me，JWT_REFRESH_SECRET=api-nova-local-release-refresh-change-me。共享网络前修改管理员密码和两个独立JWT秘密；发布物不得包含开发机.env、真实凭据或运行数据库。
