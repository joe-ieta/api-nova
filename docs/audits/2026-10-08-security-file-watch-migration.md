---
doc-version: 1.1.0
doc-status: active
doc-updated: 2026-10-08
---
# SEC-F4-02 文件监听依赖迁移

> 本文保留监听迁移后的 13 个 moderate 时点证据。后续 file-type/UUID 消费者迁移已使生产审计降至 10 个 Nest SSE 传播节点；见[残余依赖迁移与风险边界](./2026-10-08-security-residual-dependency-migration.md)。

本批在 `5a9f227` 后继续处理[解析器迁移](./2026-10-08-security-parser-chain-migration.md)保留的 chokidar/braces 生产风险。两处实际入口为 CLI 的 OpenAPI 文件热重启，以及交互配置管理器的配置变更通知；均传入一个具体文件路径，不需要 glob。`path.resolve` 本身不会关闭旧版 glob 解析，因此不能据此接受旧链风险。

## 实际修复

`api-nova-server` 将直接依赖 `chokidar ^3.6.0` 改为 `^4.0.3`，当前锁定 4.0.3 / readdirp 4.1.2。Chokidar 4 移除 glob 支持和 braces 依赖，保留 CommonJS、原子写和稳定写支持，Node 最低版本 14.16.0 满足产品 Node >=20 的范围；依据为 [4.0.3 官方说明](https://github.com/paulmillr/chokidar/blob/4.0.3/README.md)和包 manifest。

两处入口因此以字面文件名监听，花括号、方括号不再展开。CLI 保留 `awaitWriteFinish` 的 300ms 稳定窗口、100ms 采样及变化后关闭监听再触发重启；ConfigManager 保留新旧配置通知与停止函数。唯一需要适配的运行源码是 Chokidar 4 将 error 事件参数声明为 unknown，CLI 改为先判断 Error 再格式化。

锁文件仅增加 server 下的 chokidar 4.0.3 / readdirp 4.1.2 两个版本节点。开发工具仍依赖的 chokidar 3/braces 节点由 npm 按实际使用图重新标为 dev；没有手工改审计标记、删除审计条目或强制其他消费者升级。此修复写在 server 自身 manifest，单独发布/安装 server 也能获得同样的监听依赖声明，不依赖根 overrides。

## 验证

新增 `npm run test:file-watch --workspace api-nova-server`，并加入 server 默认测试链。全部使用真实文件系统、编译后的生产入口和真实 Chokidar；仅观测 watcher ready 状态以保证测试时序与清理。配置存储重定向至本机隔离目录，不访问用户现有配置。

**7/7 通过**：实际解析 Chokidar 4.0.3；普通方括号、花括号、64 层嵌套花括号文件名均按字面路径监听，类似 glob 的兄弟文件变化不触发回调；分块写完成后才触发一次重启并关闭 watcher；原子替换保存正常；远程 URL 不建本地 watcher；交互配置的两次稳定写正确携带新旧值，停止后不再通知。初次配置测试连续写入落在 Chokidar 重复事件节流窗口内，改为分别等待稳定写后再写下一次，最终全过；未通过修改生产节流策略迁就测试。

其他验证：server TypeScript 构建通过；前轮解析器消费者门禁仍通过；`npm ls --workspace api-nova-server chokidar readdirp --all` 无错误。CLI smoke、server smoke、streamable 多会话、OpenAPI transform、STDIO 可观测 12/12、持久化 smoke 均通过。

追加的 server 全测试首轮在既有 `runtime-security-audit-smoke.js:188` 发现 caller-a 观察记录预期 1、实际 21。根代理核对 `84c7aaf` 之前及当前写入逻辑，确认既有语义一直是每条 authenticated finished 记录追加 caller observation，并非去重目录。修正过时 smoke：全部观察行与 authenticated finished 的 callerId/issuer/subject/clientId/transport/observedAt 精确多重集一致；caller-a 对应条数相等且唯一 callerId 为 1，保留终态/关联完整性并补充观察文件不含 token 的检查。未更改生产写入语义。随后完整 server 默认测试链重新执行成功，包含 security audit、STDIO 12 项、持久化和新监听 7 项；最终日志 `.tmp/sec-watch-server-regression-final.log`。首轮失败证据保留。原始证据：`.tmp/sec-watch-tests-final.log`、`.tmp/sec-watch-server-regression.log`、`.tmp/sec-watch-stdio-tests.log`、`.tmp/sec-watch-persistence.log`、`.tmp/sec-watch-ls.json`、`.tmp/sec-watch-parser-gate.json`。

## 状态与剩余

`npm audit --omit=dev --json` 的生产受影响节点从 **15（0 critical / 2 high / 13 moderate）变为 13（0 / 0 / 13）**；原始 JSON 在 `.tmp/sec-watch-audit.json`。这是生产依赖图的变化，不代表开发依赖或全项目审计为零。

剩余是 Nest SSE/file-type 的传播节点与 uuid：继续按实际消费者处置，保留框架维护迁移任务及已有“尚未找到受影响生产调用”的证据边界。SEC-F4-02 仍 IN_PROGRESS；正式发行包、Linux 文件系统行为和生产账户/存储/网络/真实开关签收没有因此完成。本轮验收环境为 Windows 本机隔离目录。
