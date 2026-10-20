---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-20
---
# 在线依赖审计风险分诊

日期：2026-10-20。结论类型：依赖版本、源码入口与上游公告交叉核对；不是漏洞利用复现，也不是漏洞清零验收。

## 1. 输入、范围与证据快照

本次为只读分诊，未执行 install、update、audit fix，未修改依赖或锁文件。

输入是主代理已完成的两份在线报告：

| Scope | 文件 | info | low | moderate | high | critical | total |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 全量 | `tmp/np02-audit-all.json` | 0 | 3 | 34 | 81 | 4 | 122 |
| 生产依赖范围 | `tmp/np02-audit-production.json` | 0 | 0 | 21 | 21 | 1 | 43 |

两份文件均为 `auditReportVersion: 2`，上述值来自 `metadata.vulnerabilities`，并与 `vulnerabilities` 按包名聚合后的条目数一致。计数包含传递影响：例如 `multer` 会使 `@nestjs/platform-express` 命中；`@vue/server-renderer` 会使 `vue` 命中。不能把 43 项理解成 43 个独立 CVE、43 个公网入口或 43 个已证实可利用漏洞。

两份报告的 `metadata.dependencies` 均保留整个依赖图统计：prod 544、dev 783、optional 80、peer 15、peerOptional 0、total 1333；这些分类不是互斥项，生产 scope 的该字段也不是最终交付包的 SBOM。Vue 编译器等仍可沿生产依赖边进入生产审计。

交接说明中的 audit 命令退出码 1 表示发现漏洞；本轮没有重跑命令验证退出码。按本机 `powershell-windows-constraints` 技能，使用 PowerShell 7.6.5、显式 UTF-8 读取和结构化解析；Node 读取兼容移除开头 BOM。交接注明文件有 BOM，但本轮读取时两份文件前三字节均为 `7B-0D-0A`，未见 UTF-8 BOM；未改写输入文件。

| 证据 | 值 |
| --- | --- |
| 读取时 Git HEAD | `2f495344a3864635ac5d28b4c6affffb0ad5834e` |
| `package-lock.json` | lockfileVersion 3；SHA-256 `9EB15CC0265E1366483CC340EE6E7E55638AF3ED558EB09DC1A5BB032F3F2A54` |
| 全量报告 SHA-256 | `B702FB7BF9F0C7503BCD83B8CC5EFF7D2C0B8538E076738A7AC40A02315AA78E` |
| 生产报告 SHA-256 | `E10F84D389C686AE0BD708C10B6F65C222207F5B9BFCB96715D5C71AEBCD7D49` |

生产报告 43 个包名涉及 50 个去重安装节点：全部存在于当前锁文件，本地相应 `package.json` 的版本全部与 lock 一致。另用本地 `semver` 将 critical/high 的具体节点版本与各条 `via[].range` 比对，区分根目录与嵌套副本。版本一致不代表安装文件完整性或部署产物已经验证。

以下代码路径相对仓库根目录 `E:\CodexDev\api-nova`，行号对应本轮读取的工作树。工作树已有其他代理的并行修改，HEAD 本身不能完整表示这些源码证据。

## 2. 分诊结论与优先级

优先级按本项目入口和修复成本评估，与上游 severity 分开：

- **P1：优先处置已发现输入路径的生产风险。** `compression`、`engine.io`、`socket.io-parser`，以及经 JWT 访问的 OpenAPI 上传 `multer` 和默认 YAML 解析 `js-yaml`。
- **P1 配置核对／P2 常规修复：`proxy-addr`。** 唯一生产 critical，但需要特定信任网段配置；当前源码未发现启用该配置。应先核对真实部署，不能直接宣称匿名认证绕过，也不能据此关闭告警。
- **P2：有条件的运行时风险及可兼容升级。** Axios、MCP SDK、其他间接依赖。应按 adapter、功能、输入权限与部署配置复核。
- **P3：尚未发现对应功能入口的命中。** Vue SSR、CLI 固定文本／路径、构建时 CSS/source map、固定配置验证等。保留升级计划；不作“永远不可达”的断言。

