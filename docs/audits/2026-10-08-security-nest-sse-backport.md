---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-08
---
# SEC-F4-02 Nest SSE 官方补丁回移与交付校验

基线 `1c2c58c`，接续[file-type / UUID 迁移](./2026-10-08-security-residual-dependency-migration.md)。本批实质修复 Nest SSE 字段注入，采用有来源、可重建的 Nest 10.4.22 本地依赖归档。**npm audit 仍为 10 moderate / 0 high / 0 critical**：版本仍落在上游公告范围，10 是同一公告传播的受影响包节点数，不是 10 个独立漏洞。本批不免除 SEC-F4-02 整体签收或生产环境签收。

## 选择和兼容边界

官方公告 [GHSA-36xv-jgw5-4q75 / CVE-2026-35515](https://github.com/nestjs/nest/security/advisories/GHSA-36xv-jgw5-4q75) 的上游修复版本为 11.1.18。准确修复为 [commit 0f962c75a474b08fbc1bdf072b89eda14151c856](https://github.com/nestjs/nest/commit/0f962c75a474b08fbc1bdf072b89eda14151c856)：`SseStream._transform()` 对 type、id、retry 转成字符串后删除 CR/LF，阻止这些字段生成额外事件或字段。

本机从 npm 官方归档核对 11.1.18 core 与 platform-express。Nest 11 适配器引入 Express 5.2.1、path-to-regexp 8.4.2，`normalizePath()` 会先进行新语法校验。隔离执行实际 8.4.2 路径编译器，当前 `/v1/gateway/:routePath(*)` 报 `Unexpected ( at index 22`。即使强制底层 Express 4，也不能绕开适配器的预校验；一致迁移需连同 Gateway 路由参数、请求/查询解析、伴随 Nest 插件一起验收。本轮选择最小官方回移，没有只升级 core 到 Nest 11，也没有改变 HTTP/API 路由、鉴权、上传或 Socket.IO 语义。

没有生产 `@Sse()` 消费者只是此前的暴露范围说明，不是修复证据。本批直接验证实际 Nest 编码器以及临时真实 `@Sse()` HTTP 路由；MCP SDK SSE 和 Gateway 原始流继续使用原有实现。

## 可复现的补丁归档

- `vendor/nestjs-core-10.4.22-apinova-sse.1.tgz`：来源是官方 `@nestjs/core@10.4.22`，仅修改 `package/router/sse-stream.js` 的 `_transform()`。包名、版本、369 个 tar 条目的顺序、其余 368 个文件内容/元数据及原始 MIT LICENSE 保留；目标条目的长度与校验和按补丁更新。
- `scripts/build-nest-sse-backport.cjs`：纯 Node 标准库，先验证官方 tarball SHA-512 和原始 SSE 文件 SHA-256，再精确替换三行、加入 sanitize 一行。未知归档/源文件或重复匹配均拒绝；固定 gzip 配置，保留其他 tar 条目字节。此机器两次构建产物逐字节一致，回移后的整个 `_transform()` 与官方 11.1.18 编译 JS 完全一致。
- `vendor/nestjs-core-sse-backport.json`：记录官方 commit、公告、上游完整 integrity、补丁文件 SHA-256 和最终归档 SHA-256；`vendor/README.md` 包含重建和退出补丁的维护规则。
- 根 dependency 与 override 指向同一归档；锁文件只改变根依赖声明和 core 的 resolved / integrity 两个条目，所有包版本与其他依赖子图保持原样。`npm ls` 确认 Nest 消费者共享 10.4.22，无 invalid 或 peer 冲突。

| 对象 | SHA-256 |
| --- | --- |
| 官方 10.4.22 SSE JS | `157ba6f0a1949a441c91e122188c1c168189c0863ba56289280b6b1fd1f64fac` |
| 回移后 SSE JS | `fccdab632a969e74dc33c27c360c9bdba1292ed71b9764f0c585048df4288563` |
| 分发补丁归档 | `bb256b476e4db0f7b933ca90e3028235f17742593b0c03d11226842f606bdf32` |

重建方法：

```powershell
npm pack @nestjs/core@10.4.22 --pack-destination .tmp --silent
node scripts/build-nest-sse-backport.cjs .tmp/nestjs-core-10.4.22.tgz .tmp/nestjs-core-backport-rebuilt.tgz
npm run verify:security-nest-sse
```

归档保留 10.4.22 上游身份，文件名和 provenance 标明 ApiNova 本地回移，不能冒称官方 Nest 补丁版。压缩库改变若导致压缩字节差异，应复核与更新锁/证据，不可直接替换已锁归档。当前 archive 是交付权威字节。

## 安装陷阱与入口阻断

实测现有 node_modules 配合新 lock 执行普通 `npm install --ignore-scripts` 时，npm 同版本快路径会保留旧 core 文件。新的真实文件 SHA / SSE 注入测试立即失败，没有把 install exit 0 当成修复通过。主机随后只将经绝对路径校验的旧 core 目录移至唯一 `.tmp/sec-nest-core-before-backport-20261008` 备份，再安装锁定归档并通过所有合同；未删除备份。

交付和日常同步应使用根目录 `npm ci`。为阻止旧包继续进入交付，新增 `scripts/verify-nest-sse-backport.cjs` 同时验证 archive SHA、锁 integrity 和 API 实际解析到的 SSE 文件 SHA，并接入：

1. `scripts/build.js` 开始构建前；旧包提示执行 `npm ci` 并失败。
2. `scripts/package-release.ps1`，包括 `-SkipBuild`；原工作区若仍是旧字节，打包即失败。
3. 原生离线包生产依赖安装后；再次验证包内实际字节。
4. 生成的 `start.bat` 和 `start.sh`，在数据库初始化和 API 启动前执行同一门禁。

发布脚本复制 vendor 目录和独立校验脚本，Portable 与 OfflineCurrentPlatform 都保留本地 `file:` 依赖。补丁不依赖 postinstall，也不运行时 monkey patch。API 是 private workspace；脱离根 manifest/lock 的单包安装不继承根 overrides，不在本次保证范围。server/parser 独立 npm 包本身不消费 Nest core。

## 验证结果

入仓命令 `npm run verify:security-nest-sse` 共 6 项：真实消费者/归档/lock 一致；正常字段、多行数据、JSON 数据和自动 ID；type/id/retry 分别注入 CR、LF、CRLF；真实 Nest HTTP SSE 输出与结束；拒绝未知上游；旧版本字节阻断实际构建入口且归档篡改失败。循环案例均精确验证没有新增事件或数据字段。

| 验证 | 结果与本机日志 |
| --- | --- |
| 原始官方归档与回移归档逐条对比 | 369 条目，仅 SSE JS 变化；LICENSE 保留；方法与官方 11.1.18 相同；重建一致。`.tmp/sec-nest-backport-archive-evidence.json` |
| 完整 workspace 隔离 `npm ci --ignore-scripts` | 成功；`.tmp/sec-nest-backport-ci.log` |
| 主安装真实 SSE 合同 | 6/6；`.tmp/sec-nest-backport-main-contract.log` |
| 现有解析器消费门禁 | 通过；`.tmp/sec-nest-backport-parser-gate.log` |
| file-type / UUID 原合同 | 4/4；`.tmp/sec-nest-backport-residual-gate.log` |
| Nest 真实安装图 | exit 0、单实例；`.tmp/sec-nest-backport-ls.log` |
| 发布脚本 Portable / SkipBuild | vendor 与独立门禁均进入包；`.tmp/sec-nest-backport-portable-final-build.log` |
| 最终发布布局 `npm ci --omit=dev --ignore-scripts` | 成功；`.tmp/sec-nest-backport-portable-final-ci.log` |
| 最终发布布局安全合同/启动门禁 | 6/6；`.tmp/sec-nest-backport-portable-final-contract.log`，`.tmp/sec-nest-backport-portable-final-gate.log` |
| 生产审计 | 10 moderate / 0 high / 0 critical；`.tmp/sec-nest-backport-audit.json` |

本批测试只在隔离本机 Windows x64 / Node 24.15.0 执行，临时 HTTP SSE 服务在 finally 关闭，无常驻探针。Portable 打包和依赖验证不等于正式三平台离线产品发布，也不等于生产签收。主线统一回归已确认 API 184 套 / 1932 项通过、pipeline 67/67 通过；最终全仓构建与正式性能结果由主线记录到当前任务状态文档，不以此处定向测试替代。

## 剩余维护工作

本地回移已经修复该公告涉及的实际编码器路径，但官方 Nest 10 仍无维护修复版。后续 SEC-F4-02 应持续跟踪维护版本或推进一致 Nest 升级，重点包括 Express 5 通配符参数、Gateway 原始请求流/查询语义、鉴权、multipart、中止恢复、Socket.IO、Swagger。升级时删除本地回移前必须运行相同 SSE 合同并替换相应版本/归档门禁，不能直接移除门禁掩盖回归。当前版本审计例外如需正式签收，仍应依据组织流程明确接受范围和有效期限。
