---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-28
---
# EXT-09 / OBS-06-02 Ubuntu 容器验收证据（2026-09-28）

> Document status: Active evidence。`ubuntu:24.04` 本地镜像（无新拉取）；容器≠裸机/systemd，边界如实列出。

## 1. 环境身份

| 项 | 值 |
| --- | --- |
| 宿主 | win32 x64，Node v24.15.0，Docker 29.5.3（Linux engine） |
| 镜像 | `ubuntu:24.04`（24.04.5 LTS，glibc 2.39，WSL2 内核 5.15.167.4） |
| 提交/锁 | commit `113b342`，`package-lock.json` sha256 `20eceaf6…`（宿主=容器） |
| 工具链 | 容器 Node **v24.15.0**（官方 tarball，与宿主同版）、npm 11.12.1 |

## 2. EXT-09 Ubuntu完整流程（DONE 限定容器）

- 执行器：`npm run verify:ext-09`（根 `scripts/verify-ext-09.cjs`），**exit 0**，`EXT_09_VERIFY_OK`（342s；含失败门控验证）
- 流程：apt 供给（重试加固）→ Node tarball → 只读挂载 repo + 容器内工作副本 → `npm ci`（49s）→ `node scripts/build.js --non-ui`（parser/server/API 产物核验）→ `migration:run` → 启动 API（SQLite `/work/data/ext09.sqlite`，PORT=9010）→ `/api/health/ready`=ready（第 3 次尝试）→ 种子完成 → **Streamable E2E**：`test-managed-runtime.cjs` 14/14 + `test-publication-endpoints.cjs` 3/3 → 优雅停止
- 边界：容器为 Linux/glibc WSL2 内核；不含裸机/systemd/主机内核、PG 通道、UI 构建、长时浸泡；运行时仅 loopback（Node/npm 供给走网络）。

## 3. OBS-06-02 MCP跨平台错误验证（DONE 限定）

- 执行器：`npm run verify:obs-06-02`（根 `scripts/verify-obs-06-02.cjs`），**exit 0**，`OBS_06_02_VERIFY_OK`（374s）
- 同版本：Linux v24.15.0 = Windows 基线 v24.15.0；Windows 证据引用 2026-09-26 审计 + 同提交重跑
- 一致性（22 行映射，21 匹配）：server 套件 11/11、17/17、15/15、12/12；parser 74/74；15 个 transport 覆盖单元全部一致（含 streamable timeout=部分 `MCP_AUTH_EXPIRED`、sse/stdio timeout=不适用）；native-vs-audited 双平台均 `match=true`
- **记录的平台差异（1 项，无需改码）**：16 MiB cork/uncork 终态——Windows `timeout`（`finished=false, needDrain=true`，3000ms 界）vs Linux `completed`（`finished=true, needDrain=false`），字节数相同 16777216；两侧 native/audited 自洽。原审计的 Windows-only `SDK_BASELINE_LIMITATION` 在 Linux/glibc 不复现，作为发现记录、未平滑处理。
- 边界：Linux 为 Docker/WSL2 内核；不含裸机内核/glibc、PostgreSQL 通道、负载/延迟等值、生产启用与 Windows ACL。

## 4. 原始日志

`E:\temp\opencode\ext-09\host-run-ext-09-final.log`、`E:\temp\opencode\obs-06-02\host-run-obs-06-02-final.log`（及各自 container 日志）。
