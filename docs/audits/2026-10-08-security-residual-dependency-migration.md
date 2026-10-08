---
doc-version: 1.1.0
doc-status: active
doc-updated: 2026-10-08
---
# SEC-F4-02 file-type、UUID 迁移与 Nest SSE 剩余边界

> 后续进展：Nest SSE 实际编码器已完成[官方补丁回移及交付校验](./2026-10-08-security-nest-sse-backport.md)。以下是本批迁移时的证据；版本审计仍为 10 moderate，不能将本地回移混称为上游版本升级或整体 SEC 签收。

本批从 `5f5e2d2` 后继续[文件监听风险处置](./2026-10-08-security-file-watch-migration.md)，修复真实安装链中的 file-type 和 UUID。生产 npm 审计从 **13 个 moderate 节点降至 10 个 moderate，high / critical 仍为 0**。剩余 10 个是同一 Nest SSE 公告传播到的受影响包节点，不是 10 个独立漏洞。SEC-F4-02 仍为 IN_PROGRESS，生产签收继续待办。

## 已落地的兼容迁移

| 消费者 | 迁移 | 实际验证 |
| --- | --- | --- |
| Nest 10 common 的 FileTypeValidator | file-type 20.4.1 → 21.3.4；其 inflate 0.2.7 → 0.4.1 | 保留 Nest 原有动态 import 和 fileTypeFromBuffer 调用；真实 validator 正常识别 PNG，拒绝仅声称 PNG 的 JSON、畸形 ASF 和伪造 OOXML。 |
| API/server 产品 UUID、Nest schedule/typeorm、TypeORM | 所有实际消费者统一解析 uuid 11.1.1 | CommonJS v4 正常；真实 scheduler 注册和 TypeORM generateString 生成合法 v4；v3/v5/v6 的越界目标 buffer 在写入前抛出 RangeError。 |

