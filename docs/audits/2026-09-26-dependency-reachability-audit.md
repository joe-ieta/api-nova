---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-26
---
# SEC-F3a-01 依赖可达性与风险处置审计（2026-09-26）

> Document status: Active evidence。公告为查询时点结果；本轮不执行 `npm audit fix`、不做重大升级、不修改锁文件。

## 1. 环境与命令

- 日期：2026-09-26；仓库 HEAD：`183b1f5`（本轮文档未提交前）
- Node `v24.15.0`，npm `11.12.1`
- 锁文件：`package-lock.json` SHA-256 `9EB15CC0265E1366483CC340EE6E7E55638AF3ED558EB09DC1A5BB032F3F2A54`
- 命令：`npm audit --json --omit=dev`、`npm audit --json`（离线解析，不自动修复）

## 2. 汇总

| 范围 | critical | high | moderate | low | total |
| --- | --- | --- | --- | --- | --- |
| 生产依赖（`--omit=dev`，544 prod） | 0 | 10 | 21 | 1 | **32** |
| 全量（1333 依赖含 dev） | 1 | 24 | 30 | 4 | **59** |

生产树可达性由 `npm ls --omit=dev <pkg>` 逐项确认；以下为处置分类（非自动修复）。

## 3. 生产依赖逐项处置

### A. 现有主版本内可补丁（fix=yes，建议进入独立依赖更新任务）

| 包 | 严重度 | 生产链 | 处置 |
| --- | --- | --- | --- |
| `brace-expansion` | high | typeorm→glob→minimatch→brace-expansion@2.1.1 | 锁文件内升级到修复版；需回归数据库工具链 |
| `fast-uri` | high | MCP SDK→ajv→fast-uri@3.1.2（SSRF/host confusion） | 与网络边界验收联动升级并重跑 URL/authority 回归 |
| `ip-address` | high | MCP SDK→express-rate-limit→ip-address@10.2.0（SSRF 分类） | 升级后重跑地址分类/限流回归 |
| `socket.io-parser` | high | socket.io→socket.io-parser@4.2.6 | 升级后重跑实时流/TPS 回归 |
| `file-type` | moderate | @nestjs/common→file-type@20.4.1 | 随 Nest/common 兼容窗口升级 |
| `hono` / `@hono/node-server` | moderate | MCP SDK→hono@4.12.27 / @hono/node-server@1.19.14 | 随 SDK 兼容窗口升级 |
| `express`(qs) / `qs` | moderate | express 5→body-parser→qs@6.15.3 | 随 express 主版本升级 |
| `typeorm` | moderate | typeorm@0.3.30（migration:generate 注入） | 升级到 >=0.3.31，回归迁移生成与启动 |
| `uuid` | moderate | @nestjs/schedule/typeorm→uuid@9/11 | 升级兼容版本，回归会话/审计关联 |
| `joi` | low | 配置校验 | 升级到修复版，回归配置 schema |
| `nanoid` | high | UI vue→compiler-sfc→postcss→nanoid@3.3.15 | 随 UI 构建链升级 |
| `postcss` | high | UI vue→compiler-sfc→postcss@8.5.16 | 随 UI 构建链升级 |

### B. 需要 Nest 12 主版本升级（不属本轮）

| 包 | 严重度 | 生产链 | 处置 |
| --- | --- | --- | --- |
| `@nestjs/platform-express`（含 `multer`/`body-parser`/`qs`/`express4`） | high | Nest 10 平台层 | 规划受控 Nest 12 重大升级：入口 body 限制、上传与 framing 回归、限流/缓存重验 |
| `js-yaml`（direct） | high | parser/API/server 直接解析 YAML；swagger 依赖 | YAML 摄入已有严格 schema/防原型污染校验；升级随 swagger/Nest 12；升级前对凭证与 OpenAPI YAML 保持拒绝型校验 |
| `lodash` | high | @nestjs/config、@nestjs/swagger、inquirer、element-plus | 链上使用不含 `_.template`/`_.unset`/`_.omit` 攻击面；随 Nest 12/依赖升级处理 |
| `@nestjs/core`/`common`/`config`/`event-emitter`/`swagger`/`schedule`/`terminus`/`throttler`/`typeorm`/`platform-socket.io`/`websockets` | moderate | Nest 10 栈 | 统一随 Nest 12 升级窗口评估 |

### C. UI 直接依赖

| 包 | 严重度 | 处置 |
| --- | --- | --- |
| `echarts` <6.1.0（XSS） | moderate | 升级 echarts@6.1.0 |
| `vue-echarts` <=7.0.3 | moderate | 升级 vue-echarts@8.3.0（随 echarts） |

## 4. 开发依赖（不进入生产包）

全量审计的 1 critical 与多数 high 位于开发链：`@modelcontextprotocol/inspector`（critical，dev 工具）、`@nestjs/cli`、`@typescript-eslint/*`、`vite`/`esbuild`/`postcss`、`browserslist`、`glob`/`minimatch`/`picomatch`、`tmp`、`shell-quote`、`concurrently` 等，均有修复版本。处置：进入独立开发链更新任务；不影响当前运行时。

## 5. 结论与边界

- 本轮完成当前锁文件的生产可达性与逐项处置记录；**未应用任何补丁或重大升级**。
- 建议后续批次按 A（主版本内补丁）→ C（UI）→ B（Nest 12 重大升级）推进，每步执行相应回归与再审计。
- 生产可达性为依赖树判定，不等于运行时可利用性证明；公告为时点数据，发布前需按 `SEC-F3a-01` 重跑并更新本页。
