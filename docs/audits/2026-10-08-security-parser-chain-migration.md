---
doc-version: 1.1.0
doc-status: active
doc-updated: 2026-10-08
---
# SEC-F4-02 上传与解析器依赖链迁移

> 本文保留第三批的 15 节点时点证据。后续已将生产文件监听迁移至无 glob 的 Chokidar 4，当前为 13 个 moderate、0 high/critical；见[监听迁移验收](./2026-10-08-security-file-watch-migration.md)。

本批承接[第二批风险处置](./2026-10-08-security-dependency-closure.md)，实际替换 Nest 消费的旧 multer、Express/body-parser/qs 和 Swagger/Config 的 YAML/lodash 依赖。SEC-F4-02 仍为 IN_PROGRESS；生产环境签收继续待办。

## 解决的问题和方案

前轮升级直接 multer 没有改变 Nest `FileInterceptor` 的真实解析链。本轮从该消费者所在包重新 `require.resolve` 核实：当前已使用 multer 2.4.0，旧 2.0.2 不再安装。上游确认[特制字段可导致进程退出](https://github.com/expressjs/multer/security/advisories/GHSA-wc9g-mqfw-jrwm)，因此不能仅凭 JWT 或文件大小限制豁免旧版本。

| 实际消费者 | 原解析版本 | 当前版本 |
| --- | --- | --- |
| Nest FileInterceptor → multer | 2.0.2 | 2.4.0 |
| Nest ExpressAdapter → Express | 4.22.1 | 4.22.3 |
| Nest / Express → body-parser | 1.20.4 / 1.20.5 | 1.20.8 |
| Express / body-parser → qs | 6.14.2 / 6.15.3 | 6.16.0 |
| Swagger → js-yaml | 4.1.0 | 4.3.2 |
| Swagger / Config → lodash | 4.17.21 | 4.18.1 |

保留 Nest 10 和既有框架包版本。根 manifest 显式声明现有 `@nestjs/platform-express@10.4.22`、`@nestjs/swagger@7.4.2`、`@nestjs/config@3.3.0` 三个父包，再用限定父包/主版本的 overrides 替换解析依赖。这些父包原本已由 API workspace 引入；没有增加另一个 Nest 运行实例。根、API 和 platform-express 的 common/core 解析路径相同，`npm ls` 没有 invalid/peer 冲突。

隔离复现说明此声明有必要：全新最小 workspace 的 overrides 生效；复制本仓库的多 workspace 锁图后，仅加 overrides、更新子包、更新父包或只删旧子记录均不能替换 Nest 的固定子链；增加三个根父依赖并定向重新解析 Nest/解析器锁节点后才生效。这与 npm 的 [workspace/file link 跨越时丢失 override 报告](https://github.com/npm/cli/issues/9659)表现相近，尚未证明是同一内部缺陷。没有通过忽略 peer、整棵重建根锁文件或编辑 node_modules 强行修复。

锁变更还包括两个 MCP Express 5 子链的 content-type 2.0.0 → 2.1.0（被重新解析的 body-parser 同主依赖），以及相同版本 Terminus 的安装位置移动、已不需要的旧 multer 子依赖删除；没有 MCP SDK/Express 5 主版本变化。最终锁 SHA-256：`613f484ecae4de2721be09925bab2772c0ddf02cfdd711fef02f46c7d7586b2b`。

## 上传行为和验证

multer 2.4 已自行实现包含上限的 fileSize 语义，故移除应用侧原先为旧 Busboy 语义添加的 `+1`。两个入口继续允许恰好达到配置上限的文件，超一字节在解析阶段返回 413。按现有上传 API schema 限定一个文件、零个文本字段，拒绝无用字段、深层或超大数组索引字段和第二个文件。认证仍先于 multipart。

真实 loopback HTTP 共 **23/23**：上传 14 项覆盖原有大小/动态配置/认证边界及新增异常 multipart、重复文件、特制文本字段、客户端在上传途中断连和后续请求恢复；既有 Gateway ingress/Socket.IO 9 项验证继续握手、异常 Expect/Upgrade 拒绝和路由初始化。上传服务和身份为测试替身，使用真实 controller/interceptor/multer；不能将其计为真实 JWT 或全部解析器漏洞 PoC 验收。

新增 `npm run verify:security-parser-dependencies` 从实际消费者进行 **13 条依赖版本检查**、Nest common/core 单实例检查，以及 JSON/urlencoded 两种 parser 的无效 limit 拒绝检查。后者验证升级后的 body-parser 不再将错误配置静默解释成无限制，见[上游公告](https://github.com/expressjs/body-parser/security/advisories/GHSA-v422-hmwv-36x6)。脚本接受目标根目录参数，可用于检查复制后的交付目录。

| 安装证据 | 结果 |
| --- | --- |
| 主 workspace 增量安装、consumer 门禁、npm ls | 全通过；added 1 / removed 18 / changed 5 |
| 隔离完整 workspace，npm 11.12.1 干净 `npm ci --ignore-scripts` | 1241 包，consumer 门禁通过 |
| 同一候选锁，项目声明的 npm 10.9.2 再次干净 `npm ci --ignore-scripts` | 1241 包，consumer 门禁及 npm ls 全通过 |
| 原始安装/审计/HTTP证据 | `.tmp/sec-anchor-lock/`、`.tmp/sec-main-resolution.json`、`.tmp/sec-main-ls.json`、`.tmp/sec-parser-audit.json`、`.tmp/sec-parser-http-tests.log` |

隔离 ci 验证的是可重复依赖图，使用 ignore-scripts 且不宣称 native 生命周期或全部发布验收。主工作区实际 HTTP 回归使用真实已安装的候选依赖。根代理统一完成整仓构建、最终 API 重建，并确认 API 全量 **179 套 / 1883 项通过**；日志 `.tmp/2026-10-08-throughput-api-full-tests.log`。全量包含真实 Gateway HTTP/HTTPS 流式转发及 Socket.IO 回归；这些结果不代表正式发行包或生产签收。

## 安全剩余与交付边界

`npm audit --omit=dev --json` 从 **21 节点（0 critical / 6 high / 15 moderate）降为 15（0 / 2 / 13）**。计数是受影响依赖节点，不是独立漏洞数；本批没有靠风险忽略规则降低数字。

剩余两条 high 为 chokidar/braces 链，仍需将现有 CLI 文件监听约束为字面路径并验证或兼容迁移；其余为 Nest SSE / file-type 传播节点及 uuid。前轮对未接线的 Nest SSE/FileTypeValidator 和仅用 uuid v4 的边界判断仍有效，均不等同生产风险接受。下一步应完成这些消费者的可利用性处置及框架维护方案，而不是重复改进已经通过的上传边界。

当前 `scripts/package-release.ps1` 复制根 manifest 与 lock，再安装生产依赖，因此继承上述 overrides；未来产物必须在实际目录运行门禁并执行完整发布验收。单独 `npm pack` 后安装某个 workspace 不会自动继承根 overrides，**本报告不宣称单 workspace 发布消费者已获得相同修复**。本轮未创建或发布正式发行包，生产账号、存储权限、网络和实际开关的签收仍待办。
