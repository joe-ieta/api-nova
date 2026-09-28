---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-28
---
# MAINT-01 前端结构与分块整理证据（2026-09-28，测量驱动）

> Document status: Active evidence。计划所有者于 2026-09-28 手工确认“接口/发布边界稳定”后解冻实施；无路由/接口/依赖变更。

## 1. 解冻确认（计划所有者）

- 2026-09-28：在本地隔离环境（API `127.0.0.1:9001`、UI Vite（5174）、全新隔离 SQLite `E:\temp\opencode\manual-test\api_nova_manual.db` + 8 迁移 + 种子）完成手工确认，宣布“接口/发布边界稳定”。`/api/health/ready`=ready；`/health` 的 503 仅为磁盘阈值（C 盘近满）与 `mcp_server` 指标，不阻塞。JWT 密钥为本机新生成（原 `.env` 已备份），未回显秘密。

## 2. 测量结果（`npm run build --workspace api-nova-ui`）

| 指标 | 前 | 后 | Δ |
| --- | --- | --- | --- |
| 首屏预载（入口+modulepreload+CSS） | 2113.02 kB / 619.66 gz | **1776.71 kB / 531.98 gz** | **−336.31 kB（−15.9%）/ −87.68 gz（−14.1%）** |
| 入口 `index-*.js` | 13.33 kB | 8.66 kB | −4.67 kB |
| 首屏 eager CSS | 360.15 kB | 266.92 kB | −93.23 kB（−25.9%） |
| `vendor-misc` | 416.06 kB | 172.95 kB | −243.11 kB（zrender→charts、socket栈→realtime、@intlify→vue；消除 Circular chunk 告警） |
| 首屏 feature 预载 | 含 feature-editor/openapi/servers | 仅 vendor-* + app-core + feature-i18n | monaco 包装、charts、monitoring/testing 退出首屏 |

- 变更文件（仅 2 个）：`packages/api-nova-ui/vite.config.ts`（虚拟运行时助手固定到 app-core、manualChunks 重排、stores/services/composables/utils 固定 app-core 与 locales→feature-i18n）、`packages/api-nova-ui/src/main.ts`（去全量 `element-plus/dist/index.css`，保留 message/message-box/notification 模块样式；其余按需样式由既有 auto-import 注入）。
- 取舍（刻意保留）：`vendor-element-plus` JS 属启动即用；`feature-i18n` 启动加载双语为既有行为；`vendor-monaco` 本已动态加载；未增依赖、未改路由/API/i18n 键。

## 3. 验证

- `npm run type-check --workspace api-nova-ui`、`npm run build`（32.87s，无循环 chunk 告警）、`node scripts/check-delivery-i18n.cjs`（8/8、0 乱码）通过；`npm run lint` 仅 6 个既有错误（无新增）。
- 预览冒烟（构建产物、4174）：`/`、`/endpoints`、`/runtime-assets`、`/registration/batch` 均 200；`dist/index.html` 不再预载 `feature-editor`/`feature-openapi`；`vendor-element-plus` CSS 含 `.el-button/.el-table/.el-dialog/.el-message`。
- 原始日志：`E:\temp\opencode\maint-01\{build-before.log,build-after.log,lint-after.log,i18n-after.log,preview.log}`。
