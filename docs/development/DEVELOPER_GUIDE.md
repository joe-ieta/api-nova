---
doc-version: 1.1.0
doc-status: active
doc-updated: 2026-10-26
---
# 开发与系统集成手册

本仓库采用npm Workspaces和根package-lock.json。产品设计见[总体架构](../architecture/OVERALL_DESIGN.md)，启动见[部署手册](../guides/DEPLOYMENT.md)，API使用见[接入手册](../api/README.md)。

## 工作区与构建顺序

Parser提供共享语义，Server和API消费其产物，UI通过API工作。根构建器按依赖构建，优先使用`npm run build`，避免修改Parser后直接运行陈旧dist。

```bash
npm ci
npm run verify:package-manager
npm run build
npm run type-check
```

只维护根锁文件；不在单个workspace另装一套依赖或提交其他包管理器锁。API独立workspace脱离根锁文件安装不是现有支持路径。完整环境见[包管理政策](../guides/package-management-policy.md)。

## 代码入口

| 任务 | 主要入口 |
| --- | --- |
| Parser公共导出 | `packages/api-nova-parser/src/index.ts` |
| API启动/中间件 | `packages/api-nova-api/src/main.ts`、`app.module.ts` |
| 资产/测试/发布 | API的asset-catalog、endpoint-testing、publication、runtime-verification模块 |
| HTTP转发 | API的gateway-runtime模块；流式入口不能被通用body parser提前耗尽 |
| 受管MCP | API的servers/runtime-assets及Server运行时；可信上下文按已有协议交付 |
| UI接口 | `packages/api-nova-ui/src/services/api.ts`及`src/api`下的具体客户端 |
| 数据模型/迁移 | `packages/api-nova-api/src/database` |

## 自定义UI与系统接入

API是控制面，UI可以替换。已有业务应用可直接消费发布的Gateway/MCP，而无需实现整套管理界面。若要接管管理流程，按以下顺序接入：

1. 实现`/api/auth/login`、refresh和当前用户/权限读取；管理JWT放Authorization Bearer头。
2. 通过资产目录、实例和测试接口操作已存在模型，不直接写表；处理未绑定实例、治理阻断与失效证据。
3. 装配运行资产、成员、profile/route及上游绑定，按候选验证结果激活，处理失败保旧。
4. 消费时使用独立运行时凭据；日志/统计/事件仍按当前角色和资产范围访问。
5. 按需要接Socket.IO，处理ACK、游标、失效与重连；HTTP轮询是已有读取路径，不要求新造推送层。

默认UI客户端用相对`/api`，Vite通过`VITE_PROXY_TARGET`代理API、health、Socket.IO；分域部署需要调整代理/CORS和连接地址。UI当前有多个按业务域组织的请求模块，不应只改一个baseURL就认为全部接入完成。没有现成独立UI发行版或承诺中的新SDK。

只替换样式/局部页面的成本较低；重写完整管理UI需复现测试治理、发布、权限和实时协议，成本明显更高。可先使用[API手册](../api/README.md)的登录和目录查询，再按实际需要接入原有工作流。

## 变更验证

文档修改先执行`node scripts/verify-docs.cjs`；控制器/DTO变化先构建API，再生成并检查接口快照：

```bash
npm run build:packages
node scripts/export-api-docs.cjs
node scripts/export-api-docs.cjs --check
```

生成器使用新建隔离SQLite、随机测试身份和回环临时端口，校验登录/目录读取/匿名拒绝/刷新示例，不加载用户.env或修改业务数据库。Swagger注解不完整的字段和动态运行面不通过生成器臆造，见[接口边界](../api/README.md#接口清单与快照边界)。

功能变更运行受影响的测试，发布时再执行[发布规范](../../RELEASE_STANDARD.md)的全部门禁。Parser变更遵守[传播验证](../guides/parser-change-verification.md)。不把局部测试通过写成跨平台/生产签收，也不重开已限定DONE任务。

当前工作区已合并到main；开始工作时以实际Git分支及最新基线为准，不按历史交接自动切回oc_dev。工作台账、任务合同和open-items分别记录状态、原出口和剩余边界。默认新工作分支前缀codex/；提交前核对差异和凭据，避免混入.tmp、测试库、日志及已发布产物。历史Git协作流程已归档，实际发布分支仍须按发布规范与本轮授权确认。

## 离线开发与文档维护

断网迁移按[离线开发指南](offline-dev-migration.md)准备匹配平台的工具链和依赖。开发转移包不等于正式三平台离线交付。

文档按[规范与清单](../VERSIONS.md)维护。一个主题只有一个当前权威入口；阶段报告、原审批和旧版本放归档并保留可追溯链接。发布文档使用模板创建新tag目录，已发布版本及归档字节不原地改写。

## 开发目录与本地证据管理

项目根目录保留源码工作区、scripts、docs、examples、vendor、根manifest/锁文件及必要配置。源码保持现有路径，避免仅为整理目录改变导入和构建关系。

| 内容 | 位置与处理规则 |
| --- | --- |
| 持续开发内容 | packages内的src/tests/scripts和配置、根scripts、docs及vendor；纳入Git维护 |
| 已安装依赖与当前构建 | node_modules、packages/*/dist；本地保留便于继续开发，需要时按根锁文件/构建器重建 |
| 临时验收、数据库夹具、日志 | 新运行优先写入.tmp/<任务或日期>/；已有验收器写tmp时继续兼容，不在根目录散放日志 |
| 历史本机证据 | .local-archive/<日期-用途>/；仅本地保存，Git忽略，不进入源码提交或发布文档 |
| 业务数据库、运行审计与本地秘密 | data、packages/*/data及.env等保留原位；不能当作测试缓存删除，需按部署/留存合同单独处理 |
| 已发布产物和历史文档 | 保留其现有发布/归档结构，不因开发目录清理修改已发布字节 |

2026-10-26已将原.tmp、tmp、Server的.tmp、过期pids及根目录4份h11日志移入本地归档`.local-archive/2026-10-26-development/files/`，保留原相对路径。该归档包含历史测试数据库、安装副本和当日发布验证资料；不是生产数据库备份，也不随Git克隆转移。npm/Jest可再生缓存已删除，npm诊断日志另存cache-logs。详细移动和清理清单见归档根目录的cleanup-manifest.json及README.md。

读取历史审计中的.tmp/xxx或tmp/xxx路径时，先在上述files目录查找同路径。需要复现时，将所需单个任务目录复制到新的隔离工作区；先检查夹具中的绝对路径、符号链接和配置，不直接执行历史修改脚本。恢复不得覆盖当前生成的新证据或运行数据。归档中可能含测试凭据和本地配置，未经筛选/脱敏不得上传。

再次清理前检查Git差异、活动进程和目标路径，确认没有受跟踪文件；对junction/符号链接不跟随递归。只删除明确可再生的缓存，其余有追溯价值的内容先归档并登记路径。清理后核对锁文件、配置、数据和当前构建未变。`npm run clean`会删除依赖/构建，不作为日常日志和临时证据整理命令。
