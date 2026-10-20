# ApiNova v1.7.6-rc.5

> 发布状态：prerelease，供人工测试，生产签收未完成
> Git 提交：`@GIT_COMMIT@`
> 发布日期：2026-10-20
> 上一版本：v1.7.6-rc.4

## 核心变化

- 日志页接入真实持久化运行事件，删除示例数据；每页50条，服务端级别筛选，当前页搜索及来源筛选，支持顶部刷新。显示加载、权限、超时、失败和空结果；清空仅清除显示，退出或切换会话丢弃旧请求。
- 修复无servers的OpenAPI URL导入错误补入localhost并生成运行实例；管理端保持未绑定，用户显式配置地址。其他解析器客户端保留原有兼容默认行为。
- 修复运行实例编辑框端口不可操作、首次production绑定未正确处理404而不显示候选实例的问题。
- 补验无server双端点导入、同一Gateway发布、真实认证消费、归档停止A后迁移到B，核对端点身份、部署回放和持久化监控。
- 修复双库CI的共享包构建、测试与启动环境耦合、数据库初始化及启动探测；保留完整单元断言，增加实际双库迁移与持久化检查。

## 兼容性与配置

无新增数据库schema迁移或用户配置要求。与rc.4保持相同数据迁移合同；仅接受已知迁移链完整前缀，旧数据不自动复制到latest。日志查询沿用monitoring:read权限，只显示运行事件，不代表全部进程日志或完整安全审计。搜索和来源筛选仅作用于当前页。

完整健康要求至少空闲5GiB，包含内存及MCP依赖。保留Nest SSE字节补丁与依赖门禁。

## 平台产物与验证

Windows x64、Ubuntu24.04 x64、Ubuntu24.04 ARM64三个原生离线包，Node24.15.0、npm10.9.2。Linux基线为Ubuntu24.04。

- api-nova-release-v1.7.6-rc.5-win-x64.zip
- api-nova-release-v1.7.6-rc.5-linux-x64.tar.gz
- api-nova-release-v1.7.6-rc.5-linux-arm64.tar.gz

开发验收：API186套/1950项、解析器51套/1213项、UI95项通过；本机浏览器37阶段生命周期及22阶段文件导入/日志回归通过。双库CI实际验证各73张业务表、8次迁移、零结构漂移、重启、持久化及启动；单元测试仍使用其原SQL.js夹具。

发布还须通过锁文件安装、package-manager、runtime-closure、数据库初始化、全量测试、类型检查、lint和构建，并在三种匹配OS/CPU上通过暂存及新解压离线启动。最终运行编号、校验和及结果见本版本审计与evidence。任一平台失败不晋升、不发布。

## 已知限制

- SEC-F4-02、OBS-16-04、OPS-01目标生产签收及用户人工反馈仍待办。
- 认证规范、MCP、多角色和其他浏览器组合，以及二进制目标ACL/Linux文件语义/MCP真实外发尚未全量覆盖。
- Nest维护迁移、残余依赖风险和lint警告继续维护，不声明全部技术债清零。
- SQLite3000样本未证明有限窗口内全量采集投递，仍为非阻断诊断，不承诺生产容量。
- 真实SMTP/Webhook、反代/TLS、systemd、长时多主机运行及独立API workspace安装仍按open-items签收。
- OAuth2、额外令牌适配、跨协议QoS继续延期。

## 升级与回退

先停止旧版本并完整备份配置、数据和日志，在新目录解压测试。latest切换前完整备份旧latest至backups；不覆盖历史archive或legacy数据库。回退时使用rc.4归档及对应数据备份。

包内仅有公开本地测试默认值：账号`admin / admin@123456`，JWT默认值`api-nova-local-release-change-me`及`api-nova-local-release-refresh-change-me`；共享网络使用前修改。发布物不得含开发机.env、真实凭据或运行数据库。
