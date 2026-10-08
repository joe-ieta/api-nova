---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-08
---
# SEC-F4-02 第二批本机依赖风险处置

本轮在 `oc_dev / ffaafe0` 后的候选上继续本机隔离验证；生产签收仍待办。本批解决兼容范围内的实际依赖更新，未宣称 SEC-F4-02 完成。

## 已落地的受控更新

在其他代理暂停构建和验收的窗口执行指定包的 `npm update ... --ignore-scripts --no-audit --no-fund`，没有运行 `npm audit fix`。工作区 manifest 版本范围不变，锁文件更新 24 个安装节点；Vue 同族及其解析器依赖一起变化，两个开发工具使用的 js-yaml 3.x 同主补丁亦随指定解析包更新。没有升级 Nest、uuid、chokidar 或 file-type 的主版本。

| 依赖 | 原版本 | 当前锁定版本 |
| --- | --- | --- |
| MCP SDK | 1.29.0 | 1.32.1 |
| axios | 1.18.1 | 1.20.0 |
| compression | 1.8.1 | 1.8.2 |
| engine.io | 6.6.9 | 6.6.11 |
| figlet | 1.11.0 | 1.12.0 |
| Vue / server-renderer / compiler / runtime 同族 | 3.5.39 | 3.5.43 |
| 产品 js-yaml | 4.3.0 | 4.3.2 |
| 产品直接 multer | 2.2.0 | 2.4.0 |
| source-map-js | 1.2.1 | 1.2.2 |
| SDK / inspector 的 qs | 6.15.3 | 6.16.0 |

