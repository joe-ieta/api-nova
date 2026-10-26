---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-26
---
# 安装、部署与运维手册

本文区分已发布离线包和源码开发。当前候选为v1.7.6-rc.5，生产环境签收未完成；使用其[快速指南](../release/versions/v1.7.6-rc.5/QUICK_START.md)和[发布说明](../release/versions/v1.7.6-rc.5/RELEASE_NOTES.md)核对版本限制。

## 离线包启动

选择与OS/CPU一致的Windows x64、Linux x64或Linux ARM64包，完整解压到可写目录。内含对应平台Node和生产依赖，无需安装依赖或在线下载。rc.5 Linux实际验收环境为Ubuntu24.04；不得用跨平台复制的node_modules替代原生包。

Windows运行`start.bat`；Linux执行`./start.sh`。打开`http://127.0.0.1:9001/`。离线包使用API9001托管UI；9000用于源码Vite开发。终端按Ctrl+C停止，确认受管进程与PID状态。

公开本地测试账号为`admin / admin@123456`。包内公开JWT默认值为`api-nova-local-release-change-me`和`api-nova-local-release-refresh-change-me`；共享网络使用前设置独立秘密并修改管理员密码。不要把测试默认值当作生产配置。

## 配置、路径和健康

| 项目 | 位置/行为 |
| --- | --- |
| 包配置 | 解压根目录`.env` |
| SQLite | 默认`data/api-nova.db`；必须持久可写，不在不可变archive目录直接运行 |
| 进程输出/记录 | `logs/`、`pids/`；调用事实和正文路径按各有效配置 |
| 启动存活 | `GET /api/health/live`：只表示API进程存活 |
| 就绪 | `GET /api/health/ready`：进程就绪检查，不证明上游业务可调用 |
| 完整健康 | `GET /health`及`GET /api/health`：内存、磁盘、MCP等；需要至少空闲5GiB |
| 初始化状态 | `GET /api/system/initialization` |
| MCP | 按实际运行配置检查；独立默认9022，HTTP健康`/health` |

MCP未启动或系统盘不足会导致完整health503，即使API存活为200。2026-10-26本机完整健康已通过；这不能代替目标环境签收。生产模式不提供`/api/docs`，接口手册使用[离线API文档](../api/README.md)。

## 源码启动

Node>=20、npm>=10，仓库锁定npm10.9.2；发布验证使用Node24.15.0。始终从仓库根目录执行：

```bash
npm ci
npm run verify:package-manager
npm run build
```

只在不存在时从`packages/api-nova-api/.env.example`复制API环境文件，填写实际秘密和选定数据库。首次初始化只针对明确选定的新空库，执行[数据库手册](database-strategy.md)的迁移命令；不重置已有业务库。

分别保留三个终端：

```bash
npm run start:dev --workspace api-nova-api
npm run dev --workspace api-nova-ui
npm run dev --workspace api-nova-server
```

对应API9001、UI9000、独立MCP9022。根`npm run dev`不启动完整API，不能单独作为整套产品启动命令。普通源码构建不自动将UI复制到根public目录；源码后端启动不等于离线包单进程托管UI。

源码测试环境可在`/api/docs`查看Swagger，`/api/docs-json`读取JSON；`NODE_ENV=production`关闭该入口。数据库、API环境文件优先级和代理配置见[数据库](database-strategy.md)及[开发手册](../development/DEVELOPER_GUIDE.md)。

## 数据、升级与回退

数据库自动同步始终关闭。现有8项迁移属于当前模型演进链，不能将“有迁移”解释为支持任意历史数据库自动升级。升级前完整备份数据库、受控对象目录、有效配置及必要日志，按版本发布说明选择迁移策略。

SQLite应在停写后备份，或使用已有验证的备份方式；不能把复制一个正在写入的文件当作一致备份。PostgreSQL按已验证的备份/恢复流程操作，实际身份和目标ACL需验收。回退包和数据必须相互匹配，禁止用旧程序无证据打开已变更的新schema。

发布容器为`api-nova-release`：`archive/<tag>`不可变；`latest`为运行镜像；`backups`保留旧目录；`evidence`保留证据；`.staging`供临时构建。legacy业务数据库位于`backups/legacy-20261014065727`，不能随文档或构建清理删除。晋升/回退遵守[发布规范](../../RELEASE_STANDARD.md)。

## 外部接入与故障排查

反向代理需同时转发`/api`、`/health`、`/socket.io`，Socket.IO开启协议升级；MCP独立监听需单独配置相应HTTP/SSE通道。不同域名时核对API的`CORS_ORIGINS`；部署TLS、信任代理及出站权限应按实际合同验收。

启动失败先核对平台/CPU、9001/9022端口、可写目录、数据库连接/待迁移状态及启动日志；401先区分管理和消费身份，403核对权限/资源范围，422核对DTO白名单；调用不可见再核对来源、时间窗和采集开关。不要靠开启所有worker排障。

可观测worker/邮件默认关闭，实际接收端、密钥、保留、恢复及回退见[运维配置](OBSERVABILITY.md)和[安全合同](../reference/security-contract.md)。当前生产签收及依赖风险见[open-items](../reference/open-items.md)。