本轮未进行攻击性请求、压力测试或生产环境探测。“入口已发现”表示源码存在输入至组件的路径，不表示已在运行服务上复现崩溃、泄露或绕过。

## 3. 重点生产链、入口与条件

### 3.1 `proxy-addr 2.0.7` — critical，配置条件尚未证实

依赖链已由 lock 解析确认：

- API / server → 根 `express 4.22.2` → `proxy-addr 2.0.7`。
- API → `@nestjs/platform-express 10.4.22` → 内嵌 `express 4.22.1` → 同一 `proxy-addr`。
- SDK `1.29.0` → 内嵌 `express 5.2.1` → 同一 `proxy-addr`。

[维护者公告 GHSA-jqcg-44mw-7w3h](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h) 指向 IPv4-mapped IPv6 信任网段的前缀处理问题。例如 `::ffff:10.0.0.0/8` 一类错误配置可扩大受信地址范围，进而使攻击者提供的 `X-Forwarded-For` 影响 `req.ip`。修复版本为 `2.0.8`。

本地证据：

- 在四个 workspace 的 `src` 和 `scripts` 中搜索 `trust proxy` / `proxy-addr`，未发现配置或直接调用。
- `packages/api-nova-api/src/main.ts:21` 创建默认 Nest Express 应用；本地仅实例化 `express()`、未监听端口的检查返回 `app.get('trust proxy') === false`。
- `packages/api-nova-api/src/app.module.ts:113` 配置全局 ThrottlerGuard；`common/interceptors/logging.interceptor.ts:30` 读取 `request.ip`。因此若部署另行改变信任设置，限流／日志值得复核。
- MCP 的 `packages/api-nova-server/src/tools/mcp-http-audit.ts:26` 使用 socket peer，`proxyTrusted: false`；不能把该依赖告警自动扩展为所有审计字段都可伪造。

结论：**版本命中已确认；当前源码中未发现公告所需的信任配置。** 未读取实际生产启动包装、动态注入或反向代理配置。修复是同主版本 patch，Express 当前 `~2.0.7` / `^2.0.7` 范围允许 `2.0.8`，应列入近期刷新。若部署存在上述错误网段，优先级立即升至 P1。

应用直接读取转发头的其他逻辑属于独立审查项，不能作为本 GHSA 已触发的证据。

### 3.2 `compression 1.8.1` — high，已有全局响应入口

链：API → `compression ^1.7.4` → 锁定 `1.8.1`。

`packages/api-nova-api/src/main.ts:63` 无条件注册 `app.use(compression())`，随后 `main.ts:71` 注册静态 UI 服务，`main.ts:198` 启动监听。压缩可发生在控制器认证之外的响应上。