上游 [ASF 零长度子头公告](https://github.com/sindresorhus/file-type/security/advisories/GHSA-5v7r-6r5c-r473)与 [ZIP 解压边界公告](https://github.com/sindresorhus/file-type/security/advisories/GHSA-j47w-4g3g-c36v)分别要求至少 21.3.1 与 21.3.2，本批使用同一 21 主版本的 21.3.4。UUID [官方公告](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq)指定 11.1.1 为含补丁且保留 CommonJS 的版本；没有为追求最新版本引入 ESM-only UUID。

产品和两条 Nest UUID 消费当前仅使用 v4，TypeORM 本身原本已要求 ^11.1.1。仍升级实际依赖并验证有漏洞的辅助方法，而不是以“未调用 v3/v5/v6”当作依赖修复。UUID 11 自带类型，移除 API/server 的旧 @types/uuid；不更改 ID 格式或生成规则。

file-type 21.3.4 声明 Node >=20。根项目、README、server 和现有发布启动说明本已要求 Node 20；API 子包遗留的 >=18 声明同步为 >=20。未增加高于 Node 20 的要求。本机验证使用 Node 24.15.0，未将该结果冒充所有 Node 20 补丁版本或 Linux 的实机验证。

根 manifest 对现有同版本 common/schedule/typeorm 增加显式父依赖，并使用限定父包的 overrides。理由延续[解析器链迁移](./2026-10-08-security-parser-chain-migration.md)验证过的 workspace 链解析行为；Nest 版本保持 common/core 10.4.22、schedule 4.1.2、typeorm adapter 10.0.2。根锁仅改变 file-type、inflate、根 uuid 三个版本节点，移除旧重复 UUID、旧 types 和 fflate。根、API 与框架实际解析保持同一 Nest 实例，npm ls 无 invalid 或 peer 冲突。

## 可复现验证

入仓命令：`npm run verify:security-residual-dependencies`，脚本为 `scripts/test-security-residual-dependencies.cjs`。**4 项合同全部通过**：

1. 从 API、server、Nest schedule、Nest TypeORM 和 TypeORM 的真实模块位置解析 UUID，并验证补丁版本和 v4 输出。
2. v3/v5/v6 面对 8 字节目标 buffer、偏移 4 时均拒绝，且目标数据没有部分改写。
3. 真实 Nest scheduler 注册定时任务和 TypeORM 模块生成 ID；不启动实际定时器。
4. 子进程执行真实 FileTypeValidator 和 file-type：正常 PNG、伪造 MIME、55 字节零长度 ASF 子头，以及声明较小解压大小、实际 2 MiB XML 的 ZIP 局部文件记录。后者仍仅识别为普通 ZIP，不识别为 OOXML；通过真实 inflate 限额，未使用上游 256 MiB 大样本。子进程有 10 秒超时，即使回归阻塞事件循环也不会永久挂起测试。

这些探针不启动网络服务，不保存恶意文件，也不将 FileTypeValidator 接入新的生产上传入口。当前 OpenAPI 上传依然使用既定 JSON/YAML 业务解析规则；本批是其潜在 Nest 文件校验依赖的修复，不能宣称覆盖全部业务文件格式安全性。

| 证据 | 结果 / 日志 |
| --- | --- |
| 主安装 | removed 6 / changed 3；`.tmp/sec-residual-lock/main-install.log` |
| 主候选新合同 | 4/4；`.tmp/sec-residual-lock/contracts.log` |
| 前轮解析器消费者门禁 | 全通过；`.tmp/sec-residual-lock/parser-gate.json` |
| 声明 npm 10.9.2 的隔离完整 clean ci | 1237 包；`.tmp/sec-residual-lock/ci-npm10.log` |
| 干净安装后的同一新合同 / 原解析器门禁 / npm ls | 全通过；`clean-contracts.log`、`clean-parser-gate.json`、`clean-npm-ls.json`，位于上述目录 |
| server 默认完整测试链 | 通过，含 CLI、HTTP/SDK 会话、安全审计、STDIO 12 项、持久化及监听 7 项；`.tmp/sec-residual-lock/server-regression.log` |
| API | API构建通过，统一全量回归184套/1932项通过，见[联合验收](2026-10-08-observability-persistence-and-projector.md)。 |
| 生产 npm 审计 | `.tmp/sec-residual-lock/audit.json`；发现保留告警时 npm audit 的退出 1 为预期。 |

隔离 ci 使用 ignore-scripts，验证安装图与消费者合同，不代表 native 生命周期或完整发行包验收。最终锁 SHA-256：`480fdd288331bcfdade3d82c4989117a813ba822bcd1bbf5d3ce10d3fe72b1f4`。

## 唯一剩余的公告链：Nest SSE

[上游公告](https://github.com/nestjs/nest/security/advisories/GHSA-36xv-jgw5-4q75)针对 SseStream 将 message.type/id 的换行直接写进协议，攻击者需能影响这些字段。修复版本为 core 11.1.18；当前 Nest 10 最新维护版本仍为 10.4.22，没有可直接安装的同主补丁。

本机纯内存 stream 探针确认当前 10.4.22 **仍能输出注入的 event 字段**，证据 `.tmp/sec-residual-lock/nest-sse-probe.json`。这不是已修复或已获风险接受。当前生产源码未发现 Nest @Sse 装饰器或 SseStream 消费；现有 MCP SSE 使用 MCP SDK 的传输实现，Gateway 原始流式转发也不调用 Nest SSE 编码器。无当前生产入口限制了已识别的可利用路径，**不等于依赖漏洞消失**。

保留的 10 个节点为 core、event-emitter、platform-express、platform-socket.io、schedule、swagger、terminus、throttler、typeorm、websockets。它们是 npm 传播关系，不能将每个节点都视为一个可独立利用的新缺陷。

后续执行出口明确：

- 在引入 Nest @Sse 或直接 SseStream 前，必须先采用含上游修复的框架版本或经过维护验证的回移补丁，并对 type/id 的 CR/LF 注入和正常 SSE 帧做真实 HTTP 验证。
- 若正式签收要求依赖告警为零，另行完成一致的 Nest 框架维护迁移，覆盖 Express 路由/通配符、原始 Gateway 流、Socket.IO、鉴权、上传及 Swagger；不能只覆盖 core 的主版本而忽略 peers 和 Express 行为变化。
- 在该迁移完成前，签收资料保留本公告、当前无消费证据及明确复查触发条件。生产账户、存储权限、网络和实际开关仍按原计划待办，本机结果不是生产风险接受。

根 overrides 对整仓及复制根 manifest/lock 的现有发布流程生效。server 直接 UUID 声明可随单 workspace 安装生效；单独安装 API workspace 不自动继承 Nest file-type/UUID overrides，实际交付目录仍须执行消费者合同和完整发布检查。本轮没有制作或发布新的正式发行包。
