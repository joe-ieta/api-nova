---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-28
---
# OBS-16-03 环境依赖执行车道证据（2026-09-28）

> Document status: Active evidence。本地隔离 PostgreSQL 多进程 + 受控接收端矩阵 + Linux 容器子集；不关闭部署验收与 AVAILABLE。

## 1. 环境与执行

- 执行器：`npm run verify:obs-16-03`（根 `scripts/verify-obs-16-03.cjs`），标记 `OBS_16_03_VERIFY_OK`，**exit 0**
- 环境：win32 x64 Node v24.15.0；隔离 PostgreSQL 16.10（本机）与 Alpine PostgreSQL 16.15（容器）；`node:24-alpine`（本地镜像 v24.21.0/musl，不拉取）
- 结果：5 格通过 / 2 格 blocked（有明确前置条件）/ 0 失败；既有执行器 `verify:obs-16-local-unit`、`verify:obs-15-full-chain`、`verify:obs-14-03e3` 全绿

## 2. 逐格矩阵

| 格 | 平台/DB | 结果 | 证据（本地日志） |
| --- | --- | --- | --- |
| win-stage1 PG 多进程 | win32 / 隔离 PG 16.10（容器回退 `postgres:16.14` 亦验证） | **10/10 pass** | `E:\Temp\opencode\obs-16-03-verify\stage1-win-pg-multiprocess.log` |
| win-stage2 接收端矩阵 | win32 / SQL.js + 回环 TLS 证书 | **8/8 pass** | `...\stage2-win-receiver-matrix.log` |
| linux-stage1 PG 多进程 | linux/musl / Alpine PG 16.15 | **10/10 pass** | `E:\Temp\opencode\obs-16-03-linux\linux-container-*.log` |
| linux-stage2 接收端矩阵 | linux/musl / SQL.js | **8/8 pass** | 同上 |
| `receiver-tls-success-self-signed-ca` | win32+linux | **blocked**：保留实现无 CA/信任根注入契约（无 `ca`/`NODE_EXTRA_CA_CERTS`/配置开关）；需部署侧信任配置或系统信任库 | stage2 日志（自签 → `tls` DEPTH_ZERO_SELF_SIGNED_CERT，0 HTTP 请求） |
| `linux-container-network-none` | linux/musl | **blocked**：Alpine `postgresql16(+contrib)` 需包镜像先安装；测试本身仅回环与保留 `.invalid` DNS | stage3 日志 |

## 3. 关键断言

- **Stage1（AC-09/12/13/20）**：PG `pessimistic_write + skip_locked`、事件租约 15s / 投递租约 30s、owner 守卫完成；两个真实 Node 进程共享库；SIGKILL 打断 outbox 物化与 delivery 请求后租约回收、恰好一次完成、无丢失无重复；revision/撤销/暂停/过期边界保持。崩溃确定性由 PG 中租赁时间钉扎模拟（脚本内记录）。
- **Stage2（AC-04/12/20）**：2xx；可重试 408/429/5xx + Retry-After（秒/HTTP 日期/过去日期）；终态 4xx 与 301/302/303/307/308；缺失本地秘密；DNS 失败；metadata 地址阻断；自签/不可达 TLS 失败；观察 socket 空闲界而非严格总超时。

## 4. 边界（`notCovered`）

- 真实受控 TLS 成功（需部署信任配置；未新增生产代码）；实际部署验收（开关/密钥/host 白名单/接收方归属/授权）未执行；长时浸泡/持续负载/性能；glibc 发行版/内核竞态/多主机；`--network none` 受包安装前置限制。
- 本证据不改变生产默认（开关保持关闭），也不代表 AVAILABLE。