SDK 1.32.1 的包声明仍为 Node >=18，符合项目 Node >=20。其 [OAuth 客户端凭据公告](https://github.com/advisories/GHSA-6qxp-vccf-f47h)影响客户端向服务端指定的授权服务发送凭据的路径。当前生产源码检索未发现 `authProvider`、`OAuthClientProvider` 或 `client/auth` 接线，OAuth 功能仍延期；本次仍升级依赖，未用延期豁免 SDK。实际 SDK 会话、授权和 HTTP 兼容性必须与候选构建一起验证。

## 审计证据

| 时点 | critical | high | moderate | total |
| --- | --- | --- | --- | --- |
| 本批前 | 0 | 14 | 15 | 29 |
| 本批后 | 0 | 6 | 15 | 21 |

数字是 npm 受影响依赖节点，不是独立漏洞数。`npm audit --omit=dev --json` 退出 1 是发现告警，不是请求失败。原始 JSON、前后锁文件与更新列表保存在 `.tmp/security-closure-20261008/`；最终锁文件 SHA-256：`5684557a6e7eedca91ece8ba858e9d3bc15646c2d8f862099f2b7c215fb147c3`。前一批 critical 修复及其证据见[初次签收准备](./2026-10-08-security-signoff-readiness.md)。

## 上传解析阶段的实质修复

审阅发现两个上传入口在 controller 才检查体积，此时 Nest 的内存 multipart 接收已经完成。现已将两处接入 `OpenAPIUploadInterceptor`：每次请求读取现有 `MAX_OPENAPI_FILE_SIZE`，在 multipart 解析前设置上限。Busboy 在达到限制值时发出拒绝事件，因此使用业务上限加一，保留原本“恰好等于上限允许”的行为；后置检查复用同一尺寸解析函数，文件类型规则保持不变。无效或非安全整数配置拒绝处理，不回落为无限制。

新增真实 loopback HTTP 验证覆盖两个入口的精确边界、超一字节返回 413 且业务 parser 未执行、随后正常上传可恢复、配置变化即时生效、guard 先于 multipart 及无效配置拒绝，共 8/8 通过。使用真实 controller/Nest interceptor，身份和 OpenAPI 业务 parser 为测试替身；该证据不代表真实 JWT 或全部上传公告验收。旧 Nest multer 的其他公告与依赖迁移继续保留。

## 剩余项的实际利用条件与下一步

以下是源码/依赖调用点审阅结果，属于当前候选的边界判断，不是生产风险接受，也不把所有剩余工作归为环境不足。

| 剩余链 | 当前调用证据与风险判断 | 下一步 |
| --- | --- | --- |
| Nest platform-express → multer 2.0.2 | `openapi.controller.ts` 的两个上传路由实际使用 Nest `FileInterceptor`，因此直接依赖 multer 2.4.0 没有替换这条旧链。路由有 JWT guard；本轮已修复 controller 后置检查导致的文件体积准入缺口，但这不能消除旧包的全部异常字段/中止清理风险。 | 最高优先处理：建立可复现的 Nest 上传依赖迁移，有界大小已验收，继续补异常 multipart 和中止上传的真实 HTTP 验收。不能凭“已认证”豁免。 |
| Nest platform-express → body-parser 1.20.4 / Express 4.22.1 → qs 6.14.2；直接 Express 4.22.3 → body-parser 1.20.5 → qs 6.15.3 | 主程序 `bodyParser:false` 后显式使用根 Express JSON/urlencoded 解析器和配置大小限制；旧链依然存在。无效 limit 静默失效与 qs 特定输入条件应分别验证，不能用通用 body limit 证明所有公告不适用。 | 与框架依赖迁移一起修复解析器链；保留原始 Gateway 流式入口和 Socket.IO 不被普通 parser 吞掉的回归。 |
| Nest common → file-type 20.4.1 | 产品源码未发现 `FileTypeValidator` / `ParseFilePipe` 接线；相关公告要求实际嗅探恶意 ASF/ZIP。依赖仍有告警。 | 框架升级/回移补丁评估；在加入上传类型嗅探前必须重新验收。不能在缺少消费者验证时直接强制 file-type 21。 |
| Nest core 10 → 传播至 event-emitter/websockets/platform-socket.io/schedule/terminus/throttler/typeorm/swagger | [公告](https://github.com/advisories/GHSA-36xv-jgw5-4q75)要求攻击者影响 Nest SSE message 的 type/id。生产源码无 `@Sse` / `SseStream` 调用；Gateway 的原始流转发并不自动等于 Nest SSE 编码器调用。 | 固定当前调用边界并准备 Nest 兼容迁移；增加 SSE 功能时重新核验。当前未找到该公告的直接生产触发路径，不等同整条 Nest 链安全通过。 |
| Nest swagger → js-yaml 4.1.0 | 安装包中该路径使用 `dump(document)` 输出固定应用生成的 OpenAPI 文档，未发现调用 `load`；产品导入 YAML 走已升级的根 js-yaml 4.3.2。 | 随 Swagger/Nest 迁移移除旧包；不宣称根包升级已消除所有 YAML 审计节点。 |
| Nest config/swagger → lodash 4.17.21 | Config 调用 get/has/set；Swagger 存在 omit，但已查看调用的字段来自应用元数据或固定字段。仓库未找到外部输入接到 template imports 或攻击数组 path 的证据；尚未覆盖所有转移消费者。 | 对所有消费者完成可利用性归类或兼容替换；保留 high 节点，不因局部检索否定整包风险。 |
| chokidar 3.6 → braces 3.0.3 | [公告](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)需要深层嵌套 glob；两个产品调用来自 CLI OpenAPI 文件路径和交互配置路径。`path.resolve` 不会移除花括号，不能视为天然保护。未发现远端 API 到 watcher 的直接接线。 | 将文件监听显式收敛为字面路径并验证，再评估 chokidar 4/5 迁移；本次仍保留 high。 |
| uuid 8/9（产品、Nest schedule/typeorm） | [公告](https://github.com/advisories/GHSA-w5hq-g745-h8pq)影响 v3/v5/v6 带输出 buffer 的调用。已核对产品源代码及两条 Nest 链均使用 v4；未找到受影响函数调用。 | 记录当前边界并在维护升级时消除旧包；不为审计数字盲目引入 ESM/主版本变更。 |

截至核对，Nest 10 common/platform-express 最新版本仍为 10.4.22，精确锁定上述旧包。曾尝试仅限定父包的同主版本 overrides；本工作区 npm 11.12.1 及项目声明 npm 10.9.2 均未把 Nest 子链安装为目标版本，`npm ls` 仍显示旧包。尝试已完整撤销，恢复第一批锁文件并再次正常安装，未提交无效 overrides，也未删除整棵 node_modules 来强迫结果。后续应先用隔离的最小工作区验证解析与可复现安装，再决定修复版本或框架迁移；这属于本地工程任务，不需要生产环境才能继续。

## 验证与完成边界

本批安装后审计确认 21 节点；整仓构建（含 UI）已通过，root 统筹 API 全量回归和上传改动后的 API 重建。新增上传专项 1 套 8 项通过。SDK 会话、工具列表授权和工具执行授权三个既有合同脚本共 71/71 通过，覆盖实际 SDK/HTTP/SSE 会话；证据在 `.tmp/security-closure-20261008/sdk-contract.log`。SDK dispatcher 合同保留精确版本守卫，由 1.29.0 明确更新为当前验收的 1.32.1，没有删除版本约束来绕过验证。SEC-F4-02 继续 IN_PROGRESS：本机风险处置尚有上述明确行动，生产账户、存储权限、网络和实际开关签收继续待办。

根代理最终复核：完整monorepo构建（含UI）通过；新增上传/Worker/断连修复后API再次构建通过。全量API首轮174/175套通过，唯一旧快照测试替身缺findOneBy，补齐后失败套件与最终受影响范围29套/240项全通过；新上传8项已包含其中。未把首次失败隐藏为全量一次全绿。
