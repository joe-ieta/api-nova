# ApiNova v1.7.6-rc.3

> 发布状态：prerelease（候选测试版本，生产签收未完成）
> Git 提交：`@GIT_COMMIT@`
> 发布日期：2026-10-14
> 上一源码标签：v1.7.6-rc.2

## 核心变化

- 补齐Windows隔离环境的API注册、治理、Gateway发布/消费以及二进制留存闭环。
- 打包UI支持手工注册和带绝对server URL的OpenAPI URL导入完整流程；治理端点可打开自己的运行实例管理，完成健康探测。
- 可观测采集、指标持久化、outbox和HTTP投递采用有界批处理，保留租约围栏、逐项授权、持久化失败和至少一次投递语义。
- 用户批准完整健康检查改为至少空闲5GiB；当前本机API+MCP完整health实测200，MCP失联仍返回503。

## 已修复问题

- Gateway Registry v1表单入口、草稿成员被隐藏、成员源服务标识、生产国际化JSON文案及导入后实例管理入口缺失。
- 导入无server时误建实例、认证候选重放、实例迁移后探测旧地址、同revision重复部署冲突。
- 二进制样本的PostgreSQL兼容及失效样本对候选准入的阻断。
- Nest SSE官方修复回移到锁定vendor归档，构建、打包、启动核对实际字节。
- 清除6个历史UI lint错误：匿名表单通过父组件事件更新草稿；控制字符仍严格拒绝。

## 兼容性与配置

- 产品版本来自Git标签；本次不进行npm包发布。
- 沿用根package-lock、Node 24.15.0与npm 10.9.2；离线包携带各自平台的原生依赖和Node。
- 本次Linux原生构建基线为Ubuntu 24.04（x64/ARM64）；未在Ubuntu 22.04实测，不作22.04兼容保证。
- 磁盘阈值为5,368,709,120字节可用空间（Windows C盘，其他平台根目录），不再按总容量百分比判断。
- host网络、Verified许可、受管IPC、collector/delivery/GC等按部署合同显式配置。默认包不等于这些能力已全部启用。
- 沿用既有数据库迁移入口及关闭自动同步的默认配置。升级前完整备份数据库、观测/二进制目录、配置与凭据；不得用新版本数据库直接启动旧版本。
- SQLite文件保存失败可能发生在内存COMMIT之后；失败不代表内存已回滚，不保证盲重试安全。HTTP投递为至少一次，可能重复。

## 平台产物与发布门禁

本版本按三平台完整离线集准备；任一平台未通过则保留staging，不创建可用版本声明。

| 平台 | 固定产物名 | 原生验证记录 |
| --- | --- | --- |
| Windows x64 | api-nova-release-v1.7.6-rc.3-win-x64.zip | VERIFICATION-win-x64.json |
| Linux x64 | api-nova-release-v1.7.6-rc.3-linux-x64.tar.gz | VERIFICATION-linux-x64.json |
| Linux ARM64 | api-nova-release-v1.7.6-rc.3-linux-arm64.tar.gz | VERIFICATION-linux-arm64.json |

发布门禁为锁文件npm ci、package-manager、runtime-closure、完整test、type-check、lint及build。实际执行结果见本候选提交的 [release artifacts工作流](https://github.com/joe-ieta/api-nova/actions/workflows/release-artifacts.yml)。三个匹配平台分别完成暂存启动、新解压启动和Node网络阻断验证后才组装RELEASE_MANIFEST.json及SHA256SUMS.txt。源码文档本身不是门禁通过证据。

本机既有证据：手工/URL导入浏览器各19阶段通过，相关UI40项；健康8项及监控入口8项通过；PG3000功能完整。历史API1940项、双库43组等有各自候选范围，不与本次发布CI合并计数。

## 已知限制和未完成事项

- SEC-F4-02、OBS-16-04、OPS-01目标签收未完成：真实账户ACL/身份、TLS/代理/出站、有效开关、SMTP/告警、容量、备份恢复及回退须在目标环境签收；本RC不表示生产可用。
- OAuth2、额外令牌适配和跨协议QoS仍延期；完整多主机首次激活CAS未批准强化。
- SQLite3000在既有有限窗口内采集/投递未全量完成，不能承诺该容量。
- 浏览器文件/无server导入、认证规范、多端点、A/B迁移、MCP和多角色组合未由当前浏览器证据覆盖。
- 二进制目标账户ACL、Linux文件语义及MCP真实二进制外发；裸机/systemd、持续负载、多主机水位与真实业务存活仍须相应目标验证。
- 2026-10-14生产依赖npm audit：10 moderate版本范围节点、0 high/critical。实际Nest SSE路径有官方回移补丁，版本范围审计仍报警；维护大版本迁移及风险处置待办，不运行npm audit fix --force掩盖风险。
- UI顶部健康徽标及通用刷新仍使用app store模拟健康数据；必须以真实/health和专门监控页为依据。此项已记录在open-items，未把模拟显示当作后端健康通过证据。
- 本机lint为0 error、273 warnings（API127、parser68、UI78）；warning技术债仍存在，完整日志保留在运行记录。匿名表单及凭据/策略相关UI测试49/49、type-check通过，完整发布门禁另见CI。
- API workspace脱离根manifest/lock的独立安装未保证。

## 默认测试凭据

离线包包含公开的本地测试默认值：管理员 `admin / admin@123456`，JWT_SECRET为 `api-nova-local-release-change-me`，JWT_REFRESH_SECRET为 `api-nova-local-release-refresh-change-me`。仅供本机初始化测试，共享网络使用前必须替换；包内不得包含真实凭据和运行数据。

## 升级与回退

先停止旧进程，把配置、数据库、凭据及观测/样本数据备份到运行目录外；在新目录解压匹配平台包，审查配置后启动并验证。回退应同时恢复旧版本完整产物和对应备份数据，不只替换程序。历史平铺api-nova-release目录可能含数据库，须单独备份确认后才能迁移。