[维护者公告 GHSA-vc2v-76pw-4v95](https://github.com/expressjs/compression/security/advisories/GHSA-vc2v-76pw-4v95) 描述客户端在压缩响应完成前断开时的 zlib 资源泄漏；重复触发可耗尽内存，修复版本 `1.8.2`。

结论：**P1，源码入口明确。** 仍需验证部署是否能产生满足压缩类型／阈值的响应、代理是否缓冲，以及断连清理的实际表现。建议同主版本 patch，并在隔离环境验证压缩成功／提前断连／资源回收；不能用 JWT 或业务限流代替此验证。

### 3.3 `engine.io 6.6.9`、`socket.io-parser 4.2.6` — high，协议入口明确

链：

- API → `@nestjs/platform-socket.io 10.4.22` → 内嵌 `socket.io 4.8.1` → `engine.io 6.6.9` / `socket.io-parser 4.2.6`。
- API 直接 `socket.io 4.8.3` 也解析到上述两个节点；UI 的 `socket.io-client 4.8.3` 共享 parser 节点。

`packages/api-nova-api/src/main.ts:29` 安装 IoAdapter，`app.module.ts:94` 导入 WebSocketModule。`modules/websocket/websocket.gateway.ts:32` 声明 `/monitoring` namespace，`:41` 同时开放 `websocket`、`polling`，`:42` 设置 `allowEIO3: true`。未见应用关闭 transport upgrade；本地 Engine.IO 的 `build/server.js:46` 默认 `allowUpgrades: true`。

[Engine.IO 公告 GHSA-2gc4-cqfq-p2gv](https://github.com/socketio/socket.io/security/advisories/GHSA-2gc4-cqfq-p2gv) 描述已有会话升级时协议修订不一致可导致进程崩溃；修复 `6.6.10`。仅关闭 EIO3 兼容并不足以排除公告路径。[parser 公告 GHSA-2m8v-j782-fhvr](https://github.com/socketio/socket.io/security/advisories/GHSA-2m8v-j782-fhvr) 描述二进制附件重组内存耗尽；4.x 修复为 `4.2.7`。

结论：**P1，优先于仅有版本证据的 high。** `/monitoring` 是 namespace，不代表底层 Engine.IO HTTP path；部署需要核对通常的 `/socket.io/` 路径及代理转发。`:145` 的连接处理及 `:160` 的 observability 授权发生在较高层，不能据此认定底层握手／解码攻击被阻断。真实外网可达性和崩溃未验证。

两个叶子修复均为 patch，当前 `~6.6.0` / `~4.2.4` 范围允许纳入；不需要因为此两项直接迁移 Nest 主版本。后续需同时确认 Nest 内嵌 Socket.IO、直接 Socket.IO 与 UI 客户端的解析结果和兼容性。

### 3.4 `multer`、`@nestjs/platform-express` — high，上传入口受 JWT 保护但解析早于文件检查

必须区分两份安装：

| 节点 | 锁版本 | 父约束 | 本项目入口 |
| --- | --- | --- | --- |
| `node_modules/@nestjs/platform-express/node_modules/multer` | 2.0.2 | Nest platform-express 10.4.22 精确依赖 `2.0.2` | Nest `FileInterceptor` 实际解析到此副本 |
| `node_modules/multer` | 2.2.0 | API 直接依赖 `^2.0.2` | 未发现应用直接调用 multer；不能用此版本代表 FileInterceptor |

用 Node `createRequire` 分别从 API 和 Nest platform-express 解析 `multer`，路径与上表一致；安装版 `@nestjs/platform-express/multer/interceptors/file.interceptor.js:6` 导入 multer，`:24` 调用 `.single()`。

`packages/api-nova-api/src/modules/openapi/openapi.controller.ts:38` 为控制器配置 JwtAuthGuard；`:212`、`:292` 使用无局部限制参数的 `FileInterceptor('file')`，对应 `/api/openapi/upload`、`/api/openapi/validate-upload`。全局前缀由 `common/http-api-paths.ts:2` 定义为 `api`。安装版 Nest `router/router-execution-context.js:42` 先运行 guard，再在 `:46` 调用 interceptors，所以不能把这里描述为已确认的匿名上传攻击面。

但 `openapi.controller.ts:251`、`:340` 的文件大小校验是在 multer 完成解析、得到 `file.buffer` 后进行；全 API 源码未找到全局 MulterModule limits 配置。`express.json` 的大小限制不等同 multipart 解析限制。

[字段数组索引 DoS 公告 GHSA-535w-7cp7-47q4](https://github.com/expressjs/multer/security/advisories/GHSA-535w-7cp7-47q4) 的 `<2.3.0` 范围覆盖两个副本，小型恶意字段名也可引发同步 CPU 消耗。生产报告还包含不完整清理、递归、字段解析等问题。`2.0.2` 命中 8 条直接公告；`2.2.0` 命中 5 条，不能把所有公告同时套到两个版本。

结论：**P1，具备有效管理 JWT 的调用方可进入脆弱解析器；未复现 DoS。** 根 `2.2.0` 特有的文件描述符泄漏不能直接归因到当前内嵌 `2.0.2`；磁盘存储相关公告还需要启用相应 storage。默认内存上传并不消除字段解析 DoS。

修复代价：

- 叶子包 `2.3.0` 处理上述 high 字段问题；若要同时覆盖报告中的[磁盘写入清理公告 GHSA-3pph-fpjx-jg34](https://github.com/expressjs/multer/security/advisories/GHSA-3pph-fpjx-jg34)，候选需到 `2.4.0`。
- 只刷新根 multer 不能覆盖精确固定的 Nest 内嵌副本。
- 此报告的 `fixAvailable` 建议 `@nestjs/platform-express 12.2.0`，`isSemVerMajor: true`，相对当前 10.x 是重大升级。它是 npm 给出的方案，不是已经证明唯一可行的方案。应先验证维护中的同主版本修复路径，或评估有兼容性证据的定点依赖替换；否则按 Nest 生态协调迁移评估。
- 后续验收需覆盖 guard 拒绝、multipart limits、异常字段、上传中止以及清理，不能只检查 npm 根版本。

### 3.5 `js-yaml 4.3.0 / 4.1.0` — high，普通 OpenAPI YAML 与受限凭据 YAML 要分开

链及版本：

- API、parser、server、UI 的直接 `^4.1.0` 依赖解析为根 `4.3.0`。
- parser → `@apidevtools/swagger-parser 10.0.3` → `@apidevtools/json-schema-ref-parser 9.1.2` → 根 `js-yaml 4.3.0`。
- API → `@nestjs/swagger 7.4.2` → 精确固定的内嵌 `js-yaml 4.1.0`。

实际入口：

- `packages/api-nova-parser/src/parsers/base-parser.ts:49` 调用无 schema 覆盖的 `load(content)`。
- API `modules/openapi/services/parser.service.ts:53` 将内容传入 parser；`services/validator.service.ts:36` 的 JSON fallback 在 `:46` 同样调用默认 `load`。
- 经 JWT 的 parse／validate／upload 入口可把不可信规范带到上述路径，YAML 解析先于 OpenAPI 语义校验。

根 `4.3.0` **只命中本报告中的两条 high**：`!!omap` CPU 消耗（`<4.3.1`）与空 merge 源预算绕过（`<4.3.2`）；不应把仅旧版命中的 merge 原型污染也归给根副本。内嵌 `4.1.0` 命中报告全部 5 条。

[维护者公告 GHSA-2883-xcg3-v3hh](https://github.com/nodeca/js-yaml/security/advisories/GHSA-2883-xcg3-v3hh) 确认默认支持 merge 的 4.x 在 `<4.3.2` 存在 CPU 预算绕过。较小文档也可能触发高复杂度，字节上限和同步解析后的校验不能证明已经缓解。

结论：**普通 OpenAPI 默认 YAML 路径 P1。** 以下路径应单独降低此类公告的适用性：

- `packages/api-nova-parser/src/credentials/loader.ts:57` 检查输入大小，`:80` 拒绝 tag/anchor/alias 字符，`:86` 使用 `JSON_SCHEMA` 并限制解析深度／节点数；公告的 merge／omap 构造未见可通过该入口。
- UI `packages/api-nova-ui/src/utils/openapi.ts:18` 使用 `JSON_SCHEMA`；不能把服务端默认 load 的结论直接套到该函数。其他 CLI 默认 YAML load 仍存在。
- `@nestjs/swagger` 内嵌旧副本主要用于框架文档相关路径；`main.ts:136` 仅在非 production 条件下生成 Swagger。它与普通 OpenAPI 上传的根副本不是同一路径。

根依赖可在现有范围内升至 `4.3.2`；无需为修复普通解析入口直接升级 Nest。内嵌 `4.1.0` 的 audit 自动方案指向 `@nestjs/swagger 12.0.2`，是相对 7.x 的重大升级，需单独协调。

### 3.6 `axios 1.18.1` — high，多条公告依赖不同 adapter 与输入条件

四个 workspace 均直接依赖 Axios，当前共享根 `1.18.1`，其版本匹配报告中的 12 条直接公告。不能将 12 条都解释为同一条可利用 SSRF。

| 公告类型 | 当前入口证据 | 分诊 |
| --- | --- | --- |
| HTTP adapter 代理重定向 ReDoS，GHSA-mghh-pgcx-3jjj | parser `parsers/url-parser.ts:31` 跟随默认重定向；legacy 工具执行 `transformer/index.ts:775` 使用 Axios，`:779` 在无 upstream credentials 时允许 5 次重定向 | 有输入路径；还须部署启用 HTTP(S)_PROXY、非空 NO_PROXY，并遇到恶意重定向。环境未验证，P2；条件成立时升 P1 |
| `data:` URL 解析 ReDoS，GHSA-c29m-xwm3-cm6r | `url-parser.ts:96` 仅允许 http/https，拒绝直接 `data:` 输入 | 该导入入口不满足直接 data URL 条件；其他 CLI／调用点尚未穷尽 |
| fetch adapter 忽略 `maxRedirects: 0`，GHSA-r4gj-5m52-g5wh | 应用源码未发现选择 `adapter: 'fetch'`；本地默认 adapter 顺序为 xhr/http/fetch，Node 正常走 http | 不能据此认定当前 Node 分支的 `maxRedirects: 0` 已失效；浏览器或调用方覆盖配置需另查 |
| HTTP/2 DNS/proxy 绕过与 session error，GHSA-3pq3-5fj3-cg6v / GHSA-542g-h47m-68v8 | 应用源码未发现 `httpVersion: 2`；安装版 `axios/lib/adapters/http.js:531` 默认 1 | 未发现启用对应功能 |
| prototype-pollution gadgets，包括 headers/method/toFormData/createConnection | 报告中存在多个 gadget 公告 | 需要先建立原型污染或可控继承对象到相关配置的链；本轮没有验证完整污染来源，不能称为独立远程代码执行 |

依据：[代理重定向公告](https://github.com/axios/axios/security/advisories/GHSA-mghh-pgcx-3jjj)、[data URL 公告](https://github.com/axios/axios/security/advisories/GHSA-c29m-xwm3-cm6r)、[fetch adapter 公告](https://github.com/axios/axios/security/advisories/GHSA-r4gj-5m52-g5wh)。其他 Axios 子项的范围及名称来自已保存 audit，未逐条深审公告全文。

`transformer/index.ts:768` 的 bounded networkPlan 分支直接调用 host sender；`:779` 的凭据分支禁止隐式重定向。gateway proxy 源码使用 `node:http` / `node:https`（`packages/api-nova-api/src/modules/gateway-runtime/services/gateway-proxy-engine.service.ts:15`），不能把 parser 的 Axios 路径推断成 gateway 主转发路径。未验证各部署启用哪条分支。

报告全部 Axios 条目的修复边界为 `1.20.0`，四个 workspace 当前约束都允许该同主版本 minor。建议近期统一刷新并验证 URL 导入、legacy 工具、凭据分支、代理和浏览器行为；不能仅凭升级证明上游网络策略已经闭环。

### 3.7 `@modelcontextprotocol/sdk 1.29.0` — high，命中客户端 OAuth 功能

API / server 直接约束 `^1.26.0`，锁定 `1.29.0`。

[维护者公告 GHSA-6qxp-vccf-f47h](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h) 针对 HTTP OAuth 客户端把既有凭据发送给不可信 MCP server 指定的授权服务器。公告明确区分 MCP server 与 OAuth client，1.x 修复为 `1.31.0`。

当前 server 源码导入的是服务端 API，例如 `packages/api-nova-server/src/server.ts:1`、`core/MCPRegistry.ts:1`、`transportUtils/stream.ts:4`、`transportUtils/stdio.ts:1`。四个 workspace 的应用源码未发现 SDK `authProvider`、`withOAuth`、`fetchToken` 或 client 模块入口。

结论：**P2 升级、P3 当前特定功能暴露；没有证据把此告警判为 MCP 服务端凭据泄露。** 现有范围允许 `1.31.0`，无需迁移 2.x。若外部程序化调用方使用 SDK OAuth client，需另核对凭据 issuer 绑定／历史存储迁移；生产源码搜索不能代表所有外部消费者。

## 4. 其余生产 high：覆盖完整性与降级依据

以下表格与第 3 节合计覆盖生产报告全部 **1 critical + 21 high 包名**。这里的修复下界若仅根据 audit range 推导，会明确标为候选；本轮没有安装候选版本验证。

| 包／锁版本与链 | 代码或依赖证据、触发条件 | 优先级与升级影响 |
| --- | --- | --- |
| `vue 3.5.39` → `@vue/server-renderer 3.5.39` | UI `src/main.ts:16` 为 `createApp`，`:68` 挂载客户端；API `main.ts:71` 服务静态 UI。四个 src 未发现 SSR/renderToString/createSSRApp。公告需要 SSR 将不可信对象键作为属性名输出 | P3；未建立 SSR XSS 入口。`vue` 是传递命中，不能再算第二种漏洞 |
| `fast-uri 3.1.2` ← `ajv 8.20.0` ← SDK；server 的 `conf 10.0.2` 也使用 Ajv | 安装版 `ajv/dist/runtime/uri.js:3` 用作 schema URI resolver；CLI `interactive-cli/utils/config-manager.ts:70` 配置固定 schema。应用未发现用 fast-uri 做出网 host allowlist；`core/MCPRegistry.ts:112` 将工具 inputSchema 转成 Zod | P2；不能从“URL 解析器有 SSRF 公告”直接推出本应用 SSRF。未穷尽自定义 schema/$ref 链。audit 范围整体结束于 `<3.1.8`，3.1.8 为待验证 patch 候选 |
| `ip-address 10.2.0` ← `express-rate-limit 8.5.2` ← SDK | 应用未发现挂载 SDK OAuth router / express-rate-limit；安装版 rate-limit `dist/index.cjs:33` 的入口先用 `net.isIPv6`，主要用于 IPv6 限流键。未见应用直接使用 Address4 处理前导零地址或进行网络允许列表判定 | P2；high Address4 条件未建立。其余分类/长输入 moderate 也需按函数查。audit fix=true，没有具体版本，不能直接标已修 |
| `brace-expansion 2.1.1` ← TypeORM 0.3.30 → glob 10.5.0 → minimatch 9.0.9 | `packages/api-nova-api/src/database/database-options.ts:12` 使用固定实体集合与迁移配置；未发现请求参数成为 glob pattern | P3；依赖存在，攻击者可控 pattern 未建立。audit 范围整体至 `<2.1.7`，2.1.7 为待验证 patch 候选 |
| `braces 3.0.3` ← `chokidar 3.6.0` ← server | `interactive-cli/utils/config-manager.ts:428` watch 本机 `this.config.path`；公告要求恶意深层嵌套 pattern，未发现 HTTP 输入到 watch pattern 的路径 | P3；两个 audit 包名共享叶子原因。自动方案 `chokidar 5.0.0` 为重大升级，应评估 Node／模块与 watch 行为；不能当常规 patch |
| `figlet 1.11.0` ← server | `interactive-cli/index.ts:148` 用固定 banner 文本和 `font: 'Small'`；未传公告要求的 `whitespaceBreak` 与小 width 组合 | P3；当前调用条件不匹配。`1.11.3` 是 audit 给出的范围边界，现有 `^1.8.2` 允许同主版本升级 |
| `joi 17.13.4` ← API | `src/config/validation.schema.ts:4` 验证环境配置，源码未发现 `.isoDate()`；未发现不可信输入控制 messages／rename template | P3；high isoDate ReDoS 未建立入口。包含低／中危子项，按全部范围推导至少 17.13.8 作为待验证 patch 候选 |
| `lodash 4.17.21` ← `@nestjs/config 3.3.0`、`@nestjs/swagger 7.4.2` 精确固定；也由 inquirer 引入 | 应用未发现 `_.template` 调用；查过 config/swagger/inquirer 实现未发现 template 入口。Swagger 内部有 omit，主要处理装饰器元数据、固定 key 列表，不能将其直接断言为外部输入 RCE | P2；模板 imports key 控制和污染路径未证明。audit 指向 Swagger 12.0.2，config 也有重大升级建议；根单次刷新不一定解除精确固定 |
| `postcss 8.5.16` ← Vue → `@vue/compiler-sfc`；`nanoid 3.3.15` ← PostCSS | 生产图含编译依赖，不代表在线服务执行任意 CSS。源码未发现服务端处理上传 CSS/sourceMappingURL；安装版 `postcss/lib/input.js:80` 调用的是固定正数 `nanoid(6)`，不匹配 nanoid 的零／负 size 条件 | P3；处理不可信 CSS 的 CI/插件仍需审查。按报告范围候选 PostCSS 8.5.23、nanoid 3.3.18；需确认父约束与实际修复 |
| `source-map-js 1.2.1` ← Vue compiler / PostCSS / `@intlify/message-compiler` | indexed source map 的恶意 section offset 才是公告入口；应用无直接 SourceMapConsumer。UI `src/locales/index.ts:2` 导入仓库固定语言资源。PostCSS 的 `lib/previous-map.js:34` 确有消费 source map 的实现，但未发现在线外部 map 输入 | P3；不能因无直接 import 就全面排除间接路径。按范围候选 patch 1.2.2；构建产物、动态消息、插件输入待验证 |

Vue 公告需要特别记录来源差异：[维护者页面](https://github.com/vuejs/core/security/advisories/GHSA-g2v6-rqmx-r4w6) 仍显示 patched “None”，[GitHub Reviewed 条目](https://github.com/advisories/GHSA-g2v6-rqmx-r4w6) 已列 3.5.42 / 3.6.0-rc.6，本地 audit 对稳定版给出 `<3.5.42`。本报告将 3.5.42 视为数据库给出的候选，未独立验证发布包或修复提交，不能把维护者页面描述成已经一致确认。

## 5. 全量额外 critical 与 moderate 的处理边界

全量的 4 个 critical 包名为 `proxy-addr`、`@modelcontextprotocol/inspector`、`handlebars`、`shell-quote`；后三者未出现在生产 scope：

| 包 | 当前链／条件 | 建议 |
| --- | --- | --- |
| Inspector 0.13.0 | server 的 devDependency；critical 为代理客户端到代理服务器之间缺少认证（GHSA-7f8r-222p-6f5g），另有连接不可信 MCP server 的 XSS/命令执行 high | 不把“dev”理解成不会执行。需要核查开发者是否启动此工具、绑定地址与访问隔离。audit 建议 1.0.2，标记重大升级；本轮未检查运行中的 Inspector |
| Handlebars 4.7.9 | `ts-jest 29.4.11` 引入，lock 标 dev；报告包含 AST type confusion / own property check bypass | 优先核对 CI 是否允许不可信模板／AST进入编译；本轮未建立生产入口，也未深审 ts-jest 使用点 |
| shell-quote 1.8.4 / 1.9.0 | 前者由 concurrently 精确固定，后者由 Inspector 引入，均标 dev；critical 需要特定 comment token 后的换行 token 进入 quote 再用于 shell | 开发工具命令输入链另查。只刷新根副本可能遗漏 concurrently 内嵌固定副本；audit fix=true 不表示两个副本已处理 |

生产 21 个 moderate 未逐项深审，仍需独立跟进。尤其 `express` / `body-parser` / `qs` 的解析路径在 API `main.ts:35`、`:36` 全局注册，发生于控制器 guard 之前；不能把“上传有 JWT”的结论扩展到全部请求解析器。

Nest core/config/swagger/schedule/typeorm/websockets 等多个条目包含传递影响与生态升级耦合。报告还对 uuid、echarts/vue-echarts 等建议跨主版本。它们不构成本轮自动迁移授权，也不能只按 high/critical 过滤后视为全部可忽略。

## 6. 建议处置顺序与后续验收

1. **先核实部署暴露面。** 确认 compression 是否生效、Socket.IO 底层 path 是否对不可信客户端开放、OpenAPI 导入／上传账号权限，以及 trust proxy 的真实有效设置。错误信任网段或外网可达会提高相应项优先级。保留代理、监听和有效配置证据，避免仅搜索源码作结论。
2. **拆出可兼容的高价值修复批次。** compression ≥1.8.2、Engine.IO ≥6.6.10、socket.io-parser ≥4.2.7、根 js-yaml ≥4.3.2、proxy-addr ≥2.0.8；随后 Axios ≥1.20.0、SDK ≥1.31.0。以上是截至输入报告／已核实公告的修复边界，不是无限期的“安全版本”承诺。每次刷新检查所有物理节点与消费方。
3. **单列上传／Nest 依赖方案。** 先解决实际 FileInterceptor 使用的内嵌 multer，再处理 Swagger 内嵌 YAML 和固定 lodash。评估受支持同主版本途径、经过兼容性验证的定点方案、或协调 Nest 12.x 迁移；不要把 `audit fix --force` 当成分诊结论。
4. **处理特定功能、CLI 与开发工具。** Vue SSR 未启用的证据可以降低当前风险，但保留补丁；chokidar 与 Inspector 的重大升级分批验证，核查构建工具的不可信输入边界。中危问题另立验证项。
5. **修复后的验收由后续工作完成。** 在获准变更后重新安装／构建并重跑相同两 scope audit；对压缩断连、Socket.IO 升级／附件、带认证上传／中止／limits、YAML 合法文档兼容性、Axios adapter／代理／重定向和 SDK transport 合约进行针对性回归。保存新报告及锁文件指纹，并核对最终生产交付包，而非仅开发工作树。

## 7. 尚未验证与交付限制

- 未复现任何 DoS、SSRF、XSS、凭据泄露、命令执行或认证绕过；未对线上／本地已运行服务发送攻击流量。
- 未读取真实生产反向代理规则、有效 trust proxy、代理环境变量、网络 ACL、Socket.IO 对外路由、用户权限分配及资源限制。
- 未证明每个生产依赖最终进入离线运行包或浏览器 bundle；未构建、检查 tree shaking、打包产物或最终安装图。
- 未检查本地安装文件是否与 registry tarball/integrity 完全一致；仅确认安装版本与 lock 一致。
- 未穷尽所有 CLI、外部 SDK 消费方、动态 schema/$ref、CSS/source map、原型污染 gadget 链。搜索未命中是限定范围内的否定证据。
- 未验证所有 `fixAvailable` 候选是否已经发布可用、满足全部 peer/engine 约束或通过应用回归；报告自动给出的重大升级不是已完成的升级方案。
- 未逐条深审全量 122 项或生产 moderate 21 项。第 3、4 节覆盖生产全部 critical/high 包名，并对主要入口核实维护者公告；其他条目以已保存 audit 与本地代码为依据。
- 本轮结果足以形成 NP-02 的风险分诊与后续修复顺序，不能据此把 NP-02 标为“漏洞已修复”“生产安全验收通过”或“所有高危不可利用”。
